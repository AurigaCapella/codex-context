export const defaultRates = new Map([
  ['gpt-6.2-sol', {input: 2, cached: 0.1, output: 10, cacheWrite: 2.5}],
  ['gpt-6.2-astra', {input: 8, cached: 0.4, output: 40, cacheWrite: 10}]
]);

export function estimateStep(step, turn, overrides) {
  const model = step.responseModel ?? step.sentModel ?? turn.model;
  const custom = overrides?.get(model);
  const rate = custom ?? defaultRates.get(model);
  if (!rate || !step.usage) return null;
  const {input, cached, output, cacheWrite = 0} = step.usage;
  const writes = cacheWrite ?? 0;
  if (![input, cached, output, writes].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  if (cached + writes > input || (writes && rate.cacheWrite == null)) return null;
  const long = !custom && input > 272000;
  const inputCost = (input - cached - writes) * rate.input + cached * rate.cached + writes * (rate.cacheWrite ?? 0);
  const outputCost = output * rate.output;
  const usd = (inputCost * (long ? 2 : 1) + outputCost * (long ? 1.5 : 1)) / 1e6;
  if (!Number.isFinite(usd) || usd < 0) return null;
  return {usd, model, tier: custom ? '自定义' : long ? 'Standard 长上下文' : 'Standard'};
}

export function estimateCosts(turns, overrides) {
  let usd = 0;
  let priced = 0;
  let total = 0;
  for (const turn of turns) {
    for (const step of turn.steps) {
      total++;
      const cost = estimateStep(step, turn, overrides);
      if (!cost) continue;
      priced++;
      usd += cost.usd;
    }
  }
  return {usd: priced ? usd : null, priced, total};
}
