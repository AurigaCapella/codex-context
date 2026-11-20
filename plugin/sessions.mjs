import {open, readdir, readFile, stat} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {createRollout} from './rollout.mjs';
import {attachProviderModels, readProviderTrace} from './provider-trace.mjs';
import {readLiveTrace} from './live-provider-trace.mjs';

export const threadIdPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const rolloutPattern = /-([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\.jsonl$/i;
export const rolloutId = name => basename(name).startsWith('rollout-') ? basename(name).match(rolloutPattern)?.[1]?.toLowerCase() : undefined;

export function createSessions(root) {
  const metricsCache = new Map();
  const bounded = new Map();
  let lastScan = 0;
  let pendingScan;
  let files = new Map();
  let indexVersion = 0;
  let scannedVersion = -1;

  async function scan() {
    const version = indexVersion;
    const names = await Promise.all(['sessions', 'archived_sessions'].map(async folder => {
      const directory = join(root, folder);
      const entries = await readdir(directory, {recursive: true, withFileTypes: true}).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      return entries.filter(entry => entry.isFile() && rolloutId(entry.name))
        .map(entry => ({path: join(entry.parentPath, entry.name), archived: folder === 'archived_sessions'}));
    }));
    const indexed = await readFile(join(root, 'session_index.jsonl'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const titles = new Map();
    for (const line of indexed.split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (typeof item.thread_name === 'string') titles.set(item.id, item.thread_name);
      } catch { /* An index update may be incomplete. */ }
    }
    const found = new Map();
    const candidates = names.flat();
    for (let offset = 0; offset < candidates.length; offset += 64) {
      await Promise.all(candidates.slice(offset, offset + 64).map(async file => {
        const id = rolloutId(file.path);
        const info = await stat(file.path).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!info) return;
        const existing = found.get(id);
        if (!existing || existing.archived) found.set(id, {id, title: titles.get(id), updated: info.mtimeMs, ...file});
      }));
    }
    files = found;
    lastScan = Date.now();
    scannedVersion = version;
  }

  async function refresh() {
    if (scannedVersion === indexVersion && Date.now() - lastScan < 5000) return;
    pendingScan ??= scan().finally(() => { pendingScan = null; });
    await pendingScan;
  }

  async function update(entry, path) {
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat();
      if (entry.snapshot && entry.inode === info.ino && entry.offset === info.size && entry.updated === info.mtimeMs) {
        return entry.snapshot;
      }
      if (!entry.rollout || entry.inode !== info.ino || entry.offset > info.size || (entry.offset === info.size && entry.updated !== info.mtimeMs)) {
        Object.assign(entry, {offset: 0, tail: Buffer.alloc(0), rollout: createRollout(entry.options), inode: info.ino});
      }
      const buffer = Buffer.allocUnsafe(256 * 1024);
      while (entry.offset < info.size) {
        const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, info.size - entry.offset), entry.offset);
        if (bytesRead === 0) break;
        entry.offset += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        const data = entry.tail.length ? Buffer.concat([entry.tail, chunk]) : chunk;
        let start = 0;
        for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
          const line = data.toString('utf8', start, end).trim();
          if (line) entry.rollout.append(line);
          start = end + 1;
        }
        entry.tail = Buffer.from(data.subarray(start));
      }
      entry.updated = info.mtimeMs;
      entry.snapshot = entry.rollout.snapshot();
      return entry.snapshot;
    } finally {
      await handle.close();
    }
  }

  function createEntry(path, options) {
    return {path, offset: 0, tail: Buffer.alloc(0), options};
  }

  function useCache(path, options) {
    if (options.details) {
      const slot = options.summary ? 'summary' : options.turnId || options.resource ? 'selected' : 'full';
      const key = JSON.stringify([path, options]);
      const prior = bounded.get(slot);
      clearTimeout(prior?.expiry);
      const entry = prior?.key === key ? prior.entry : createEntry(path, options);
      const expiry = setTimeout(() => bounded.delete(slot), 20000).unref();
      bounded.set(slot, {key, entry, expiry});
      return entry;
    }
    const entry = metricsCache.get(path) ?? createEntry(path, options);
    metricsCache.delete(path);
    metricsCache.set(path, entry);
    if (metricsCache.size > 4) metricsCache.delete(metricsCache.keys().next().value);
    return entry;
  }

  return {
    invalidate() { indexVersion++; },
    async list() {
      await refresh();
      return [...files.values()]
        .sort((a, b) => b.updated - a.updated)
        .map(({path, ...item}) => item);
    },
    async read(id, options = {}) {
      if (scannedVersion !== indexVersion || !files.has(id)) await refresh();
      const file = files.get(id);
      if (!file) return null;
      const entry = useCache(file.path, {details: true, ...options});
      const next = (entry.queue ?? Promise.resolve()).catch(() => {}).then(async () => {
        const snapshot = await update(entry, file.path).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          files.delete(id);
          lastScan = 0;
          return null;
        });
        if (!snapshot) return null;
        const traceDirectory = join(root, 'context-traces');
        const active = snapshot.turns.at(-1);
        const scanTrace = !entry.options.turnId && (!entry.options.resource || entry.options.resource === 'request-context');
        const [trace, providerLive] = scanTrace ? await Promise.all([
          readProviderTrace(join(traceDirectory, `${id}.jsonl`), entry.trace, entry.options),
          active?.state === 'running' ? readLiveTrace(traceDirectory, id, active.id) : null
        ]) : [{key: null, records: new Map(), error: null}, null];
        if (entry.source !== snapshot || entry.trace?.key !== trace.key || entry.trace?.error !== trace.error) {
          entry.presentation = attachProviderModels(snapshot, trace);
          entry.source = snapshot;
        }
        entry.trace = trace;
        return {
          thread: {id, title: file.title, updated: entry.updated, archived: file.archived},
          ...entry.presentation, providerLive
        };
      });
      entry.queue = next;
      return next;
    }
  };
}
