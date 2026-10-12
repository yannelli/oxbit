import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { Agent, type AgentExtensions, type AgentHost, type Params } from "@oxbit/agent-core";
import type { AgentModels, FileSystem } from "@oxbit/sdk";
import type { AgentConfig } from "./config.js";
import { nodeFilesystem } from "./fs.js";
import { missingKey, needsKey, nodeModels, type ProviderChoice } from "./providers.js";
import { JsonlSessionStore } from "./sessions.js";
import { Terminals } from "./shell.js";
import { snapshotStores, undoCommands } from "./snapshots.js";

const MAX_BYTES = 1024 * 1024;
const WRITE_OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow edits for this session", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

/** ACP clientCapabilities from initialize. `_meta.oxbit.diagnostics` marks a client that answers oxbit/diagnostics. */
export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  _meta?: Params;
}
/** The ACP client side of a connection, as the host sees it. */
export interface ClientLink {
  capabilities(): ClientCapabilities;
  update(sessionId: string, update: Params): void;
  request(method: string, params: Params): Promise<any>;
}

const absolutePath = (params: Params) => {
  const path = params.path;
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("ACP paths must be absolute");
  return path;
};

/** fs/* and terminal/* served from this machine. Writes without `_meta.oxbit.mode` ask through session/request_permission first. */
export class LocalClient {
  readonly terminals = new Terminals();
  private trusted = new Set<string>();
  constructor(private ask: (params: Params) => Promise<any>) {}
  async readTextFile(params: Params) {
    const text = await readFile(absolutePath(params), "utf8");
    const start = (params.line ?? 1) - 1;
    const content = params.line !== undefined || params.limit !== undefined
      ? text.split("\n").slice(start, params.limit ? start + params.limit : undefined).join("\n") : text;
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("File content exceeds 1 MiB; request a smaller line range");
    return { content };
  }
  async writeTextFile(params: Params) {
    const path = absolutePath(params);
    if (typeof params.content !== "string") throw new Error("Invalid content");
    const sessionId = String(params.sessionId ?? "");
    if (!params._meta?.oxbit?.mode && !this.trusted.has(sessionId)) {
      const oldText = await readFile(path, "utf8").catch(() => null);
      const response = await this.ask({ sessionId, options: WRITE_OPTIONS, toolCall: { toolCallId: params.toolCallId ?? `write-${Date.now()}`,
        title: `Write ${path}`, kind: "edit", status: "pending", locations: [{ path }],
        content: [{ type: "diff", path, oldText, newText: params.content }] } });
      const choice = response?.outcome?.outcome === "selected" ? response.outcome.optionId : undefined;
      if (choice === "allow_always") this.trusted.add(sessionId);
      else if (choice !== "allow") throw new Error("The user rejected this write");
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.content);
    return {};
  }
  dispose() {
    this.terminals.dispose();
  }
}

/** Sends fs/* and terminal/* to the client when it advertised them, else serves them locally. */
export function routeRequests(link: ClientLink, local: LocalClient) {
  return (method: string, params: Params): Promise<any> => {
    const capabilities = link.capabilities();
    if (method === "fs/read_text_file") return capabilities.fs?.readTextFile ? link.request(method, params) : local.readTextFile(params);
    if (method === "fs/write_text_file") return capabilities.fs?.writeTextFile ? link.request(method, params) : local.writeTextFile(params);
    if (method.startsWith("terminal/")) return capabilities.terminal ? link.request(method, params) : local.terminals.handle(method, params);
    if (method === "oxbit/diagnostics" && !capabilities._meta?.oxbit?.diagnostics)
      return Promise.reject(new Error("Language diagnostics are unavailable here. Run the project's type checker or linter with bash."));
    return link.request(method, params);
  };
}

export interface AgentSetup {
  root: string;
  config: AgentConfig;
  provider: ProviderChoice;
  /** Replaces the fetch transport, for tests. */
  models?: AgentModels;
  /** Merged over the default session store, snapshots and /undo, /redo. */
  extensions?: AgentExtensions;
  generateTitles?: boolean;
  ripgrep?: boolean;
  log?(text: string): void;
}

/** The Node AgentHost for one ACP connection. */
export function nodeHost(setup: AgentSetup, link: ClientLink) {
  const { root, config, provider, log } = setup;
  const local = new LocalClient((params) => link.request("session/request_permission", params));
  const transport = setup.models ?? nodeModels(provider, { save: config.saveKey, remove: config.removeKey });
  const storeFor = snapshotStores(config.paths.snapshots, log);
  const filesystems = new Map<string, FileSystem>();
  const filesystemFor = (cwd: string) => {
    let filesystem = filesystems.get(cwd);
    if (!filesystem) filesystems.set(cwd, filesystem = nodeFilesystem(cwd, { ripgrep: setup.ripgrep }));
    return filesystem;
  };
  const extensions: AgentExtensions = {
    sessions: new JsonlSessionStore(config.paths.sessions),
    snapshots: storeFor(root),
    ...setup.extensions,
    commands: [undoCommands(storeFor), ...setup.extensions?.commands ?? []],
  };
  const host: AgentHost = {
    models: () => {
      if (!setup.models && needsKey(provider) && !provider.key) throw missingKey(provider);
      return transport;
    },
    endpoint: () => provider.endpoint,
    model: () => provider.model,
    saveModel: (model) => {
      provider.model = model;
      const providers = config.settings.providers ?? {};
      config.saveSettings({ providers: { ...providers, [provider.id]: { ...providers[provider.id], model } } })
        .catch((error) => log?.(`Could not save the model: ${error.message}`));
    },
    capabilities: { fs: true, terminal: true },
    filesystem: filesystemFor(root),
    filesystemFor,
    root,
    update: (sessionId, update) => link.update(sessionId, update),
    request: routeRequests(link, local),
    generateTitles: setup.generateTitles,
    extensions,
  };
  return { host, local, dispose: () => local.dispose() };
}

export type AgentFactory = (link: ClientLink) => { agent: Agent; host: AgentHost; dispose(): void };
export const agentFactory = (setup: AgentSetup): AgentFactory => (link) => {
  const { host, dispose } = nodeHost(setup, link);
  return { agent: new Agent(host), host, dispose };
};
