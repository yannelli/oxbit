import "../prelude.js";
import libraries from "oxbit:typescript-libraries";
import { createServer as create } from "../server.js";
import { TypeScriptServer } from "../typescript.js";
import type { NativeFileHost, ServerOptions } from "../files.js";

export function createServer(options: ServerOptions, host: NativeFileHost) {
  return create(options, host, files => new TypeScriptServer(files), libraries);
}
