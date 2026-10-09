import "../prelude.js";
import { createServer as create } from "../server.js";
import { DockerfileServer } from "../dockerfile.js";
import type { NativeFileHost, ServerOptions } from "../files.js";

// dockerfile-ast checks for a UTF-8 BOM with `Buffer.from(char, "UTF-8")`; this context has no Buffer.
(globalThis as any).Buffer ??= { from: (text: string) => new TextEncoder().encode(text) };

export function createServer(options: ServerOptions, host: NativeFileHost) {
  return create(options, host, files => new DockerfileServer(files));
}
