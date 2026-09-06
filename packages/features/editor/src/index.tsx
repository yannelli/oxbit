import { translate as tr, getPhrases } from "@zapp/ui";
import { useEffect, useRef, useState } from "react";
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  type Extension as CMExtension,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  highlightWhitespace,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab, selectAll } from "@codemirror/commands";
import {
  foldGutter,
  foldEffect,
  foldKeymap,
  indentOnInput,
  bracketMatching,
  syntaxHighlighting,
  HighlightStyle,
  indentUnit,
  foldAll,
  unfoldAll,
} from "@codemirror/language";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
} from "@codemirror/search";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
  startCompletion,
} from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { DocumentHandle } from "@zapp/documents";
import type { LanguageDefinition, Extension, Kernel } from "@zapp/sdk";
import { contributedLanguage, editorLanguageId } from "./languages.js";
import { contributedDecorations } from "./decorations.js";
import {
  captureView,
  restoredSelection,
  LARGE_DOCUMENT_LENGTH,
  detectedIndentation,
} from "./view-state.js";
import type { WorkbenchController } from "@zapp/workbench";
const syntax = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--tok-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--tok-string)" },
  { tag: tags.number, color: "var(--tok-number)" },
  { tag: tags.comment, color: "var(--tok-comment)" },
  { tag: [tags.typeName, tags.className], color: "var(--tok-type)" },
  { tag: tags.function(tags.variableName), color: "var(--tok-function)" },
  { tag: tags.propertyName, color: "var(--tok-property)" },
  { tag: tags.tagName, color: "var(--tok-tag)" },
  { tag: tags.attributeName, color: "var(--tok-attr)" },
  { tag: tags.punctuation, color: "var(--tok-punct)" },
  { tag: tags.operator, color: "var(--tok-operator)" },
  { tag: tags.heading, color: "var(--tok-heading)", fontWeight: "bold" },
  { tag: tags.link, color: "var(--tok-link)" },
]);
function visualWhitespace(
  mode: string,
  guides: boolean,
  tabSize: number,
): CMExtension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet)
          this.decorations = this.build(update.view);
      }
      build(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();
        const seen = new Set<number>();
        for (const range of view.visibleRanges) {
          for (let at = range.from; at <= range.to;) {
            const line = view.state.doc.lineAt(at);
            if (!seen.has(line.number)) {
              seen.add(line.number);
              const leading = line.text.match(/^[\t ]*/)?.[0] || "";
              let columns = 0;
              for (const c of leading)
                columns += c === "\t" ? tabSize - (columns % tabSize) : 1;
              if (guides && columns)
                builder.add(
                  line.from,
                  line.from,
                  Decoration.line({
                    attributes: { style: `--zapp-indent-width:${columns}ch` },
                  }),
                );
              if (mode === "boundary" || mode === "selection") {
                for (const match of line.text.matchAll(/[\t ]+/g)) {
                  const from = line.from + match.index;
                  const end = from + match[0].length;
                  if (mode === "boundary") {
                    if (
                      match[0].length > 1 ||
                      match.index === 0 ||
                      end === line.to
                    )
                      builder.add(
                        from,
                        end,
                        Decoration.mark({ class: "zapp-whitespace" }),
                      );
                  } else
                    for (const selection of view.state.selection.ranges) {
                      const a = Math.max(from, selection.from),
                        b = Math.min(end, selection.to);
                      if (a < b)
                        builder.add(
                          a,
                          b,
                          Decoration.mark({ class: "zapp-whitespace" }),
                        );
                    }
                }
              }
            }
            if (line.to >= range.to) break;
            at = line.to + 1;
          }
        }
        return builder.finish();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
export function languageFor(path: string, kernel?: Kernel): CMExtension {
  const custom = kernel ? contributedLanguage(kernel, path) : undefined;
  if (custom)
    return ((custom.data as LanguageDefinition).editorExtensions ||
      []) as CMExtension[];
  switch (path.split(".").pop()) {
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: true });
    case "json":
      return json();
    case "css":
      return css();
    case "html":
      return html();
    case "md":
      return markdown();
    default:
      return [];
  }
}
function configured(
  kernel: Kernel,
  path: string,
  content: string,
): CMExtension[] {
  const language = editorLanguageId(kernel, path);
  const get: {
    (id: string, fallback: string): string;
    (id: string, fallback: number): number;
    (id: string, fallback: boolean): boolean;
  } = (id: string, fallback: any) =>
    kernel.configuration.get(id, language) ?? fallback;
  let size = get("editor.tabSize", 2),
    spaces = get("editor.insertSpaces", true);
  if (get("editor.detectIndentation", true)) {
    const data = kernel.configuration.export() as {
      user: Record<string, unknown>;
      workspace: Record<string, unknown>;
      userLanguages: Record<string, Record<string, unknown>>;
      workspaceLanguages: Record<string, Record<string, unknown>>;
    };
    const explicit = (id: string) =>
      [
        data.user,
        data.workspace,
        data.userLanguages[language],
        data.workspaceLanguages[language],
      ].some((layer) => layer && Object.hasOwn(layer, id));
    const detected = detectedIndentation(content, size, spaces);
    if (!explicit("editor.tabSize")) size = detected.size;
    if (!explicit("editor.insertSpaces")) spaces = detected.spaces;
  }
  const fontSize = get("editor.fontSize", 13);
  const height = get("editor.lineHeight", 20) || fontSize * 1.55;
  return [
    EditorState.phrases.of(getPhrases()),
    drawSelection({
      cursorBlinkRate:
        get("editor.cursorBlinking", "blink") === "solid" ? 0 : 1200,
    }),
    visualWhitespace(
      get("editor.renderWhitespace", "selection"),
      get("editor.renderIndentGuides", true),
      size,
    ),
    EditorState.tabSize.of(size),
    indentUnit.of(spaces ? " ".repeat(size) : "\t"),
    get("editor.wordWrap", "off") !== "off" ? EditorView.lineWrapping : [],
    get("editor.renderWhitespace", "selection") === "all"
      ? highlightWhitespace()
      : [],
    EditorView.theme(
      {
        "&": {
          height: "100%",
          fontSize: `${fontSize}px`,
          backgroundColor: "var(--bg-editor)",
          color: "var(--fg)",
        },
        ".cm-scroller": {
          fontFamily: get(
            "editor.fontFamily",
            "'JetBrains Mono',ui-monospace,monospace",
          ),
          lineHeight: `${height}px`,
          overflow: "auto",
          fontVariantLigatures: get("editor.fontLigatures", false)
            ? "normal"
            : "none",
        },
        ".cm-content": {
          padding: "6px 0",
          caretColor: "var(--accent)",
          ...(get("editor.wordWrap", "off") === "bounded"
            ? { maxWidth: "90ch" }
            : {}),
        },
        ".cm-line": {
          padding: "0 8px",
          ...(get("editor.renderIndentGuides", true)
            ? {
                backgroundImage: `repeating-linear-gradient(to right,transparent 0,transparent calc(${size}ch - 1px),var(--guide) calc(${size}ch - 1px),var(--guide) ${size}ch)`,
                backgroundSize: "var(--zapp-indent-width,0) 100%",
                backgroundRepeat: "no-repeat",
              }
            : {}),
        },
        ".cm-gutters": {
          backgroundColor: "var(--bg-editor)",
          color: "var(--fg-3)",
          border: "none",
          minWidth: "56px",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          minWidth: "35px",
          paddingRight: "8px",
        },
        ".cm-foldGutter": { width: "16px" },
        ".cm-activeLine,.cm-activeLineGutter": {
          backgroundColor: "var(--line-active)",
        },
        ".cm-selectionBackground,&.cm-focused .cm-selectionBackground": {
          backgroundColor: "var(--sel)",
        },
        ".cm-cursor,.cm-dropCursor": {
          borderLeftColor: "var(--accent)",
          transition:
            get("editor.cursorBlinking", "blink") === "smooth"
              ? "opacity 160ms"
              : get("editor.cursorBlinking", "blink") === "phase"
                ? "opacity 450ms"
                : "none",
        },
        ".cm-selectionMatch": { backgroundColor: "var(--occ)" },
        ".cm-searchMatch": { backgroundColor: "var(--match)", outline: "none" },
        ".cm-searchMatch.cm-searchMatch-selected": {
          backgroundColor: "var(--match-active)",
        },
        ".cm-panels": {
          backgroundColor: "var(--bg-raised)",
          color: "var(--fg)",
          borderColor: "var(--bd)",
        },
        ".cm-tooltip": {
          backgroundColor: "var(--bg-raised)",
          color: "var(--fg)",
          borderColor: "var(--bd)",
          borderRadius: "6px",
          boxShadow: "var(--shadow)",
        },
        ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
          backgroundColor: "var(--bg-selected)",
          color: "var(--fg)",
        },
        ".cm-button": {
          background: "var(--bg-surface)",
          border: "1px solid var(--bd)",
          color: "var(--fg)",
          borderRadius: "4px",
        },
        ".cm-textfield": {
          background: "var(--bg-input)",
          color: "var(--fg)",
          borderColor: "var(--bd)",
        },
      },
      { dark: get("workbench.colorTheme", "Graphite (dark)").includes("dark") },
    ),
  ];
}
export function CodeEditor({
  handle,
  kernel,
  workbench,
  viewId,
}: {
  handle: DocumentHandle;
  kernel: Kernel;
  workbench: WorkbenchController;
  viewId: string;
}) {
  const parent = useRef<HTMLDivElement>(null),
    viewRef = useRef<EditorView | null>(null);
  const [revision, setRevision] = useState(0);
  const config = useRef(new Compartment()),
    lsp = useRef(new Compartment()),
    syntaxMode = useRef(new Compartment()),
    decorations = useRef(new Compartment()),
    readonly = useRef(new Compartment());
  useEffect(() => {
    const tick = () => setRevision((v) => v + 1);
    const unsub = kernel.configuration.subscribe(tick);
    const unlanguages = kernel.contributions.subscribe(tick);

    return () => {
      unsub();
      unlanguages();
    };
  }, [kernel]);
  useEffect(() => {
    if (!parent.current) return;
    const getLsp = () =>
      kernel.services
        .optional<{ extensions(path: string): CMExtension[] }>("language")
        ?.extensions(handle.path) || [];
    const getDecorations = () =>
      contributedDecorations(
        kernel,
        { id: handle.id, path: handle.path },
        (message) => workbench.notify(message, "error"),
      );
    const saved = handle.views.get(viewId);
    const content = handle.text.toString();
    const view = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: content,
        selection: restoredSelection(saved, content.length),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          foldGutter(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          rectangularSelection(),
          crosshairCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(syntax),
          syntaxMode.current.of(
            content.length > LARGE_DOCUMENT_LENGTH
              ? []
              : languageFor(handle.path, kernel),
          ),
          yCollab(handle.text, handle.awareness, { undoManager: handle.undo }),
          keymap.of([
            ...yUndoManagerKeymap,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          config.current.of(configured(kernel, handle.path, content)),
          decorations.current.of(getDecorations()),
          lsp.current.of(
            content.length > LARGE_DOCUMENT_LENGTH ? [] : getLsp(),
          ),
          readonly.current.of([
            EditorState.readOnly.of(handle.readonly),
            EditorView.editable.of(!handle.readonly),
          ]),
          EditorView.updateListener.of((update) => {
            if (
              update.selectionSet ||
              update.transactions.some((transaction) =>
                transaction.effects.some((effect) => effect.is(foldEffect)),
              )
            ) {
              const s = update.state.selection.main;
              handle.views.set(viewId, captureView(update.view));
              kernel.events.emit("editor.selection", {
                id: handle.id,
                viewId,
                anchor: s.anchor,
                head: s.head,
              });
            }
            if (update.docChanged) {
              workbench.keepOpen();
              const start = performance.now();
              requestAnimationFrame(() => {
                performance.measure("zapp.keystroke-to-paint", {
                  start,
                  end: performance.now(),
                });
              });
            }
          }),
          EditorView.domEventHandlers({
            focus: () => {
              workbench.editors.set(viewId, view);
              if (workbench.state.activeGroup !== viewId)
                workbench.set({ activeGroup: viewId });
              return false;
            },
            scroll: () => {
              handle.views.set(viewId, captureView(view));
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    workbench.editors.set(viewId, view);
    if (saved?.folds?.length)
      view.dispatch({
        effects: saved.folds
          .filter(
            (fold) =>
              fold.from >= 0 &&
              fold.to <= content.length &&
              fold.to > fold.from,
          )
          .map((fold) => foldEffect.of(fold)),
      });
    if (saved) {
      view.scrollDOM.scrollTop = saved.scrollTop || 0;
      view.scrollDOM.scrollLeft = saved.scrollLeft || 0;
    }
    const unsubscribe = kernel.context.subscribe(() => {
      view.dispatch({
        effects: [
          lsp.current.reconfigure(
            view.state.doc.length > LARGE_DOCUMENT_LENGTH ? [] : getLsp(),
          ),
          decorations.current.reconfigure(getDecorations()),
        ],
      });
    });
    return () => {
      handle.views.set(viewId, captureView(view));
      unsubscribe();
      if (workbench.editors.get(viewId) === view)
        workbench.editors.delete(viewId);
      view.destroy();
      viewRef.current = null;
    };
  }, [handle, kernel, workbench, viewId]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        decorations.current.reconfigure(
          contributedDecorations(
            kernel,
            { id: handle.id, path: handle.path },
            (message) => workbench.notify(message, "error"),
          ),
        ),
        syntaxMode.current.reconfigure(
          handle.text.length > LARGE_DOCUMENT_LENGTH
            ? []
            : languageFor(handle.path, kernel),
        ),
        config.current.reconfigure(
          configured(kernel, handle.path, handle.text.toString()),
        ),
        readonly.current.reconfigure([
          EditorState.readOnly.of(handle.readonly),
          EditorView.editable.of(!handle.readonly),
        ]),
      ],
    });
  }, [revision, handle, kernel, handle.readonly]);
  return (
    <div className="code-container">
      {handle.text.length > LARGE_DOCUMENT_LENGTH && (
        <div className="document-banner" role="status">
          {tr(
            "Large document: syntax, minimap, and language services are paused above 1,048,576 UTF-16 code units.",
          )}
        </div>
      )}
      <div
        className="codemirror-host"
        ref={parent}
        data-testid="code-editor"
        data-path={handle.path}
      />
      {kernel.configuration.get<boolean>("editor.minimap") &&
        handle.text.length <= LARGE_DOCUMENT_LENGTH && (
          <Minimap handle={handle} view={viewRef.current} />
        )}
    </div>
  );
}
function Minimap({
  handle,
  view,
}: {
  handle: DocumentHandle;
  view: EditorView | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const paint = () => {
      const c = ref.current;
      if (!c) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = getComputedStyle(c).color;
      handle.text
        .toString()
        .split("\n")
        .slice(0, 450)
        .forEach((line, i) =>
          ctx.fillRect(
            (line.match(/^\s*/)?.[0].length || 0) * 0.7,
            i * 2,
            Math.min(54, line.trim().length * 0.7),
            1,
          ),
        );
    };
    paint();
    handle.text.observe(paint);
    return () => handle.text.unobserve(paint);
  }, [handle]);
  return (
    <canvas
      aria-label={tr("Document minimap")}
      className="minimap"
      width="60"
      height="900"
      ref={ref}
      onClick={(e) => {
        if (view)
          view.scrollDOM.scrollTop =
            (e.nativeEvent.offsetY / e.currentTarget.clientHeight) *
            view.scrollDOM.scrollHeight;
      }}
    />
  );
}
export function createFeature({
  kernel,
  workbench,
}: {
  kernel: Kernel;
  workbench: WorkbenchController;
}): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id: "zapp.editor",
      name: "Code Editor",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
      description:
        "CodeMirror editing for TypeScript, TSX, JavaScript, JSON, CSS, HTML and Markdown.",
    },
    activate(ctx) {
      ctx.own(
        ctx.contributions.register({
          id: "zapp.editor.document",
          kind: "documentView",
          title: "Text Editor",
          order: 0,
          component: CodeEditor,
          data: { default: true },
        }),
      );
      const command = (
        id: string,
        title: string,
        run: (args?: any) => unknown,
        shortcut?: string,
      ) =>
        ctx.own(
          ctx.commands.register({
            id,
            title,
            category: "Editor",
            when: /^editor\.(close|pin|keepOpen|split|moveToNextGroup)/.test(id)
              ? "activeTab"
              : "editor",
            shortcut,
            run,
          }),
        );
      command(
        "editor.find",
        "Find",
        () => {
          const v = workbench.activeEditor();
          if (v) openSearchPanel(v);
        },
        "Ctrl+F",
      );
      command(
        "editor.replace",
        "Replace",
        () => {
          const v = workbench.activeEditor();
          if (v) {
            openSearchPanel(v);
            setTimeout(() =>
              v.dom
                .querySelector<HTMLInputElement>('input[name="replace"]')
                ?.focus(),
            );
          }
        },
        "Ctrl+H",
      );
      command(
        "editor.selectAll",
        "Select All",
        () => {
          const v = workbench.activeEditor();
          if (v) selectAll(v);
        },
        "Ctrl+A",
      );
      command(
        "editor.suggest",
        "Trigger Suggest",
        () => {
          const v = workbench.activeEditor();
          if (v) startCompletion(v);
        },
        "Ctrl+Space",
      );
      command(
        "editor.foldAll",
        "Fold All",
        () => {
          const v = workbench.activeEditor();
          if (v) foldAll(v);
        },
        "Ctrl+K Ctrl+0",
      );
      command(
        "editor.unfoldAll",
        "Unfold All",
        () => {
          const v = workbench.activeEditor();
          if (v) unfoldAll(v);
        },
        "Ctrl+K Ctrl+J",
      );
      command(
        "editor.toggleWordWrap",
        "Toggle Word Wrap",
        () =>
          kernel.configuration.set(
            "editor.wordWrap",
            kernel.configuration.get("editor.wordWrap") === "off"
              ? "on"
              : "off",
          ),
        "Alt+Z",
      );
      for (const [id, title, run, shortcut] of [
        [
          "editor.closeTab",
          "Close Editor",
          (args?: { groupId?: string; tabId?: string }) => {
            const s = workbench.state;
            const tab = workbench.activeTab();
            const id = args?.tabId || tab?.id;
            if (id)
              return workbench.closeTab(args?.groupId || s.activeGroup, id);
          },
          "Ctrl+W",
        ],
        [
          "editor.closeOthers",
          "Close Other Editors",
          async () => {
            const s = workbench.state;
            const active = workbench.activeTab();
            for (const tab of s.groups.find((g) => g.id === s.activeGroup)
              ?.tabs || [])
              if (tab.id !== active?.id && !tab.pinned)
                await workbench.closeTab(s.activeGroup, tab.id);
          },
          undefined,
        ],
        [
          "editor.pin",
          "Pin Editor",
          (args?: { groupId?: string; tabId?: string }) =>
            workbench.pin(args?.groupId, args?.tabId),
          "Ctrl+K Shift+Enter",
        ],
        [
          "editor.keepOpen",
          "Keep Editor Open",
          () => workbench.keepOpen(),
          "Ctrl+K Enter",
        ],
        [
          "editor.splitRight",
          "Split Editor Right",
          () => workbench.split("row"),
          "Ctrl+\\",
        ],
        [
          "editor.splitDown",
          "Split Editor Down",
          () => workbench.split("column"),
          "Ctrl+K Ctrl+\\",
        ],
        [
          "editor.moveToNextGroup",
          "Move Editor into Next Group",
          () => {
            const s = workbench.state,
              i = s.groups.findIndex((g) => g.id === s.activeGroup),
              tab = workbench.activeTab();
            if (tab && s.groups.length > 1)
              workbench.moveTab(
                s.activeGroup,
                tab.id,
                s.groups[(i + 1) % s.groups.length]!.id,
              );
          },
          "Ctrl+Alt+ArrowRight",
        ],
      ] as const)
        command(id, title, run, shortcut);
    },
  };
}
