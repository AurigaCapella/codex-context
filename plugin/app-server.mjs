import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

export async function withAppServer(run, options = {}) {
  const child = spawn(options.executable ?? 'codex', ['app-server', '--listen', 'stdio://'], {
    env: options.env ?? process.env, cwd: options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
  });
  const pending = new Map();
  let requestId = 0;
  let failure;
  function fail(error) {
    failure ??= error;
    for (const cancel of pending.values()) cancel(failure);
  }

  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', code => fail(new Error(`Codex App Server 已退出（${code ?? 'signal'}）`)));
  const lines = createInterface({input: child.stdout});
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      child.stdin.write(JSON.stringify({id: message.id, error: {code: -32601, message: 'Unsupported server request'}}) + '\n');
      return;
    }
    pending.get(message.id)?.(message.error ? new Error(message.error.message) : null, message.result);
  });
  function send(message) { child.stdin.write(JSON.stringify(message) + '\n'); }
  function request(method, params) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => complete(new Error(`${method} 等待超时`)), 20000);
      function complete(error, result) {
        clearTimeout(timer);
        pending.delete(id);
        if (error) reject(error);
        else resolve(result);
      }
      pending.set(id, complete);
      send({id, method, params});
    });
  }
  try {
    await request('initialize', {clientInfo: {name: 'codex-context', title: 'Codex Context', version: '0.1.0'}, capabilities: {experimentalApi: true}});
    send({method: 'initialized'});
    return await run(request);
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
