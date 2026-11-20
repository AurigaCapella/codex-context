import {defaultRates, estimateCosts, estimateStep} from './pricing.mjs';

const $ = id => document.getElementById(id);
const integer = new Intl.NumberFormat('zh-CN');
const compact = new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1});
const day = new Intl.DateTimeFormat('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
const absent = '—';
const storedRates = 'codex-context.rates.v1';
let customRates = new Map();
try { customRates = new Map(JSON.parse(localStorage.getItem(storedRates) ?? '[]')); } catch { /* Use defaults. */ }

let threads = [];
let selected = location.hash.slice(1).toLowerCase();
let manualSelection = Boolean(selected);
let data;
let tab = 'context';
let signature = '';
let sidebarSignature = '';
let sequence = 0;
let toastTimer;
const pendingForks = new Set();
let mcpCatalog;
let loadingCatalog = false;

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value != null) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function button(label, action, className = 'button') {
  const node = element('button', label, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function count(value) { return value == null ? absent : integer.format(value); }
function percent(value) { return value == null ? absent : `${(value * 100).toFixed(1)}%`; }
function usd(value) { return value == null ? absent : `$${value.toFixed(value > 0 && value < 0.01 ? 5 : 3)}`; }
function timing(value) { return value == null ? absent : `${(value / 1000).toFixed(2)} s`; }
function cacheRate(usage) { return usage?.input > 0 && usage.cached != null ? usage.cached / usage.input : null; }
function tps(turn) {
  if (!(turn?.outputWindowMs > 0) || turn.usage?.output == null) return absent;
  return `≈ ${(turn.usage.output * 1000 / turn.outputWindowMs).toFixed(1)}`;
}

function rateFor(name) { return customRates.get(name) ?? defaultRates.get(name); }

async function get(path, params = {}, options = {}) {
  const query = new URLSearchParams(params);
  const response = await fetch(`${path}?${query}`, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function toast(message) {
  $('toast').textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 6500);
}

function select(id, manual = true) {
  if (manual) manualSelection = true;
  if (selected === id && data?.thread.id === id) return;
  if (selected !== id) {
    data = null;
    signature = '';
    sequence++;
    selected = id;
    mcpCatalog = null;
    loadingCatalog = false;
    history.replaceState(null, '', id ? `#${id}` : location.pathname);
    render();
    renderSidebar();
  }
  if (id) void loadThread(id);
}

function renderSidebar() {
  const query = $('search').value.trim().toLowerCase();
  const filtered = threads.filter(item => `${item.title ?? ''} ${item.id}`.toLowerCase().includes(query));
  const next = JSON.stringify([filtered, selected]);
  if (next === sidebarSignature) return;
  sidebarSignature = next;
  $('thread-count').textContent = count(filtered.length);
  const elements = filtered.map(item => {
    const row = button(item.title || item.id.slice(0, 8), () => select(item.id), 'thread');
    row.title = item.title ?? item.id;
    if (selected === item.id) row.setAttribute('aria-current', 'true');
    const date = element('time', day.format(item.updated) + (item.archived ? ' · 已归档' : ''));
    date.dateTime = new Date(item.updated).toISOString();
    row.append(date);
    return row;
  });
  $('threads').replaceChildren(...(elements.length ? elements : [element('p', '没有匹配的本机会话', 'empty')]));
}

async function loadThread(id) {
  const version = sequence;
  try {
    const next = await get('/api/thread', {id});
    if (version !== sequence || id !== selected) return;
    const serialized = JSON.stringify(next);
    if (serialized === signature) return;
    signature = serialized;
    data = next;
    render();
  } catch (error) {
    if (!data && version === sequence) $('transcript').replaceChildren(element('p', error.message, 'empty'));
  }
}

async function poll() {
  try {
    threads = await get('/api/threads');
    $('connection').textContent = '本地日志 · 每秒刷新';
    $('connection-dot').classList.add('connected');
    if (!manualSelection && threads[0]?.id && selected !== threads[0].id) select(threads[0].id, false);
    else if (selected) await loadThread(selected);
    renderSidebar();
  } catch {
    $('connection').textContent = '本地服务连接中断';
    $('connection-dot').classList.remove('connected');
  } finally {
    setTimeout(poll, 1000);
  }
}

function messageElement(message) {
  const node = element('div', null, `message ${message.role}`);
  node.append(element('span', message.role === 'user' ? '你' : 'Codex', 'role'), element('p', message.text));
  return node;
}

function usageLabel(usage) {
  if (!usage) return '暂无单轮用量';
  return `输入 ${count(usage.input)} · 输出 ${count(usage.output)} · 缓存 ${count(usage.cached)}`;
}

async function fork(id, turnId) {
  const key = `${id}:${turnId}`;
  if (pendingForks.has(key)) return;
  pendingForks.add(key);
  renderTranscript();
  try {
    const branch = await get('/api/fork', {id}, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-Context-Action': 'fork'},
      body: JSON.stringify({lastTurnId: turnId})
    });
    select(branch.id);
    toast(`已创建分支 ${branch.id.slice(0, 8)}`);
  } catch (error) {
    toast(`分支创建失败 · ${error.message}`);
  } finally {
    pendingForks.delete(key);
    renderTranscript();
  }
}

function renderTranscript() {
  const transcript = $('transcript');
  if (!data) {
    transcript.replaceChildren(element('p', selected ? '正在读取会话…' : '在左侧选择一个会话', 'empty'));
    return;
  }
  const bottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 70;
  const opened = new Set([...transcript.querySelectorAll('details[open]')].map(node => node.dataset.turn));
  const states = {running: '进行中', complete: '已完成', interrupted: '已中断'};
  const turns = data.turns.map((turn, index) => {
    const row = element('article', null, 'turn');
    const head = element('div', null, 'turn-head');
    head.append(element('span', `第 ${index + 1} 轮`), element('span', states[turn.state]));
    row.append(head);
    const commentary = turn.messages.filter(message => message.role === 'assistant' && message.phase === 'commentary');
    const messages = turn.messages.filter(message => !commentary.includes(message));
    row.append(...messages.filter(message => message.role === 'user').map(messageElement));
    if (commentary.length) {
      const details = element('details', null, 'inline');
      details.dataset.turn = turn.id;
      details.open = opened.has(turn.id);
      details.append(element('summary', `过程消息 · ${commentary.length}`), ...commentary.map(messageElement));
      row.append(details);
    }
    row.append(...messages.filter(message => message.role === 'assistant').map(messageElement));
    const action = element('div', null, 'turn-actions');
    const id = data.thread.id;
    const pending = pendingForks.has(`${id}:${turn.id}`);
    const branch = button(pending ? '正在分支…' : '从此轮分支 ↗', () => fork(id, turn.id));
    branch.disabled = pending || turn.state !== 'complete' || data.thread.archived;
    action.append(element('span', usageLabel(turn.usage), 'usage'), branch);
    row.append(action);
    return row;
  });
  transcript.replaceChildren(...(turns.length ? turns : [element('p', '本地日志中暂无轮次', 'empty')]));
  if (bottom) transcript.scrollTop = transcript.scrollHeight;
}

function progress(value, max) {
  const node = element('progress');
  node.max = max;
  node.value = value;
  node.setAttribute('aria-label', '上下文占用');
  return node;
}

function metric(label, value, title) {
  const node = element('div', null, 'metric');
  node.title = title ?? label;
  node.append(element('span', label), element('strong', value));
  return node;
}

function renderMetrics() {
  const latest = data?.turns.at(-1);
  const timed = data?.turns.findLast(turn => turn.ttft != null || turn.firstTextDelayMs != null);
  const firstToken = timed?.ttft != null ? timing(timed.ttft)
    : timed?.firstTextDelayMs != null ? `≈ ${timing(timed.firstTextDelayMs)}` : absent;
  const live = data?.providerLive;
  const prior = timed && timed !== latest ? '上轮 ' : '';
  const cumulative = data?.cumulative;
  const steps = data?.turns.reduce((sum, turn) => sum + turn.steps.length, 0);
  const ratio = data?.windowSize > 0 && data.contextSize != null ? data.contextSize / data.windowSize : null;
  const used = data?.contextSize == null ? absent : compact.format(data.contextSize);
  const context = metric('上下文', ratio == null ? used : `${percent(ratio)} · ${used}`, `${count(data?.contextSize)} / ${count(data?.windowSize)} Token，按最近请求使用量`);
  const estimate = data ? estimateCosts(data.turns, customRates) : null;
  const isPartial = estimate?.usd != null && estimate.priced < estimate.total;
  if (ratio != null) context.append(progress(ratio, 1));
  $('metrics').replaceChildren(
    metric('轮数 / 请求步', data ? `${count(data.turns.length)} / ${count(steps)}` : absent),
    live?.textTps != null ? metric('网关文本 TPS', `≈ ${live.textTps.toFixed(1)}`, '根据上游已返回的可见文本 Token 和接收时间估计')
      : metric(prior + '有效 TPS', tps(timed), '生成中按最近已记账请求，完成后按整轮。包含工具等待。'),
    live?.ttftMs != null ? metric('网关首文本', timing(live.ttftMs), '当前请求从转发到第一个可见文本增量的时间')
      : metric(prior + 'TTFT', firstToken, '≈ 为首段文本日志推算。完成后优先显示 Codex 记录的 TTFT。'),
    metric('累计 Token', count(cumulative?.total), usageLabel(cumulative)),
    metric('缓存命中', percent(cacheRate(cumulative)), '累计缓存读取 Token ÷ 累计输入 Token'),
    metric(isPartial ? 'API 估算（部分）' : 'API 估算', usd(estimate?.usd),
      estimate ? `USD · 已估算 ${estimate.priced} / ${estimate.total} 个请求步` : 'USD'),
    context
  );
}

function card(title) {
  const node = element('section', null, 'card');
  node.append(element('h2', title));
  return node;
}

function field(label, value) {
  const row = element('div', null, 'data-line');
  row.append(element('span', label), element('span', value ?? absent));
  return row;
}

function showDetail(label, value) {
  $('detail-title').textContent = label;
  $('detail-body').textContent = value;
  if (!$('detail').open) $('detail').showModal();
}

async function detail(path, label, params, format) {
  try { showDetail(label, format(await get(path, params))); }
  catch (error) { toast(error.message); }
}

async function inspectStep(step) {
  const model = (value, source) => value ? [value, source].filter(Boolean).join(' · ') : '日志未记录';
  const id = data.thread.id;
  const title = `请求步 ${step.label}`;
  const cost = estimateStep(step, {model: step.configured}, customRates);
  const summary = [
    `响应 ID  ${step.id ?? absent}`,
    `配置模型  ${step.configured ?? absent}`,
    `请求模型  ${model(step.sentModel, step.sentModelSource)}`,
    `响应模型  ${model(step.responseModel, step.responseModelSource)}`,
    step.gatewayTiming ? `网关首段文本  ${timing(step.gatewayTiming.ttftMs)}` : '',
    step.gatewayTiming?.textSpanMs ? `网关文本流跨度  ${timing(step.gatewayTiming.textSpanMs)}` : '',
    step.gatewayTiming?.textTps ? `网关可见文本 TPS  ≈ ${step.gatewayTiming.textTps.toFixed(1)}` : '',
    step.modelConflict ? '本地上游记录与会话记录不一致。' : '',
    step.providerContextConflict ? '同一响应 ID 有不一致的请求快照。' : '',
    '',
    usageLabel(step.usage),
    cost ? `API 估算  ${usd(cost.usd)} · ${cost.tier}` : 'API 估算  无可用费率或用量',
    `缓存写入 ${count(step.usage.cacheWrite)} · 推理 Token ${count(step.usage.reasoning)} · 合计 ${count(step.usage.total)}`
  ].join('\n');
  showDetail(title, summary);
  if (!step.hasProviderContext) return;
  try {
    const context = await get('/api/request-context', {id, turn: step.turnId, response: step.id});
    if (selected === id && $('detail').open && $('detail-title').textContent === title && $('detail-body').textContent === summary) {
      $('detail-body').textContent = [
        summary, '', '来源 · 自管网关的用户提供记录', '',
        '请求指令', typeof context.instructions === 'string' ? context.instructions : JSON.stringify(context.instructions, null, 2), '',
        'system / developer 文本消息', JSON.stringify(context.messages, null, 2), '',
        '函数与自定义工具 Schema', JSON.stringify(context.tools, null, 2)
      ].join('\n');
    }
  } catch (error) { if (selected === id) toast(error.message); }
}

function contextPanel() {
  const latest = data.turns.at(-1);
  const models = card('模型');
  const reportedModels = [...new Set(data.turns.flatMap(turn => turn.steps.map(step => step.responseModel).filter(Boolean)))];
  const sentModels = [...new Set(data.turns.flatMap(turn => turn.steps.map(step => step.sentModel).filter(Boolean)))];
  models.append(
    field('配置模型', latest?.model ?? data.model),
    field('服务商', data.provider),
    field('请求模型', sentModels.join(' / ') || '日志未记录'),
    field('响应模型', reportedModels.join(' / ') || '日志未记录'),
    field('最近轮改派', latest?.rerouted)
  );
  if (data.providerTrace?.matched) models.append(field('上游记录', `已匹配 ${data.providerTrace.matched} 步`));
  if (data.providerLive?.responseModel) models.append(field('流式响应模型', data.providerLive.responseModel));
  if (data.providerTrace?.error) models.append(element('p', data.providerTrace.error, 'muted'));

  const instructions = card('指令');
  instructions.append(data.hasInstructions
    ? button('查看本地 AGENTS.md 指令快照', () => detail('/api/instructions', 'AGENTS.md 指令快照', {id: data.thread.id}, result => result.text), 'item-button')
    : element('p', '此会话没有 AGENTS.md 指令快照。', 'muted'));
  instructions.append(button('查看当前配置的指令文件', () => detail(
    '/api/configured-instructions', '当前配置的指令文件', {id: data.thread.id},
    result => result.text == null ? '当前本地配置未设置用户或工作区的 model_instructions_file。' : `${result.path}\n\n${result.text}`
  ), 'item-button'));
  instructions.append(element('p', '服务端完整系统提示词未公开。', 'muted'));

  const history = card('上下文变化');
  const steps = data.turns.flatMap((turn, index) => turn.steps.map((step, n) => ({
    ...step, label: `${index + 1}.${n + 1}`, configured: turn.model, turnId: turn.id
  }))).slice(-12);
  const max = data.windowSize || Math.max(1, ...steps.map(step => (step.usage.input ?? 0) + (step.usage.output ?? 0)));
  for (const step of steps) {
    const row = element('div', null, 'step');
    const used = step.usage.input != null && step.usage.output != null ? step.usage.input + step.usage.output : null;
    row.append(button(step.label, () => inspectStep(step), 'quiet'));
    if (used != null) row.append(progress(used, max));
    row.append(field('窗口用量', count(used)));
    history.append(row);
  }
  if (!steps.length) history.append(element('p', '暂无请求用量', 'muted'));
  for (const event of data.events.slice(-5).reverse()) {
    history.append(field(event.type, event.detail ?? (event.at ? day.format(new Date(event.at)) : absent)));
  }
  if (data.corrupt) history.append(element('p', `已跳过 ${data.corrupt} 条无法解析的日志记录`, 'muted'));
  return [models, instructions, history];
}

async function loadMcpCatalog(id) {
  loadingCatalog = true;
  renderPanel();
  try {
    const result = await get('/api/mcp-schemas', {id}, {
      method: 'POST', headers: {'X-Context-Action': 'list-mcp-schemas'}
    });
    if (selected === id) mcpCatalog = result;
  } catch (error) {
    if (selected === id) toast(error.message);
  } finally {
    if (selected === id) {
      loadingCatalog = false;
      if (tab === 'schema') renderPanel();
    }
  }
}

function renderPanel() {
  const panel = $('panel');
  const before = panel.scrollTop;
  if (!data) {
    panel.replaceChildren(element('p', '选择会话后检查上下文。', 'empty'));
    return;
  }
  const id = data.thread.id;
  if (tab === 'context') panel.replaceChildren(...contextPanel());
  if (tab === 'tools') {
    const groups = data.turns.map((turn, index) => ({turn, index})).filter(({turn}) => turn.calls.length);
    const content = groups.reverse().map(({turn, index}) => {
      const group = card(`第 ${index + 1} 轮`);
      for (const call of turn.calls) {
        const row = button(call.name, () => detail('/api/call', call.name, {id, turn: turn.id, call: call.id, source: call.source}, result => JSON.stringify(result.details, null, 2)), 'item-button');
        row.append(element('small', call.source === 'item' ? 'Codex 执行记录' : '模型请求 / 工具返回'));
        group.append(row);
      }
      return group;
    });
    panel.replaceChildren(...(content.length ? content : [element('p', '暂无工具调用记录', 'empty')]));
  }
  if (tab === 'schema') {
    const schemas = card('会话留存的输入 Schema');
    for (const name of data.schemaNames) {
      schemas.append(button(name, () => detail('/api/schema', name, {id, name}, result => JSON.stringify(result.schema, null, 2)), 'item-button'));
    }
    if (!data.schemaNames.length) schemas.append(element('p', '此会话没有留存工具 Schema。', 'muted'));
    const configured = card('已配置 MCP 的 Schema');
    const refresh = button(loadingCatalog ? '查询中…' : '查询工具定义', () => loadMcpCatalog(id));
    refresh.disabled = loadingCatalog;
    configured.append(refresh);
    if (mcpCatalog) {
      configured.append(element('p', `${mcpCatalog.scope === 'workspace' ? '当前本地配置' : '本机配置'} · ${mcpCatalog.tools.length} 项`, 'muted'));
      for (const tool of mcpCatalog.tools) {
        const label = `${tool.server} / ${tool.name}`;
        configured.append(button(label, () => showDetail(label, JSON.stringify({
          inputSchema: tool.inputSchema, outputSchema: tool.outputSchema
        }, null, 2)), 'item-button'));
      }
      if (mcpCatalog.unavailable.length) configured.append(element('p', `无法查询 · ${mcpCatalog.unavailable.join('、')}`, 'muted'));
    }
    panel.replaceChildren(schemas, configured);
  }
  panel.scrollTop = before;
}

function render() {
  $('thread-title').textContent = data?.thread.title || data?.thread.id || 'Codex Context';
  $('breadcrumb').textContent = data?.meta.cwd || '本机会话';
  $('open-codex').disabled = !data;
  renderTranscript();
  renderMetrics();
  renderPanel();
}

function rateModel() { return $('rates-form').elements.model.value.trim(); }
function loadRates() {
  const rate = rateFor(rateModel());
  for (const key of ['input', 'cached', 'output', 'cacheWrite']) $('rates-form').elements[key].value = rate?.[key] ?? '';
  $('rate-status').textContent = customRates.has(rateModel()) ? '自定义费率' :
    rate ? '默认 API Standard 短上下文费率' : '此模型需要填写费率';
}

function storeRates() {
  try {
    localStorage.setItem(storedRates, JSON.stringify([...customRates]));
  } catch {
    toast('当前浏览器无法保存费率，刷新后会恢复。');
  }
  renderMetrics();
}

$('search').addEventListener('input', renderSidebar);
$('open-codex').addEventListener('click', () => { if (data) location.href = `codex://threads/${data.thread.id}`; });
document.querySelectorAll('[data-tab]').forEach(control => control.addEventListener('click', () => {
  tab = control.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-pressed', String(button === control)));
  $('panel').scrollTop = 0;
  renderPanel();
}));
$('settings').addEventListener('click', () => {
  $('rates-form').elements.model.value = data?.turns.at(-1)?.model ?? data?.model ?? '';
  loadRates();
  $('rates-dialog').showModal();
});
$('rates-form').elements.model.addEventListener('change', loadRates);
$('close-rates').addEventListener('click', () => $('rates-dialog').close());
$('delete-rate').addEventListener('click', () => {
  customRates.delete(rateModel());
  storeRates();
  loadRates();
});
$('rates-form').addEventListener('submit', event => {
  event.preventDefault();
  const model = rateModel();
  if (!model) return;
  const fields = $('rates-form').elements;
  customRates.set(model, {
    input: fields.input.valueAsNumber, cached: fields.cached.valueAsNumber, output: fields.output.valueAsNumber,
    cacheWrite: fields.cacheWrite.value === '' ? null : fields.cacheWrite.valueAsNumber
  });
  storeRates();
  $('rates-dialog').close();
});
window.addEventListener('hashchange', () => select(location.hash.slice(1).toLowerCase()));
render();
void poll();
