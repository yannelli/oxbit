import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RpcError, type RuntimeIdentity } from "@oxbit/protocol";
import type { FileEntry } from "@oxbit/sdk";

export interface NativeError {
  code: string;
  message: string;
}
export interface OpenedRoot {
  id: string;
  root: string;
  name: string;
}
export interface Folder {
  id: string;
  name: string;
  path: string;
  stale: boolean;
}
export interface WriteResult {
  revision: string;
  size: number;
}
export interface GitAccount {
  id: string;
  provider: "github" | "gitea";
  host: string;
  url?: string;
  login: string;
  isDefault: boolean;
}
export interface GitCredentials {
  name?: string;
  email?: string;
  accounts: GitAccount[];
}
export interface SshKeyInfo {
  id: string;
  name: string;
  algorithm: string;
  fingerprint: string;
  publicKey: string;
}
export interface KnownHostKey {
  algorithm: string;
  fingerprint: string;
  added: number;
}
export type SshAuth = "key" | "password";
export interface SshHostInput {
  id?: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth: SshAuth;
  keyId?: string;
}
export interface SshHost extends SshHostInput {
  id: string;
  passwordSaved: boolean;
  knownKeys?: KnownHostKey[];
}
export interface SshHostKey {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}
export type SshConnectOutcome =
  | { status: "connected"; home: string }
  | { status: "hostUnknown"; hostKey: SshHostKey }
  | { status: "hostChanged"; hostKey: SshHostKey; known: KnownHostKey[] }
  | { status: "passwordRequired" };
export type GitSshPrompt =
  | { status: "hostUnknown"; hostKey: SshHostKey }
  | { status: "hostChanged"; hostKey: SshHostKey; known: KnownHostKey[] }
  | { status: "keyRequired"; hostname: string; port: number; username: string };
export interface PickedFile {
  name: string;
  path: string;
  size: number;
}
export interface TransferProgress {
  transferred: number;
  total: number;
  file: string;
}
export interface TransferSummary {
  files: number;
  bytes: number;
}
export type GitCredentialRequest =
  | { operation: "get" }
  | { operation: "save"; name: string; email: string }
  | { operation: "addGitHub"; token: string }
  | { operation: "addGitea"; url: string; token: string }
  | { operation: "remove" | "setDefault"; id: string };
export interface RuntimeCredentialRequest {
  operation: "get" | "pair" | "forget" | "health";
  url: string;
  /** Keys the Keychain item by runtime ID; a saved URL item moves to it on `get`. */
  runtimeId?: string;
  code?: string;
}
/** Workspace storage key holding the account ID that native Git uses for the workspace root. */
export const GIT_ACCOUNT_KEY = "git-account";
/** Workspace storage key holding the SSH key ID that native Git uses for SSH remotes. */
export const GIT_SSH_KEY = "git-ssh-key";

export interface CommitSigningKey {
  fingerprint: string;
  keyId: string;
  userIds: string[];
  /** Unix seconds. */
  createdAt: number;
  publicKey: string;
}
export interface CommitSigningState {
  enabled: boolean;
  key?: CommitSigningKey;
}
export type CommitSigningRequest =
  | { operation: "get" | "remove" }
  | { operation: "generate"; name: string; email: string }
  | { operation: "import"; secretKey: string; passphrase?: string }
  | { operation: "setEnabled"; enabled: boolean };

function isNativeError(value: unknown): value is NativeError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NativeError).code === "string" &&
    typeof (value as NativeError).message === "string"
  );
}

