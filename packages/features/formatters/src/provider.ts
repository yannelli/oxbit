import type { Extension, Formatter } from "@zapp/sdk";
import { formatPrettier } from "./prettier";
import { formatTypeScript } from "./typescript";

function providerExtension(
  id: string,
  title: string,
  provider: "prettier" | "typescript",
  languages: string[],
): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id,
      name: title,
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      dependencies: { "zapp.formatters": "^1.0.0" },
      activation: ["*"],
      capabilities: [],
    },
    activate(ctx) {
      const formatter: Formatter = {
        id,
        languages,
        async format(text, path, options) {
          const signal = options.signal
            ? AbortSignal.any([options.signal, ctx.signal])
            : ctx.signal;
          signal.throwIfAborted();
          if (typeof Worker === "undefined")
            return (
              provider === "typescript" ? formatTypeScript : formatPrettier
            )(text, path, { ...options, signal });
          return new Promise<string>((resolve, reject) => {
            const worker = new Worker(
              new URL("./format.worker.ts", import.meta.url),
              { type: "module" },
            );
            const cleanup = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", abort);
              worker.terminate();
            };
            const abort = () => {
              cleanup();
              reject(new DOMException("Formatting cancelled", "AbortError"));
            };
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error("Formatting exceeded 15 seconds"));
            }, 15000);
            signal.addEventListener("abort", abort, { once: true });
            worker.onmessage = (event) => {
              cleanup();
              if (event.data.error) reject(new Error(event.data.error));
              else resolve(event.data.text);
            };
            worker.onerror = (event) => {
              cleanup();
              reject(new Error(event.message));
            };
            worker.postMessage({
              provider,
              text,
              path,
              tabSize: options.tabSize,
              insertSpaces: options.insertSpaces,
            });
          });
        },
      };
      ctx.contributions.register({
        id,
        kind: "formatter",
        title,
        data: formatter,
      });
    },
  };
}

export const createPrettierFeature = (): Extension =>
  providerExtension("zapp.prettier", "Prettier", "prettier", [
    "typescript",
    "tsx",
    "javascript",
    "json",
    "html",
    "css",
    "markdown",
  ]);
export const createTypeScriptFormatterFeature = (): Extension =>
  providerExtension("zapp.builtin-ts", "TypeScript formatter", "typescript", [
    "typescript",
    "tsx",
    "javascript",
    "json",
  ]);
