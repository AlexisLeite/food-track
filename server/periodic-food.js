import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { today } from './nutrition.js';
import { dateOffset } from './history.js';
import { insertMealCopy, mealSnapshot } from './meal-copy.js';
import { logExecution } from './execution-log.js';

export function createPeriodicFood(db, photoStorage, order) {
  async function write(callback) {
    const photos = [];
    const copyPhoto = async (source, id) => {
      if (!source) return '';
      const name = `${id}.jpg`;
      try {
        await photoStorage.copy(source, name);
        photos.push(name);
        return name;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return '';
      }
    };
    try {
      return await transaction(db, () => callback(copyPhoto));
    } catch (error) {
      await Promise.allSettled(photos.map(name => photoStorage.remove(name)));
      throw error;
    }
  }

  async function insertOccurrence(row, date, copyPhoto) {
    const snapshot = JSON.parse(row.snapshot);
    const id = randomUUID();
    const photo = await copyPhoto(snapshot.photo, id);
    if (!photo && !snapshot.description) {
      snapshot.description = [snapshot.selected.name, snapshot.selected.portion].filter(Boolean).join(' · ');
    }
    await insertMealCopy(db, { id, userId: row.user_id, date, snapshot, photo });
    await db.prepare('UPDATE meals SET periodic_food_id=? WHERE id=?').run(row.id, id);
  }

  return {
    async enable(userId, mealId, date = today()) {
      return write(async copyPhoto => {
        const lock = db.dialect === 'postgresql' ? ' FOR UPDATE' : '';
        const meal = await db.prepare(`SELECT * FROM meals WHERE id=? AND user_id=?${lock}`).get(mealId, userId);
        if (!meal) throw Object.assign(new Error('Comida no encontrada'), { status: 404 });
        if (!meal.selected) throw Object.assign(new Error('La comida aún no tiene una opción elegida'), { status: 409 });
        if (meal.periodic_food_id) return;

        const id = randomUUID();
        const snapshot = await mealSnapshot(db, meal, order);
        snapshot.photo = await copyPhoto(snapshot.photo, id);
        const row = { id, user_id: userId, snapshot: JSON.stringify(snapshot) };
        await db.prepare('INSERT INTO periodic_food(id,user_id,source_meal_id,snapshot,next_date) VALUES(?,?,?,?,?)')
          .run(id, userId, mealId, row.snapshot, dateOffset(date, 1));
        await db.prepare('UPDATE meals SET periodic_food_id=? WHERE id=?').run(id, mealId);
        if (meal.date !== date) await insertOccurrence(row, date, copyPhoto);
      });
    },

    async disable(userId, mealId) {
      const removed = await transaction(db, async () => {
        const rule = await db.prepare(`SELECT p.id,p.snapshot FROM periodic_food p
          WHERE p.user_id=? AND p.id=(SELECT periodic_food_id FROM meals WHERE id=? AND user_id=?)`)
          .get(userId, mealId, userId);
        if (rule) await db.prepare('DELETE FROM periodic_food WHERE id=?').run(rule.id);
        return rule;
      });
      const photo = removed && JSON.parse(removed.snapshot).photo;
      if (photo) await photoStorage.remove(photo).catch(error => {
        logExecution('periodic_food_cleanup_failed', { ruleId: removed.id, code: error.code || error.name });
      });
    },

    async materialize(asOf = today()) {
      const due = await db.prepare('SELECT id FROM periodic_food WHERE next_date<=? ORDER BY next_date,id').all(asOf);
      for (const { id } of due) {
        try {
          // Bound the work per rule on each tick after a long outage.
          for (let batch = 0; batch < 31; batch++) {
            const inserted = await write(async copyPhoto => {
              const row = await db.prepare('SELECT * FROM periodic_food WHERE id=? AND next_date<=?').get(id, asOf);
              if (!row) return false;
              await insertOccurrence(row, row.next_date, copyPhoto);
              await db.prepare('UPDATE periodic_food SET next_date=? WHERE id=?').run(dateOffset(row.next_date, 1), id);
              return true;
            });
            if (!inserted) break;
          }
        } catch (error) {
          logExecution('periodic_food_failed', { ruleId: id, code: error.code || error.name });
        }
      }
    },
  };
}

export function startPeriodicFoodWorker(periodicFood) {
  let pending;
  const tick = () => {
    pending ??= periodicFood.materialize()
      .catch(error => logExecution('periodic_food_scheduler_failed', { code: error.code || error.name }))
      .finally(() => { pending = null; });
  };
  tick();
  const timer = setInterval(tick, 30_000);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}
