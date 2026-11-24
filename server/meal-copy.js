import { randomUUID } from 'node:crypto';

export async function mealSnapshot(db, meal, order) {
  const description = (await db.prepare('SELECT description FROM meal_descriptions WHERE meal_id=?').get(meal.id))?.description;
  const analyses = await db.prepare(`SELECT id,instructions,description,options,created_at FROM analyses WHERE meal_id=? ORDER BY created_at,${order}`).all(meal.id);
  return { selected: JSON.parse(meal.selected), description, analyses, photo: meal.photo };
}

export async function insertMealCopy(db, { id, userId, date, snapshot, photo }) {
  const createdAt = new Date().toISOString();
  const selected = { ...snapshot.selected };
  const mapped = new Map(snapshot.analyses.map(analysis => [analysis.id, randomUUID()]));
  const insertAnalysis = db.prepare('INSERT INTO analyses(id,meal_id,instructions,description,options,created_at) VALUES(?,?,?,?,?,?)');
  await db.prepare('INSERT INTO meals(id,user_id,date,photo,selected,created_at) VALUES(?,?,?,?,?,?)').run(id, userId, date, photo, null, createdAt);
  if (snapshot.description) {
    await db.prepare('INSERT INTO meal_descriptions VALUES(?,?)').run(id, snapshot.description);
  }
  for (const analysis of snapshot.analyses) {
    await insertAnalysis.run(mapped.get(analysis.id), id, analysis.instructions, analysis.description, analysis.options, analysis.created_at);
  }
  if (mapped.has(selected.analysisId)) {
    selected.analysisId = mapped.get(selected.analysisId);
  } else {
    const analysisId = randomUUID();
    const { analysisId: oldAnalysisId, optionIndex, ...option } = selected;
    await insertAnalysis.run(analysisId, id, '', snapshot.description || selected.name, JSON.stringify([option]), createdAt);
    selected.analysisId = analysisId;
    selected.optionIndex = 0;
  }
  await db.prepare('UPDATE meals SET selected=? WHERE id=?').run(JSON.stringify(selected), id);
}
