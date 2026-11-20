import {createServer, request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {appendFile, mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {threadIdPattern} from './sessions.mjs';
import {startLiveTrace} from './live-provider-trace.mjs';

const hopHeaders = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function headersForProxy(headers) {
  const named = new Set((headers.connection ?? '').split(',').map(name => name.trim().toLowerCase()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !hopHeaders.has(name) && !named.has(name)));
}

function conversationIds(headers) {
  let meta;
  try { meta = JSON.parse(headers['x-codex-turn-metadata'] ?? '{}'); } catch { meta = {}; }
  const fallback = typeof meta?.thread_id === 'string' ? meta.thread_id.toLowerCase() : null;
  const header = typeof headers['thread-id'] === 'string' ? headers['thread-id'].toLowerCase() : null;
  if (header && fallback && header !== fallback) return {};
  const id = header ?? fallback;
  const turnId = typeof meta?.turn_id === 'string' && threadIdPattern.test(meta.turn_id)
    ? meta.turn_id.toLowerCase() : null;
  return threadIdPattern.test(id ?? '') ? {id, turnId} : {};
}

function observeText(onLine) {
  const decoder = new TextDecoder();
  let pending = '';
  let oversized = false;
  return chunk => {
    const next = pending + decoder.decode(chunk, {stream: true});
    let start = 0;
    for (let newline = next.indexOf('\n'); newline >= 0; newline = next.indexOf('\n', start)) {
      if (!oversized && newline - start <= 8 * 1024 * 1024) onLine(next.slice(start, newline).replace(/\r$/, ''));
      oversized = false;
      start = newline + 1;
    }
    pending = next.slice(start);
    if (pending.length > 8 * 1024 * 1024) { pending = ''; oversized = true; }
  };
}

function streamObserver(started, live) {
  let data = [];
  let eventSize = 0;
  let first = null;
  let last = null;
  let completed = null;
  let textTokenCount = 0;
  const feed = observeText(line => {
    if (line.startsWith('data:')) {
      eventSize += line.length;
      if (eventSize <= 8 * 1024 * 1024) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (line !== '') return;
    try {
      if (eventSize > 8 * 1024 * 1024 || !data.length) return;
      const event = JSON.parse(data.join('\n'));
      if (event?.type === 'response.created') {
        live?.update({responseId: event.response?.id, responseModel: event.response?.model});
      }
      if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta.length) {
        const now = performance.now();
        first ??= now;
        last = now;
        const counts = event.logprobs;
        if (textTokenCount != null && Array.isArray(counts) && counts.length && counts.every(item => typeof item?.token === 'string')) {
          textTokenCount += counts.length;
        } else {
          textTokenCount = null;
        }
        live?.update({
          ttftMs: Math.max(0, Math.round(first - started)),
          textTps: textTokenCount && last - first >= 1 ? textTokenCount * 1000 / (last - first) : null
        });
      }
      if (event?.type === 'response.completed') completed = event.response;
    } catch { /* The relay forwards unrecognized events unchanged. */ }
    finally { data = []; eventSize = 0; }
  });
  return {
    feed,
    result() {
      if (typeof completed?.id !== 'string' || typeof completed?.model !== 'string') return null;
      const timing = first == null ? null : {
        ttft_ms: Math.max(0, Math.round(first - started)),
        text_span_ms: last > first ? Math.round(last - first) : null,
        text_output_tokens: textOnlyOutputTokens(completed)
      };
      return {response: {id: completed.id, model: completed.model}, timing};
    }
  };
}

function textOnlyOutputTokens(response) {
  const usage = response.usage;
  if (usage?.output_tokens_details?.reasoning_tokens !== 0 ||
      !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 1) return null;
  if (!Array.isArray(response.output) || !response.output.length) return null;
  const onlyText = response.output.every(item => item?.type === 'message' && item.role === 'assistant' &&
    Array.isArray(item.content) && item.content.length > 0 && item.content.every(part => part?.type === 'output_text'));
  return onlyText ? usage.output_tokens : null;
}

function tap(observe) {
  return new Transform({transform(chunk, encoding, done) {
    observe(chunk);
    done(null, chunk);
  }});
}

export function createTraceRelay({upstream, traceDirectory}) {
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error('上游地址必须为不含账号、查询参数或片段的 HTTP(S) base URL');
  }
  target.pathname = target.pathname.replace(/\/+$/, '') + '/responses';
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return createServer((input, output) => {
    if (input.method !== 'POST' || input.url !== '/v1/responses' || input.headers.origin) {
      output.writeHead(404).end();
      return;
    }
    const {id, turnId} = conversationIds(input.headers);
    const body = [];
    let bodySize = 0;
    const captureBody = tap(chunk => {
      if (!id) return;
      bodySize += chunk.length;
      if (bodySize <= 8 * 1024 * 1024) body.push(chunk);
    });
    const started = performance.now();
    const options = {method: 'POST', headers: {...headersForProxy(input.headers), 'accept-encoding': 'identity'}};
    const request = send(target, options, async upstreamResponse => {
      const isStream = id && upstreamResponse.statusCode === 200 &&
        /^text\/event-stream\b/i.test(upstreamResponse.headers['content-type'] ?? '') &&
        [undefined, 'identity'].includes(upstreamResponse.headers['content-encoding']);
      let model = null;
      if (isStream && bodySize <= 8 * 1024 * 1024) {
        try {
          const value = JSON.parse(Buffer.concat(body).toString('utf8')).model;
          if (typeof value === 'string') model = value;
        } catch { /* No request model was recorded. */ }
      }
      body.length = 0;
      const live = isStream && turnId ? startLiveTrace(traceDirectory, id, turnId, model) : null;
      const observer = isStream ? streamObserver(started, live) : null;
      output.writeHead(upstreamResponse.statusCode, headersForProxy(upstreamResponse.headers));
      try {
        if (!observer) { await pipeline(upstreamResponse, output); return; }
        await pipeline(upstreamResponse, tap(observer.feed), output);
        const record = observer.result();
        if (!record) return;
        await mkdir(traceDirectory, {recursive: true});
        await appendFile(join(traceDirectory, `${id}.jsonl`), JSON.stringify({
          type: 'response.completed', request: {model}, ...record
        }) + '\n', 'utf8');
      } catch {
        if (!output.destroyed) output.destroy();
        if (observer && output.writableFinished) console.error('无法写入本地上游记录');
      } finally { await live?.close(); }
    });
    request.on('error', () => {
      if (!output.headersSent && !output.destroyed) output.writeHead(502).end();
      else output.destroy();
    });
    output.on('close', () => { if (!output.writableFinished) request.destroy(); });
    pipeline(input, captureBody, request).catch(() => request.destroy());
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const {values} = parseArgs({options: {
    upstream: {type: 'string'}, port: {type: 'string', default: '47372'}
  }});
  const port = Number(values.port);
  if (!values.upstream || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('用法：node trace-relay.mjs --upstream https://gateway.example/v1 [--port 47372]');
  }
  const traceDirectory = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'context-traces');
  createTraceRelay({upstream: values.upstream, traceDirectory}).listen(port, '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${port}/v1`);
  });
}
