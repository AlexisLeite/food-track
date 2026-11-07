import { getMacroPlan, getGoalProjection, getCalorieLimits, caloriePolicyVersion, defaultMaxDailyDeficitPercent, maxDailyDeficitPercent, activityFactors, dailyActivityFactors } from '../public/nutrition.js';
export function withMacroPlan(profile) { return profile ? { ...profile, macroPlan: getMacroPlan(profile), projection: getGoalProjection(profile) } : null; }
export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function calculateProfile(input, start = today()) {
  const { height, age, weight, targetWeight, gender, activity = input.expenditureMode === 'workouts' ? 'sedentary' : undefined, targetDate } = input;
  for (const [name, value, min, max] of [['Altura', height, 100, 250], ['Edad', age, 18, 100], ['Peso actual', weight, 30, 350], ['Peso objetivo', targetWeight, 30, 350]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name}: ingresá un valor entre ${min} y ${max}.`);
  }
  if (!Number.isInteger(age)) throw new Error('La edad debe ser un número entero.');
  const expenditureMode = input.expenditureMode ?? 'estimated';
  const dailyActivity = input.dailyActivity ?? 'sedentary';
  const percent = input.maxDailyDeficitPercent ?? defaultMaxDailyDeficitPercent;
  if (!['estimated', 'workouts'].includes(expenditureMode)) throw new Error('Elegí un perfil de gasto válido.');
  if (!Object.hasOwn(dailyActivityFactors, dailyActivity)) throw new Error('Elegí tu actividad cotidiana.');
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > maxDailyDeficitPercent) throw new Error(`El déficit máximo debe estar entre 0 y ${maxDailyDeficitPercent} %. Puedes usar 0 para no permitir déficit.`);
  const factors = activityFactors;
  if (!['male', 'female'].includes(gender) || !Object.hasOwn(factors, activity)) throw new Error('Elegí género y actividad.');
  if (!validDate(targetDate) || targetDate <= start) throw new Error('Elegí una fecha futura para tu objetivo.');
  const days = Math.round((Date.parse(targetDate) - Date.parse(start)) / 86400000);
  const expenditure = Math.round((10 * weight + 6.25 * height - 5 * age + (gender === 'male' ? 5 : -161)) * (expenditureMode === 'workouts' ? dailyActivityFactors[dailyActivity] : factors[activity]));
  const requestedCalories = Math.round(expenditure + (targetWeight - weight) * 7700 / days);
  return applyCaloriePolicy({ height, age, weight, targetWeight, gender, activity, targetDate, startDate: start, expenditureMode, dailyActivity, maxDailyDeficitPercent: percent, expenditure, requestedCalories });
}
export function applyCaloriePolicy(profile) {
  profile = { ...profile, expenditureMode: profile.expenditureMode ?? 'estimated', dailyActivity: profile.dailyActivity ?? 'sedentary', maxDailyDeficitPercent: profile.maxDailyDeficitPercent ?? defaultMaxDailyDeficitPercent };
  const { minimum, maximum } = getCalorieLimits(profile);
  const days = Math.round((Date.parse(profile.targetDate) - Date.parse(profile.startDate)) / 86400000);
  const requestedCalories = Number.isFinite(profile.requestedCalories) ? profile.requestedCalories : Math.round(profile.expenditure + (profile.targetWeight - profile.weight) * 7700 / days);
  if (!Number.isFinite(requestedCalories) || !Number.isFinite(profile.expenditure)) throw new Error('No se pudo actualizar el objetivo calórico guardado.');
  const dailyCalories = Math.round(Math.max(minimum, Math.min(maximum, requestedCalories)));
  return withMacroPlan({ ...profile, dailyCalories, requestedCalories, limited: dailyCalories !== requestedCalories, caloriePolicyVersion });
}
