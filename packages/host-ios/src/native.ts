import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { RpcError } from "@oxbit/protocol";
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
export type GitCredentialRequest =
  | { operation: "get" }
  | { operation: "save"; name: string; email: string }
  | { operation: "addGitHub"; token: string }
  | { operation: "addGitea"; url: string; token: string }
  | { operation: "remove" | "setDefault"; id: string };
/** Workspace storage key holding the account ID that native Git uses for the workspace root. */
export const GIT_ACCOUNT_KEY = "git-account";

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

export const native = {
  lspMessage: (request: { workspaceId: string; sessionId: string; kind: "typescript" | "json"; method: string; params: unknown }) =>
    call<{ payload: string }>("ios_lsp_message", request),
  gitCredentials: (request: GitCredentialRequest) =>
    call<GitCredentials>("plugin:oxbit-files|git_credentials", { request }),
  commitSigning: (request: CommitSigningRequest) =>
    call<CommitSigningState>("plugin:oxbit-files|commit_signing", { request }),
  copyText: (text: string) => call<void>("plugin:clipboard-manager|write_text", { text }),
  gitRequest: <T>(id: string, requestId: string, method: string, params: Record<string, unknown>) =>
    call<T>("ios_git_request", { id, requestId, method, params }),
  gitCancel: (id: string, requestId: string) => call<void>("ios_git_cancel", { id, requestId }),
  runtimeCredentials: (request: { operation: "get" | "pair" | "forget"; url: string; code?: string }) =>
    call<{ token?: string }>("plugin:oxbit-files|runtime_credentials", { request }),
  storageGet: <T>(scope: string, key: string) => call<T | null>("ios_storage_get", { scope, key }),
  storageSet: (scope: string, key: string, value: unknown) =>
    call<void>("ios_storage_set", { scope, key, value: value ?? null }),
  documentsPath: () => call<string>("ios_documents_path"),
  openRoot: (path: string) => call<OpenedRoot>("ios_fs_open_root", { path }),
  closeRoot: (id: string) => call<void>("ios_fs_close_root", { id }),
  list: (id: string, path: string) => call<FileEntry[]>("ios_fs_list", { id, path }),
  read: (id: string, path: string) => call<ArrayBuffer>("ios_fs_read", { id, path }),
  write: (id: string, path: string, bytes: Uint8Array, expectedRevision: string | null) =>
    call<WriteResult>("ios_fs_write", bytes, {
      headers: {
        "x-oxbit-root": id,
        "x-oxbit-path": encodeURIComponent(path),
        "x-oxbit-expected": expectedRevision ?? "",
      },
    }),
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
