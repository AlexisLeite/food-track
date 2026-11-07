import { getMacroPlan, summarizeMeals, getCalorieLimits } from '../public/nutrition.js';
export function dateOffset(date, offset) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}
export function profileAt(goals, date) {
  let profile = null;
  for (const goal of [...goals].sort((a,b)=>a.date.localeCompare(b.date))) {
    if (goal.date > date) break;
    profile = JSON.parse(goal.profile);
  }
  return profile;
}
export function exerciseCalories(date, goals, workouts = [], asOf = date) {
  if (date > asOf || profileAt(goals, date)?.expenditureMode !== 'workouts') return 0;
  return workouts.filter(w => w.date === date && w.confirmed).reduce((sum, w) => sum + (w.calories || 0), 0);
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
export function buildWeek({ date, meals, goals, profile, asOf = date, workouts = [] }) {
  const { start, end } = weekRange(date);
  // Project the week using only configurations known on the allocation date.
  // A change on Thursday must not change what Monday's weekly budget was.
  const allocationDate = date > asOf ? (asOf < start ? start : asOf) : date;
  const effectiveGoals = goals.filter(goal => goal.date <= allocationDate);
  const history = buildBaseHistory({ start, end, meals, goals: effectiveGoals });
  const target = history.days.reduce((sum, day) => sum + (day.target?.calories ?? (!goals.length ? profile?.dailyCalories : 0) ?? 0), 0);
  const dailyMaintenance = history.days.map(day => day.maintenance?.calories ?? (!goals.length ? profile?.expenditure : undefined));
  const maintenance = dailyMaintenance.every(Number.isFinite) ? dailyMaintenance.reduce((sum, calories) => sum + calories, 0) : null;
  // Future days share today's allocation; future weeks begin their own Sunday.
  const consumedBeforeDate = history.days.filter(day => day.date < allocationDate).reduce((sum, day) => sum + (day.actual.calories ?? 0), 0);
  const daysRemaining = Math.round((Date.parse(end) - Date.parse(allocationDate)) / 86400000) + 1;
  const exerciseToday = exerciseCalories(date, effectiveGoals, workouts, asOf);
  const exerciseBefore = history.days.filter(day => day.date < allocationDate).reduce((sum, day) => sum + exerciseCalories(day.date, effectiveGoals, workouts, asOf), 0);
  const exerciseWeek = history.days.reduce((sum, day) => sum + exerciseCalories(day.date, effectiveGoals, workouts, asOf), 0);
  const remaining = target - consumedBeforeDate + exerciseWeek;
  // Past exercise offsets past consumption. Today's session belongs to today;
  // it is not also distributed across every remaining day.
  const rawDailyCalories = (target - consumedBeforeDate + exerciseBefore) / daysRemaining;
  const allocationProfile = profileAt(effectiveGoals, allocationDate) || profile;
  const minimumDailyCalories = getCalorieLimits(allocationProfile || {}).minimum;
  return { start, end,
    total: history.days.reduce((sum, day) => sum + (day.actual.calories ?? 0), 0),
    target: target + exerciseWeek, maintenance: maintenance === null ? null : maintenance + exerciseWeek,
    exerciseCalories: exerciseToday, exerciseWeekCalories: exerciseWeek,
    consumedBeforeDate, daysRemaining, remaining, rawDailyCalories,
    minimumDailyCalories, limited: Math.round(rawDailyCalories) < minimumDailyCalories,
    dailyCalories: Math.max(minimumDailyCalories, Math.round(rawDailyCalories)) + exerciseToday
  };
}

export function buildHistory({ start, end, meals, goals, asOf = end, workouts = [] }) {
  const history = buildBaseHistory({ start, end, meals, goals });
  const ordered = [...goals].sort((a, b) => b.date.localeCompare(a.date));
  for (const day of history.days) {
    const goal = ordered.find(goal => goal.date <= day.date);
    if (!goal) continue;
    const profile = JSON.parse(goal.profile);
    const budget = buildWeek({ date: day.date, meals, goals, profile, asOf, workouts });
    const macro = getMacroPlan({ ...profile, dailyCalories: budget.dailyCalories });
    const exercise = exerciseCalories(day.date, goals, workouts, asOf);
    if (exercise && day.maintenance) day.maintenance.calories += exercise;
    day.target = { calories: budget.dailyCalories, protein: macro.protein, fat: macro.fat, carbs: macro.carbs };
  }
  return history;
}
