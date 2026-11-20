const counterFields = {
  input: 'input_tokens',
  cached: 'cached_input_tokens',
  cacheWrite: 'cache_write_input_tokens',
  output: 'output_tokens',
  reasoning: 'reasoning_output_tokens',
  total: 'total_tokens'
};

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usage(raw) {
  if (!raw) return null;
  return Object.fromEntries(Object.entries(counterFields).map(([key, field]) => [key, count(raw[field])]));
}

function delta(now, previous) {
  if (!now) return null;
  if (!previous) return now;
  if (Object.keys(now).some(key => now[key] != null && previous[key] != null && now[key] < previous[key])) return null;
  return Object.fromEntries(Object.keys(now).map(key => [
    key, now[key] != null && previous[key] != null ? now[key] - previous[key] : null
  ]));
}

function text(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

function makeTurn(id, baseline, model, details) {
  return {
    id, state: 'running', model, baseline, usage: null, sampledUsage: null,
    steps: [], messages: details ? new Map() : null, calls: details ? new Map() : null, ttft: null, duration: null,
    startedAtMs: null, firstTextAtMs: null, lastUsageAtMs: null
  };
}

function timestamp(at) {
  const date = Date.parse(at);
  return Number.isFinite(date) ? date : null;
}

const callTypes = new Set([
  'CommandExecution', 'FileChange', 'McpToolCall', 'DynamicToolCall', 'ImageView',
  'WebSearch', 'ImageGeneration', 'CollabAgentToolCall', 'Extension'
]);
const rawCall = /^(function|custom_tool|local_shell|web_search|image_generation|computer)_call$/;
const rawResult = /^(function|custom_tool|computer)_call_output$/;

function itemDetails(item) {
  const {type, id, ...details} = item;
  return details;
}

function schemaEntries(tools, prefix = '') {
  const entries = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool.name ?? tool.function?.name;
    const path = [prefix, name].filter(Boolean).join('.');
    const schema = tool.parameters ?? tool.inputSchema ?? tool.input_schema ?? tool.function?.parameters;
    if (path && schema && typeof schema === 'object') entries.push({name: path, schema});
    if (Array.isArray(tool.tools)) entries.push(...schemaEntries(tool.tools, path));
  }
  return entries;
}

function expandTools(source) {
  if (Array.isArray(source)) return schemaEntries(source);
  if (!source || typeof source !== 'object') return [];
  return Object.entries(source).flatMap(([name, value]) => {
    let raw = value;
    if (typeof raw === 'string' && raw.startsWith('{')) {
      try { raw = JSON.parse(raw); } catch { return []; }
    }
    if (!raw || typeof raw !== 'object') return [];
    if (raw.type === 'object' && raw.properties) return [{name, schema: raw}];
    return schemaEntries([{name, ...raw}]);
  });
}

