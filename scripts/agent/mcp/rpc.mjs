export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_VERSION = -32022;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export function toolResult(data) {
  const structured = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : { value: data };
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

function toolError(error) {
  return { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createHandler({ tools, ctx, serverInfo, instructions }) {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const capabilities = { tools: { listChanged: false } };

  const methods = {
    initialize(params) {
      const requested = params.protocolVersion;
      const protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      return { protocolVersion, capabilities, serverInfo, instructions };
    },
    'server/discover'() {
      return { supportedVersions: SUPPORTED_VERSIONS, capabilities, instructions, _meta: { [META_SERVER_INFO]: serverInfo } };
    },
    ping() {
      return {};
    },
    'tools/list'() {
      return { tools: tools.map((tool) => tool.definition) };
    },
    async 'tools/call'(params) {
      const tool = typeof params.name === 'string' ? byName.get(params.name) : undefined;
      if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`);
      const args = params.arguments ?? {};
      if (!isObject(args)) throw new RpcError(INVALID_PARAMS, 'arguments must be an object');
      try {
        return toolResult(await tool.run(args, ctx));
      } catch (error) {
        return toolError(error);
      }
    },
  };

  async function dispatch(message) {
    const params = message.params ?? {};
    if (!isObject(params)) throw new RpcError(INVALID_PARAMS, 'params must be an object');
    const requested = isObject(params._meta) ? params._meta[META_VERSION] : undefined;
    if (requested !== undefined && !SUPPORTED_VERSIONS.includes(requested)) {
      throw new RpcError(UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested });
    }
    const method = Object.hasOwn(methods, message.method) ? methods[message.method] : undefined;
    if (!method) throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    const result = await method(params);
    const modern = requested === MODERN_VERSION || message.method === 'server/discover';
    return modern ? { resultType: 'complete', ...result } : result;
  }

  return async function handle(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } };
    }
    const hasId = isObject(message) && Object.hasOwn(message, 'id');
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      if (hasId && !Object.hasOwn(message, 'method')) return null;
      return { jsonrpc: '2.0', id: hasId ? message.id : null, error: { code: INVALID_REQUEST, message: 'Invalid request' } };
    }
    if (!hasId) return null;
    try {
      return { jsonrpc: '2.0', id: message.id, result: await dispatch(message) };
    } catch (error) {
      const known = error instanceof RpcError;
      const body = { code: known ? error.code : INTERNAL_ERROR, message: String(error?.message ?? error) };
      if (known && error.data !== undefined) body.data = error.data;
      return { jsonrpc: '2.0', id: message.id, error: body };
    }
  };
}
