import type { ComponentType } from "react";
export const SDK_VERSION = "1.0.0";
export function languageIdForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "tsx") return "tsx";
  if (["ts", "mts", "cts"].includes(extension ?? "")) return "typescript";
  if (["js", "jsx", "mjs", "cjs"].includes(extension ?? ""))
    return "javascript";
  if (["md", "markdown"].includes(extension ?? "")) return "markdown";
  if (["html", "htm"].includes(extension ?? "")) return "html";
  if (["json", "css"].includes(extension ?? "")) return extension!;
  return "plaintext";
}
export type Environment = "browser" | "runtime" | "embedded";
export type Capability =
  | "filesystem.read"
  | "filesystem.write"
  | "terminal"
  | "tasks"
  | "git"
  | "lsp"
  | "collaboration"
  | "extensions";
export interface Disposable {
  dispose(): void;
}
export type Unsubscribe = () => void;
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type ContextValues = Record<
  string,
  boolean | string | number | undefined
>;
export interface Command {
  id: string;
  title: string;
  category?: string;
  when?: string;
  shortcut?: string;
  priority?: number;
  run(args?: unknown): unknown | Promise<unknown>;
}
export interface Setting {
  id: string;
  title: string;
  description?: string;
  type: "boolean" | "number" | "string";
  default: boolean | number | string;
  enum?: (string | number)[];
  min?: number;
  max?: number;
  category?: string;
}
export type ContributionKind =
  | "activityView"
  | "panel"
  | "tab"
  | "toolbar"
  | "statusItem"
  | "documentView"
  | "theme"
  | "icon"
  | "menu"
  | "shortcut"
  | "language"
  | "diagnostics"
  | "completion"
  | "formatter"
  | "codeAction"
  | "filesystem"
  | "transport"
  | "outputChannel"
  | "editorDecoration";
