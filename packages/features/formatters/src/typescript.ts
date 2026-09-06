import type { Formatter } from "@zapp/sdk";

export const formatTypeScript: Formatter["format"] = async (
  text,
  path,
  options,
) => {
  options.signal?.throwIfAborted();
  if (!/\.(?:[cm]?tsx?|[cm]?jsx?|json)$/i.test(path))
    throw new Error(`TypeScript formatter does not support ${path}`);
  const ts = await import("typescript");
  const service = ts.createLanguageService({
    getScriptFileNames: () => [path],
    getScriptVersion: () => "1",
    getScriptSnapshot: (file) =>
      file === path ? ts.ScriptSnapshot.fromString(text) : undefined,
    getCurrentDirectory: () => "",
    getCompilationSettings: () => ({
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
      resolveJsonModule: true,
    }),
    getDefaultLibFileName: () => "lib.d.ts",
    fileExists: (file) => file === path,
    readFile: (file) => (file === path ? text : undefined),
    readDirectory: () => [],
  });
  try {
    const edits = service.getFormattingEditsForDocument(path, {
      indentSize: options.tabSize,
      tabSize: options.tabSize,
      convertTabsToSpaces: options.insertSpaces,
      newLineCharacter: "\n",
      indentStyle: ts.IndentStyle.Smart,
      insertSpaceAfterCommaDelimiter: true,
      insertSpaceBeforeAndAfterBinaryOperators: true,
      insertSpaceAfterKeywordsInControlFlowStatements: true,
      insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
    });
    let result = text;
    for (const edit of edits.sort(
      (left, right) => right.span.start - left.span.start,
    ))
      result =
        result.slice(0, edit.span.start) +
        edit.newText +
        result.slice(edit.span.start + edit.span.length);
    options.signal?.throwIfAborted();
    return result;
  } finally {
    service.dispose();
  }
};
