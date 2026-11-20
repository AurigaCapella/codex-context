import assert from 'node:assert/strict';
import {test} from 'node:test';
import {estimateCosts, estimateStep} from '../plugin/ui/pricing.mjs';

const sol = {model: 'gpt-6.2-sol'};
const request = (input) => ({usage: {input, cached: 100000, cacheWrite: 2000, output: 1000}});

test('rates apply to the entire request only after the long-context threshold is exceeded', () => {
  const short = estimateStep(request(272000), sol);
  const long = estimateStep(request(272001), sol);
  assert.equal(short.usd, 0.365);
  assert.equal(long.usd, 0.725004);
  assert.equal(long.tier, 'Standard 长上下文');
});

test('partial totals retain known requests and expose coverage', () => {
  const known = request(272000);
  const unknown = {...known, responseModel: 'unknown-model'};
  assert.deepEqual(estimateCosts([{...sol, steps: [known, unknown]}]), {usd: 0.365, priced: 1, total: 2});
  assert.deepEqual(estimateCosts([{...sol, steps: [unknown]}]), {usd: null, priced: 0, total: 1});
});

test('explicit response model and custom rate take precedence', () => {
  const override = new Map([['gateway-model', {input: 1, cached: 1, cacheWrite: 1, output: 1}]]);
  const step = {...request(300000), responseModel: 'gateway-model', sentModel: sol.model};
  assert.deepEqual(estimateStep(step, sol, override), {usd: 0.301, model: 'gateway-model', tier: '自定义'});
});