export function createRollout({details = true} = {}) {
  const turns = new Map();
  const schemas = new Map();
  const orphanOutputs = new Map();
  const owners = new Map();
  const events = [];
  let meta = {};
  let current = null;
  let model = null;
  let provider = null;
  let instructions = null;
  let cumulative = null;
  let contextSize = null;
  let windowSize = null;
  let latestCount = null;
  let corrupt = 0;

  function getTurn(id) {
    if (!id) return current;
    if (!turns.has(id)) turns.set(id, makeTurn(id, cumulative, model, details));
    return turns.get(id);
  }

  function saveSchemas(entries) {
    for (const entry of entries) schemas.set(entry.name, entry.schema);
  }

  function onUsage(p, at, responseModel) {
    const turn = getTurn(p.turn_id);
    if (!turn) return;
    const last = usage(p.usage);
    if (last && !turn.steps.some(step => p.response_id && step.id === p.response_id)) {
      turn.steps.push({id: p.response_id, at, usage: last, responseModel, sentModel: p.sent_model ?? null});
      turn.lastUsageAtMs = timestamp(at) ?? turn.lastUsageAtMs;
    }
    turn.usage = usage(p.turn_token_usage) ?? turn.usage;
    cumulative = usage(p.thread_token_usage) ?? cumulative;
    if (last?.input != null && last.output != null) contextSize = last.input + last.output;
  }

  function onEvent(p, at) {
    const turn = getTurn(p.turn_id);
    switch (p.type) {
      case 'task_started':
      case 'turn_started':
        if (turn) {
          current = turn;
          turn.at = at;
          turn.startedAtMs = timestamp(at);
          turn.state = 'running';
          turn.baseline = cumulative;
        }
        windowSize = count(p.model_context_window) ?? windowSize;
        break;
      case 'task_complete':
      case 'turn_completed':
      case 'turn_aborted':
        if (turn) {
          turn.state = p.type === 'turn_aborted' ? 'interrupted' : 'complete';
          turn.ttft = count(p.time_to_first_token_ms);
          turn.duration = count(p.duration_ms);
          if (details && p.last_agent_message && ![...turn.messages.values()].some(message => message.role === 'assistant' && message.text === p.last_agent_message)) {
            turn.messages.set('final', {role: 'assistant', text: p.last_agent_message, phase: 'final_answer'});
          }
        }
        break;
      case 'token_count': {
        const total = usage(p.info?.total_token_usage);
        const last = usage(p.info?.last_token_usage);
        windowSize = count(p.info?.model_context_window) ?? windowSize;
        if (!last || !total) break;
        if (last.input != null && last.output != null) {
          contextSize = last.input + last.output + (p.info?.last_usage_includes_reasoning === false ? last.reasoning ?? 0 : 0);
        }
        const signature = JSON.stringify(total);
        if (signature === latestCount) break;
        latestCount = signature;
        if (turn) {
          turn.sampledUsage = delta(total, turn.baseline);
          turn.sampledSteps ??= [];
          turn.sampledSteps.push({at, usage: last});
          if (turn.steps.length === 0) turn.lastUsageAtMs = timestamp(at) ?? turn.lastUsageAtMs;
        }
        cumulative = total;
        break;
      }
      case 'thread_settings_applied':
        model = p.thread_settings?.model ?? model;
        provider = p.thread_settings?.model_provider_id ?? provider;
        break;
      case 'model_rerouted':
      case 'model_reroute':
        if (turn) turn.rerouted = p.to_model ?? p.toModel ?? null;
        if (details) events.push({at, type: '模型改派', turnId: turn?.id, detail: p.to_model ?? p.toModel});
        break;
      case 'item_started':
      case 'item_completed': {
        if (!turn || !p.item) break;
        const item = p.item;
        if (item.type === 'AgentMessage' && count(p.started_at_ms) != null) {
          turn.firstTextAtMs = Math.min(turn.firstTextAtMs ?? Infinity, p.started_at_ms);
        }
        if (!details) break;
        if (p.type === 'item_completed' && ['UserMessage', 'AgentMessage'].includes(item.type)) {
          const role = item.type === 'UserMessage' ? 'user' : 'assistant';
          turn.messages.set(item.id, {role, text: text(item.content), phase: item.phase});
        } else if (callTypes.has(item.type)) {
          turn.calls.set(`item:${item.id}`, {id: item.id, name: item.tool ?? item.type, source: 'item', at, details: itemDetails(item)});
        }
        break;
      }
      case 'agent_message':
      case 'user_message': {
        if (!details || !turn || typeof p.message !== 'string') break;
        const role = p.type === 'agent_message' ? 'assistant' : 'user';
        if (![...turn.messages.values()].some(message => message.role === role && message.text === p.message)) {
          turn.messages.set(`message:${turn.messages.size}`, {role, text: p.message, phase: p.phase});
        }
        break;
      }
      case 'context_compacted':
        if (details) events.push({at, type: '上下文压缩', turnId: turn?.id});
        break;
      case 'thread_rolled_back': {
        const ids = [...turns.keys()];
        const amount = count(p.num_turns) ?? 0;
        for (const id of ids.slice(Math.max(0, ids.length - amount))) turns.delete(id);
        current = [...turns.values()].at(-1) ?? null;
        break;
      }
    }
  }

  function onResponse(p, at) {
    if (p.type === 'additional_tools') saveSchemas(schemaEntries(p.tools));
    if (!current) return;
    if (p.type === 'message' && p.role === 'assistant') {
      const content = text(p.content);
      if (content && ![...current.messages.values()].some(message => message.role === 'assistant' && message.text === content)) {
        current.messages.set(p.id ?? `message:${current.messages.size}`, {role: p.role, text: content, phase: p.phase});
      }
    }
    if (rawCall.test(p.type)) {
      const id = p.call_id ?? p.id;
      if (!id) return;
      owners.set(id, current);
      current.calls.set(id, {
        id, name: [p.namespace, p.name].filter(Boolean).join('.') || p.type,
        source: 'response', at, details: {arguments: p.arguments ?? p.input ?? p.action, output: orphanOutputs.get(id)}
      });
      orphanOutputs.delete(id);
    }
    if (rawResult.test(p.type) && p.call_id) {
      const call = owners.get(p.call_id)?.calls.get(p.call_id);
      if (call) call.details.output = p.output;
      else orphanOutputs.set(p.call_id, p.output);
    }
  }

  return {
    append(line) {
      let record;
      try { record = JSON.parse(line); } catch { corrupt++; return; }
      const {type, timestamp: at, payload: p} = record ?? {};
      if (!p || typeof p !== 'object') return;
      switch (type) {
        case 'session_meta':
          meta = {id: p.id, cwd: p.cwd, created: p.timestamp ?? at, parent: p.parent_thread_id ?? p.forked_from_id, historyMode: p.history_mode};
          provider = p.model_provider ?? provider;
          if (details) saveSchemas(schemaEntries(p.dynamic_tools));
          break;
        case 'turn_context': {
          model = p.model ?? model;
          const turn = getTurn(p.turn_id);
          if (turn) turn.model = model;
          break;
        }
        case 'world_state':
          if (!details) break;
          if (typeof p.state?.agents_md?.text === 'string') instructions = p.state.agents_md.text;
          saveSchemas(expandTools(p.state?.tools));
          saveSchemas(expandTools(p.state?.top_level_tools));
          break;
        case 'token_usage_record':
          onUsage(p, at, p.response_model ?? p.usage?.response_model ?? null);
          break;
        case 'compacted':
          contextSize = null;
          if (details && (events.at(-1)?.type !== '上下文压缩' || events.at(-1)?.turnId !== current?.id)) {
            events.push({at, type: '上下文压缩', turnId: current?.id});
          }
          break;
        case 'event_msg':
          onEvent(p, at);
          break;
        case 'response_item':
          if (details) onResponse(p, at);
          break;
      }
    },
    snapshot() {
      const result = [...turns.values()].map(turn => {
        const {baseline, sampledUsage, sampledSteps, messages, calls, startedAtMs, firstTextAtMs, lastUsageAtMs, ...data} = turn;
        const steps = data.steps.length > 0 ? data.steps : sampledSteps ?? [];
        const estimate = startedAtMs != null && firstTextAtMs != null && firstTextAtMs >= startedAtMs
          ? firstTextAtMs - startedAtMs : null;
        const tpsWindowMs = data.duration != null && (data.ttft ?? estimate) != null
          ? data.duration - (data.ttft ?? estimate)
          : lastUsageAtMs != null && firstTextAtMs != null ? lastUsageAtMs - firstTextAtMs : null;
        return {
          ...data, usage: data.usage ?? sampledUsage, steps,
          firstTextDelayMs: estimate,
          outputWindowMs: tpsWindowMs > 0 ? tpsWindowMs : null,
          ...(details && {
            messages: [...messages.values()].filter(message => message.text),
            calls: [...calls.values()]
          })
        };
      });
      return {
        meta, model, provider, cumulative, contextSize, windowSize, corrupt, instructions,
        schemas: [...schemas].sort(([a], [b]) => a.localeCompare(b)),
        events, turns: result
      };
    }
  };
}
