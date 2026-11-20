import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRollout} from '../plugin/rollout.mjs';

const started = Date.parse('2026-11-20T00:00:00.000Z');
const counts = {input_tokens: 120, cached_input_tokens: 80, output_tokens: 30, total_tokens: 150};

function record(rollout, time, type, payload) {
  rollout.append(JSON.stringify({timestamp: new Date(started + time).toISOString(), type, payload}));
}

function event(rollout, time, type, fields = {}) {
  record(rollout, time, 'event_msg', {type, turn_id: 't1', ...fields});
}

test('in-progress timing uses the first persisted text and most recent reported usage', () => {
  const rollout = createRollout();
  event(rollout, 0, 'task_started');
  event(rollout, 1000, 'item_completed', {
    item: {type: 'CommandExecution', id: 'command'},
    started_at_ms: started + 500
  });
  assert.equal(rollout.snapshot().turns[0].firstTextDelayMs, null);
  event(rollout, 3000, 'item_completed', {
    item: {type: 'AgentMessage', id: 'text', content: 'hello'},
    started_at_ms: started + 700
  });
  assert.equal(rollout.snapshot().turns[0].firstTextDelayMs, 700);
  assert.equal(rollout.snapshot().turns[0].outputWindowMs, null);

  record(rollout, 4000, 'token_usage_record', {
    turn_id: 't1', response_id: 'r1', usage: counts, turn_token_usage: counts
  });
  event(rollout, 4100, 'token_count', {info: {last_token_usage: counts, total_token_usage: counts}});
  const active = rollout.snapshot().turns[0];
  assert.equal(active.state, 'running');
  assert.equal(active.outputWindowMs, 3300);
  assert.equal(active.ttft, null);
  assert.equal(active.usage.output, 30);
  assert.equal(active.steps.length, 1);

  event(rollout, 5000, 'task_complete', {time_to_first_token_ms: 680, duration_ms: 5000});
  const complete = rollout.snapshot().turns[0];
  assert.equal(complete.ttft, 680);
  assert.equal(complete.outputWindowMs, 4320);
});

test('older snapshots can provide a timing window without treating duplicate usage as new output', () => {
  const rollout = createRollout();
  event(rollout, 0, 'task_started');
  event(rollout, 1200, 'item_started', {
    item: {type: 'AgentMessage', id: 'text'},
    started_at_ms: started + 1200
  });
  const info = {last_token_usage: counts, total_token_usage: counts};
  event(rollout, 2200, 'token_count', {info});
  event(rollout, 9000, 'token_count', {info});
  const turn = rollout.snapshot().turns[0];
  assert.equal(turn.steps.length, 1);
  assert.equal(turn.outputWindowMs, 1000);
});
