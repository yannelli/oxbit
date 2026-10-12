import type { AgentModelEndpoint, AgentModels } from "@oxbit/sdk";
import { bodyText, httpError, textChunks, type Fetch } from "./http.js";

export const ANTHROPIC_VERSION = "2023-06-01";
const ORIGINS: Record<string, string> = { openai: "https://api.openai.com", anthropic: "https://api.anthropic.com" };
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** How a request authenticates: `x-api-key` for Anthropic keys, else `Authorization: Bearer`. */
export interface ModelCredentials {
  /** The key or access token for `endpoint`, or undefined to send none. */
  get(endpoint: AgentModelEndpoint): Promise<string | undefined>;
  /** A fresh token after a 401, or undefined to report the 401. */
  refresh?(endpoint: AgentModelEndpoint): Promise<string | undefined>;
}

export interface HttpModelsOptions {
  fetch: Fetch;
  credentials: ModelCredentials;
  keys: AgentModels["keys"];
  /** Allows `http://` base URLs on localhost, 127.0.0.1 and [::1], for a local Ollama. The iOS host allows https only. */
  loopbackHttp?: boolean;
  /** Rewrites an error body before it reaches the agent, for example to add a usage link. */
  describe?(status: number, body: string): string;
}

/** The validated base of an endpoint: origin plus path prefix without a trailing slash. Ports AgentModelEndpoint.swift. */
export function endpointBase(endpoint: AgentModelEndpoint, loopbackHttp = false) {
  if (ORIGINS[endpoint.api]) return ORIGINS[endpoint.api];
  if (endpoint.api !== "openai-compatible") throw new Error(`Unknown model API ${endpoint.api}.`);
  let url: URL;
  try {
    url = new URL((endpoint.baseUrl ?? "").trim());
  } catch {
    throw new Error("Enter an https:// base URL without credentials, a query, or a fragment.");
  }
  const http = url.protocol === "http:" && loopbackHttp && LOOPBACK.has(url.hostname);
  if ((url.protocol !== "https:" && !http) || url.username || url.password || url.search || url.hash || (endpoint.baseUrl ?? "").includes("#"))
    throw new Error(loopbackHttp ? "Enter an https:// base URL, or http:// for localhost, without credentials, a query, or a fragment."
      : "Enter an https:// base URL without credentials, a query, or a fragment.");
  if (url.pathname.includes("..") || /%2e/i.test(url.pathname)) throw new Error("The base URL path cannot contain \"..\".");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The full URL for `path` under the endpoint base. Throws for paths that could leave it. */
export function endpointUrl(endpoint: AgentModelEndpoint, path: string, loopbackHttp = false) {
  const base = endpointBase(endpoint, loopbackHttp);
  const invalid = !path.startsWith("/") || path.startsWith("//") || /\.\.|\\|#|%2e|[\s\x00-\x1f\x7f]/i.test(path);
  const url = invalid ? undefined : new URL(base + path);
  const prefix = new URL(base);
  if (!url || url.origin !== prefix.origin || !url.pathname.startsWith(prefix.pathname.replace(/\/$/, "") + "/") || url.username || url.password)
    throw new Error(`The model API path ${path} is not allowed.`);
  return url.toString();
}

/** An AgentModels service over the host's fetch. Requests stay on the endpoint's origin and redirects fail. */
export function httpModels(options: HttpModelsOptions): AgentModels {
  const send = async (url: string, init: RequestInit, endpoint: AgentModelEndpoint, token: string | undefined) => {
    const headers: Record<string, string> = { ...(init.body ? { "content-type": "application/json" } : {}) };
    if (endpoint.api === "anthropic") {
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      if (token) headers["x-api-key"] = token;
    } else if (token) headers.authorization = `Bearer ${token}`;
    return options.fetch(url, { ...init, headers, redirect: "error" });
  };
  return {
    async *stream(request, signal) {
      const endpoint: AgentModelEndpoint = { api: request.api, ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}) };
      const url = endpointUrl(endpoint, request.path, options.loopbackHttp);
      const init: RequestInit = { method: request.method, signal, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) };
      let response = await send(url, init, endpoint, await options.credentials.get(endpoint));
      if (response.status === 401 && options.credentials.refresh) {
        const token = await options.credentials.refresh(endpoint);
        if (token) {
          await response.body?.cancel().catch(() => {});
          response = await send(url, init, endpoint, token);
        }
      }
      if (!response.ok) {
        const body = await bodyText(response);
        throw httpError(response.status, options.describe ? options.describe(response.status, body) : body);
      }
      yield* textChunks(response.body);
    },
    keys: options.keys,
  };
}
