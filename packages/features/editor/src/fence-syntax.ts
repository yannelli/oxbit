import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { Language, highlightingFor } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { fenceLanguage, fenceText, findFences, type LanguageDefinition } from "@oxbit/sdk";
import { LARGE_DOCUMENT_LENGTH } from "./view-state.js";

export type SyntaxForLanguage = (id: string) => Extension;

/** Parser language from a `languageFor` result, which is a LanguageSupport, a Language, or an empty extension. */
export function parserLanguage(extension: Extension): Language | undefined {
  if (extension instanceof Language) return extension;
  const language = (extension as { language?: unknown }).language;
  return language instanceof Language ? language : undefined;
}

/** `codeLanguages` for the Markdown parser, so fence content uses the fence language's syntax. */
export function fenceCodeLanguages(syntaxFor: SyntaxForLanguage, definitions: readonly LanguageDefinition[] = []) {
  return (info: string): Language | null => {
    const language = fenceLanguage(info, definitions);
    return language && language.id !== "markdown" && language.id !== "mdx" ? parserLanguage(syntaxFor(language.id)) ?? null : null;
  };
}

/** Highlights fences inside comments by parsing each fence's content with its language and marking the host ranges. */
export function commentFenceHighlighting(hostLanguage: string, syntaxFor: SyntaxForLanguage): Extension {
  const build = (view: EditorView): DecorationSet => {
    const text = view.state.doc.toString();
    if (text.length > LARGE_DOCUMENT_LENGTH || (!text.includes("```") && !text.includes("~~~"))) return Decoration.none;
    const marks: Range<Decoration>[] = [];
    for (const fence of findFences(text, hostLanguage)) {
      const language = parserLanguage(syntaxFor(fence.language.id));
      if (!language) continue;
      const starts: number[] = [];
      let base = 0;
      for (const line of fence.lines) { starts.push(base); base += line.to - line.from + 1; }
      highlightTree(language.parser.parse(fenceText(text, fence)), { style: tags => highlightingFor(view.state, tags) }, (from, to, classes) => {
        fence.lines.forEach((line, row) => {
          const start = Math.max(from, starts[row]), end = Math.min(to, starts[row] + line.to - line.from);
          if (start < end) marks.push(Decoration.mark({ class: classes }).range(line.from + start - starts[row], line.from + end - starts[row]));
        });
      });
    }
    return Decoration.set(marks, true);
  };
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(update: ViewUpdate) { if (update.docChanged) this.decorations = build(update.view); }
  }, { decorations: plugin => plugin.decorations });
}
