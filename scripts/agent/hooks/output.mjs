export const TOOLS = new Set(['claude', 'codex', 'cursor']);

export function denyOutput(tool, reason) {
  if (tool === 'cursor') return JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason });
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}

// Cursor blocks on a missing answer, and "allow" skips its approval prompt, so a pass answers "ask".
export function allowOutput(tool) {
  return tool === 'cursor' ? JSON.stringify({ permission: 'ask' }) : '';
}

export function stopOutput(tool, warning) {
  if (tool === 'cursor') return JSON.stringify(warning ? { followup_message: warning } : {});
  return warning ? JSON.stringify({ decision: 'block', reason: warning }) : '';
}

export function failOpenOutput(tool, event) {
  return event === 'pre-shell' ? allowOutput(tool) : stopOutput(tool, null);
}
