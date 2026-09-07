import { lspGlobMatches } from "./lsp-glob.js";
import { canonicalLanguageId } from "./languages.js";
export const lspCapabilityKeys: Record<string, string> = {
  "textDocument/completion": "completionProvider", "textDocument/hover": "hoverProvider", "textDocument/signatureHelp": "signatureHelpProvider",
  "textDocument/definition": "definitionProvider", "textDocument/declaration": "declarationProvider", "textDocument/typeDefinition": "typeDefinitionProvider", "textDocument/implementation": "implementationProvider",
  "textDocument/references": "referencesProvider", "textDocument/rename": "renameProvider", "textDocument/codeAction": "codeActionProvider", "textDocument/documentSymbol": "documentSymbolProvider",
  "textDocument/formatting": "documentFormattingProvider", "workspace/executeCommand": "executeCommandProvider", "workspace/symbol": "workspaceSymbolProvider",
  "textDocument/documentHighlight": "documentHighlightProvider", "textDocument/documentLink": "documentLinkProvider", "textDocument/prepareCallHierarchy": "callHierarchyProvider", "textDocument/prepareTypeHierarchy": "typeHierarchyProvider",
  "textDocument/semanticTokens": "semanticTokensProvider", "textDocument/inlayHint": "inlayHintProvider",
};
export interface LspRegistration { id: string; method: string; registerOptions?: any }
export function registrationMatches(selector: any, document?: { path: string; language: string }) {
  if (selector === undefined || selector === null) return true;
  if (!document || !Array.isArray(selector)) return false;
  return selector.some(item => item && (!item.scheme || item.scheme === "file") && (!item.language || item.language === "*" || canonicalLanguageId(item.language) === canonicalLanguageId(document.language)) && (!item.pattern || typeof item.pattern === "string" && lspGlobMatches(item.pattern, document.path)));
}
export function effectiveCapabilities(base: Record<string, any>, registrations: Iterable<LspRegistration>, document?: { path: string; language: string }) {
  const result = { ...base };
  for (const registration of registrations) {
    const key = lspCapabilityKeys[registration.method];
    if (!registrationMatches(registration.registerOptions?.documentSelector, document)) continue;
    if (key) result[key] = registration.registerOptions ?? true;
    const sync = { ...synchronization(result) };
    if (registration.method === "textDocument/didOpen" || registration.method === "textDocument/didClose") sync.openClose = true;
    else if (registration.method === "textDocument/didChange") sync.change = registration.registerOptions?.syncKind ?? 0;
    else if (registration.method === "textDocument/didSave") sync.save = registration.registerOptions ?? true;
    else if (registration.method === "textDocument/willSave") sync.willSave = true;
    else if (registration.method === "textDocument/willSaveWaitUntil") sync.willSaveWaitUntil = true;
    else continue;
    result.textDocumentSync = sync;
  }
  return result;
}
export function synchronization(capabilities: Record<string, any>) {
  const sync = capabilities.textDocumentSync;
  return typeof sync === "number" ? { openClose: true, change: sync } : sync ?? { openClose: false, change: 0 };
}
