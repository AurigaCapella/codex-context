import assert from 'node:assert/strict';
import {test} from 'node:test';
import {attachProviderModels, parseProviderTrace} from '../plugin/provider-trace.mjs';

const event = (id, model, sent) => JSON.stringify({
  type: 'response.completed', response: {id, model},
  request: {model: sent}, unrelatedContent: 'ignore payload contents'
});

function attach(steps, lines) {
  return attachProviderModels({turns: [{model: 'configured', steps}]}, {
    records: parseProviderTrace(lines.join('\n')), key: '1', error: null
  });
}

test('reports request and response model only on an exact response ID match', () => {
  const snapshot = attach([{id: 'resp_a'}, {id: 'resp_b'}], [
    event('resp_a', 'actual-2026', 'alias'), event('resp_foreign', 'unrelated'), '{"unfinished":'
  ]);
  assert.equal(snapshot.turns[0].model, 'configured');
  assert.equal(snapshot.providerTrace.matched, 1);
  const [matched, empty] = snapshot.turns[0].steps;
  assert.equal(matched.responseModel, 'actual-2026');
  assert.equal(matched.sentModel, 'alias');
  assert.equal(matched.responseModelSource, '本地上游记录');
  assert.equal(empty.responseModel, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /ignore payload contents|unrelated/);
});

test('keeps original models and flags inconsistent exports', () => {
  const snapshot = attach([{id: 'resp_a', responseModel: 'codex-actual'}, {id: 'resp_b'}], [
    event('resp_a', 'other-model'),
    event('resp_b', 'duplicate-first'), event('resp_b', 'duplicate-second')
  ]);
  const [preserved, conflict] = snapshot.turns[0].steps;
  assert.equal(preserved.responseModel, 'codex-actual');
  assert.equal(preserved.responseModelSource, 'Codex 会话日志');
  assert.equal(conflict.responseModel, null);
  assert.equal(snapshot.providerTrace.conflicts, 2);
});

test('loads explicitly provided instruction text and tool schemas for the matched request', () => {
  const capture = {
    type: 'response.completed',
    capture: 'user-owned-request',
    response: {id: 'resp_a', model: 'actual-2026'},
    request: {
      model: 'alias',
      instructions: 'First line.\nLast line.',
      input: [
        {role: 'developer', content: [{type: 'input_text', text: 'Keep the order.'}, {type: 'input_image', image_url: 'data:discard'}]},
        {role: 'user', content: 'do not include user text'}
      ],
      tools: [
        {type: 'namespace', name: 'search', tools: [{type: 'function', name: 'lookup', parameters: {type: 'object'}}]},
        {type: 'mcp', name: 'external', headers: {Authorization: 'discard-auth-header'}}
      ]
    }
  };
  const unmarked = {...capture, capture: undefined, response: {...capture.response, id: 'resp_b'}};
  const {turns: [{steps: [marked, ignored]}]} = attach([{id: 'resp_a'}, {id: 'resp_b'}], [capture, unmarked].map(x => JSON.stringify(x)));
  assert.deepEqual(marked.providerContext, {
    instructions: 'First line.\nLast line.',
    messages: [{role: 'developer', content: [{type: 'input_text', text: 'Keep the order.'}]}],
    tools: [{name: 'search.lookup', type: 'function', schema: {type: 'object'}}]
  });
  assert.equal(ignored.providerContext, null);
});

test('does not display an instruction snapshot when exports disagree', () => {
  const capture = instructions => JSON.stringify({
    type: 'response.completed', capture: 'user-owned-request',
    response: {id: 'resp_a', model: 'same-model'}, request: {instructions}
  });
  const {turns: [{steps: [step]}]} = attach([{id: 'resp_a'}], [capture('first'), capture('second')]);
  assert.equal(step.responseModel, 'same-model');
  assert.equal(step.providerContext, null);
  assert.equal(step.providerContextConflict, true);
});
