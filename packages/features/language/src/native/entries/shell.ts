import "../prelude.js";
import { createServer as create } from "../server.js";
import { ShellServer } from "../shell.js";
import type { NativeFileHost, ServerOptions } from "../files.js";

export function createServer(options: ServerOptions, host: NativeFileHost) {
  return create(options, host, (files, host) => ShellServer.create(files, host));
}
