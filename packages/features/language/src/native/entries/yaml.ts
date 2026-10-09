import "../prelude.js";
import { createServer as create } from "../server.js";
import { YamlServer } from "../yaml.js";
import type { NativeFileHost, ServerOptions } from "../files.js";

export function createServer(options: ServerOptions, host: NativeFileHost) {
  return create(options, host, async (files, host, settings) => {
    const service = new YamlServer(files, host);
    await service.changed(settings ?? {});
    return service;
  });
}
