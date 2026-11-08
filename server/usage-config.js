// Pro US$200, GPT-6.1 Sol: provisional weekly capacities inferred from usage.
// These are alternative pure-token scenarios, not additive quotas or official limits.
export const weeklyTokenCapacity = Object.freeze({
  input: 300_000_000,
  cached: 6_000_000_000,
  output: 60_000_000
});
export const tokenSpeedMultiplier = Object.freeze({ standard: 1, fast: 2.5, ultrafast: 8 });
// Relative credit rates are a provisional proxy for included subscription usage.
export const tokenModelWeight = Object.freeze({
  'gpt-6.1-sol': Object.freeze({ input: 1, cached: 1, output: 1 }),
  'gpt-6.1-terra': Object.freeze({ input: 0.5, cached: 0.5, output: 0.5 }),
  'gpt-6-luna': Object.freeze({ input: 0.05, cached: 0.1, output: 0.05 })
});
export function weeklyQuotaPercent({ input, cached, output }, speed = 'standard', model = 'gpt-6.1-sol') {
  const weight = tokenModelWeight[model] || tokenModelWeight['gpt-6.1-sol'];
  return 100 * ((input - cached) * weight.input / weeklyTokenCapacity.input + cached * weight.cached / weeklyTokenCapacity.cached + output * weight.output / weeklyTokenCapacity.output) * tokenSpeedMultiplier[speed];
}
