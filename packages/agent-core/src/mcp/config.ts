export type McpScope = "global" | "project" | "session";
export type McpServerConfig = { name: string; scope: McpScope; timeout?: number } & (
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> }
);
export interface ParsedServers {
  servers: McpServerConfig[];
  /** Entries that were skipped, and `${VAR}` references with no value. */
  warnings: string[];
}

/** Credentials that never expand into a remote server's url or headers, as in Claude Code. */
export const REMOTE_HIDDEN_VARIABLES = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "OXBIT_AGENT_KEY",
  "AWS_BEARER_TOKEN_BEDROCK", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NPM_TOKEN"]);

/** Expands `${VAR}` and `${VAR:-default}`. A missing variable without a default stays as written and adds a warning. */
export function expandVariables(text: string, env: Record<string, string | undefined>, remote: boolean, warn: (name: string) => void) {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, fallback: string | undefined) => {
    if (remote && REMOTE_HIDDEN_VARIABLES.has(name.toUpperCase())) return "";
    const value = env[name];
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback;
    warn(name);
    return match;
  });
}

const strings = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
const timeoutOf = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? { timeout: value as number } : {};

/** Claude Code `.mcp.json`: `{"mcpServers": {"name": {"command", "args", "env"} | {"type": "http" | "sse", "url", "headers"}}}`. */
export function parseMcpJson(text: string, scope: McpScope, env: Record<string, string | undefined> = {}, source = ".mcp.json"): ParsedServers {
  const warnings: string[] = [];
  let body: any;
  try {
    body = JSON.parse(text);
  } catch (error) {
    return { servers: [], warnings: [`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const entries = body?.mcpServers;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return { servers: [], warnings: [`${source} has no "mcpServers" object`] };
  const servers: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries(entries as Record<string, any>)) {
    if (!entry || typeof entry !== "object" || entry.enabled === false || entry.disabled === true) continue;
    const missing = new Set<string>();
    const expand = (value: string, remote: boolean) => expandVariables(value, env, remote, (variable) => missing.add(variable));
    const type = entry.type ?? "stdio";
    if (entry.type === undefined && typeof entry.url === "string") {
      warnings.push(`MCP server "${name}" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry`);
      continue;
    }
    if (type === "stdio") {
      if (typeof entry.command !== "string" || !entry.command) {
        warnings.push(`MCP server "${name}" in ${source} has no command`);
        continue;
      }
      const args = Array.isArray(entry.args) ? entry.args.filter((arg: unknown) => typeof arg === "string") : [];
      servers.push({ name, scope, type: "stdio", command: expand(entry.command, false), args: args.map((arg: string) => expand(arg, false)),
        env: Object.fromEntries(Object.entries(strings(entry.env)).map(([key, value]) => [key, expand(value, false)])), ...timeoutOf(entry.timeout) });
    } else if (type === "http" || type === "streamable-http" || type === "sse") {
      if (typeof entry.url !== "string" || !entry.url) {
        warnings.push(`MCP server "${name}" in ${source} has no url`);
        continue;
      }
      servers.push({ name, scope, type: type === "sse" ? "sse" : "http", url: expand(entry.url, true),
        headers: Object.fromEntries(Object.entries(strings(entry.headers)).map(([key, value]) => [key, expand(value, true)])), ...timeoutOf(entry.timeout) });
    } else {
      warnings.push(`MCP server "${name}" uses the "${type}" transport, which Oxbit Agent does not support`);
      continue;
    }
    for (const variable of missing) warnings.push(`MCP server "${name}" references \${${variable}}, which is not set`);
  }
  return { servers, warnings };
}

const pairs = (value: unknown) => Array.isArray(value)
  ? Object.fromEntries(value.filter((item) => typeof item?.name === "string" && typeof item?.value === "string").map((item) => [item.name, item.value]))
  : strings(value);

/** ACP `session/new` `mcpServers`: stdio `{name, command, args, env: [{name, value}]}`, or `{type: "http" | "sse", name, url, headers: [{name, value}]}`. */
export function parseAcpServers(list: unknown): ParsedServers {
  const servers: McpServerConfig[] = [];
  const warnings: string[] = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const name = typeof entry?.name === "string" && entry.name ? entry.name : undefined;
    if (!name) {
      warnings.push("An MCP server from the client has no name");
      continue;
    }
    if (entry.type === "http" || entry.type === "sse") {
      if (typeof entry.url === "string" && entry.url) servers.push({ name, scope: "session", type: entry.type, url: entry.url, headers: pairs(entry.headers) });
      else warnings.push(`MCP server "${name}" from the client has no url`);
    } else if (entry.type === undefined || entry.type === "stdio") {
      if (typeof entry.command === "string" && entry.command)
        servers.push({ name, scope: "session", type: "stdio", command: entry.command,
          args: Array.isArray(entry.args) ? entry.args.filter((arg: unknown) => typeof arg === "string") : [], env: pairs(entry.env) });
      else warnings.push(`MCP server "${name}" from the client has no command`);
    } else warnings.push(`MCP server "${name}" from the client uses the "${entry.type}" transport, which Oxbit Agent does not support`);
  }
  return { servers, warnings };
}

/** Later lists win by name, whole entry. Pass global, then project, then session. */
export function mergeServers(...lists: McpServerConfig[][]) {
  const byName = new Map<string, McpServerConfig>();
  for (const server of lists.flat()) byName.set(server.name, server);
  return [...byName.values()];
}
