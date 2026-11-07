// Pro US$200, GPT-6.1 Sol: provisional weekly capacities inferred from usage.
// These are alternative pure-token scenarios, not additive quotas or official limits.
export const weeklyTokenCapacity = Object.freeze({
  input: 300_000_000,
  cached: 6_000_000_000,
  output: 60_000_000
});
export const tokenSpeedMultiplier = Object.freeze({ standard: 1, fast: 2.5, ultrafast: 8 });
export function weeklyQuotaPercent({ input, cached, output }, speed = 'standard') {
  return 100 * ((input - cached) / weeklyTokenCapacity.input + cached / weeklyTokenCapacity.cached + output / weeklyTokenCapacity.output) * tokenSpeedMultiplier[speed];
}
