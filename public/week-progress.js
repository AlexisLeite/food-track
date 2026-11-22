const offsetDate = (date, offset) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0,10);
};
export function rollingWeekWindow(asOf, end = asOf) {
  const last = end < asOf ? end : asOf;
  return { first: offsetDate(last, -27), last };
}
// Each point compares only that date and its six preceding calendar days.
export function rollingWeekProgress(days, asOf, currentMaintenance, end = asOf) {
  const { first, last } = rollingWeekWindow(asOf, end);
  const byDate = new Map(days.map(day => [day.date, day]));
  const result = new Map();
  for (let date = first; date <= last; date = offsetDate(date, 1)) {
    const day = byDate.get(date);
    if (!Number.isFinite(day?.actual?.calories)) continue;
    const dailyMaintenance = day.maintenance?.calories ?? currentMaintenance;
    if (!Number.isFinite(dailyMaintenance) || dailyMaintenance <= 0) continue;
    const start = offsetDate(date, -6);
    let consumed = 0, maintenance = 0, target = 0, missingDays = 0, pendingDays = 0;
    for (let cursor = start; cursor <= date; cursor = offsetDate(cursor, 1)) {
      const entry = byDate.get(cursor);
      const expenditure = entry?.maintenance?.calories ?? currentMaintenance;
      if (!Number.isFinite(entry?.actual?.calories) || !Number.isFinite(expenditure) || expenditure <= 0) { missingDays++; continue; }
      consumed += entry.actual.calories;
      maintenance += expenditure;
      target += Number.isFinite(entry.target?.calories) ? entry.target.calories : expenditure;
      if (entry.pendingMeals) pendingDays++;
    }
    const balance=consumed-maintenance;
    // Intake alone determines the red line; targets and expenditure are comparisons.
    const value=consumed/(7-missingDays);
    result.set(date, { value, ratio: consumed / maintenance, consumed, maintenance, target, balance,
      goalDifference: consumed - target, missingDays, pendingDays, provisional: date === asOf, start });
  }
  return result;
}