export interface Contribution {
  id: string;
  owner?: string;
  kind: ContributionKind;
  title: string;
  order?: number;
  priority?: number;
  when?: string;
  command?: string;
  location?: string;
  component?: ComponentType<any>;
  data?: unknown;
}
export interface DocumentViewContributionData {
  extensions?: string[];
  matches?: (path: string) => boolean;
  default?: boolean;
}
export interface LanguageDefinition {
  id: string;
  extensions: string[];
  editorExtensions?: unknown[];
}
export interface EditorDecorationContribution {
  extensions?: unknown[];
  createExtensions?: (document: { path: string; id: string }) => unknown[];
}
export interface FileSystemProvider {
  open(): FileSystem | Promise<FileSystem>;
}
export interface ProviderDocument {
  id: string;
  path: string;
  text: string;
  version: number;
  revision: string;
  language: string;
}
export interface LanguageTransportProvider {
  languages: string[];
  createTransport(context: {
    workspaceId: string;
    signal: AbortSignal;
  }): LanguageTransport;
  rootUri?: string;
}
export interface ProviderDiagnostic {
  from: number;
  to: number;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  source?: string;
}
export interface DiagnosticsProvider {
  languages: string[];
  provideDiagnostics(
    document: ProviderDocument,
    signal: AbortSignal,
  ): ProviderDiagnostic[] | Promise<ProviderDiagnostic[]>;
}
export interface ProviderCompletion {
  label: string;
  detail?: string;
  insertText?: string;
  from?: number;
  to?: number;
}
export interface CompletionProvider {
  languages: string[];
  triggerCharacters?: string[];
  provideCompletions(
    document: ProviderDocument,
    offset: number,
    signal: AbortSignal,
  ): ProviderCompletion[] | Promise<ProviderCompletion[]>;
}
export interface ProviderCodeAction {
  title: string;
  edits?: DocumentEdit[];
  resources?: ResourceEdit[];
}
export interface CodeActionProvider {
  languages: string[];
  provideCodeActions(
    document: ProviderDocument,
    range: { from: number; to: number },
    signal: AbortSignal,
  ): ProviderCodeAction[] | Promise<ProviderCodeAction[]>;
}
export interface OpenViewOptions {
  groupId?: string;
  path?: string;
  contributionId?: string;
}
export interface ExtensionManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  sdk: string;
  environments: Environment[];
  description?: string;
  dependencies?: Record<string, string>;
  activation: string[];
  capabilities: Capability[];
  configuration?: Setting[];
  commands?: Omit<Command, "run">[];
  contributions?: Omit<Contribution, "component">[];
}
export interface CommandService {
  register(command: Command): Disposable;
  execute(id: string, args?: unknown): Promise<unknown>;
  list(): Command[];
  available(id: string): { enabled: boolean; reason?: string };
  resolveShortcut(key: string): Command | undefined;
}
export interface ContextService {
  set(key: string, value: ContextValues[string]): void;
  get(key: string): ContextValues[string];
  matches(expression?: string): boolean;
  subscribe(listener: () => void): Unsubscribe;
}
export interface ConfigurationService {
  register(setting: Setting): Disposable;
  get<T = unknown>(id: string, language?: string): T;
  set(
    id: string,
    value: unknown,
    scope?: "user" | "workspace",
    language?: string,
  ): void;
  reset(id: string, scope?: "user" | "workspace", language?: string): void;
  list(): Setting[];
  subscribe(listener: () => void): Unsubscribe;
  export(): unknown;
  import(data: unknown): void;
}
export interface ContributionService {
  register(value: Contribution, owner?: string): Disposable;
  list(kind?: ContributionKind): Contribution[];
  subscribe(listener: () => void): Unsubscribe;
}
export interface ServiceRegistry {
  register<T>(id: string, value: T): Disposable;
  get<T>(id: string): T;
  optional<T>(id: string): T | undefined;
}
export interface EventMap {
  "document.open": { id: string; path: string };
  "document.change": { id: string; version: number; origin: unknown };
  "document.save": { id: string; revision: string };
  "document.close": { id: string };
  "workspace.change": { id: string; state?: "opened" | "closed" };
  "editor.active": { id: string; viewId: string };
  "editor.selection": {
    id: string;
    viewId: string;
    anchor: number;
    head: number;
  };
  "command.execute": { id: string };
  "diagnostics.change": { path: string; diagnostics: unknown[] };
  "terminal.change": { id: string; state: string };
  "connection.change": { state: string };
  "extension.change": { id: string; state: string; error?: string };
}
export interface EventService {
  on<K extends keyof EventMap>(
    event: K,
    listener: (value: EventMap[K]) => void,
  ): Disposable;
  emit<K extends keyof EventMap>(event: K, value: EventMap[K]): void;
}
export interface SaveHookContext {
  documentId: string;
  path: string;
  text: string;
  signal: AbortSignal;
}
export interface HookService {
  beforeSave(
    id: string,
    handler: (ctx: SaveHookContext) => void | string | Promise<void | string>,
    order?: number,
  ): Disposable;
  runBeforeSave(ctx: SaveHookContext, timeoutMs?: number): Promise<string>;
}
export interface ExtensionContext {
  readonly id: string;
  readonly signal: AbortSignal;
  commands: CommandService;
  context: ContextService;
  configuration: ConfigurationService;
  contributions: ContributionService;
  services: ServiceRegistry;
  events: EventService;
  hooks: HookService;
  own<T extends Disposable>(value: T): T;
  subscribe(cleanup: Unsubscribe): void;
}
export interface Extension {
  manifest: ExtensionManifest;
  activate(
    ctx: ExtensionContext,
  ): void | Disposable | Promise<void | Disposable>;
}
export type ExtensionState =
  "registered" | "activating" | "active" | "disabled" | "failed";
