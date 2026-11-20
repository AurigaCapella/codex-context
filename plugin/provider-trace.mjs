import {open} from 'node:fs/promises';

const maxTraceBytes = 4 * 1024 * 1024;

function label(value) {
  return typeof value === 'string' && value.trim() && value.length <= 240 && !/[\x00-\x1f\x7f]/.test(value)
    ? value.trim() : null;
}

function instructionMessages(items) {
  if (!Array.isArray(items)) return [];
  return items.flatMap(item => {
    if (!['system', 'developer'].includes(item?.role)) return [];
    if (typeof item.content === 'string') return [{role: item.role, content: item.content}];
    if (!Array.isArray(item.content)) return [];
    const content = item.content.filter(part => part?.type === 'input_text' && typeof part.text === 'string')
      .map(part => ({type: 'input_text', text: part.text}));
    return content.length ? [{role: item.role, content}] : [];
  });
}

function toolSchemas(tools, namespace = '') {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap(tool => {
    const name = label(tool?.name);
    if (!name) return [];
    const qualified = namespace ? `${namespace}.${name}` : name;
    if (tool.type === 'namespace') return toolSchemas(tool.tools, qualified);
    const schema = tool.type === 'function' ? tool.parameters : tool.type === 'custom' ? tool.format : null;
    if (schema != null && (typeof schema !== 'object' || Array.isArray(schema))) return [];
    if (!['function', 'custom'].includes(tool.type)) return [];
    return [{name: qualified, type: tool.type, schema: schema ?? null}];
  });
}

function requestContext(event) {
  if (event.capture !== 'user-owned-request') return null;
  const request = event.request;
  if (!request || typeof request !== 'object') return null;
  const instructions = typeof request.instructions === 'string' ? request.instructions : instructionMessages(request.instructions);
  const messages = instructionMessages(request.input);
  const tools = toolSchemas(request.tools);
  return instructions.length || messages.length || tools.length ? {instructions, messages, tools} : null;
}

function requestTiming(value) {
  if (!Number.isSafeInteger(value?.ttft_ms) || value.ttft_ms < 0) return null;
  const textSpanMs = Number.isSafeInteger(value.text_span_ms) && value.text_span_ms > 0 ? value.text_span_ms : null;
  const textTokens = Number.isSafeInteger(value.text_output_tokens) && value.text_output_tokens > 0
    ? value.text_output_tokens : null;
  return {
    ttftMs: value.ttft_ms, textSpanMs,
    textTps: textSpanMs && textTokens ? textTokens * 1000 / textSpanMs : null
  };
}

export function parseProviderTrace(text, {details = true} = {}) {
  const records = new Map();
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'response.completed') continue;
    const id = label(event.response?.id);
    const responseModel = label(event.response?.model);
    if (!id || !responseModel) continue;
    const sentModel = label(event.request?.model);
    const prior = records.get(id);
    if (prior && (prior.responseModel !== responseModel || (prior.sentModel && sentModel && prior.sentModel !== sentModel))) {
      records.set(id, {conflict: true});
    } else {
      const context = details ? requestContext(event) : null;
      const contextConflict = Boolean(prior?.contextConflict || (prior?.context && context &&
        JSON.stringify(prior.context) !== JSON.stringify(context)));
      records.set(id, {
        responseModel, sentModel: sentModel ?? prior?.sentModel ?? null,
        timing: requestTiming(event.timing) ?? prior?.timing ?? null,
        context: contextConflict ? null : context ?? prior?.context ?? null,
        contextConflict
      });
    }
  }
  return records;
}

export async function readProviderTrace(path, previous, options) {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    return {key: null, records: new Map(), error: error.code === 'ENOENT' ? null : '无法读取本地上游记录'};
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) return {key: null, records: new Map(), error: '上游记录必须为文件'};
    const key = [info.ino, info.mtimeMs, info.size].join(':');
    if (previous?.key === key) return previous;
    if (info.size > maxTraceBytes) return {key, records: new Map(), error: '上游记录超过 4 MiB'};
    const bytes = Buffer.alloc(info.size);
    const {bytesRead} = await file.read(bytes, 0, bytes.length, 0);
    return {key, records: parseProviderTrace(bytes.toString('utf8', 0, bytesRead), options), error: null};
  } catch {
    return {key: null, records: new Map(), error: '无法读取本地上游记录'};
  } finally {
    await file.close();
  }
}

export function attachProviderModels(snapshot, trace) {
  let matched = 0;
  let conflicts = 0;
  const turns = snapshot.turns.map(turn => ({
    ...turn,
    steps: turn.steps.map(step => {
      const record = trace.records.get(step.id);
      const conflict = Boolean(record?.conflict ||
        (step.responseModel && record?.responseModel && step.responseModel !== record.responseModel) ||
        (step.sentModel && record?.sentModel && step.sentModel !== record.sentModel));
      if (record) matched++;
      if (conflict) conflicts++;
      return {
        ...step,
        responseModel: step.responseModel || (!conflict ? record?.responseModel ?? null : null),
        sentModel: step.sentModel || (!conflict ? record?.sentModel ?? null : null),
        responseModelSource: step.responseModel ? 'Codex 会话日志' : !conflict && record?.responseModel ? '本地上游记录' : null,
        sentModelSource: step.sentModel ? 'Codex 会话日志' : !conflict && record?.sentModel ? '本地上游记录' : null,
        modelConflict: conflict,
        gatewayTiming: conflict ? null : record?.timing ?? null,
        providerContext: conflict ? null : record?.context ?? null,
        providerContextConflict: !conflict && Boolean(record?.contextConflict)
      };
    })
  }));
  return {...snapshot, turns, providerTrace: {matched, conflicts, version: trace.key, error: trace.error}};
}
