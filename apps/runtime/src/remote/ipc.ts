import * as fs from "node:fs/promises";
import net from "node:net";

/** Method name to handler; a thrown error with a string `code` is returned to the caller. */
export type IpcHandlers = Record<string, (params: Record<string, unknown>) => unknown>;

export class HostNotRunning extends Error {
  readonly code = "HOST_NOT_RUNNING";
  constructor() {
    super('The remote access host is not running. Run "oxbit remote enable", or "oxbit remote serve" when the login item is off.');
  }
}
export class IpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const probe = (socketPath: string) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/** Newline-delimited JSON requests on a Unix socket readable by the owner only. */
export async function serveIpc(socketPath: string, handlers: IpcHandlers): Promise<{ close(): Promise<void> }> {
  if (await probe(socketPath)) throw new IpcError("HOST_RUNNING", `Another oxbit remote host is serving ${socketPath}`);
  await fs.rm(socketPath, { force: true });
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1024 * 1024) return socket.destroy();
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void answer(line).then((reply) => {
          if (!socket.destroyed) socket.write(JSON.stringify(reply) + "\n");
        });
      }
    });
  });
  const answer = async (line: string) => {
    let request: { id?: unknown; method?: unknown; params?: unknown };
    try {
      request = JSON.parse(line);
    } catch {
      return { error: { code: "INVALID_REQUEST", message: "Invalid JSON" } };
    }
    const handler = typeof request.method === "string" ? handlers[request.method] : undefined;
    try {
      if (!handler) throw new IpcError("METHOD_NOT_FOUND", `Unknown method ${String(request.method)}`);
      return { id: request.id, result: (await handler((request.params ?? {}) as Record<string, unknown>)) ?? null };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return { id: request.id, error: { code: typeof code === "string" ? code : "INTERNAL", message: (error as Error).message } };
    }
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await fs.chmod(socketPath, 0o600);
  return {
    async close() {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
    },
  };
}

const NOT_RUNNING = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "ENOTDIR"]);

/** One request to the running host; rejects with HostNotRunning when nothing listens. */
export function ipcRequest<T = any>(socketPath: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new IpcError("TIMEOUT", `The remote access host did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    socket.once("connect", () => socket.write(JSON.stringify({ id: 1, method, params }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      let reply: { result?: unknown; error?: { code: string; message: string } };
      try {
        reply = JSON.parse(buffer.slice(0, index));
      } catch {
        return done(() => reject(new IpcError("INVALID_REPLY", `The remote access host sent an invalid reply to ${method}`)));
      }
      done(() => (reply.error ? reject(new IpcError(reply.error.code, reply.error.message)) : resolve(reply.result as T)));
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done(() => reject(NOT_RUNNING.has(error.code ?? "") ? new HostNotRunning() : error)),
    );
    socket.once("close", () => done(() => reject(new IpcError("CLOSED", `The remote access host closed the connection during ${method}`))));
  });
}

/** True when a host answers on the control socket. */
export const hostRunning = (socketPath: string) =>
  ipcRequest(socketPath, "ping", {}, 3000).then(
    () => true,
    () => false,
  );
