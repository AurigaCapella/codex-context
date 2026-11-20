import {watch} from 'node:fs';
import {join} from 'node:path';
import {rolloutId, threadIdPattern} from './sessions.mjs';

export function createNotifications(root, invalidateIndex) {
  const clients = new Set();
  const watchers = new Map();
  const folders = ['sessions', 'archived_sessions', 'context-traces'];
  let flush;
  let heartbeat;

  function send(response, event) {
    if (!response.write(event)) response.destroy();
  }

  function queue(topic, id) {
    for (const client of clients) {
      if (id && client.id !== id) continue;
      client.pending.add(topic);
    }
    if (!flush && [...clients].some(client => client.pending.size)) {
      flush = setTimeout(() => {
        flush = undefined;
        for (const {response, pending} of clients) {
          if (!pending.size) continue;
          send(response, `data: ${JSON.stringify([...pending])}\n\n`);
          pending.clear();
        }
      }, 160).unref();
    }
  }

  function changed(folder, event, file) {
    if (!file) {
      invalidateIndex();
      queue('refresh');
      return;
    }
    if (!folder) {
      if (file === 'config.toml') queue('appearance');
      if (file === 'session_index.jsonl' || folders.slice(0, 2).includes(file)) {
        invalidateIndex();
        queue('threads');
      }
      if (folders.includes(file) && event === 'rename') {
        watchers.get(file)?.close();
        watchers.delete(file);
        attach(file);
        queue('refresh');
      }
      return;
    }
    if (folder === 'context-traces') {
      const parts = file.split(/[\\/]/);
      const id = parts[0] === 'live' ? parts[1] : parts[0].replace(/\.jsonl$/i, '');
      if (id && threadIdPattern.test(id)) queue('metrics', id.toLowerCase());
      return;
    }
    const id = rolloutId(file);
    if (id) queue('metrics', id);
    if (event === 'rename') {
      invalidateIndex();
      queue('threads');
    }
  }

  function attach(folder) {
    if (watchers.has(folder)) return;
    try {
      const watcher = watch(join(root, folder), {recursive: Boolean(folder)}, (event, file) => changed(folder, event, file));
      watcher.on('error', () => {
        watcher.close();
        watchers.delete(folder);
        queue('refresh');
      });
      watchers.set(folder, watcher);
    } catch {
      // Some of the directories do not exist until the first session or trace.
    }
  }

  function stopWatching() {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    clearInterval(heartbeat);
    clearTimeout(flush);
    heartbeat = flush = undefined;
  }

  return {
    subscribe(response, id) {
      const client = {response, id, pending: new Set()};
      clients.add(client);
      response.once('close', () => {
        clients.delete(client);
        if (!clients.size) stopWatching();
      });
      if (clients.size === 1) {
        invalidateIndex();
        heartbeat = setInterval(() => {
          for (const listener of clients) send(listener.response, ': keepalive\n\n');
        }, 20000).unref();
      }
      for (const folder of ['', ...folders]) attach(folder);
      response.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8'});
      send(response, 'data: ["refresh"]\n\n');
    },
    close() {
      stopWatching();
      for (const {response} of clients) response.end();
      clients.clear();
    }
  };
}
