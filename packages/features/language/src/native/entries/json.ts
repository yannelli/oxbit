import "../prelude.js";
import { createServer as create } from "../server.js";
import { JsonServer } from "../json.js";
import type { NativeFileHost, ServerOptions } from "../files.js";

export function createServer(options: ServerOptions, host: NativeFileHost) {
  return create(options, host, async (files, host, settings) => {
    const service = new JsonServer(files, host);
    await service.changed(settings ?? {});
    return service;
  });
}
