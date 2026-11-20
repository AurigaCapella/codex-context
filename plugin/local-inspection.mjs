import {open, stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {withAppServer} from './app-server.mjs';

async function localCwd(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return undefined;
  if ((await stat(path).catch(() => null))?.isDirectory()) return path;
}

function schema(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export async function configuredSchemas(path) {
  const cwd = await localCwd(path);
  return withAppServer(async rpc => {
    const tools = [];
    const unavailable = [];
    const visited = new Set();
    let cursor = null;
    do {
      if (visited.has(cursor)) throw new Error('MCP 工具目录返回了重复分页');
      visited.add(cursor);
      const page = await rpc('mcpServerStatus/list', {detail: 'toolsAndAuthOnly', limit: 25, cursor});
      for (const server of page.data) {
        if (server.toolsError) unavailable.push(server.name);
        for (const tool of Object.values(server.tools ?? {})) {
          const inputSchema = schema(tool?.inputSchema);
          if (!inputSchema || typeof tool.name !== 'string') continue;
          tools.push({
            server: server.name,
            name: tool.name,
            inputSchema,
            outputSchema: schema(tool.outputSchema)
          });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    tools.sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
    return {tools, unavailable, scope: cwd ? 'workspace' : 'host'};
  }, {cwd});
}

export async function configuredInstructions(path) {
  const cwd = await localCwd(path);
  const key = 'model_instructions_file';
  const {config, origins} = await withAppServer(rpc => rpc('config/read', {cwd}), {cwd});
  const filename = config[key];
  const origin = origins[key]?.name?.type;
  if (typeof filename !== 'string' || !isAbsolute(filename) || !['user', 'project'].includes(origin)) {
    return {text: null};
  }
  const handle = await open(filename, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('配置的指令路径必须是普通文件');
    if (info.size > 2 * 1024 * 1024) throw new Error('配置的指令文件超过 2 MiB');
    const bytes = Buffer.alloc(info.size);
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
    return {text: bytes.toString('utf8', 0, bytesRead), path: filename, origin};
  } finally {
    await handle.close();
  }
}
