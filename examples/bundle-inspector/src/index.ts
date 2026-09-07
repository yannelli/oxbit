import { createElement, useEffect, useState } from "react";
import type {
  Extension,
  ExtensionContext,
  FileSnapshot,
  FileSystem,
  WorkbenchService,
} from "@oxbit/sdk";

interface Chunk {
  path: string;
  bytes: number;
  gzip?: number;
  modules?: number;
  error?: string;
}
interface BundleReport {
  directory: string;
  files: Chunk[];
  total: number;
  gzip: number;
  truncated: boolean;
  running: boolean;
  error?: string;
}
const kilobytes = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;
const colors = [
  "#818cf8",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#60a5fa",
  "#fb923c",
];
const contentBytes = (file: FileSnapshot): Uint8Array<ArrayBuffer> => {
  const text =
    file.eol === "CRLF"
      ? file.text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")
      : file.text;
  if (file.encoding === "latin1")
    return Uint8Array.from(text, (character) => character.charCodeAt(0));
  if (file.encoding === "utf-16le") {
    const bytes = new Uint8Array(text.length * 2 + 2);
    bytes.set([255, 254]);
    for (let index = 0; index < text.length; index++) {
      bytes[index * 2 + 2] = text.charCodeAt(index) & 255;
      bytes[index * 2 + 3] = text.charCodeAt(index) >> 8;
    }
    return bytes;
  }
  const bytes = new TextEncoder().encode(text);
  if (file.encoding !== "utf-8-bom") return bytes;
  const result = new Uint8Array(bytes.length + 3);
  result.set([239, 187, 191]);
  result.set(bytes, 3);
  return result;
};

