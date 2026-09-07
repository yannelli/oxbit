import type { DocumentSymbol, SymbolRange } from "@oxbit/sdk";

function isRange(value: any): value is SymbolRange {
  const valid = (p: any) =>
    Number.isInteger(p?.line) &&
    p.line >= 0 &&
    Number.isInteger(p?.character) &&
    p.character >= 0;
  return (
    valid(value?.start) &&
    valid(value?.end) &&
    (value.start.line < value.end.line ||
      (value.start.line === value.end.line &&
        value.start.character <= value.end.character))
  );
}

/** Accept both LSP DocumentSymbol trees and SymbolInformation arrays. */
export function documentSymbols(
  values: unknown,
  path: string,
  pathForUri: (uri: string) => string,
): DocumentSymbol[] {
  const result: DocumentSymbol[] = [];
  const visit = (items: unknown, depth: number) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item.name !== "string") continue;
      const range = item.range ?? item.location?.range;
      if (!isRange(range)) continue;
      let target = path;
      if (item.location?.uri) {
        try {
          target = pathForUri(item.location.uri);
        } catch {
          continue;
        }
      }
      result.push({
        name: item.name,
        kind: item.kind,
        detail:
          typeof item.detail === "string" ? item.detail : item.containerName,
        path: target,
        depth,
        range,
        selectionRange: isRange(item.selectionRange)
          ? item.selectionRange
          : range,
      });
      visit(item.children, depth + 1);
    }
  };
  visit(values, 0);
  return result;
}
