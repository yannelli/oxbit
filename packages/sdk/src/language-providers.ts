import type { ProviderDocument } from "./index.js";
import type { TextPosition } from "./text-positions.js";
export interface LanguageRange { start: TextPosition; end: TextPosition }
export interface LanguageLocation { uri: string; range: LanguageRange; name?: string }
export interface SemanticTokensProvider {
  languages: string[];
  legend: { tokenTypes: string[]; tokenModifiers: string[] };
  provideSemanticTokens(document: ProviderDocument, range: LanguageRange | undefined, signal: AbortSignal): { data: number[] } | Promise<{ data: number[] }>;
  range?: boolean;
}
export interface ProviderInlayHint {
  position: TextPosition;
  label: string | { value: string; tooltip?: string | { kind: "markdown" | "plaintext"; value: string }; location?: LanguageLocation }[];
  kind?: 1 | 2;
  tooltip?: string | { kind: "markdown" | "plaintext"; value: string };
  textEdits?: { range: LanguageRange; newText: string }[];
  paddingLeft?: boolean;
  paddingRight?: boolean;
}
export interface InlayHintsProvider {
  languages: string[];
  provideInlayHints(document: ProviderDocument, range: LanguageRange, signal: AbortSignal): ProviderInlayHint[] | Promise<ProviderInlayHint[]>;
  resolveInlayHint?(hint: ProviderInlayHint, signal: AbortSignal): ProviderInlayHint | Promise<ProviderInlayHint>;
}
export type NavigationKind = "definition" | "declaration" | "typeDefinition" | "implementation" | "references";
export interface NavigationProvider {
  languages: string[];
  operations: NavigationKind[];
  provideLocations(document: ProviderDocument, offset: number, operation: NavigationKind, signal: AbortSignal): LanguageLocation[] | Promise<LanguageLocation[]>;
}
