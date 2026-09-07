/** A flattened outline with zero-based lines and UTF-16 character offsets. */
export interface DocumentSymbol {
  name: string;
  kind: number;
  detail?: string;
  path: string;
  depth: number;
  range: SymbolRange;
  selectionRange: SymbolRange;
}
export interface SymbolRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
export interface DocumentSymbolProvider {
  symbols(path: string, signal?: AbortSignal): Promise<DocumentSymbol[]>;
}