export const extension: Extension = {
  manifest: {
    manifestVersion: 1,
    id: "orbitlabs.bundle-inspector",
    name: "Bundle Inspector",
    version: "1.0.0",
    sdk: "^1.0.0",
    environments: ["browser", "embedded"],
    activation: ["onStartup", "onCommand:bundle.analyze", "onCommand:bundle.openReport"],
    commands: [
      { id: "bundle.analyze", title: "Bundle Inspector: Analyze", category: "Bundle Inspector", when: "workspace" },
      { id: "bundle.openReport", title: "Bundle Inspector: Open Report", category: "Bundle Inspector", when: "workspace" },
    ],
    capabilities: ["filesystem.read"],
    description:
      "Measure workspace file sizes and gzip sizes through the public extension SDK.",
    configuration: [
      {
        id: "bundle.outputDirectory",
        title: "Bundle output directory",
        type: "string",
        default: "dist",
        category: "Bundle Inspector",
      },
      {
        id: "bundle.budgetKB",
        title: "Bundle size budget (kB)",
        type: "number",
        default: 500,
        min: 1,
        max: 1000000,
        category: "Bundle Inspector",
      },
    ],
  },
  activate(ctx: ExtensionContext) {
    let report: BundleReport = {
      directory: "",
      files: [],
      total: 0,
      gzip: 0,
      truncated: false,
      running: false,
    };
    const listeners = new Set<() => void>();
    const output: { lines: string[] } = { lines: [] };
    const announce = () => {
      for (const listener of listeners) listener();
    };
    let controller: AbortController | undefined;
    const workbench = () => ctx.services.optional<WorkbenchService>("workbench");
    const cancel = () => controller?.abort();
    ctx.signal.addEventListener("abort", cancel);
    const run = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const filesystem = ctx.services.get<FileSystem>("filesystem");
      report = {
        directory: ctx.configuration.get<string>("bundle.outputDirectory"),
        files: [],
        total: 0,
        gzip: 0,
        truncated: false,
        running: true,
      };
      const result = report;
      workbench()?.openPanel("bundle");
      announce();
      const check = () => {
        if (signal.aborted || ctx.signal.aborted)
          throw new DOMException("Analysis cancelled", "AbortError");
      };
      try {
        let entries: Awaited<ReturnType<FileSystem["list"]>>;
        try {
          entries = await filesystem.list(result.directory);
        } catch (error) {
          if (
            !/ENOENT|not found|missing|does not exist/i.test(
              error instanceof Error ? error.message : String(error),
            )
          )
            throw error;
          result.directory = "";
          entries = await filesystem.list("");
        }
        check();
        if (entries.length === 0 && result.directory) {
          result.directory = "";
          entries = await filesystem.list("");
        }
        const scan = async (
          files: Awaited<ReturnType<FileSystem["list"]>>,
        ): Promise<void> => {
          for (const entry of files) {
            check();
            if (result.files.length >= 2000) {
              result.truncated = true;
              return;
            }
            if (entry.kind === "directory") {
              if (!["node_modules", ".git", ".oxbit", ".zapp"].includes(entry.name))
                await scan(await filesystem.list(entry.path));
              continue;
            }
            const chunk: Chunk = { path: entry.path, bytes: entry.size ?? 0 };
            if (!entry.size || entry.size <= 2_000_000) {
              try {
                const snapshot = await filesystem.read(entry.path);
                const bytes = contentBytes(snapshot);
                chunk.bytes = bytes.length;
                if (typeof CompressionStream !== "undefined")
                  chunk.gzip = (
                    await new Response(
                      new Blob([bytes])
                        .stream()
                        .pipeThrough(new CompressionStream("gzip")),
                    ).arrayBuffer()
                  ).byteLength;
                if (/\.[cm]?js$/.test(entry.name)) {
                  try {
                    const map = JSON.parse(
                      (await filesystem.read(`${entry.path}.map`)).text,
                    ) as { sources?: unknown[] };
                    if (Array.isArray(map.sources))
                      chunk.modules = map.sources.length;
                  } catch {}
                }
              } catch (error) {
                chunk.error =
                  error instanceof Error ? error.message : String(error);
              }
            }
            check();
            result.files.push(chunk);
            result.total += chunk.bytes;
            result.gzip += chunk.gzip ?? 0;
          }
        };
        await scan(entries);
        result.files.sort(
          (a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path),
        );
      } catch (error) {
        if (signal.aborted || ctx.signal.aborted) return;
        result.error = error instanceof Error ? error.message : String(error);
      } finally {
        result.running = false;
        if (!signal.aborted && !ctx.signal.aborted) {
          output.lines.push(
            `${new Date().toISOString()} ${result.directory || "workspace"}: ${result.files.length} files, ${result.total} bytes${result.error ? `, ${result.error}` : ""}`,
          );
          if (output.lines.length > 200) output.lines.shift();
          announce();
        }
      }
      return result;
    };
    const openReport = () =>
      workbench()?.openView("bundle.report", "Bundle report", DocumentView, {}, { contributionId: "bundle.report" });
    function useReport() {
      const [, refresh] = useState(0);
      useEffect(() => {
        const update = () => refresh((value) => value + 1);
        listeners.add(update);
        const unsubscribe = ctx.configuration.subscribe(update);
        return () => {
          listeners.delete(update);
          unsubscribe();
        };
      }, []);
      return report;
    }
    function Chart() {
      const data = useReport();
      return createElement(
        "div",
        {
          style: {
            display: "flex",
            height: 14,
            gap: 2,
            borderRadius: 4,
            overflow: "hidden",
            margin: "12px 0",
          },
          "aria-label": "File size distribution",
        },
        ...data.files
          .slice(0, 40)
          .map((file, index) =>
            createElement("span", {
              key: file.path,
              title: `${file.path}: ${file.bytes} bytes`,
              style: {
                background: colors[index % colors.length],
                width: `${data.total ? (file.bytes / data.total) * 100 : 0}%`,
              },
            }),
          ),
      );
    }
    function Controls() {
      const data = useReport();
      return createElement(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          },
        },
        createElement("strong", null, kilobytes(data.total)),
        createElement(
          "span",
          { className: "muted" },
          `${data.files.length} files · ${data.directory || "workspace"}/ · budget ${ctx.configuration.get<number>("bundle.budgetKB")} kB`,
        ),
        createElement(
          "button",
          {
            className: "button",
            disabled: data.running,
            onClick: () => {
              void ctx.commands.execute("bundle.analyze");
            },
          },
          data.running ? "Analyzing…" : "Analyze",
        ),
        createElement(
          "button",
          { className: "button", onClick: openReport },
          "Open report",
        ),
      );
    }
    function Panel() {
      const data = useReport();
      return createElement(
        "section",
        {
          className: "bundle-inspector",
          style: { padding: 16 },
          "aria-label": "Bundle Inspector",
        },
        createElement(Controls),
        createElement(Chart),
        data.error
          ? createElement("p", { role: "alert" }, data.error)
          : createElement(
              "p",
              { className: "muted" },
              data.files.length
                ? `${kilobytes(data.gzip)} measured gzip${data.truncated ? " · First 2,000 files" : ""}`
                : "Run Analyze to measure files in the output directory.",
            ),
      );
    }
    function DocumentView() {
      const data = useReport();
      const budget = ctx.configuration.get<number>("bundle.budgetKB") * 1000;
      const header = createElement(
        "thead",
        null,
        createElement(
          "tr",
          null,
          ...["File", "Size", "Gzip", "Modules", "Share"].map((label) =>
            createElement("th", { key: label, style: { padding: 8 } }, label),
          ),
        ),
      );
      const rows = data.files.map((file, index) =>
        createElement(
          "tr",
          { key: file.path, title: file.error },
          createElement(
            "td",
            { style: { padding: 8, fontFamily: "var(--font-mono)" } },
            file.path,
          ),
          createElement("td", null, kilobytes(file.bytes)),
          createElement(
            "td",
            null,
            file.gzip === undefined ? "Not measured" : kilobytes(file.gzip),
          ),
          createElement(
            "td",
            null,
            file.modules === undefined ? "No source map" : String(file.modules),
          ),
          createElement(
            "td",
            null,
            createElement("span", {
              style: {
                display: "block",
                height: 8,
                background: colors[index % colors.length],
                width: `${data.total ? (file.bytes / data.total) * 100 : 0}%`,
                minWidth: 2,
              },
            }),
          ),
        ),
      );
      const table = createElement(
        "table",
        {
          style: {
            width: "100%",
            borderCollapse: "collapse",
            textAlign: "left",
            fontSize: 12,
          },
        },
        header,
        createElement("tbody", null, ...rows),
      );
      return createElement(
        "article",
        {
          style: { padding: 20, overflow: "auto", height: "100%", maxWidth: 880, margin: "0 auto", boxSizing: "border-box" },
          "aria-label": "Bundle report",
        },
        createElement("h2", null, "Bundle report"),
        createElement(Controls),
        createElement(Chart),
        table,
        createElement(
          "p",
          { className: "muted" },
          `Budget ${kilobytes(budget)} · ${data.total <= budget ? "Within budget" : "Over budget"}${data.truncated ? " · First 2,000 files" : ""}`,
        ),
      );
    }
    function Status() {
      const data = useReport();
      return createElement(
        "span",
        null,
        data.running ? "Analyzing…" : `Bundle ${data.total >= 1_000_000_000 ? `${(data.total / 1_000_000_000).toFixed(1)} GB` : data.total >= 1_000_000 ? `${(data.total / 1_000_000).toFixed(1)} MB` : kilobytes(data.total)}`,
      );
    }
    ctx.commands.register({
      id: "bundle.analyze",
      title: "Bundle Inspector: Analyze",
      category: "Bundle Inspector",
      when: "workspace && bundleExt",
      run,
    });
    ctx.commands.register({
      id: "bundle.openReport",
      title: "Bundle Inspector: Open Report",
      category: "Bundle Inspector",
      when: "workspace && bundleExt",
      run: openReport,
    });
    ctx.contributions.register({
      id: "bundle",
      kind: "panel",
      title: "Bundle Inspector",
      order: 90,
      component: Panel,
    });
    ctx.contributions.register({
      id: "bundle.status",
      kind: "statusItem",
      title: "Bundle Inspector",
      order: 90,
      command: "bundle.analyze",
      component: Status,
      data: { label: "Bundle" },
    });
    ctx.contributions.register({
      id: "bundle.output",
      kind: "outputChannel",
      title: "Bundle Inspector",
      data: output,
    });
    ctx.contributions.register({
      id: "bundle.report",
      kind: "documentView",
      title: "Bundle report",
      component: DocumentView,
      command: "bundle.openReport",
      data: { matches: (path: string) => path.split("/").pop() === "package.json" },
    });
    ctx.context.set("bundleExt", true);
    ctx.subscribe(() => {
      cancel();
      ctx.signal.removeEventListener("abort", cancel);
      workbench()?.closeView("bundle.report");
      listeners.clear();
      output.lines.length = 0;
      ctx.context.set("bundleExt", false);
    });
  },
};

export default extension;
