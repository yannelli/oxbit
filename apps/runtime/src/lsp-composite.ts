/** Composite presets retain the primary protocol's synchronization/semantic legend. */
export function compositeCapabilities(primary: any, companion?: any) {
  if (!companion) return primary;
  const result = { ...companion, ...primary };
  for (const key of ["completionProvider", "signatureHelpProvider", "executeCommandProvider"]) {
    const a = primary[key], b = companion[key];
    if (!a || !b) { result[key] = a || b; continue; }
    result[key] = { ...b, ...a };
    for (const field of ["triggerCharacters", "retriggerCharacters", "commands"]) if (a[field] || b[field]) result[key][field] = [...new Set([...(a[field] ?? []), ...(b[field] ?? [])])];
    if (a.resolveProvider || b.resolveProvider) result[key].resolveProvider = true;
  }
  for (const key of Object.keys(companion)) if (key.endsWith("Provider") && !result[key]) result[key] = companion[key];
  return result;
}
export function compositeItems(value: any, source: "primary" | "companion") {
  const defaults = Array.isArray(value) ? {} : value?.itemDefaults ?? {};
  return (Array.isArray(value) ? value : value?.items ?? []).map((item: any) => {
    const result = { ...defaults, ...item };
    if (!result.textEdit && defaults.editRange) result.textEdit = { ...(defaults.editRange.start ? { range: defaults.editRange } : defaults.editRange), newText: item.textEditText ?? item.insertText ?? item.label };
    result.data = { __oxbitSource: source, original: result.data };
    delete result.editRange; return result;
  });
}
