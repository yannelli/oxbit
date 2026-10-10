import "../prelude.js";
import { createServer as create } from "../server.js";
import { PythonServer } from "../python.js";
import type { NativeFileHost, ServerOptions } from "../files.js";

export function createServer(options: ServerOptions, host: NativeFileHost) {
  return create(options, host, (files, host) => new PythonServer(files, host));
}
