import { headerValue } from "./jsonrpc.js";

/** Anthropic allows 128 characters; 64 is the lower limit used here for OpenAI, which the function-calling guide does not state. */
export const TOOL_NAME_LIMIT = 64;
export const RESULT_LIMIT = 100000;
const HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const PRIMITIVES = new Set(["string", "number", "integer", "boolean"]);

/** FNV-1a, 8 hex digits. */
export function shortHash(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
const clean = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "_") || "_";

/** `mcp__<server>__<tool>`, cut to 64 characters with a hash suffix, unique within `taken`. */
export function toolName(server: string, tool: string, taken: Set<string>) {
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  const fit = (suffix: string) => `${full.slice(0, TOOL_NAME_LIMIT - suffix.length - 1)}_${suffix}`;
  let name = full.length <= TOOL_NAME_LIMIT ? full : fit(shortHash(`${server}\n${tool}`));
  for (let attempt = 1; taken.has(name); attempt++) name = fit(shortHash(`${server}\n${tool}\n${attempt}`));
  taken.add(name);
  return name;
}

export interface HeaderParam { path: string[]; header: string }

/** `x-mcp-header` annotations along `properties`. Undefined when an annotation is invalid, which excludes the tool. */
export function headerParams(schema: unknown): HeaderParam[] | undefined {
  const found: HeaderParam[] = [];
  const seen = new Set<string>();
  const walk = (node: any, path: string[]): boolean => {
    for (const [key, property] of Object.entries<any>(node?.properties ?? {})) {
      if (!property || typeof property !== "object") continue;
      const header = property["x-mcp-header"];
      if (header !== undefined) {
        if (typeof header !== "string" || !HEADER_TOKEN.test(header) || !PRIMITIVES.has(property.type) || seen.has(header.toLowerCase())) return false;
        seen.add(header.toLowerCase());
        found.push({ path: [...path, key], header });
      }
      if (property.type === "object" && !walk(property, [...path, key])) return false;
    }
    return true;
  };
  return walk(schema, []) ? found : undefined;
}

/** `Mcp-Param-<name>` headers for the arguments a tool marked with `x-mcp-header`. */
export function paramHeaders(params: HeaderParam[], args: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  for (const { path, header } of params) {
    let value: unknown = args;
    for (const key of path) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    if (typeof value === "string") headers[`Mcp-Param-${header}`] = headerValue(value);
    else if (typeof value === "number" || typeof value === "boolean") headers[`Mcp-Param-${header}`] = String(value);
  }
  return headers;
}

/** The tool's input schema as a JSON Schema object, as model APIs require. */
export function toolSchema(schema: unknown): Record<string, unknown> {
  const base = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as Record<string, unknown> : {};
  const properties = base.properties && typeof base.properties === "object" ? base.properties : {};
  return { ...base, type: "object", properties };
}

const base64Bytes = (data: unknown) => typeof data === "string" ? Math.floor(data.replace(/=+$/, "").length * 3 / 4) : 0;
const equalJson = (text: string, value: unknown) => {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch {
    return false;
  }
};

function block(item: any): string {
  switch (item?.type) {
    case "text":
      return typeof item.text === "string" ? item.text : "";
    case "image":
    case "audio":
      return `[${item.type} ${item.mimeType ?? "unknown type"}, ${base64Bytes(item.data)} bytes]`;
    case "resource_link":
      return `[resource ${item.name ?? item.title ?? ""} ${item.uri ?? ""}${item.mimeType ? ` ${item.mimeType}` : ""}]`.replace(/ {2,}/g, " ");
    case "resource": {
      const resource = item.resource ?? {};
      if (typeof resource.text === "string") return `${resource.uri ?? "resource"}:\n${resource.text}`;
      return `[resource ${resource.uri ?? ""} ${resource.mimeType ?? "unknown type"}, ${base64Bytes(resource.blob)} bytes]`;
    }
    default:
      return `[${typeof item?.type === "string" ? item.type : "unknown"} content]`;
  }
}

/** A tools/call result as text. `isError` results throw so the tool call reports a failure. */
export function renderResult(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  const parts = content.map(block).filter((text: string) => text);
  const structured = result?.structuredContent;
  if (structured !== undefined && !content.some((item: any) => item?.type === "text" && equalJson(item.text, structured)))
    parts.push(JSON.stringify(structured, null, 2));
  let text = parts.join("\n\n");
  if (text.length > RESULT_LIMIT) text = `${text.slice(0, RESULT_LIMIT)}\n[Output cut at ${RESULT_LIMIT} characters]`;
  if (result?.isError === true) throw new Error(text || "The MCP tool reported an error");
  return text || "(no output)";
}
