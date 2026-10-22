// Explicit maintenance task: npm start never invokes this backfill.
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { estimateMissingMacros } from '../server/codex.js';
import { hasMacros, macroKeys, summarizeMeals } from '../public/nutrition.js';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const db = new DatabaseSync(path.join(dataDir, 'foodtrack.sqlite'));
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
let completed = 0, selectedCompleted = 0;
try {
  const meals = db.prepare('SELECT * FROM meals ORDER BY created_at').all();
  const backupDir = path.join(dataDir, 'backups');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await backup(db, path.join(backupDir, `before-macros-${Date.now()}.sqlite`));
  for (const meal of meals) {
    const analyses = db.prepare('SELECT * FROM analyses WHERE meal_id=? ORDER BY created_at, rowid').all(meal.id);
    const pending = [];
    const selected = meal.selected ? JSON.parse(meal.selected) : null;
    for (const analysis of analyses) {
      const options = JSON.parse(analysis.options);
      for (let i = 0; i < options.length; i++) {
        if (!hasMacros(options[i])) pending.push({ analysis, optionIndex: i, option: options[i] });
      }
    }
    let selectedSource = selected && pending.find(p => p.analysis.id === selected.analysisId && p.optionIndex === selected.optionIndex && ['name', 'portion', 'calories'].every(k => p.option[k] === selected[k]));
    if (selected && !hasMacros(selected) && !selectedSource) {
      selectedSource = { option: selected }; pending.push(selectedSource);
    }
    if (!pending.length) continue;
    const inputs = pending.map((p, index) => ({ index, name: p.option.name, portion: p.option.portion, calories: p.option.calories, details: p.option.details }));
    const context = pending.map((p, index) => ({ index, description: p.analysis?.description || '', instructions: p.analysis?.instructions || '' }));
    const results = await estimateMissingMacros(path.join(dataDir, 'photos', meal.photo), inputs, context);
    const enriched = new Map(results.map(r => [r.index, Object.fromEntries(macroKeys.map(k => [k, r[k]]))]));
    db.exec('BEGIN IMMEDIATE');
    try {
      // Compare snapshots inside the transaction so a concurrent edit is never overwritten.
      const current = db.prepare('SELECT selected FROM meals WHERE id=? AND user_id=?').get(meal.id, meal.user_id);
      if (!current) { db.exec('ROLLBACK'); continue; }
      const edited = new Map();
      for (const [index, item] of pending.entries()) {
        if (!item.analysis) continue;
        let state = edited.get(item.analysis.id);
        if (!state) {
          const row = db.prepare('SELECT options FROM analyses WHERE id=? AND meal_id=?').get(item.analysis.id, meal.id);
          if (!row || row.options !== item.analysis.options) throw new Error('Las opciones cambiaron durante el proceso.');
          state = JSON.parse(row.options); edited.set(item.analysis.id, state);
        }
        state[item.optionIndex] = { ...state[item.optionIndex], ...enriched.get(index) };
      }
      for (const [id, options] of edited) db.prepare('UPDATE analyses SET options=? WHERE id=?').run(JSON.stringify(options), id);
      let selectionUpdated = false;
      if (selected && !hasMacros(selected) && current.selected === meal.selected) {
        const index = pending.indexOf(selectedSource);
        db.prepare('UPDATE meals SET selected=? WHERE id=?').run(JSON.stringify({ ...selected, ...enriched.get(index) }), meal.id);
        selectionUpdated = true;
      }
      db.exec('COMMIT');
      completed += pending.filter(p => p.analysis).length;
      if (selectionUpdated) selectedCompleted++;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const mealsNow = db.prepare('SELECT selected FROM meals').all().map(m => ({ selected: m.selected ? JSON.parse(m.selected) : null }));
  const missingOptions = db.prepare('SELECT options FROM analyses').all().reduce((n, a) => n + JSON.parse(a.options).filter(o => !hasMacros(o)).length, 0);
  console.log(JSON.stringify({ completedOptions: completed, completedSelections: selectedCompleted, missingOptions, missingSelections: summarizeMeals(mealsNow).missingMacros }));
} finally { db.close(); }
