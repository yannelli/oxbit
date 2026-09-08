export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_BUFFER_BYTES = 1024 * 1024;
export type ClientMessage =
  | {
      v: 1;
      type: "request";
      id: string;
      method: string;
      params: Record<string, unknown>;
    }
  | { v: 1; type: "cancel"; id: string }
  | { v: 1; type: "ack"; stream: string; seq: number };
export type ServerMessage =
  | {
      v: 1;
      type: "response";
      id: string;
      result?: unknown;
      error?: { code: string; message: string; data?: unknown };
    }
  | {
      v: 1;
      type: "event";
      event: string;
      params: Record<string, unknown>;
      stream?: string;
      seq?: number;
    };
export class RpcError extends Error {
  constructor(
    public code: string,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
export function parseClientMessage(raw: string): ClientMessage {
  if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES)
    throw new RpcError("TOO_LARGE", "Message exceeds 2 MiB");
  let m: any;
  try { m = JSON.parse(raw); }
  catch { throw new RpcError("INVALID_MESSAGE", "Message is not valid JSON"); }
  if (!m || m.v !== 1 || !["request", "cancel", "ack"].includes(m.type))
    throw new RpcError("INVALID_MESSAGE", "Invalid protocol message");
  if (m.type === "ack") {
    if (
      typeof m.stream !== "string" ||
      !m.stream || m.stream.length > 256 ||
      !Number.isSafeInteger(m.seq) ||
      m.seq < 0
    )
      throw new RpcError("INVALID_MESSAGE", "Invalid acknowledgement");
  } else if (typeof m.id !== "string" || !m.id || m.id.length > 128)
    throw new RpcError("INVALID_MESSAGE", "Invalid request ID");
  if (
    m.type === "request" &&
    (typeof m.method !== "string" ||
      !m.method ||
      m.method.length > 128 ||
      !m.params ||
      typeof m.params !== "object" ||
      Array.isArray(m.params))
  )
    throw new RpcError("INVALID_MESSAGE", "Invalid request");
  return m;
}
export function requireString(
  params: Record<string, unknown>,
  key: string,
  max = 4096,
): string {
  const value = params[key];
  if (typeof value !== "string" || value.length > max)
    throw new RpcError("INVALID_PARAMS", `Invalid ${key}`);
  return value;
}
export const operationMethods = [
  "terminal.create",
  "tasks.run",
  "git.commit",
  "git.clone",
  "git.push",
  "git.checkout",
  "git.init",
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.stageAll",
  "git.unstageAll",
  "git.hunk",
  "git.branchCreate",
  "git.branchTrack",
  "git.branchRename",
  "git.branchDelete",
  "git.merge",
  "git.continue",
  "git.abort",
  "git.cherryPick",
  "git.revert",
  "git.stashSave",
  "git.stashApply",
  "git.stashPop",
  "git.stashDrop",
  "git.remoteAdd",
  "git.remoteRemove",
  "git.publish",
  "git.pull",
  "fs.write",
  "fs.rename",
  "fs.delete",
  "fs.mkdir",
  "collab.save",
  "git.fetch",
  "git.restore",
  "terminal.kill",
  "tasks.cancel",
  "extensions.load",
  "extensions.update",
  "extensions.activate",
  "extensions.disable",
  "extensions.remove",
] as const;
