// Shared by the browser and server so the goals and totals always agree.
export const macroKeys = ['protein', 'fat', 'carbs'];
const round = value => Math.round((value + Number.EPSILON) * 10) / 10;
export function getMacroPlan({ weight, targetWeight, dailyCalories }) {
  const goal = targetWeight < weight ? 'lose' : targetWeight > weight ? 'gain' : 'maintain';
  // Product defaults within adult AMDR ranges, expressed as shares of energy.
  const ratios = {
    lose: { protein: 0.30, fat: 0.25, carbs: 0.45 },
    gain: { protein: 0.25, fat: 0.25, carbs: 0.50 },
    maintain: { protein: 0.20, fat: 0.30, carbs: 0.50 }
  }[goal];
  return { goal, ratios, protein: round(dailyCalories * ratios.protein / 4), fat: round(dailyCalories * ratios.fat / 9), carbs: round(dailyCalories * ratios.carbs / 4) };
}
export function hasMacros(option) {
  return !!option && macroKeys.every(key => typeof option[key] === 'number' && Number.isFinite(option[key]) && option[key] >= 0 && option[key] <= 2500);
}
export function summarizeMeals(meals) {
  const result = { calories: 0, protein: 0, fat: 0, carbs: 0, missingMacros: 0, knownMeals: 0 };
  for (const { selected } of meals) {
    if (!selected) continue;
    result.calories += selected.calories;
    if (!hasMacros(selected)) { result.missingMacros++; continue; }
    result.knownMeals++;
    for (const key of macroKeys) result[key] += selected[key];
  }
  for (const key of macroKeys) result[key] = round(result[key]);
  return result;
}

export function getGoalProjection({ weight, targetWeight, expenditure, dailyCalories, startDate, targetDate }) {
  if (![weight, targetWeight, expenditure, dailyCalories].every(Number.isFinite) || !startDate || !targetDate) return null;
  const start = Date.parse(`${startDate}T12:00:00Z`), end = Date.parse(`${targetDate}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const deadlineDays = Math.round((end - start) / 86400000), dailyAdjustment = dailyCalories - expenditure;
  const change = targetWeight - weight;
  const estimatedDays = change === 0 ? 0 : change * dailyAdjustment > 0 ? Math.ceil(Math.abs(change * 7700 / dailyAdjustment)) : null;
  return { deadlineDays, dailyAdjustment,
    projectedWeight: round(weight + dailyAdjustment * deadlineDays / 7700),
    estimatedDays,
    estimatedTargetDate: estimatedDays === null ? null : new Date(start + estimatedDays * 86400000).toISOString().slice(0, 10)
  };
}

export const caloriePolicyVersion = 5;
export function getCalorieLimits({ expenditure }) {
  if (!Number.isFinite(expenditure)) return { minimum: 0, maximum: Infinity };
  return { minimum: Math.max(0, expenditure - 1200), maximum: expenditure + 500 };
}
