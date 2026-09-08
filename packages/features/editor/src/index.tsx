import { javascript as streamJavaScript, typescript as streamTypeScript, json as streamJson } from "@codemirror/legacy-modes/mode/javascript";
import { xml as streamXml, html as streamHtml } from "@codemirror/legacy-modes/mode/xml";
import { typographyCSS } from "@oxbit/themes";
import { languageForKernel, resolveLanguage } from "@oxbit/sdk";
import { php } from "@codemirror/lang-php";
import { vue } from "@codemirror/lang-vue";
import { xml } from "@codemirror/lang-xml";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { localSyntax, astroSyntax } from "./local-syntax.js";
import { translate as tr, getPhrases } from "@oxbit/ui";
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
import type { DocumentHandle } from "@oxbit/documents";
import type { LanguageDefinition, Extension, Kernel } from "@oxbit/sdk";
import { contributedLanguage, editorLanguageId } from "./languages.js";
import { contributedDecorations } from "./decorations.js";
import {
  captureView,
  restoredSelection,
  LARGE_DOCUMENT_LENGTH,
  detectedIndentation,
} from "./view-state.js";
import { themeMode, themeTypography, type WorkbenchController } from "@oxbit/workbench";
const syntax = HighlightStyle.define([
  { tag: tags.variableName, color: "var(--tok-variable)", backgroundColor: "var(--tok-variable-background)", fontWeight: "var(--tok-variable-weight)", fontStyle: "var(--tok-variable-style)", textDecoration: "var(--tok-variable-decoration)" },
  { tag: tags.name, color: "var(--tok-ident)", backgroundColor: "var(--tok-ident-background)", fontWeight: "var(--tok-ident-weight)", fontStyle: "var(--tok-ident-style)", textDecoration: "var(--tok-ident-decoration)" },
  { tag: tags.content, color: "var(--tok-text)", backgroundColor: "var(--tok-text-background)", fontWeight: "var(--tok-text-weight)", fontStyle: "var(--tok-text-style)", textDecoration: "var(--tok-text-decoration)" },
  { tag: tags.strong, class: "oxbit-syntax-strong" },
  { tag: tags.emphasis, class: "oxbit-syntax-emphasis" },
  { tag: tags.keyword, color: "var(--tok-keyword)", backgroundColor: "var(--tok-keyword-background)", fontWeight: "var(--tok-keyword-weight)", fontStyle: "var(--tok-keyword-style)", textDecoration: "var(--tok-keyword-decoration)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--tok-string)", backgroundColor: "var(--tok-string-background)", fontWeight: "var(--tok-string-weight)", fontStyle: "var(--tok-string-style)", textDecoration: "var(--tok-string-decoration)" },
  { tag: tags.number, color: "var(--tok-number)", backgroundColor: "var(--tok-number-background)", fontWeight: "var(--tok-number-weight)", fontStyle: "var(--tok-number-style)", textDecoration: "var(--tok-number-decoration)" },
  { tag: tags.comment, color: "var(--tok-comment)", backgroundColor: "var(--tok-comment-background)", fontWeight: "var(--tok-comment-weight)", fontStyle: "var(--tok-comment-style)", textDecoration: "var(--tok-comment-decoration)" },
  { tag: [tags.typeName, tags.className], color: "var(--tok-type)", backgroundColor: "var(--tok-type-background)", fontWeight: "var(--tok-type-weight)", fontStyle: "var(--tok-type-style)", textDecoration: "var(--tok-type-decoration)" },
  { tag: tags.function(tags.variableName), color: "var(--tok-function)", backgroundColor: "var(--tok-function-background)", fontWeight: "var(--tok-function-weight)", fontStyle: "var(--tok-function-style)", textDecoration: "var(--tok-function-decoration)" },
  { tag: tags.propertyName, color: "var(--tok-property)", backgroundColor: "var(--tok-property-background)", fontWeight: "var(--tok-property-weight)", fontStyle: "var(--tok-property-style)", textDecoration: "var(--tok-property-decoration)" },
  { tag: tags.tagName, color: "var(--tok-tag)", backgroundColor: "var(--tok-tag-background)", fontWeight: "var(--tok-tag-weight)", fontStyle: "var(--tok-tag-style)", textDecoration: "var(--tok-tag-decoration)" },
  { tag: tags.attributeName, color: "var(--tok-attr)", backgroundColor: "var(--tok-attr-background)", fontWeight: "var(--tok-attr-weight)", fontStyle: "var(--tok-attr-style)", textDecoration: "var(--tok-attr-decoration)" },
  { tag: tags.punctuation, color: "var(--tok-punct)", backgroundColor: "var(--tok-punct-background)", fontWeight: "var(--tok-punct-weight)", fontStyle: "var(--tok-punct-style)", textDecoration: "var(--tok-punct-decoration)" },
  { tag: tags.operator, color: "var(--tok-operator)", backgroundColor: "var(--tok-operator-background)", fontWeight: "var(--tok-operator-weight)", fontStyle: "var(--tok-operator-style)", textDecoration: "var(--tok-operator-decoration)" },
  { tag: tags.heading, color: "var(--tok-heading)", backgroundColor: "var(--tok-heading-background)", fontWeight: "var(--tok-heading-weight)", fontStyle: "var(--tok-heading-style)", textDecoration: "var(--tok-heading-decoration)" },
  { tag: tags.link, color: "var(--tok-link)", backgroundColor: "var(--tok-link-background)", fontWeight: "var(--tok-link-weight)", fontStyle: "var(--tok-link-style)", textDecoration: "var(--tok-link-decoration)" },
]);
const selectionForeground = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations=this.build(view); }
  update(update: ViewUpdate) { if(update.selectionSet||update.docChanged)this.decorations=this.build(update.view); }
  build(view:EditorView) {return Decoration.set(view.state.selection.ranges.filter(r=>!r.empty).map(r=>Decoration.mark({class:'oxbit-selection-text'}).range(r.from,r.to)),true);}
}, {decorations:plugin=>plugin.decorations});
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
                    attributes: { style: `--oxbit-indent-width:${columns}ch` },
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
                        Decoration.mark({ class: "oxbit-whitespace" }),
                      );
                  } else
                    for (const selection of view.state.selection.ranges) {
                      const a = Math.max(from, selection.from),
                        b = Math.min(end, selection.to);
                      if (a < b)
                        builder.add(
                          a,
                          b,
                          Decoration.mark({ class: "oxbit-whitespace" }),
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
export function languageFor(path: string, kernel?: Kernel, firstLine?: string): CMExtension {
  const custom = kernel ? contributedLanguage(kernel, path) : undefined;
  if (custom)
    return ((custom.data as LanguageDefinition).editorExtensions ||
      []) as CMExtension[];
  const id = kernel ? languageForKernel(kernel, path, firstLine).id : resolveLanguage(path, { firstLine }).id;
  switch (id) {
    case "typescript": return javascript({ typescript: true });
    case "typescriptreact": return javascript({ typescript: true, jsx: true });
    case "javascript": case "javascriptreact": return javascript({ jsx: true });
    case "json": return json();
    case "jsonc": case "jsonl": return StreamLanguage.define(localSyntax(id));
    case "css": return css();
    case "html": return html();
    case "vue": return vue();
    case "astro": return astroSyntax();
    case "php": case "blade": return php();
    case "xml": return xml();
    case "markdown": return markdown();
    case "mdx": return markdown({ htmlTagLanguage: javascript({ jsx: true }) });
    case "shellscript": return StreamLanguage.define(shell);
    case "toml": return StreamLanguage.define(toml);
    case "dockerfile": return StreamLanguage.define(dockerFile);
    case "zsh": case "ini": case "dotenv": case "csv": case "log": return StreamLanguage.define(localSyntax(id));
    default: return [];
  }
}

function documentSyntax(path: string, kernel: Kernel, text: string): CMExtension {
  const firstLine = text.split("\n", 1)[0];
  if (text.length <= LARGE_DOCUMENT_LENGTH) return languageFor(path, kernel, firstLine);
  const id = languageForKernel(kernel, path, firstLine).id;
  if (["typescript", "typescriptreact"].includes(id)) return StreamLanguage.define(streamTypeScript);
  if (["javascript", "javascriptreact"].includes(id)) return StreamLanguage.define(streamJavaScript);
  if (id === "json") return StreamLanguage.define(streamJson);
  if (id === "xml") return StreamLanguage.define(streamXml);
  if (["html", "vue", "php", "blade"].includes(id)) return StreamLanguage.define(streamHtml);
  if (id === "mdx") return languageFor(path, kernel, firstLine);
  return ["jsonc", "jsonl", "shellscript", "toml", "dockerfile", "zsh", "ini", "dotenv", "csv", "log", "astro"].includes(id) ? languageFor(path, kernel, firstLine) : [];
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
  const font = themeTypography(kernel, "editor", language);
  const fontSize = font.size;
  return [
    EditorState.phrases.of(getPhrases()),
    selectionForeground,
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
          color: "var(--tok-text)",
        },
        ".cm-scroller": {
          ...typographyCSS(font),
          overflow: "auto",
        },
        ".cm-content": {
          padding: "6px 0",
          caretColor: "var(--editor-cursor)",
          ...(get("editor.wordWrap", "off") === "bounded"
            ? { maxWidth: "90ch" }
            : {}),
        },
        ".cm-line": {
          padding: "0 8px",
          ...(get("editor.renderIndentGuides", true)
            ? {
                backgroundImage: `repeating-linear-gradient(to right,transparent 0,transparent calc(${size}ch - 1px),var(--guide) calc(${size}ch - 1px),var(--guide) ${size}ch)`,
                backgroundSize: "var(--oxbit-indent-width,0) 100%",
                backgroundRepeat: "no-repeat",
              }
            : {}),
        },
        ".cm-gutters": {
          backgroundColor: "var(--editor-gutter-background)",
          color: "var(--editor-gutter-foreground)",
          border: "none",
          minWidth: "56px",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          minWidth: "35px",
          paddingRight: "8px",
        },
        ".cm-foldGutter": { width: "18px" },
        ".cm-foldGutter .cm-gutterElement": { padding: "0", textAlign: "center" },
        ".cm-fold-marker": { display: "inline-block", width: "14px", height: "14px", verticalAlign: "middle", position: "relative", top: "-1px" },
        ".cm-fold-marker::after": { content: '\"\"', position: "absolute", width: "6px", height: "6px", borderRight: "1.5px solid currentColor", borderBottom: "1.5px solid currentColor", left: "4px", top: "2px", transform: "rotate(45deg)" },
        ".cm-fold-marker[data-folded=true]::after": { transform: "rotate(-45deg)", left: "2px", top: "4px" },
        ".cm-activeLine,.cm-activeLineGutter": {
          backgroundColor: "var(--line-active)",
        },
        ".cm-selectionBackground,&.cm-focused .cm-selectionBackground": {
          backgroundColor: "var(--editor-selection-background)",
        },
        "&:not(.cm-focused) .cm-selectionBackground": { backgroundColor: "var(--editor-selection-inactiveBackground)" },
        ".oxbit-selection-text,.oxbit-selection-text *": {color:"var(--editor-selection-foreground) !important"},
        ".cm-lintRange-error": {backgroundImage:"none",textDecoration:"underline wavy var(--err)"},
        ".cm-lintRange-warning": {backgroundImage:"none",textDecoration:"underline wavy var(--warn)"},
        ".cm-lintRange-info": {backgroundImage:"none",textDecoration:"underline wavy var(--info)"},
        ".cm-diagnostic-error": {borderLeftColor:"var(--err)"},
        ".cm-diagnostic-warning": {borderLeftColor:"var(--warn)"},
        ".cm-diagnostic-info": {borderLeftColor:"var(--info)"},
        ".cm-content ::selection": { color: "var(--editor-selection-foreground)" },
        ".cm-cursor,.cm-dropCursor": {
          borderLeftColor: "var(--editor-cursor)",
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
      { dark: themeMode(kernel) === "dark" },
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
    const measure = () => viewRef.current?.requestMeasure();
    document.fonts?.addEventListener("loadingdone", measure);
    document.addEventListener("oxbit-fonts-loaded", measure);

    return () => {
      unsub();
      unlanguages();
      document.fonts?.removeEventListener("loadingdone", measure);
      document.removeEventListener("oxbit-fonts-loaded", measure);
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
          foldGutter({ markerDOM: open => {
            const marker = document.createElement("span");
            marker.className = "cm-fold-marker";
            marker.dataset.folded = String(!open);
            marker.title = open ? "Fold code" : "Unfold code";
            return marker;
          } }),
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
            documentSyntax(handle.path, kernel, content),
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
            getLsp(),
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
                performance.measure("oxbit.keystroke-to-paint", {
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
            getLsp(),
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
        lsp.current.reconfigure(kernel.services.optional<{ extensions(path: string): CMExtension[] }>("language")?.extensions(handle.path) ?? []),
        syntaxMode.current.reconfigure(
          documentSyntax(handle.path, kernel, handle.text.toString()),
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
            "Large document: the minimap is paused. Background analysis follows your large-file settings.",
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
      id: "oxbit.editor",
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
          id: "oxbit.editor.document",
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
