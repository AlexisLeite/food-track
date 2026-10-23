const offsetDate = (date, offset) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0,10);
};
export function currentWeekProgress(days, asOf, currentMaintenance) {
  const sunday = offsetDate(asOf, -new Date(`${asOf}T12:00:00Z`).getUTCDay());
  const byDate = new Map(days.map(day=>[day.date,day]));
  if (!byDate.has(sunday)) return new Map();
  const result = new Map();
  let consumed = 0, maintenance = 0, target = 0, missingDays = 0, pendingDays = 0;
  for (let date=sunday;date<=asOf;date=offsetDate(date,1)) {
    const day=byDate.get(date);
    if (!day) break;
    const dailyMaintenance=day.maintenance?.calories ?? currentMaintenance;
    const dailyTarget=day.target?.calories;
    if (!Number.isFinite(day.actual?.calories) || !Number.isFinite(dailyMaintenance) || dailyMaintenance<=0) { missingDays++; continue; }
    consumed+=day.actual.calories;
    maintenance+=dailyMaintenance;
    target+=Number.isFinite(dailyTarget)?dailyTarget:dailyMaintenance;
    if(day.pendingMeals) pendingDays++;
    const balance=consumed-maintenance, goalBalance=target-maintenance;
    const dailyGoalGap=(Number.isFinite(dailyTarget)?dailyTarget:dailyMaintenance)-dailyMaintenance;
    // Anchor the cumulative energy balance to the existing daily reference lines:
    // consumed == maintenance -> green; consumed == target -> grey.
    // Both references remain meaningful when the daily budget changes during the week.
    const comparable=goalBalance!==0 && dailyGoalGap!==0 && Math.sign(goalBalance)===Math.sign(dailyGoalGap);
    const lowerTotal=Math.min(target,maintenance), lowerDaily=Math.min(Number.isFinite(dailyTarget)?dailyTarget:dailyMaintenance,dailyMaintenance);
    const value=comparable
      ? consumed<=lowerTotal && lowerTotal>0 ? consumed/lowerTotal*lowerDaily : dailyMaintenance+balance/goalBalance*dailyGoalGap
      : consumed/maintenance*dailyMaintenance;
    result.set(date,{value,ratio:consumed/maintenance,consumed,maintenance,target,balance,
      goalDifference:consumed-target,missingDays,pendingDays,provisional:date===asOf});
  }
  return result;
}
