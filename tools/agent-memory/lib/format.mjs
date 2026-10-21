const DESCRIPTION_CHARS = 140;

function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`;
}

/** One pointer line: an openable path, the note's title and summary, and why it matched. */
export function formatLine(hit) {
  const location = hit.line > 1 ? `${hit.path}:${hit.line}` : hit.path;
  const why = [];
  if (hit.matched?.length) why.push(`matched ${hit.matched.slice(0, 5).join(', ')}`);
  if (hit.semantic != null) why.push(`semantic ${hit.semantic.toFixed(2)}`);
  if (hit.reason && hit.reason !== 'new') why.push(hit.reason);
  const summary = hit.description && hit.description !== hit.title ? `: ${clip(hit.description, DESCRIPTION_CHARS)}` : '';
  return `- ${location} (${clip(hit.title, 80)})${summary} [${why.join('; ') || 'shown before compaction'}]`;
}

export function renderContext(picked, { carryOver = false } = {}) {
  if (picked.length === 0) return '';
  const header = carryOver
    ? 'Memory notes from before compaction. Open a path if it still applies:'
    : 'Memory notes that match this turn. Open a path if it applies:';
  return [header, ...picked.map((hit) => hit.text)].join('\n');
}

/** Wraps context in the JSON each tool reads from a command hook's stdout. */
export function hookOutput(tool, event, context) {
  if (!context) return '';
  if (tool === 'cursor') return JSON.stringify({ additional_context: context });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
}
