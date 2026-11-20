import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {createSessions, threadIdPattern} from './sessions.mjs';
import {withAppServer} from './app-server.mjs';
import {configuredInstructions, configuredSchemas} from './local-inspection.mjs';
import {estimateCosts, estimateStep} from './ui/pricing.mjs';
import {createAppearance} from './appearance.mjs';
import {createNotifications} from './notifications.mjs';

const {values} = parseArgs({options: {port: {type: 'string', default: '47371'}}});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const sessions = createSessions(codexHome);
const readAppearance = createAppearance(codexHome);
const notifications = createNotifications(codexHome, sessions.invalidate);
const inProgress = new Set();
const catalogRequests = new Map();
const estimates = new WeakMap();
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/pricing.mjs': ['pricing.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};

function json(response, code, data) {
  response.writeHead(code, {'Content-Type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(data));
}

function metrics(snapshot) {
  const {thread, turns, cumulative, contextSize, windowSize, providerLive, providerTrace} = snapshot;
  const latest = turns.at(-1);
  const timed = turns.findLast(turn => turn.ttft != null || turn.firstTextDelayMs != null);
  if (!estimates.has(turns)) estimates.set(turns, estimateCosts(turns));
  return {
    thread, cumulative, contextSize, windowSize, providerLive,
    revision: JSON.stringify([thread.id, thread.updated, thread.title, thread.archived, providerTrace.version, providerTrace.error, providerLive]),
    roundCount: turns.length, latestTurnId: latest?.id, latestState: latest?.state,
    timing: timed && {
      id: timed.id, ttft: timed.ttft, firstTextDelayMs: timed.firstTextDelayMs,
      outputWindowMs: timed.outputWindowMs, output: timed.usage?.output
    },
    apiEstimate: estimates.get(turns)
  };
}

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function route(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (request.headers.host !== host || request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && request.headers.origin !== origin)) {
    return json(response, 403, {error: '仅接受本机同源请求'});
  }
  const url = new URL(request.url, origin);
  const path = url.pathname;
  if (request.method === 'GET' && Object.hasOwn(assets, path)) {
    const [file, type] = assets[path];
    const content = await readFile(new URL(`./ui/${file}`, import.meta.url));
    response.writeHead(200, {'Content-Type': type});
    return response.end(content);
  }
  if (request.method === 'GET' && path === '/api/health') {
    return json(response, 200, {service: 'codex-context'});
  }
  if (request.method === 'POST' && path === '/api/stop') {
    if (request.headers.origin !== origin || request.headers['x-context-action'] !== 'stop') {
      return json(response, 403, {error: '请求来源不匹配'});
    }
    json(response, 200, {stopping: true});
    notifications.close();
    return server.close();
  }
  if (request.method === 'GET' && path === '/api/threads') {
    return json(response, 200, await sessions.list());
  }
  if (request.method === 'GET' && path === '/api/appearance') {
    return json(response, 200, await readAppearance());
  }
  if (request.method === 'GET' && path === '/api/events') {
    const id = url.searchParams.get('id')?.toLowerCase();
    if (id && !threadIdPattern.test(id)) return json(response, 400, {error: '无效的会话 ID'});
    return notifications.subscribe(response, id);
  }

  const id = url.searchParams.get('id')?.toLowerCase();
  if (!id || !threadIdPattern.test(id)) return json(response, 404, {error: '未找到会话'});
  const turnId = url.searchParams.get('turn');
  const callId = url.searchParams.get('call');
  if ((path === '/api/turn' || path === '/api/call-preview' || path === '/api/call') &&
      (!turnId || ((path === '/api/call' || path === '/api/call-preview') && !callId))) {
    return json(response, 404, {error: '未找到轮次或工具调用'});
  }
  const options = {
    '/api/thread-metrics': {details: false},
    '/api/thread-summary': {summary: true},
    '/api/turn': {turnId},
    '/api/call': {turnId, callId},
    '/api/call-preview': {turnId, callId},
    '/api/instructions': {resource: 'instructions'},
    '/api/schema': {resource: 'schema', schemaName: url.searchParams.get('name')},
    '/api/request-context': {resource: 'request-context'},
    '/api/configured-instructions': {details: false},
    '/api/mcp-schemas': {details: false},
    '/api/fork': {details: false}
  };
  const snapshot = await sessions.read(id, options[path]);
  if (!snapshot) return json(response, 404, {error: '本地会话不存在'});
  if (request.method === 'GET' && path === '/api/thread-metrics') {
    return json(response, 200, metrics(snapshot));
  }
  if (request.method === 'GET' && (path === '/api/thread' || path === '/api/thread-summary')) {
    const {instructions, schemas, turns, ...summary} = snapshot;
    return json(response, 200, {
      ...summary, hasInstructions: Boolean(instructions), schemaNames: schemas.map(([name]) => name),
      ...metrics(snapshot),
      turns: turns.map(turn => ({
        ...turn,
        calls: turn.calls.map(({details, ...call}) => call),
        steps: turn.steps.map(({providerContext, ...step}) => ({
          ...step, hasProviderContext: step.hasProviderContext ?? Boolean(providerContext), apiEstimate: estimateStep(step, turn)
        }))
      }))
    });
  }
  if (request.method === 'GET' && path === '/api/turn') {
    const turn = snapshot.turns.find(item => item.id === turnId);
    return turn ? json(response, 200, {messages: turn.messages}) : json(response, 404, {error: '未找到轮次'});
  }
  if (request.method === 'GET' && path === '/api/request-context') {
    const responseId = url.searchParams.get('response');
    const turn = snapshot.turns.find(item => item.id === turnId);
    const step = responseId ? turn?.steps.find(item => item.id === responseId) : null;
    return step?.providerContext
      ? json(response, 200, step.providerContext)
      : json(response, 404, {error: '该请求没有匹配的本地指令或工具定义记录'});
  }
  if (request.method === 'GET' && path === '/api/instructions') {
    return json(response, 200, {text: snapshot.instructions});
  }
  if (request.method === 'GET' && path === '/api/configured-instructions') {
    return json(response, 200, await configuredInstructions(snapshot.meta.cwd));
  }
  if (request.method === 'POST' && path === '/api/mcp-schemas') {
    if (request.headers.origin !== origin || request.headers['x-context-action'] !== 'list-mcp-schemas') {
      return json(response, 403, {error: '请求来源不匹配'});
    }
    const cwd = snapshot.meta.cwd;
    if (!catalogRequests.has(cwd)) {
      catalogRequests.set(cwd, configuredSchemas(cwd).finally(() => catalogRequests.delete(cwd)));
    }
    return json(response, 200, await catalogRequests.get(cwd));
  }
  if (request.method === 'GET' && path === '/api/schema') {
    const match = snapshot.schemas.find(([name]) => name === url.searchParams.get('name'));
    return match ? json(response, 200, {schema: match[1]}) : json(response, 404, {error: '缺少本地 Schema'});
  }
  if (request.method === 'GET' && (path === '/api/call' || path === '/api/call-preview')) {
    const turn = snapshot.turns.find(turn => turn.id === turnId);
    const call = turn?.calls?.find(call => call.id === callId && call.source === url.searchParams.get('source'));
    if (!call) return json(response, 404, {error: '未找到调用'});
    if (path === '/api/call') return json(response, 200, call);
    const value = JSON.stringify(call.details, null, 2) ?? '';
    return json(response, 200, {text: value.slice(0, 8192), truncated: value.length > 8192});
  }
  if (request.method === 'POST' && path === '/api/fork') {
    if (request.headers.origin !== origin || request.headers['x-context-action'] !== 'fork') {
      return json(response, 403, {error: '分支操作须由同源面板发起'});
    }
    const {lastTurnId} = await body(request);
    if (snapshot.thread.archived || !snapshot.turns.some(turn => turn.id === lastTurnId && turn.state === 'complete')) {
      return json(response, 409, {error: '只能从未归档会话中的已完成轮次创建分支'});
    }
    const key = `${id}:${lastTurnId}`;
    if (inProgress.has(key)) return json(response, 409, {error: '正在创建分支'});
    inProgress.add(key);
    try {
      const branch = await withAppServer(rpc => rpc('thread/fork', {threadId: id, lastTurnId, excludeTurns: true}));
      return json(response, 201, {id: branch.thread.id});
    } finally {
      inProgress.delete(key);
    }
  }
  return json(response, 404, {error: '未找到页面'});
}

const server = createServer((request, response) => {
  route(request, response).catch(error => {
    if (!response.headersSent) json(response, 500, {error: error.message});
    else response.destroy();
  });
});
server.listen(port, '127.0.0.1', () => console.log(origin));
