import { getMacroPlan, summarizeMeals, getCalorieLimits } from '../public/nutrition.js';
export function dateOffset(date, offset) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}
function buildBaseHistory({ start, end, meals, goals }) {
  const grouped = new Map();
  for (const meal of meals) {
    const day = grouped.get(meal.date) || [];
    day.push({ selected: meal.selected ? JSON.parse(meal.selected) : null }); grouped.set(meal.date, day);
  }
  const ordered = [...goals].sort((a, b) => a.date.localeCompare(b.date));
  let goalIndex = 0, profile = null;
  const days = [];
  for (let date = start; date <= end; date = dateOffset(date, 1)) {
    while (goalIndex < ordered.length && ordered[goalIndex].date <= date) profile = JSON.parse(ordered[goalIndex++].profile);
    const entries = grouped.get(date) || [];
    const selectedCount = entries.filter(m => m.selected).length;
    const total = summarizeMeals(entries);
    const macroPlan = profile ? getMacroPlan(profile) : null;
    days.push({ date, meals: selectedCount, pendingMeals: entries.length - selectedCount,
      actual: { calories: selectedCount ? total.calories : null, protein: selectedCount && !total.missingMacros ? total.protein : null, fat: selectedCount && !total.missingMacros ? total.fat : null, carbs: selectedCount && !total.missingMacros ? total.carbs : null },
      maintenance: Number.isFinite(profile?.expenditure) ? { calories: profile.expenditure } : null,
      target: profile ? { calories: profile.dailyCalories, protein: macroPlan.protein, fat: macroPlan.fat, carbs: macroPlan.carbs } : null
    });
  }
  return { start, end, days };
}

export function weekRange(date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const start = dateOffset(date, -weekday);
  return { start, end: dateOffset(start, 6) };
}
export function buildWeek({ date, meals, goals, profile, asOf = date }) {
  const { start, end } = weekRange(date);
  const history = buildBaseHistory({ start, end, meals, goals });
  const target = history.days.reduce((sum, day) => sum + (day.target?.calories ?? profile?.dailyCalories ?? 0), 0);
  const dailyMaintenance = history.days.map(day => day.maintenance?.calories ?? profile?.expenditure);
  const maintenance = dailyMaintenance.every(Number.isFinite) ? dailyMaintenance.reduce((sum, calories) => sum + calories, 0) : null;
  // Future days share today's allocation; future weeks begin their own Sunday.
  const allocationDate = date > asOf ? (asOf < start ? start : asOf) : date;
  const consumedBeforeDate = history.days.filter(day => day.date < allocationDate).reduce((sum, day) => sum + (day.actual.calories ?? 0), 0);
  const daysRemaining = Math.round((Date.parse(end) - Date.parse(allocationDate)) / 86400000) + 1;
  const remaining = target - consumedBeforeDate;
  const rawDailyCalories = remaining / daysRemaining;
  const allocationGoal = [...goals].sort((a, b) => b.date.localeCompare(a.date)).find(goal => goal.date <= allocationDate);
  const allocationProfile = allocationGoal ? JSON.parse(allocationGoal.profile) : profile;
  const minimumDailyCalories = getCalorieLimits(allocationProfile || {}).minimum;
  return { start, end,
    total: history.days.reduce((sum, day) => sum + (day.actual.calories ?? 0), 0),
    target, maintenance, consumedBeforeDate, daysRemaining, remaining, rawDailyCalories,
    minimumDailyCalories, limited: Math.round(rawDailyCalories) < minimumDailyCalories,
    dailyCalories: Math.max(minimumDailyCalories, Math.round(rawDailyCalories))
  };
}

export function buildHistory({ start, end, meals, goals, asOf = end }) {
  const history = buildBaseHistory({ start, end, meals, goals });
  const ordered = [...goals].sort((a, b) => b.date.localeCompare(a.date));
  for (const day of history.days) {
    const goal = ordered.find(goal => goal.date <= day.date);
    if (!goal) continue;
    const profile = JSON.parse(goal.profile);
    const budget = buildWeek({ date: day.date, meals, goals, profile, asOf });
    const macro = getMacroPlan({ ...profile, dailyCalories: budget.dailyCalories });
    day.target = { calories: budget.dailyCalories, protein: macro.protein, fat: macro.fat, carbs: macro.carbs };
  }
  return history;
}