export interface ExtensionRecord {
  manifest: ExtensionManifest;
  state: ExtensionState;
  error?: string;
}
export interface ExtensionService {
  register(extension: Extension): void;
  activate(id: string): Promise<void>;
  trigger(event: string): Promise<void>;
  disable(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  update(extension: Extension): Promise<void>;
  load(url: string, options?: { activate?: boolean }): Promise<string>;
  list(): ExtensionRecord[];
  subscribe(listener: () => void): Unsubscribe;
}
export interface Kernel {
  commands: CommandService;
  context: ContextService;
  configuration: ConfigurationService;
  contributions: ContributionService;
  services: ServiceRegistry;
  events: EventService;
  hooks: HookService;
  extensions: ExtensionService;
  dispose(): void;
}
export type Encoding = "utf-8" | "utf-8-bom" | "utf-16le" | "latin1";
export type Eol = "LF" | "CRLF";
export interface FileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size?: number;
  readonly?: boolean;
  revision?: string;
}
export interface FileSnapshot {
  sharedUpdate?: string;
  path: string;
  text: string;
  revision: string;
  encoding: Encoding;
  eol: Eol;
  readonly?: boolean;
}
export interface WriteOptions {
  expectedRevision: string | null;
  encoding?: Encoding;
  eol?: Eol;
}
export interface FileChange {
  path: string;
  kind: "created" | "changed" | "deleted";
}
export interface FileSystem {
  readonly id: string;
  list(path?: string): Promise<FileEntry[]>;
  read(path: string): Promise<FileSnapshot>;
  readDisk?(path: string): Promise<FileSnapshot>;
  write(
    path: string,
    text: string,
    options: WriteOptions,
  ): Promise<FileSnapshot>;
  mkdir(path: string): Promise<void>;
  rename(path: string, to: string): Promise<void>;
  delete(path: string): Promise<void>;
  watch(listener: (event: FileChange) => void): Disposable;
  dispose?(): void;
}
export interface Persistence {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}
export interface DocumentEdit {
  path: string;
  expectedVersion?: number;
  expectedRevision?: string;
  edits: TextEdit[];
}
export interface ResourceEdit {
  kind: "create" | "rename" | "delete";
  path: string;
  to?: string;
}
export interface RpcClient {
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal; id?: string },
  ): Promise<T>;
  subscribe(event: string, listener: (params: any) => void): Unsubscribe;
  readonly connected: boolean;
}
export interface LanguageTransport {
  request<T = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  notify(method: string, params: unknown): void;
  onNotification(listener: (method: string, params: any) => void): Disposable;
  dispose(): void;
}
export interface HostAdapter {
  environment: Environment;
  filesystem: FileSystem;
  persistence: Persistence;
  runtime?: RpcClient;
  pickDirectory?: () => Promise<FileSystem>;
  clipboard?: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
  };
}
export interface Formatter {
  id: string;
  languages: string[];
  format(
    text: string,
    path: string,
    options: { tabSize: number; insertSpaces: boolean; signal?: AbortSignal },
  ): Promise<string>;
}

export interface NotifyOptions {
  ttl?: number;
  actions?: { title: string; command: string; args?: unknown }[];
  source?: string;
}
export interface WorkbenchService {
  ask(
    title: string,
    message: string,
    choices?: string[],
    danger?: boolean,
  ): Promise<string | undefined>;
  prompt(title: string, value?: string): Promise<string | undefined>;
  openFile(
    path: string,
    options?: {
      line?: number;
      col?: number;
      from?: number;
      to?: number;
      preview?: boolean;
      groupId?: string;
    },
  ): void | Promise<void>;
  openPanel(id: string): void;
  togglePanel(id: string): void;
  openView(
    id: string,
    title: string,
    component: ComponentType<any>,
    props?: any,
    options?: OpenViewOptions,
  ): void;
  split(direction: "row" | "column"): string | undefined;
  notify(message: string, type?: string, options?: NotifyOptions): void;
  showContextMenu(
    location: string,
    x: number,
    y: number,
    commands?: string[],
  ): void;
  activePath(): string | undefined;
  activeEditor(): any;
  editorForPath(path: string): any;
  openPalette(mode?: string): void;
  closeView(id: string): void;
  refreshFiles(): void | Promise<void>;
}
export interface FeatureOptions {
  kernel: Kernel;
  documents: any;
  filesystem: FileSystem;
  runtime?: RpcClient;
  workbench: WorkbenchService;
}
