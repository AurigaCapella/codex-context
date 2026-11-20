import assert from 'node:assert/strict';
import {appendFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createSessions} from '../plugin/sessions.mjs';
import {estimateCosts} from '../plugin/ui/pricing.mjs';

test('compact sessions keep usage and timing while details rehydrate from the same log', async t => {
  const root = await mkdtemp(join(tmpdir(), 'context-session-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const id = '4a67aed0-8321-47ab-ac48-0de37d8fa011';
  const directories = ['sessions', 'context-traces'].map(name => join(root, name));
  await Promise.all(directories.map(directory => mkdir(directory)));
  const log = join(directories[0], `rollout-2026-11-20-${id}.jsonl`);
  const entry = (type, payload) => JSON.stringify({type, timestamp: '2026-11-20T00:00:00Z', payload}) + '\n';
  await writeFile(log, [
    entry('session_meta', {id, dynamic_tools: [{name: 'fixture', parameters: {type: 'object'}}]}),
    entry('event_msg', {type: 'task_started', turn_id: 'turn', model_context_window: 475000}),
    entry('response_item', {type: 'function_call', call_id: 'call', name: 'fixture', arguments: '{}'}),
    entry('response_item', {type: 'function_call_output', call_id: 'call', output: 'tool detail'}),
    entry('token_usage_record', {turn_id: 'turn', response_id: 'response', usage: {
      input_tokens: 128000, cached_input_tokens: 96000, output_tokens: 200
    }})
  ].join(''));
  await writeFile(join(directories[1], `${id}.jsonl`), JSON.stringify({
    type: 'response.completed', capture: 'user-owned-request',
    response: {id: 'response', model: 'gpt-6.2-sol'},
    request: {model: 'gpt-6.2-sol', instructions: 'request detail'}
  }));
  const sessions = createSessions(root);
  const compact = await sessions.read(id, {details: false});
  assert.equal(compact.contextSize, 128200);
  assert.equal(compact.turns[0].steps[0].responseModel, 'gpt-6.2-sol');
  assert.equal(compact.turns[0].steps[0].providerContext, null);
  assert.equal(compact.turns[0].calls, undefined);
  assert.deepEqual(compact.schemas, []);

  await appendFile(log, entry('event_msg', {
    type: 'task_complete', turn_id: 'turn', duration_ms: 1000, time_to_first_token_ms: 200,
    last_agent_message: 'answer'
  }));
  const current = await sessions.read(id, {details: false});
  const detail = await sessions.read(id);
  assert.equal(current.turns[0].ttft, 200);
  assert.equal(current.turns[0].state, 'complete');
  assert.deepEqual(estimateCosts(current.turns), estimateCosts(detail.turns));
  assert.equal(detail.turns[0].messages[0].text, 'answer');
  assert.equal(detail.turns[0].calls[0].details.output, 'tool detail');
  assert.equal(detail.turns[0].steps[0].providerContext.instructions, 'request detail');
  assert.deepEqual(detail.schemas, [['fixture', {type: 'object'}]]);
});