/** Rust commands reject with `{ code, message }`; documents classify these by code and message text. */
export function toError(error: unknown): Error {
  if (isNativeError(error)) return new RpcError(error.code, error.message);
  if (typeof error === "string") {
    try {
      const parsed: unknown = JSON.parse(error);
      if (isNativeError(parsed)) return new RpcError(parsed.code, parsed.message);
    } catch {
      // A plain string error keeps its text.
    }
    return new Error(error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function call<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await invoke<T>(command, args, options);
  } catch (error) {
    throw toError(error);
  }
}

function rawWrite(command: string, id: string, path: string, bytes: Uint8Array, expectedRevision: string | null) {
  return call<WriteResult>(command, bytes, {
    headers: {
      "x-oxbit-root": id,
      "x-oxbit-path": encodeURIComponent(path),
      "x-oxbit-expected": expectedRevision ?? "",
    },
  });
}

/** A runtime started on an SSH host, reached through a loopback tunnel. */
export interface RemoteRuntimeStarted {
  url: string;
  token: string;
  workspaceKey: string;
  root: string;
  openFile?: string | null;
}
export type RemoteRuntimeEvent =
  | { state: "progress"; message: string }
  | { state: "running" }
  | { state: "reconnecting"; message: string }
  | { state: "failed"; message: string };

/** SFTP workspace roots take the same arguments as device roots. */
export const ssh = {
  closeRoot: (id: string) => call<void>("ios_ssh_close_root", { id }),
  list: (id: string, path: string) => call<FileEntry[]>("ios_ssh_fs_list", { id, path }),
  read: (id: string, path: string) => call<ArrayBuffer>("ios_ssh_fs_read", { id, path }),
  write: (id: string, path: string, bytes: Uint8Array, expectedRevision: string | null) =>
    rawWrite("ios_ssh_fs_write", id, path, bytes, expectedRevision),
  mkdir: (id: string, path: string) => call<void>("ios_ssh_fs_mkdir", { id, path }),
  rename: (id: string, path: string, to: string) => call<void>("ios_ssh_fs_rename", { id, path, to }),
  delete: (id: string, path: string) => call<void>("ios_ssh_fs_delete", { id, path }),
  openRoot: (hostId: string, path: string) => call<OpenedRoot>("ios_ssh_open_root", { hostId, path }),
  hosts: () => call<SshHost[]>("ios_ssh_hosts_list"),
  saveHost: (host: SshHostInput) => call<SshHost>("ios_ssh_host_save", { host }),
  removeHost: (id: string) => call<void>("ios_ssh_host_remove", { id }),
  forgetPassword: (id: string) => call<void>("ios_ssh_forget_password", { id }),
  keys: async () => (await call<{ keys: SshKeyInfo[] }>("plugin:oxbit-files|ssh_keys", { request: { operation: "list" } })).keys,
  deleteKey: async (id: string) =>
    (await call<{ keys: SshKeyInfo[] }>("plugin:oxbit-files|ssh_keys", { request: { operation: "delete", id } })).keys,
  generateKey: (name: string) => call<SshKeyInfo>("ios_ssh_keys_generate", { name }),
  importKey: (request: { name: string; text?: string; path?: string; passphrase?: string }) =>
    call<SshKeyInfo>("ios_ssh_keys_import", request),
  connect: (hostId: string, password?: string, savePassword?: boolean) =>
    call<SshConnectOutcome>("ios_ssh_connect", { hostId, password, savePassword }),
  trust: (hostId: string, hostKey: Pick<SshHostKey, "algorithm" | "fingerprint">) =>
    call<void>("ios_ssh_trust", { hostId, algorithm: hostKey.algorithm, fingerprint: hostKey.fingerprint }),
  forgetHostKey: (hostId: string) => call<void>("ios_ssh_forget_host_key", { hostId }),
  disconnect: (hostId: string) => call<void>("ios_ssh_disconnect", { hostId }),
  gitPrompt: (id: string) => call<GitSshPrompt | null>("ios_ssh_git_prompt", { id }),
  gitTrust: (id: string, fingerprint: string) => call<void>("ios_ssh_git_trust", { id, fingerprint }),
  gitForgetHostKey: (id: string) => call<void>("ios_ssh_git_forget_host_key", { id }),
  pickFiles: async (multiple = false) =>
    (await call<{ files: PickedFile[] }>("plugin:oxbit-files|pick_files", { multiple })).files,
  upload: (id: string, transferId: string, directory: string, files: string[]) =>
    call<TransferSummary>("ios_ssh_upload", { id, transferId, directory, files }),
  download: (id: string, transferId: string, path: string, destination: string) =>
    call<TransferSummary>("ios_ssh_download", { id, transferId, path, destination }),
  cancelTransfer: (transferId: string) => call<void>("ios_ssh_transfer_cancel", { transferId }),
  onTransfer: (transferId: string, listener: (progress: TransferProgress) => void) =>
    listen<TransferProgress>(`ios-ssh-transfer:${transferId}`, (event) => listener(event.payload)),
  /** `keepAlive` is milliseconds after the last client; 0 runs until stopped; omitted uses 75000. */
  runtimeStart: (id: string, hostId: string, path: string, keepAlive?: number) =>
    call<RemoteRuntimeStarted>("ios_ssh_runtime_start", { id, hostId, path, keepAlive }),
  runtimeResume: (id: string) => call<RemoteRuntimeStarted>("ios_ssh_runtime_resume", { id }),
  runtimeStop: (id: string) => call<void>("ios_ssh_runtime_stop", { id }),
  onRuntime: (id: string, listener: (event: RemoteRuntimeEvent) => void) =>
    listen<RemoteRuntimeEvent>(`ios-ssh-runtime:${id}`, (event) => listener(event.payload)),
};

export const native = {
  lspMessage: (request: { workspaceId: string; sessionId: string; kind: "typescript" | "json" | "yaml" | "dockerfile" | "shell" | "python"; method: string; params: unknown }) =>
    call<{ payload: string }>("ios_lsp_message", request),
  gitCredentials: (request: GitCredentialRequest) =>
    call<GitCredentials>("plugin:oxbit-files|git_credentials", { request }),
  commitSigning: (request: CommitSigningRequest) =>
    call<CommitSigningState>("plugin:oxbit-files|commit_signing", { request }),
  copyText: (text: string) => call<void>("plugin:clipboard-manager|write_text", { text }),
  gitRequest: <T>(id: string, requestId: string, method: string, params: Record<string, unknown>) =>
    call<T>("ios_git_request", { id, requestId, method, params }),
  gitCancel: (id: string, requestId: string) => call<void>("ios_git_cancel", { id, requestId }),
  /** `health` reads `/api/health` natively; `pair` returns the runtime identity when it reports one. */
  runtimeCredentials: (request: RuntimeCredentialRequest) =>
    call<{ token?: string; runtime?: RuntimeIdentity }>("plugin:oxbit-files|runtime_credentials", { request }),
  storageGet: <T>(scope: string, key: string) => call<T | null>("ios_storage_get", { scope, key }),
  storageSet: (scope: string, key: string, value: unknown) =>
    call<void>("ios_storage_set", { scope, key, value: value ?? null }),
  documentsPath: () => call<string>("ios_documents_path"),
  openRoot: (path: string) => call<OpenedRoot>("ios_fs_open_root", { path }),
  closeRoot: (id: string) => call<void>("ios_fs_close_root", { id }),
  list: (id: string, path: string) => call<FileEntry[]>("ios_fs_list", { id, path }),
  read: (id: string, path: string) => call<ArrayBuffer>("ios_fs_read", { id, path }),
  write: (id: string, path: string, bytes: Uint8Array, expectedRevision: string | null) =>
    rawWrite("ios_fs_write", id, path, bytes, expectedRevision),
  mkdir: (id: string, path: string) => call<void>("ios_fs_mkdir", { id, path }),
  rename: (id: string, path: string, to: string) => call<void>("ios_fs_rename", { id, path, to }),
  delete: (id: string, path: string) => call<void>("ios_fs_delete", { id, path }),
  watch: (id: string) => call<void>("ios_fs_watch", { id }),
  unwatch: (id: string) => call<void>("ios_fs_unwatch", { id }),
  iconPacksRead: <T>() => call<T[]>("ios_icon_packs_read"),
  iconPacksMutate: (operation: string, id: string, pack?: unknown, enabled?: boolean) =>
    call<void>("ios_icon_packs_mutate", { operation, id, pack, enabled }),
  external: (url: string) => call<void>("ios_open_external", { url }),
  pickFolder: () => call<Folder>("plugin:oxbit-files|pick_folder"),
  openFolder: (id: string) => call<Folder>("plugin:oxbit-files|open_folder", { id }),
  closeFolder: (id: string) => call<void>("plugin:oxbit-files|close_folder", { id }),
  forgetFolder: (id: string) => call<void>("plugin:oxbit-files|forget_folder", { id }),
};

/** Workspace search on device roots; `method` is `search` for content or `files` for quick open. */
export const search = {
  request: <T>(id: string, requestId: string, method: "search" | "files", params: Record<string, unknown>) =>
    call<T>("ios_search_request", { id, requestId, method, params }),
  cancel: (id: string, requestId: string) => call<void>("ios_search_cancel", { id, requestId }),
};
