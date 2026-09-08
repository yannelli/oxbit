import http, { type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import path from "node:path";
import { setting, workspaceDataDir } from "./branding.js";
export { workspaceDataDir } from "./branding.js";
import {
  randomBytes,
  createHash,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import chokidar from "chokidar";
import type { Capability, Encoding, Eol } from "@oxbit/sdk";
import {
  RpcError,
  parseClientMessage,
  requireString,
  MAX_MESSAGE_BYTES,
  MAX_BUFFER_BYTES,
  operationMethods,
  type ServerMessage,
} from "@oxbit/protocol";
import { WorkspaceFiles } from "./filesystem.js";
import { Processes, runCommand } from "./processes.js";
import { TaskConfigStore } from "./tasks/config.js";
import { TaskRunner } from "./tasks/runner.js";
import { TaskWorktrees } from "./tasks/worktrees.js";
import { Git } from "./git.js";
import { LanguageServerManager } from "./lsp-manager.js";
import { ProjectStore } from "./projects.js";
import { SettingsStore } from "./settings.js";
import { JsonSchemas } from "./json-schemas.js";
import os from "node:os";
import { Collaboration } from "./collaboration.js";
import { RuntimeExtensions } from "./extensions.js";

export interface RuntimeOptions {
  root: string;
  port?: number;
  host?: string;
  dataDir?: string;
  projectsDir?: string;
  settingsFile?: string;
  pairingCode?: string;
  /** Override the home containing .oxbit/projects (for isolated embedders/tests). */
  tasksHome?: string;
  /** Private desktop SSH bridge: return the local forwarded port for an owned service. */
  forwardTaskPort?: (host: string, port: number) => Promise<number>;
  origins?: string[];
  webRoot?: string;
  /** Desktop has a private parent channel and never serves frontend assets or pairs over HTTP. */
  desktop?: { token: string; workspaceKey: string; rgPath: string; gitPath?: string };
}
interface Session {
  id: string;
  hash: string;
  owner: boolean;
  capabilities: Capability[];
  revoked: boolean;
  createdAt: number;
}
interface Connection {
  id: string;
  ws: WebSocket;
  cookie?: string;
  session?: Session;
  pending: Map<string, AbortController>;
  watching: boolean;
  language: boolean;
  edits: Map<string,{resolve:(result:{applied:boolean;failureReason?:string})=>void;cleanup:()=>void}>;
}
interface Operation {
  id: string;
  owner: string;
  method: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: number;
  result?: unknown;
  error?: { code: string; message: string; data?: unknown };
}
const allCapabilities: Capability[] = [
  "filesystem.read",
  "filesystem.write",
  "terminal",
  "tasks",
  "git",
  "lsp",
  "collaboration",
  "extensions",
];
const durableMethods = new Set<string>([
  ...operationMethods,
  "fs.mkdir",
  "collab.save",
  "git.fetch",
  "git.restore",
  "extensions.load",
  "extensions.update",
]);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const errorShape = (error: unknown) => {
  if (error instanceof RpcError)
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  const e = error as NodeJS.ErrnoException;
  return { code: e.code ?? "INTERNAL", message: e.message ?? String(error) };
};

export function importMapHashes(html: string) {
  return [
    ...html.matchAll(
      /<script\b(?=[^>]*\btype\s*=\s*["']importmap["'])[^>]*>([\s\S]*?)<\/script\s*>/gi,
    ),
  ].map(
    (match) =>
      `'sha256-${createHash("sha256").update(match[1]!.replace(/\r\n?/g, "\n")).digest("base64")}'`,
  );
}

export async function createRuntime(options: RuntimeOptions) {
  const root = await fs.realpath(options.root),
    host = options.host ?? "127.0.0.1";
  const dataDir = path.resolve(options.dataDir ?? workspaceDataDir(root));
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(dataDir, "runtime.json");
  const files = new WorkspaceFiles(root, dataDir),
    sessions = new Map<string, Session>(),
    operations = new Map<string, Operation>(),
    inflight = new Map<string, Promise<unknown>>(),
    connections = new Map<string, Connection>();
  let trusted = false,
    closed = false;
  try {
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    trusted = state.trusted === true;
    for (const session of state.sessions ?? [])
      sessions.set(session.hash, session);
    for (const operation of state.operations ?? []) {
      if (operation.status === "running") {
        operation.status = "interrupted";
        operation.error = {
          code: "INTERRUPTED",
          message:
            "Runtime stopped before operation completion was recorded; inspect state before retrying with a new request ID",
        };
      }
      operations.set(`${operation.owner}:${operation.id}`, operation);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Cannot recover runtime state: ${String(error)}`);
  }
  if (options.desktop) {
    if (options.desktop.token.length < 32) throw new Error("Invalid desktop credential");
    for (const [key, session] of sessions) if (session.id === "desktop-owner") sessions.delete(key);
    sessions.set(hash(options.desktop.token), {
      id: "desktop-owner", hash: hash(options.desktop.token), owner: true,
      capabilities: [...allCapabilities], revoked: false, createdAt: Date.now(),
    });
  }
  let persistence = Promise.resolve();
  const persist = () => {
    const payload = JSON.stringify({
      trusted,
      sessions: [...sessions.values()],
      operations: [...operations.values()],
    });
    persistence = persistence
      .catch(() => {})
      .then(async () => {
        await fs.writeFile(stateFile + ".tmp", payload, { mode: 0o600 });
        await fs.rename(stateFile + ".tmp", stateFile);
      });
    return persistence;
  };
  await persist();
  const pairingCode = options.pairingCode ?? randomBytes(6).toString("hex");
  let port = options.port ?? 9277;
  const allowedOrigins = () =>
    new Set([
      ...(options.desktop ? [] : [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://${host}:${port}`]),
      ...(options.origins ?? []),
    ]);
  const originAllowed = (request: IncomingMessage, required = false) => {
    const origin = request.headers.origin;
    return origin === undefined ? !required : allowedOrigins().has(origin);
  };
  const send = (connection: Connection, message: ServerMessage) => {
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    if (connection.ws.bufferedAmount > MAX_BUFFER_BYTES) {
      connection.ws.close(1013, "Slow consumer; reconnect to resynchronize");
      return;
    }
    connection.ws.send(JSON.stringify(message));
  };
  const event = (
    connection: Connection,
    name: string,
    params: Record<string, unknown>,
    stream?: string,
    seq?: number,
  ) =>
    send(connection, {
      v: 1,
      type: "event",
      event: name,
      params,
      ...(stream ? { stream, seq } : {}),
    });
  const authorized = (
    connection: Connection,
    capability?: Capability,
    trust = false,
  ) => {
    const session = connection.session;
    if (!session || session.revoked)
      throw new RpcError("UNAUTHENTICATED", "Pair with the runtime first");
    if (capability && !session.capabilities.includes(capability))
      throw new RpcError(
        "FORBIDDEN",
        `Workspace grant does not allow ${capability}`,
      );
    if (trust && !trusted)
      throw new RpcError(
        "UNTRUSTED",
        "Trust this workspace before executing tools",
      );
    return session;
  };
  const owner = (connection: Connection) => {
    const session = authorized(connection);
    if (!session.owner)
      throw new RpcError("FORBIDDEN", "Owner access is required");
    return session;
  };
  const processEvent = ({ event: name, params, stream, seq }: import("./processes.js").ProcessEvent, ownerId?: string) => {
    const cap = name.startsWith("terminal.") ? "terminal" : "tasks";
    for (const c of connections.values()) {
      const session = c.session;
      if (session && session.id === ownerId && !session.revoked && session.capabilities.includes(cap)) event(c, name, params, stream, seq);
    }
  };
  const processes = new Processes(root, processEvent);
  const taskStore = await TaskConfigStore.create(root, { home: options.tasksHome ?? setting("TASKS_HOME"), gitPath: options.desktop?.gitPath });
  const tasks = new TaskRunner(taskStore, processEvent, options.forwardTaskPort);
  const worktrees = new TaskWorktrees(taskStore, tasks);
  let projectChanged = () => {};
  const project = await new ProjectStore(files, options.projectsDir ?? setting("PROJECTS_DIR") ?? path.join(os.homedir(), ".oxbit", "projects"), () => projectChanged()).initialize();
  const projectDataRoot = files.protect(path.dirname(project.directory));
  let settingsChanged = () => {};
  const settings = await new SettingsStore(files, options.settingsFile ?? setting("SETTINGS_FILE") ?? path.join(os.homedir(), ".oxbit", "settings.json"), project.directory, () => {
    for (const c of connections.values()) if (c.session?.owner && !c.session.revoked && c.session.capabilities.includes("filesystem.read")) event(c, "settings.changed", {});
    settingsChanged();
  }).initialize();
  files.protect(settings.userFile);
  project.useSettings(() => settings.effective());
  const lspCache = setting("LSP_CACHE") ?? path.join(os.homedir(), ".oxbit", "language-servers");
  const lsp = new LanguageServerManager(files, lspCache, (method, params, instanceId) => {
    for (const c of connections.values())
      if (
        c.language &&
        (!instanceId || lsp.isAttached(c.id, instanceId)) &&
        c.session &&
        !c.session.revoked &&
        c.session.capabilities.includes("lsp")
      )
        { event(c, "lsp.notification", { method, params, instanceId }); if (method === "oxbit/serverRequest") break; }
  }, 300_000, project, new JsonSchemas(files, path.join(lspCache, "json-schemas"), fetch, { settingsPaths: settings.paths, schemaFile: settings.schemaFile }));
  projectChanged = () => { void lsp.refreshSchemas(); };
  const initialPreferences = await settings.effective();
  let intelligencePreference = JSON.stringify(initialPreferences["project.intelligence"]), schemaPreference = JSON.stringify(initialPreferences["project.schemas"]);
  settingsChanged = () => {
    void settings.effective().then(preferences => {
      const intelligence = JSON.stringify(preferences["project.intelligence"]), schemas = JSON.stringify(preferences["project.schemas"]);
      if (intelligence !== intelligencePreference || schemas !== schemaPreference) project.invalidate();
      if (schemas !== schemaPreference) void lsp.refreshSchemas();
      intelligencePreference = intelligence; schemaPreference = schemas;
    });
  };
  project.invalidate();
  const collaboration = new Collaboration(
    files,
    path.join(dataDir, "collaboration"),
    lsp,
    (name, params, members) => {
      for (const id of members) {
        const c = connections.get(id);
        if (
          c?.session &&
          !c.session.revoked &&
          c.session.capabilities.includes("collaboration")
        )
          event(c, name, params);
      }
    },
  );
  const git = new Git(files, options.desktop?.gitPath);
  const extensions = new RuntimeExtensions(files, {
    "runtime.git": {
      status: (signal?: AbortSignal) => git.status(signal),
      diff: (path: string, staged = false, signal?: AbortSignal) =>
        git.diff(path, staged, signal),
    },
    "runtime.lsp": {
      start: () => lsp.start(),
      request: (method: string, params: unknown, signal?: AbortSignal) =>
        lsp.request(method, params, signal),
      notify: (method: string, params: unknown) => lsp.notify(method, params),
    },
    "runtime.command": {
      run: (command: string, args: string[], signal?: AbortSignal) =>
        runCommand(command, args, { cwd: root, signal }),
    },
  });
  extensions.kernel.events.on("extension.change", (params) => {
    for (const c of connections.values())
      if (
        c.session &&
        !c.session.revoked &&
        c.session.capabilities.includes("extensions")
      )
        event(c, "extensions.change", params);
  });
  const tokenSession = (token: string) => {
    const session = sessions.get(hash(token));
    return session && !session.revoked ? session : undefined;
  };
  const sessionInfo = (session: Session) => ({
    workspaceId: "default",
    workspaceKey: options.desktop?.workspaceKey ?? hash(root).slice(0, 24),
    workspaceName: path.basename(root),
    capabilities: session.capabilities,
    owner: session.owner,
    trusted,
    sessionId: session.id,
  });
  const createSession = async (
    isOwner: boolean,
    capabilities: Capability[],
  ) => {
    const token = randomBytes(32).toString("base64url"),
      session: Session = {
        id: randomUUID(),
        hash: hash(token),
        owner: isOwner,
        capabilities,
        revoked: false,
        createdAt: Date.now(),
      };
    sessions.set(session.hash, session);
    await persist();
    return { token, ...sessionInfo(session) };
  };
  const revoke = async (id: string) => {
    const session = [...sessions.values()].find((s) => s.id === id);
    if (!session) throw new RpcError("NOT_FOUND", "Grant does not exist");
    session.revoked = true;
    processes.revoke(session.id);
    tasks.revoke(session.id);
    for (const c of connections.values())
      if (c.session?.id === id) {
        for (const controller of c.pending.values()) controller.abort();
        c.ws.close(4003, "Workspace grant was revoked");
      }
    await persist();
    return { ok: true };
  };
  const caps = (value: unknown): Capability[] => {
    if (
      !Array.isArray(value) ||
      value.some((cap) => !allCapabilities.includes(cap)) ||
      value.length > allCapabilities.length
    )
      throw new RpcError("INVALID_PARAMS", "Invalid workspace capabilities");
    return [...new Set(value)] as Capability[];
  };
  const httpJson = (
    response: ServerResponse,
    status: number,
    value: unknown,
  ) => {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
  };
  const body = async (request: IncomingMessage) => {
    let value = "";
    for await (const chunk of request) {
      value += chunk;
      if (Buffer.byteLength(value) > 65536)
        throw new RpcError("TOO_LARGE", "HTTP body exceeds 64 KiB");
    }
    try {
      return JSON.parse(value);
    } catch {
      throw new RpcError("INVALID_PARAMS", "Invalid JSON request");
    }
  };
  const cookies = (request: IncomingMessage) => {
    const entries = request.headers.cookie?.split(";").map((x) => x.trim());
    return entries
      ?.find((x) => x.startsWith("oxbit_session="))
      ?.slice("oxbit_session=".length);
  };
  const httpSession = (request: IncomingMessage) => {
    const token =
      request.headers.authorization?.replace(/^Bearer /, "") ??
      cookies(request);
    return token ? tokenSession(token) : undefined;
  };
  const attempts = new Map<string, { count: number; reset: number }>();
  const webRoot = path.resolve(
    options.webRoot ??
      fileURLToPath(new URL("../../web/dist/", import.meta.url)),
  );
  const server = http.createServer((request, response) => {
    void (async () => {
      if (!originAllowed(request)) {
        httpJson(response, 403, { error: "Origin is not allowed" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${host}:${port}`);
      if (url.pathname === "/api/health") {
        httpJson(response, 200, { ok: true, protocol: 1 });
        return;
      }
      if (url.pathname === "/api/pair" && request.method === "POST") {
        if (options.desktop) {
          httpJson(response, 403, { error: "Desktop pairing requires the parent channel" });
          return;
        }
        const address = request.socket.remoteAddress ?? "unknown",
          entry = attempts.get(address) ?? {
            count: 0,
            reset: Date.now() + 60000,
          };
        if (Date.now() > entry.reset) {
          entry.count = 0;
          entry.reset = Date.now() + 60000;
        }
        if (++entry.count > 10) {
          httpJson(response, 429, { error: "Pairing rate limit reached" });
          return;
        }
        attempts.set(address, entry);
        const input = await body(request);
        const code = typeof input.code === "string" ? input.code : "";
        const a = Buffer.from(code),
          b = Buffer.from(pairingCode);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          httpJson(response, 401, { error: "Invalid pairing code" });
          return;
        }
        const result = await createSession(true, [...allCapabilities]);
        response.setHeader(
          "Set-Cookie",
          `oxbit_session=${result.token}; HttpOnly; SameSite=Strict; Path=/`,
        );
        httpJson(response, 200, result);
        return;
      }
      if (url.pathname === "/api/grants") {
        const session = httpSession(request);
        if (!session?.owner) {
          httpJson(response, 403, { error: "Owner access is required" });
          return;
        }
        if (request.method === "POST") {
          const input = await body(request);
          httpJson(
            response,
            201,
            await createSession(false, caps(input.capabilities)),
          );
          return;
        }
        if (request.method === "GET") {
          httpJson(
            response,
            200,
            [...sessions.values()].map((s) => ({
              id: s.id,
              owner: s.owner,
              capabilities: s.capabilities,
              revoked: s.revoked,
            })),
          );
          return;
        }
      }
      if (
        url.pathname.startsWith("/api/grants/") &&
        request.method === "DELETE"
      ) {
        if (!httpSession(request)?.owner) {
          httpJson(response, 403, { error: "Owner access is required" });
          return;
        }
        httpJson(
          response,
          200,
          await revoke(
            decodeURIComponent(url.pathname.slice("/api/grants/".length)),
          ),
        );
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        httpJson(response, 405, { error: "Method not allowed" });
        return;
      }
      let relative: string;
      try {
        relative = decodeURIComponent(url.pathname);
      } catch {
        httpJson(response, 400, { error: "Invalid path" });
        return;
      }
      if (options.desktop) { httpJson(response, 404, { error: "Not found" }); return; }
      let target = path.resolve(webRoot, "." + relative);
      if (target !== webRoot && !target.startsWith(webRoot + path.sep)) {
        httpJson(response, 403, { error: "Path denied" });
        return;
      }
      try {
        if ((await fs.stat(target)).isDirectory())
          target = path.join(target, "index.html");
        await fs.access(target);
      } catch {
        target = path.join(webRoot, "index.html");
      }
      let content: Buffer;
      try {
        const real = await fs.realpath(target);
        if (real !== webRoot && !real.startsWith(webRoot + path.sep)) {
          httpJson(response, 403, { error: "Path denied" });
          return;
        }
        content = await fs.readFile(real);
      } catch {
        httpJson(response, 503, {
          error: "Web build is missing. Run pnpm build.",
        });
        return;
      }
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".json": "application/json",
        ".woff2": "font/woff2",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".ico": "image/x-icon",
      };
      response.writeHead(200, {
        "Content-Type":
          mime[path.extname(target)] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'self'; script-src 'self' blob: ${target.endsWith(".html") ? importMapHashes(content.toString("utf8")).join(" ") : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`,
        "Cache-Control": target.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=3600",
      });
      response.end(request.method === "HEAD" ? undefined : content);
    })().catch((error) =>
      httpJson(response, error instanceof RpcError ? 400 : 500, {
        error: errorShape(error),
      }),
    );
  });
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.url?.split("?")[0] !== "/ws" || !originAllowed(request, true)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (ws) =>
      websocket.emit("connection", ws, request),
    );
  });
  const requireRevision = (params: Record<string, unknown>) => {
    if (
      params.expectedRevision !== null &&
      typeof params.expectedRevision !== "string"
    )
      throw new RpcError("INVALID_PARAMS", "expectedRevision is required");
    return params.expectedRevision as string | null;
  };
  const permission = (
    method: string,
  ): { cap?: Capability; trust?: boolean } => {
    if (method.startsWith("fs."))
      return {
        cap: ["fs.list", "fs.read", "fs.watch", "fs.unwatch"].includes(method)
          ? "filesystem.read"
          : "filesystem.write",
      };
    if (method.startsWith("search.")) return { cap: "filesystem.read" };
    if (method.startsWith("project.")) return { cap: "filesystem.read" };
    if (method.startsWith("settings.")) return { cap: method === "settings.patch" ? "filesystem.write" : "filesystem.read" };
    if (method.startsWith("terminal.")) return { cap: "terminal", trust: true };
    if (method.startsWith("tasks.")) return { cap: "tasks", trust: !["tasks.catalog", "tasks.list", "tasks.attach", "tasks.worktrees"].includes(method) };
    if (method.startsWith("git.")) return { cap: "git", trust: true };
    if (method.startsWith("lsp.")) return { cap: "lsp", trust: true };
    if (method.startsWith("collab.")) return { cap: "collaboration" };
    if (method.startsWith("extensions."))
      return { cap: "extensions", trust: true };
    return {};
  };
  const execute = async (
    connection: Connection,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    requestId: string,
  ): Promise<any> => {
    if (method === "auth.authenticate") {
      const token =
        typeof params.token === "string" ? params.token : connection.cookie;
      if (!token)
        throw new RpcError("UNAUTHENTICATED", "Pair with the runtime first");
      const session = tokenSession(token);
      if (!session)
        throw new RpcError("UNAUTHENTICATED", "Token is invalid or revoked");
      if (connection.session && connection.session.id !== session.id)
        throw new RpcError(
          "FORBIDDEN",
          "Open a new connection to change sessions",
        );
      connection.session = session;
      return sessionInfo(session);
    }
    const workspace = params.workspaceId ?? "default";
    if (workspace !== "default")
      throw new RpcError("FORBIDDEN", "Workspace is not granted");
    const required = permission(method),
      session = authorized(connection, required.cap, required.trust);
    if (method.startsWith("project.")) owner(connection);
    if (method.startsWith("settings.")) owner(connection);
    switch (method) {
      case "settings.read":
        return settings.read(params.legacy as Parameters<SettingsStore["read"]>[0]);
      case "settings.patch":
        return settings.patch(params.changes);
      case "project.info":
        return project.info();
      case "project.refresh":
        await project.refresh(); return project.info();
      case "project.intelligence": {
        const index = await project.snapshot();
        if (!index) return null;
        const offset = typeof params.offset === "number" ? params.offset : 0, limit = typeof params.limit === "number" ? params.limit : 50;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new RpcError("INVALID_PARAMS", "Use a nonnegative offset and limit from 1 to 200");
        return { ...index, files: index.files.slice(offset, offset + limit), totalFiles: index.files.length };
      }
      case "project.relations":
        return project.relations(requireString(params, "path"));
      case "workspace.info":
        return sessionInfo(session);
      case "workspace.trust":
        owner(connection);
        if (typeof params.trusted !== "boolean")
          throw new RpcError("INVALID_PARAMS", "trusted must be boolean");
        trusted = params.trusted;
        if (!trusted) {
          await extensions.suspend();
          for (const c of connections.values()) for (const pending of c.pending.values()) pending.abort();
          for (const s of sessions.values()) { processes.revoke(s.id); tasks.revoke(s.id); }
          await lsp.suspend();
        }
        await persist();
        for (const c of connections.values())
          if (c.session) event(c, "workspace.trust", { trusted });
        return { trusted };
      case "workspace.grant":
        owner(connection);
        return createSession(false, caps(params.capabilities));
      case "workspace.grants":
        owner(connection);
        return [...sessions.values()].map((s) => ({
          id: s.id,
          owner: s.owner,
          capabilities: s.capabilities,
          revoked: s.revoked,
        }));
      case "workspace.revoke":
        owner(connection);
        return revoke(requireString(params, "id"));
      case "operation.status": {
        const value = operations.get(
          `${session.id}:${requireString(params, "id")}`,
        );
        return value ?? { id: params.id, status: "unknown" };
      }
      case "fs.list":
        return files.list(typeof params.path === "string" ? params.path : "");
      case "fs.read":
        return files.read(
          requireString(params, "path"),
          params.encoding as Encoding | undefined,
        );
      case "fs.write": {
        const snapshot = await files.write(
          requireString(params, "path"),
          requireString(params, "text", 20 * 1024 * 1024),
          {
            expectedRevision: requireRevision(params),
            encoding: params.encoding as Encoding | undefined,
            eol: params.eol as Eol | undefined,
          },
        );
        lsp.saved(requireString(params, "path"), snapshot.text);
        return snapshot;
      }
      case "fs.mkdir":
        await files.mkdir(requireString(params, "path"));
        return { ok: true };
      case "fs.rename":
        await files.rename(
          requireString(params, "path"),
          requireString(params, "to"),
        );
        return { ok: true };
      case "fs.delete":
        await files.delete(requireString(params, "path"));
        return { ok: true };
      case "fs.watch":
        connection.watching = true;
        return { ok: true };
      case "fs.unwatch":
        connection.watching = false;
        return { ok: true };
      case "terminal.create":
        return processes.create(
          session.id,
          connection.id,
          Number(params.cols ?? 100),
          Number(params.rows ?? 30),
        );
      case "terminal.input":
        processes.input(
          requireString(params, "id"),
          session.id,
          requireString(params, "data", 65536),
        );
        return { ok: true };
      case "terminal.resize":
        processes.resize(
          requireString(params, "id"),
          session.id,
          Number(params.cols),
          Number(params.rows),
        );
        return { ok: true };
      case "terminal.kill":
        processes.kill(requireString(params, "id"), session.id);
        return { ok: true };
      case "terminal.list":
        return processes.list(session.id);
      case "terminal.attach":
        return processes.attach(
          requireString(params, "id"),
          session.id,
          connection.id,
          Number(params.afterSeq ?? 0),
        );
      case "terminal.ack":
        processes.ack(
          requireString(params, "id"),
          session.id,
          connection.id,
          Number(params.seq),
        );
        return { ok: true };
      case "tasks.catalog":
        return taskStore.catalog();
      case "tasks.save":
        owner(connection);
        return taskStore.save({ sourceId: requireString(params, "sourceId"), name: requireString(params, "name"), task: params.task, sourceCommand: params.sourceCommand as string | undefined, expectedRevision: params.expectedRevision, create: params.create === true });
      case "tasks.settings":
        owner(connection);
        return taskStore.saveSettings({ sourceId: requireString(params, "sourceId"), worktree: params.worktree, env: params.env, expectedRevision: params.expectedRevision });
      case "tasks.share":
        owner(connection);
        if (!params.expectedRevisions || typeof params.expectedRevisions !== "object" || Array.isArray(params.expectedRevisions)) throw new RpcError("INVALID_PARAMS", "Source revisions are required");
        return taskStore.share(params.expectedRevisions as Record<string, string | null>);
      case "tasks.start":
        return tasks.start(session.id, requireString(params, "taskId"), signal);
      case "tasks.run":
        return tasks.run(session.id, requireString(params, "command", 32768), signal);
      case "tasks.cancel":
      case "tasks.stop":
        return tasks.stop(requireString(params, "id"), session.id, params.force === true);
      case "tasks.restart":
        return tasks.restart(requireString(params, "id"), session.id, signal);
      case "tasks.list":
        return tasks.list(session.id);
      case "tasks.attach":
        return tasks.attach(requireString(params, "id"), session.id, Number(params.afterSeq ?? 0));
      case "tasks.worktrees":
        owner(connection);
        return worktrees.list();
      case "tasks.worktreeCreate":
        owner(connection);
        return worktrees.create(session.id, requireString(params, "branch"), typeof params.base === "string" ? params.base : "HEAD", signal);
      case "tasks.worktreeInit":
        owner(connection);
        return worktrees.retryInit(session.id, requireString(params, "id"), signal);
      case "tasks.worktreeRemove":
        owner(connection);
        return worktrees.remove(session.id, requireString(params, "id"), signal);
      case "git.status":
        return git.status(signal);
      case "git.diff":
        return git.diff(
          requireString(params, "path"),
          params.staged === true,
          signal,
        );
      case "git.restore":
      case "git.init":
      case "git.stage":
      case "git.unstage":
      case "git.discard":
      case "git.commit":
      case "git.checkout":
      case "git.push":
      case "git.fetch":
      case "git.clone":
        return git.action(method.slice(4), params, signal, (data) =>
          event(connection, "git.progress", { id: requestId, data }),
        );
      case "extensions.load":
        return extensions.load(requireString(params, "path"));
      case "extensions.update":
        return extensions.update(requireString(params, "path"));
      case "extensions.list":
        return extensions.list();
      case "extensions.disable":
        return extensions.disable(requireString(params, "id"));
      case "extensions.activate":
        return extensions.activate(requireString(params, "id"));
      case "extensions.remove":
        return extensions.remove(requireString(params, "id"));
      case "lsp.laravelRoot":
        return lsp.laravelRoot(requireString(params, "path"));
      case "lsp.attach":
        connection.language = true;
        return lsp.attach(requireString(params, "path"), connection.id, params.configuration ?? {}, params.associations ?? {}, typeof params.definitionId === "string" ? params.definitionId : undefined);
      case "lsp.detach":
        lsp.detach(connection.id, typeof params.path === "string" ? params.path : undefined, typeof params.instanceId === "string" ? params.instanceId : undefined);
        return { ok: true };
      case "lsp.instances":
        return lsp.list();
      case "lsp.versions":
        return lsp.versions(typeof params.instanceId === "string" ? params.instanceId : undefined);
      case "lsp.status":
        connection.language = true;
        return lsp.status(typeof params.instanceId === "string" ? params.instanceId : undefined);
      case "lsp.start":
        connection.language = true;
        return lsp.start(params?.resume !== false, typeof params.instanceId === "string" ? params.instanceId : undefined);
      case "lsp.external.authorize":
      case "lsp.external.read": {
        const instanceId = requireString(params, "instanceId");
        if (!session.capabilities.includes("filesystem.read")) throw new RpcError("FORBIDDEN", "External sources require filesystem read access");
        if (!lsp.isAttached(connection.id, instanceId)) throw new RpcError("FORBIDDEN", "Language instance is not attached");
        return method.endsWith("authorize") ? lsp.authorizeExternal(requireString(params, "uri"), instanceId) : lsp.readExternal(requireString(params, "handle"), instanceId);
      }
      case "lsp.serverResponse": {
        if (typeof params.id !== "number" || !Number.isInteger(params.id) || params.id >= 0) throw new RpcError("INVALID_PARAMS", "Invalid server request id");
        if (typeof params.instanceId === "string" && !lsp.isAttached(connection.id, params.instanceId)) throw new RpcError("FORBIDDEN", "Language instance is not attached");
        lsp.respond(params.id, params.result ?? null, typeof params.instanceId === "string" ? params.instanceId : undefined); return { ok: true };
      }
      case "lsp.applyEditResult": {
        const id=requireString(params,"id"), pending=connection.edits.get(id);
        if (!pending) throw new RpcError("NOT_FOUND","Language workspace edit expired");
        if (typeof params.applied !== "boolean") throw new RpcError("INVALID_PARAMS","applied must be boolean");
        pending.cleanup(); connection.edits.delete(id); pending.resolve({applied:params.applied,failureReason:typeof params.failureReason==="string"?params.failureReason:undefined}); return {ok:true};
      }
      case "lsp.request":
        connection.language = true;
        return lsp.request(
          requireString(params, "method"),
          params.params ?? {},
          signal,
          (edit,label) => {
            authorized(connection,"filesystem.write",true);
            return new Promise(resolve=>{
              const id=randomUUID(), finish=(result:{applied:boolean;failureReason?:string})=>{const pending=connection.edits.get(id);pending?.cleanup();connection.edits.delete(id);resolve(result);};
              const abort=()=>finish({applied:false,failureReason:"Language command was cancelled"});
              const timer=setTimeout(()=>finish({applied:false,failureReason:"Document client did not acknowledge the workspace edit"}),15000);
              const cleanup=()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);};
              connection.edits.set(id,{resolve,cleanup});signal.addEventListener("abort",abort,{once:true});
              if(signal.aborted) abort(); else event(connection,"lsp.applyEdit",{id,edit,label,instanceId:params.instanceId});
            });
          },
          typeof params.instanceId === "string" ? params.instanceId : undefined,
        );
      case "lsp.notify":
        await lsp.notify(requireString(params, "method"), params.params ?? {}, typeof params.instanceId === "string" ? params.instanceId : undefined);
        return { ok: true };
      case "lsp.restart":
        connection.language = true;
        return lsp.restart(typeof params.instanceId === "string" ? params.instanceId : undefined);
      case "lsp.stop":
        await lsp.stop(true, typeof params.instanceId === "string" ? params.instanceId : undefined);
        return { ok: true };
      case "collab.join":
        authorized(connection, "filesystem.read");
        return collaboration.join(requireString(params, "path"), connection.id);
      case "collab.update":
        authorized(connection, "filesystem.write");
        return collaboration.update(
          requireString(params, "path"),
          connection.id,
          requireString(params, "update", MAX_MESSAGE_BYTES),
        );
      case "collab.awareness":
        return collaboration.awareness(
          requireString(params, "path"),
          connection.id,
          requireString(params, "update", 65536),
        );
      case "collab.leave":
        await collaboration.leave(connection.id, requireString(params, "path"));
        return { ok: true };
      case "collab.save":
        authorized(connection, "filesystem.write");
        return collaboration.save(
          requireString(params, "path"),
          connection.id,
          requireRevision(params),
          params.encoding as Encoding | undefined,
          params.eol as Eol | undefined,
        );
      case "search.query": {
        const query = requireString(params, "query", 8192);
        if (!query) return [];
        const args = [
          "--json",
          "--line-number",
          "--column",
          "--max-count",
          "1000",
          "--max-filesize",
          "20M",
          "--glob",
          "!.git/**",
          "--glob",
          "!node_modules/**",
        ];
        if (!params.regex) args.push("--fixed-strings");
        if (!params.caseSensitive) args.push("--ignore-case");
        if (params.wholeWord) args.push("--word-regexp");
        for (const [key, exclude] of [
          ["include", false],
          ["exclude", true],
        ] as const) {
          const value = params[key];
          if (value !== undefined && typeof value !== "string")
            throw new RpcError(
              "INVALID_PARAMS",
              `${key} must be a glob string`,
            );
          for (const glob of String(value ?? "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)) {
            if (glob.length > 1024)
              throw new RpcError("INVALID_PARAMS", "Path filter is too long");
            args.push("--glob", exclude ? "!" + glob : glob);
          }
        }
        args.push("--", query, ".");
        const result = await runCommand(options.desktop?.rgPath ?? "rg", args, {
          cwd: root,
          signal,
          maxBytes: 8 * MAX_BUFFER_BYTES,
        });
        if (result.exitCode > 1)
          throw new RpcError("SEARCH_FAILED", result.stderr.trim());
        const snapshots = new Map<
          string,
          Awaited<ReturnType<WorkspaceFiles["read"]>>
        >();
        const results = [];
        for (const row of result.stdout.split("\n")) {
          if (!row) continue;
          const parsed = JSON.parse(row);
          if (parsed.type !== "match") continue;
          const data = parsed.data,
            relative = String(data.path.text).replace(/^\.\//, "");
          if (!snapshots.has(relative)) {
            try {
              snapshots.set(relative, await files.read(relative));
            } catch {
              continue;
            }
          }
          const snapshot = snapshots.get(relative)!;
          const lines = snapshot.text.split("\n");
          const line = Number(data.line_number),
            lineText = lines[line - 1] ?? "";
          if (lineText !== String(data.lines.text).replace(/\r?\n$/, ""))
            continue;
          const lineOffset = lines
            .slice(0, line - 1)
            .reduce((n, s) => n + s.length + 1, 0);
          for (const match of data.submatches) {
            const raw = Buffer.from(data.lines.text);
            const column = raw.subarray(0, match.start).toString().length;
            const end = raw.subarray(0, match.end).toString().length;
            results.push({
              path: relative,
              line,
              column: column + 1,
              from: lineOffset + column,
              to: lineOffset + end,
              text: lineText,
              revision: snapshot.revision,
            });
            if (results.length >= 10000) return results;
          }
        }
        return results;
      }
      default:
        throw new RpcError(
          "METHOD_NOT_FOUND",
          `Unknown runtime method ${method}`,
        );
    }
  };
  websocket.on("connection", (ws, request) => {
    const connection: Connection = {
      id: randomUUID(),
      ws,
      cookie: cookies(request),
      pending: new Map(),
      watching: false,
      language: false,
      edits: new Map(),
    };
    connections.set(connection.id, connection);
    const authDeadline = setTimeout(() => {
      if (!connection.session) ws.close(4001, "Authenticate within 10 seconds");
    }, 10000);
    authDeadline.unref();
    ws.on("message", (raw) => {
      void (async () => {
        let message;
        try {
          message = parseClientMessage(raw.toString());
        } catch (error) {
          event(connection, "protocol.error", errorShape(error));
          ws.close(1008, "Invalid protocol message");
          return;
        }
        if (message.type === "cancel") {
          authorized(connection);
          connection.pending.get(message.id)?.abort();
          return;
        }
        if (message.type === "ack") {
          const session = authorized(connection, "terminal");
          if (!message.stream.startsWith("terminal:"))
            throw new RpcError("INVALID_PARAMS", "Unknown stream");
          processes.ack(
            message.stream.slice(9),
            session.id,
            connection.id,
            message.seq,
          );
          return;
        }
        const { id, method, params } = message;
        if (connection.pending.size >= 64) {
          send(connection, {
            v: 1,
            type: "response",
            id,
            error: { code: "BUSY", message: "Maximum 64 concurrent requests" },
          });
          return;
        }
        const controller = new AbortController();
        try {
          if (connection.pending.has(id))
            throw new RpcError(
              "DUPLICATE_ID",
              "Request is already in flight on this connection",
            );
          connection.pending.set(id, controller);
          let result;
          if (durableMethods.has(method)) {
            const required = permission(method),
              session = authorized(connection, required.cap, required.trust);
            const key = `${session.id}:${id}`,
              existing = operations.get(key);
            if (existing) {
              if (existing.method !== method)
                throw new RpcError(
                  "DUPLICATE_ID",
                  "Request ID was used for another operation",
                );
              if (inflight.has(key)) result = await inflight.get(key);
              else if (existing.status === "completed")
                result = existing.result;
              else
                throw new RpcError(
                  existing.error?.code ?? "INTERRUPTED",
                  existing.error?.message ?? "Operation status is uncertain",
                  existing.error?.data,
                );
            } else {
              const operation: Operation = {
                id,
                owner: session.id,
                method,
                status: "running",
                startedAt: Date.now(),
              };
              operations.set(key, operation);
              const run = (async () => {
                await persist();
                try {
                  const value = await execute(
                    connection,
                    method,
                    params,
                    controller.signal,
                    id,
                  );
                  operation.status = "completed";
                  operation.result = value;
                  await persist();
                  return value;
                } catch (error) {
                  operation.status = "failed";
                  operation.error = errorShape(error);
                  await persist();
                  throw error;
                }
              })();
              inflight.set(key, run);
              try {
                result = await run;
              } finally {
                inflight.delete(key);
              }
            }
          } else
            result = await execute(
              connection,
              method,
              params,
              controller.signal,
              id,
            );
          send(connection, {
            v: 1,
            type: "response",
            id,
            result: result ?? null,
          });
        } catch (error) {
          send(connection, {
            v: 1,
            type: "response",
            id,
            error: errorShape(error),
          });
        } finally {
          if (connection.pending.get(id) === controller)
            connection.pending.delete(id);
        }
      })().catch((error) =>
        event(connection, "protocol.error", errorShape(error)),
      );
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clearTimeout(authDeadline);
      lsp.detach(connection.id);
      connections.delete(connection.id);
      for (const pending of connection.edits.values()) {pending.cleanup();pending.resolve({applied:false,failureReason:"Document client disconnected"});} connection.edits.clear();
      processes.disconnect(connection.id);
      void collaboration.leave(connection.id);
      for (const [id, controller] of connection.pending) {
        const operation =
          connection.session &&
          operations.get(`${connection.session.id}:${id}`);
        if (!operation) controller.abort();
      }
    });
  });
  let watcher: ReturnType<typeof chokidar.watch> | undefined,
    watcherTransition = Promise.resolve();
  let watcherReadyResolve: () => void,
    watcherReadyReject: (error: unknown) => void;
  const watcherReady = new Promise<void>((resolve, reject) => {
    watcherReadyResolve = resolve;
    watcherReadyReject = reject;
  });
  let fileChangeQueue: Promise<void> = Promise.resolve();
  const watchedChange = (kind: string, full: string) => {
    fileChangeQueue = fileChangeQueue.catch(() => {}).then(async () => {
      const relative = path.relative(root, full).split(path.sep).join("/");
      try {
        await files.resolve(relative, true);
      } catch {
        return;
      }
      const change = {
        path: relative,
        kind:
          kind === "unlink" || kind === "unlinkDir"
            ? "deleted"
            : kind === "add" || kind === "addDir"
              ? "created"
              : "changed",
      };
      if (kind !== "addDir" && kind !== "unlinkDir") await collaboration.changed(relative);
      project.invalidate();
      await lsp.watched(relative, change.kind === "created" ? 1 : change.kind === "deleted" ? 3 : 2);
      for (const c of connections.values())
        if (
          c.watching &&
          c.session &&
          !c.session.revoked &&
          c.session.capabilities.includes("filesystem.read")
        )
          event(c, "fs.change", change);
      extensions.changed({
        ...change,
        kind: change.kind as "created" | "changed" | "deleted",
      });
    }).catch(() => {});
  };
  const startWatcher = (usePolling: boolean) => {
    const current = chokidar.watch([], {
      ignoreInitial: true,
      followSymlinks: false,
      usePolling,
      interval: 100,
      binaryInterval: 250,
      ignored: (file: string) => {
        const relative = path.relative(root, file);
        return (
          relative
            .split(path.sep)
            .some(
              (segment) =>
                segment === ".git" ||
                segment === "node_modules" ||
                segment.startsWith(".oxbit-tmp-"),
            ) ||
          file === dataDir ||
          file.startsWith(dataDir + path.sep) ||
          file === projectDataRoot || file.startsWith(projectDataRoot + path.sep)
        );
      },
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    watcher = current;
    current.on("all", watchedChange);
    current.once("ready", () => {
      if (watcher === current) watcherReadyResolve();
    });
    current.on("error", (failure) => {
      if (watcher !== current) return;
      const error = failure as NodeJS.ErrnoException;
      if (!usePolling && (error.code === "EMFILE" || error.code === "ENOSPC")) {
        watcher = undefined;
        watcherTransition = current
          .close()
          .then(() => {
            if (!closed) startWatcher(true);
          })
          .catch(watcherReadyReject);
        for (const c of connections.values())
          if (c.watching && c.session)
            event(c, "fs.watchStatus", { mode: "polling", reason: error.code });
      } else {
        for (const c of connections.values())
          if (c.watching && c.session)
            event(c, "fs.watchError", {
              message: error.message,
              code: error.code,
            });
        watcherReadyReject(error);
      }
    });
    current.add(root);
  };
  startWatcher(
    setting("WATCH_POLLING") === "1" ||
      setting("WATCH_POLLING") === "true",
  );
  await watcherReady;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address && typeof address === "object") port = address.port;
  return {
    server,
    port,
    pairingCode,
    root,
    dataDir,
    async rotateDesktopToken(token: string) {
      if (!options.desktop || token.length < 32) throw new Error("Invalid desktop rotation");
      const previous = [...sessions.entries()].find(([, session]) => session.id === "desktop-owner");
      if (!previous) throw new Error("Desktop owner is unavailable");
      sessions.delete(previous[0]);
      previous[1].hash = hash(token);
      sessions.set(previous[1].hash, previous[1]);
      await persist();
      for (const connection of connections.values())
        if (connection.session?.id === "desktop-owner") connection.ws.close(4003, "Project ownership transferred");
    },
    async close() {
      if (closed) return;
      closed = true;
      await watcherTransition;
      await watcher?.close();
      await fileChangeQueue;
      for (const c of connections.values()) {
        for (const controller of c.pending.values()) controller.abort();
        c.ws.terminate();
      }
      extensions.dispose();
      processes.close();
      await tasks.close();
      await project.dispose();
      await settings.dispose();
      await lsp.dispose();
      await Promise.allSettled([...inflight.values()]);
      await collaboration.close();
      await persistence;
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
