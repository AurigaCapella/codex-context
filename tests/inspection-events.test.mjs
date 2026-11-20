import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {appendFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const id = '4a67aed0-8321-47ab-ac48-0de37d8fa011';
const otherId = 'f945592f-64bd-4068-9732-4364cc71b4dd';
const logName = thread => `rollout-2026-11-20-${thread}.jsonl`;
const entry = (type, payload) => JSON.stringify({type, timestamp: '2026-11-20T00:00:00Z', payload}) + '\n';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'context-notifications-'));
  const folders = ['sessions', 'archived_sessions', 'context-traces'];
  await Promise.all(folders.map(folder => mkdir(join(root, folder))));
  const log = join(root, 'sessions', logName(id));
  const output = 'tool output '.repeat(3000);
  await writeFile(log, [
    entry('session_meta', {id, dynamic_tools: [{name: 'example', parameters: {type: 'object'}}]}),
    entry('event_msg', {type: 'turn_started', turn_id: 'first', model_context_window: 475000}),
    entry('event_msg', {type: 'user_message', turn_id: 'first', message: 'first question'}),
    entry('response_item', {type: 'function_call', call_id: 'call', name: 'example', arguments: '{"a":1}'}),
    entry('response_item', {type: 'function_call_output', call_id: 'call', output}),
    entry('token_usage_record', {turn_id: 'first', response_id: 'resp-fixture', usage: {
      input_tokens: 128000, cached_input_tokens: 108000, output_tokens: 200
    }}),
    entry('event_msg', {type: 'turn_completed', turn_id: 'first', last_agent_message: 'first answer'}),
    entry('event_msg', {type: 'turn_started', turn_id: 'second'}),
    entry('event_msg', {type: 'turn_completed', turn_id: 'second', last_agent_message: 'second answer'})
  ].join(''));
  await writeFile(join(root, 'context-traces', `${id}.jsonl`), JSON.stringify({
    type: 'response.completed', capture: 'user-owned-request', response: {id: 'resp-fixture', model: 'gpt-6.2-sol'},
    request: {instructions: 'saved fixture instructions'}
  }));
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  socket.close();
  await once(socket, 'close');
  const origin = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../plugin/server.mjs', import.meta.url)), '--port', String(port)], {
    env: {...process.env, CODEX_HOME: root}, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true
  });
  const closed = once(proc, 'exit');
  t.after(async () => {
    if (proc.exitCode === null) {
      await fetch(`${origin}/api/stop`, {
        method: 'POST', headers: {Origin: origin, 'X-Context-Action': 'stop'}, signal: AbortSignal.timeout(2000)
      }).catch(() => proc.kill());
    }
    await closed;
    await rm(root, {recursive: true, force: true});
  });
  await Promise.race([once(proc.stdout, 'data'), closed.then(() => { throw new Error('fixture server did not start'); })]);
  return {root, log, origin, output};
}

test('native summary omits bodies, then loads only the selected turn or call', {timeout: 10000}, async t => {
  const {origin, output} = await fixture(t);
  const read = path => fetch(`${origin}${path}`).then(response => response.json());
  const summary = await read(`/api/thread-summary?id=${id}`);
  assert.equal(summary.contextSize, 128200);
  assert.equal(summary.turns[0].preview, 'first answer');
  assert.equal(summary.turns[0].messages, undefined);
  assert.equal(summary.turns[0].calls[0].details, undefined);
  assert.equal(summary.turns[0].steps[0].hasProviderContext, true);
  assert.deepEqual(summary.schemaNames, ['example']);
  const turn = await read(`/api/turn?id=${id}&turn=first`);
  assert.deepEqual(turn.messages.map(item => item.text), ['first question', 'first answer']);
  const query = `?id=${id}&turn=first&call=call&source=response`;
  const preview = await read(`/api/call-preview${query}`);
  assert.equal(preview.truncated, true);
  assert.equal(preview.text.length, 8192);
  assert.equal((await read(`/api/call${query}`)).details.output, output);
  assert.equal((await read(`/api/schema?id=${id}&name=example`)).schema.type, 'object');
  assert.equal((await read(`/api/request-context?id=${id}&turn=first&response=resp-fixture`)).instructions, 'saved fixture instructions');
  assert.equal((await read(`/api/thread?id=${id}`)).turns[0].messages[1].text, 'first answer');
});

test('send file notifications for the selected rollout, trace and theme', {timeout: 10000}, async t => {
  const {root, log, origin} = await fixture(t);
  const stream = await fetch(`${origin}/api/events?id=${id}`, {signal: AbortSignal.timeout(6000)});
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  async function until(topic) {
    while (!text.includes(`"${topic}"`)) {
      const part = await reader.read();
      if (part.done) throw new Error(`missing notification: ${topic}`);
      text += part.value;
    }
    text = '';
  }
  try {
    await until('refresh');
    await appendFile(log, entry('event_msg', {type: 'turn_started', turn_id: 'third'}));
    await until('metrics');
    await writeFile(join(root, 'config.toml'), '[desktop]\nappearanceTheme = "dark"\n');
    await until('appearance');
    await writeFile(join(root, 'sessions', logName(otherId)), entry('session_meta', {id: otherId}));
    await until('threads');
    const threads = await fetch(`${origin}/api/threads`).then(response => response.json());
    assert(threads.some(thread => thread.id === otherId));
    await appendFile(join(root, 'context-traces', `${id}.jsonl`), '\n');
    await until('metrics');
  } finally { await reader.cancel(); }
});
