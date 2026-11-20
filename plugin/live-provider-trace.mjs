import {randomUUID} from 'node:crypto';
import {mkdir, readdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const ttlMs = 15000;
const liveFile = /^\d{13}-[\da-f-]{36}\.json$/;

export function startLiveTrace(traceDirectory, threadId, turnId, sentModel) {
  const directory = join(traceDirectory, 'live', threadId);
  const startedAt = Date.now();
  const filename = join(directory, `${startedAt}-${randomUUID()}.json`);
  const temp = filename + '.tmp';
  const summary = {turnId, sentModel};
  let pending;
  let closed = false;
  const folder = mkdir(directory, {recursive: true}).then(() => true, () => false);

  function flush() {
    if (closed || pending) return;
    const body = JSON.stringify({...summary, updatedAt: Date.now()});
    pending = folder.then(async available => {
      if (!available) return;
      await writeFile(temp, body, 'utf8');
      await rename(temp, filename);
    }).catch(() => {}).finally(() => { pending = null; });
  }

  const timer = setInterval(flush, 500);
  timer.unref();
  flush();
  return {
    update(fields) {
      Object.assign(summary, fields);
      flush();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await pending;
      await Promise.all([unlink(filename).catch(() => {}), unlink(temp).catch(() => {})]);
    }
  };
}

export async function readLiveTrace(traceDirectory, threadId, turnId) {
  const directory = join(traceDirectory, 'live', threadId);
  const entries = await readdir(directory).catch(() => []);
  const candidates = entries.filter(name => liveFile.test(name)).sort().reverse();
  for (const name of candidates) {
    let item;
    try { item = JSON.parse(await readFile(join(directory, name), 'utf8')); } catch { continue; }
    const age = Date.now() - item?.updatedAt;
    if (!(age >= 0 && age <= ttlMs) || item.turnId !== turnId) continue;
    const text = value => typeof value === 'string' && value.length <= 240 ? value : null;
    const positive = value => Number.isFinite(value) && value >= 0 ? value : null;
    return {
      turnId,
      responseId: text(item.responseId),
      responseModel: text(item.responseModel),
      sentModel: text(item.sentModel),
      ttftMs: positive(item.ttftMs),
      textTps: positive(item.textTps)
    };
  }
  return null;
}
