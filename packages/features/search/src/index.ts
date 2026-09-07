import { translate as tr, FileBadge } from "@oxbit/ui";
import React, { useEffect, useRef, useState } from "react";
import type { Extension, FeatureOptions } from "@oxbit/sdk";
import type { SearchMatch, SearchOptions } from "./engine";
import { SearchService } from "./service";
export * from "./engine";
export { SearchService } from "./service";
export function createFeature(o: FeatureOptions): Extension {
  const service = new SearchService(o);
  function SearchPanel() {
    const [options, setOptions] = useState<SearchOptions>({ query: "" });
    const [searched, setSearched] = useState<SearchOptions>(options);
    const [replace, setReplace] = useState("");
    const [results, setResults] = useState<SearchMatch[]>([]);
    const [preview, setPreview] = useState<SearchMatch[] | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [warnings, setWarnings] = useState<string[]>([]);
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => controller.current?.abort(), []);
    const run = async () => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setBusy(true);
      setError("");
      try {
        const found = await service.search(options, request.signal);
        if (request.signal.aborted) return;
        setResults(found);
        setSearched({ ...options });
        setPreview(null);
        setWarnings([
          ...(service.truncated
            ? [
                tr(
                  "Search stopped at 10,000 results. Narrow the query or path filters.",
                ),
              ]
            : []),
          ...service.warnings,
        ]);
      } catch (e) {
        if (!request.signal.aborted) setError(String(e));
      } finally {
        if (controller.current === request) {
          setBusy(false);
          controller.current = null;
        }
      }
    };
    const groups = new Map<string, SearchMatch[]>();
    for (const match of preview ?? results) {
      const group = groups.get(match.path) ?? [];
      group.push(match);
      groups.set(match.path, group);
    }
    const toggleFile = (path: string, checked: boolean) =>
      setSelected((current) => {
        const next = new Set(current);
        if (checked) next.add(path);
        else next.delete(path);
        return next;
      });
    return React.createElement(
      "div",
      {
        className: "feature-search",
        style: { padding: 12, display: "grid", gap: 8 },
      },
      React.createElement("input", {
        "aria-label": tr("Search files"),
        placeholder: tr("Search"),
        value: options.query,
        onChange: (e: any) => setOptions({ ...options, query: e.target.value }),
        onKeyDown: (e: any) => {
          if (e.key === "Enter") void run();
        },
      }),
      React.createElement(
        "div",
        null,
        ...(["caseSensitive", "wholeWord", "regex"] as const).map((key, i) =>
          React.createElement(
            "label",
            { key },
            React.createElement("input", {
              type: "checkbox",
              checked: !!options[key],
              onChange: (e: any) =>
                setOptions({ ...options, [key]: e.target.checked }),
            }),
            tr(["Match case", "Whole word", "Regular expression"][i]),
          ),
        ),
      ),
      ...(["include", "exclude"] as const).map((key) =>
        React.createElement("input", {
          key,
          "aria-label": tr(
            key === "include" ? "Files to include" : "Files to exclude",
          ),
          placeholder: tr(
            key === "include" ? "Files to include" : "Files to exclude",
          ),
          value: options[key] ?? "",
          onChange: (e: any) =>
            setOptions({ ...options, [key]: e.target.value }),
        }),
      ),
      React.createElement("input", {
        "aria-label": tr("Replace text"),
        placeholder: tr("Replace"),
        value: replace,
        onChange: (e: any) => setReplace(e.target.value),
      }),
      React.createElement(
        "div",
        null,
        React.createElement(
          "button",
          { onClick: () => void run(), disabled: busy },
          tr("Search"),
        ),
        busy &&
          React.createElement(
            "button",
            { onClick: () => controller.current?.abort() },
            tr("Cancel"),
          ),
        React.createElement(
          "button",
          {
            disabled: !results.length || busy,
            onClick: () =>
              void service.preview(results, searched, replace).then(
                (items) => {
                  setPreview(items);
                  setSelected(new Set(items.map((item) => item.path)));
                },
                (e) => setError(String(e)),
              ),
          },
          tr("Preview replacement"),
        ),
      ),
      error && React.createElement("p", { role: "alert" }, error),
      warnings.length > 0 &&
        React.createElement(
          "div",
          { role: "status" },
          ...warnings.map((warning) =>
            React.createElement("p", { key: warning }, warning),
          ),
        ),
      preview &&
        React.createElement(
          "div",
          null,
          React.createElement(
            "strong",
            null,
            tr("{0} replacements", {
              "0": preview.filter((match) => selected.has(match.path)).length,
            }),
          ),
          React.createElement(
            "button",
            {
              disabled: !selected.size,
              onClick: () =>
                void service
                  .apply(preview.filter((match) => selected.has(match.path)))
                  .then(
                    (result) => {
                      setError(
                        result.failures
                          .map((failure) => failure.path + ": " + failure.error)
                          .join("\n"),
                      );
                      setPreview(null);
                      setResults([]);
                      o.workbench.notify(
                        tr("{0} files updated", { "0": result.applied }),
                      );
                    },
                    (e) => setError(String(e)),
                  ),
            },
            tr("Apply replacements"),
          ),
          React.createElement(
            "button",
            {
              onClick: () =>
                void o.workbench
                  .ask(
                    tr("Discard replacement preview?"),
                    tr("No replacements have been applied."),
                    [tr("Discard"), tr("Cancel")],
                  )
                  .then((choice) => {
                    if (choice === tr("Discard")) setPreview(null);
                  }),
            },
            tr("Cancel"),
          ),
        ),
      React.createElement(
        "div",
        { role: "list", "aria-label": tr("Search results") },
        ...[...groups].map(([path, matches]) =>
          React.createElement(
            "section",
            { key: path, role: "listitem", "aria-label": path },
            React.createElement(
              "h3",
              { style: { margin: "8px 0", fontSize: "inherit" } },
              preview &&
                React.createElement("input", {
                  type: "checkbox",
                  checked: selected.has(path),
                  "aria-label": tr("Replace in {0}", { "0": path }),
                  onChange: (e: any) => toggleFile(path, e.target.checked),
                }),
              React.createElement(FileBadge, { path, kernel: o.kernel }),
              path,
              " (",
              matches.length,
              ")",
            ),
            ...matches.map((match) =>
              React.createElement(
                "button",
                {
                  key: match.from + ":" + match.to,
                  onClick: () =>
                    void o.workbench.openFile(match.path, {
                      from: match.from,
                      to: match.to,
                    }),
                  style: { display: "block", textAlign: "left", width: "100%" },
                },
                React.createElement(
                  "span",
                  { className: "muted" },
                  match.line + ":" + match.column,
                ),
                React.createElement(
                  "pre",
                  { style: { whiteSpace: "pre-wrap", margin: 2 } },
                  match.text,
                ),
                preview && React.createElement("ins", null, match.replacement),
              ),
            ),
          ),
        ),
      ),
    );
  }
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.search",
      name: "Workspace Search",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["filesystem.read", "filesystem.write"],
    },
    activate(ctx) {
      ctx.own(service);
      ctx.own(ctx.services.register("search", service));
      ctx.own(
        ctx.contributions.register({
          id: "search",
          kind: "activityView",
          title: "Search",
          component: SearchPanel,
          order: 20,
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "search.findInFiles",
          title: "Find in Files",
          shortcut: "Mod+Shift+F",
          run: () => o.workbench.openPanel("search"),
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "search.replaceInFiles",
          title: "Replace in Files",
          run: () => o.workbench.openPanel("search"),
        }),
      );
    },
  };
}
