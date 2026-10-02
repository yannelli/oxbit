import libraries from "oxbit:typescript-libraries";
import { createServer as create, type NativeResult } from "./server.js";
import type { NativeFileHost, ServerOptions } from "./files.js";

export function createServer(options: ServerOptions, host: NativeFileHost) {
  return create(options, host, libraries);
}
export type { NativeResult };
