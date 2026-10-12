/* @jsxRuntime automatic */
import { Box, Text } from "ink";
import { MODES } from "@oxbit/agent-core";
import type { Controller, ViewState } from "./controller.js";
import { overlayItems } from "./controller.js";
import type { CompletionItem } from "./complete.js";
import type { PendingPermission } from "./session-controller.js";
import { commandOf, decisionLabel, DECISIONS, question } from "./permission.js";
import { DiffView, relative } from "./tool-card.js";
import { useTheme } from "./theme.js";
import type { DiffBlock } from "./transcript.js";
import { width as cells } from "./width.js";

const KEYS: [string, string][] = [
  ["enter", "send"], ["shift+enter, alt+enter, ctrl+j, \\ enter", "new line"], ["↑ ↓", "history, or move between lines"],
  ["esc", "stop the agent, close a menu"], ["ctrl+c", "stop, then press again to exit"], ["shift+tab", "switch the mode"],
  ["ctrl+o", "expand tool output and thinking"], ["ctrl+p, /model", "choose the model"], ["/ and @", "complete commands and files"],
  ["ctrl+a e u k w", "line editing"],
];

/** Rows `index` falls in, `size` at a time, for scrolling lists. */
export function windowOf<T>(items: T[], index: number, size: number) {
  const start = Math.min(Math.max(0, index - size + 1), Math.max(0, items.length - size));
  return { start, rows: items.slice(start, start + size) };
}

export function PickList({ items, index, width, size = 8 }: { items: CompletionItem[]; index: number; width: number; size?: number }) {
  const theme = useTheme();
  const { start, rows } = windowOf(items, index, size);
  const label = Math.min(Math.max(...rows.map((item) => cells(item.label)), 8) + 3, Math.floor(width * 0.5));
  return (
    <Box flexDirection="column" width={width}>
      {start > 0 ? <Text color={theme.muted}>  ↑ {start} more</Text> : null}
      {rows.map((item, at) => {
        const selected = start + at === index;
        return (
          <Box key={item.value}>
            <Box width={label} flexShrink={0}>
              <Text color={selected ? theme.accent : undefined} bold={selected} wrap="truncate-end">{selected ? "❯ " : "  "}{item.label}</Text>
            </Box>
            {item.detail ? <Box flexShrink={1}><Text color={theme.muted} wrap="truncate-end">{item.detail}</Text></Box> : null}
          </Box>
        );
      })}
      {start + rows.length < items.length ? <Text color={theme.muted}>  ↓ {items.length - start - rows.length} more</Text> : null}
    </Box>
  );
}

export function PermissionDialog({ pending, controller, width, cwd }: { pending: PendingPermission; controller: Controller; width: number; cwd: string }) {
  const theme = useTheme();
  const { request, index } = pending;
  const call = request.toolCall;
  const diffs: DiffBlock[] = (call.content ?? []).filter((block) => block.type === "diff")
    .map((block) => ({ path: String(block.path ?? ""), oldText: block.oldText ?? null, newText: String(block.newText ?? "") }));
  const shown = controller.liveTool(call.toolCallId)?.diffs.length ? [] : diffs;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1} width={width} marginTop={1}>
      <Text bold color={theme.warning}>{question(request)}</Text>
      <Box marginY={1} flexDirection="column">
        {call.kind === "execute"
          ? <Text wrap="wrap"><Text color={theme.accent}>$ </Text>{commandOf(request)}</Text>
          : <Text bold wrap="wrap">{relative(cwd, call.title ?? "Tool call")}</Text>}
        {shown.map((diff, at) => <DiffView key={at} diff={diff} cwd={cwd} limit={10} />)}
      </Box>
      {DECISIONS.map((decision, at) => (
        <Text key={decision} color={at === index ? theme.accent : undefined} bold={at === index} wrap="wrap">
          {at === index ? "❯" : " "} {at + 1}. {decisionLabel(request, decision)}
        </Text>
      ))}
      <Text color={theme.muted}>↑↓ select · enter confirm · 1-3 · esc deny</Text>
    </Box>
  );
}

export function OverlayView({ state, width }: { state: ViewState; width: number }) {
  const theme = useTheme();
  const overlay = state.overlay!;
  if (overlay.kind === "help") {
    const key = Math.min(40, Math.floor(width * 0.45));
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} width={width} marginTop={1}>
        <Text bold>Keys</Text>
        {KEYS.map(([keys, action]) => (
          <Box key={keys}><Box width={key} flexShrink={0} paddingRight={1}><Text color={theme.accent} wrap="wrap">{keys}</Text></Box><Text wrap="wrap">{action}</Text></Box>
        ))}
        <Text bold>{"\n"}Modes</Text>
        {MODES.map((mode) => <Text key={mode.id} wrap="wrap"><Text color={theme.modes[mode.id]}>{mode.name}</Text><Text color={theme.muted}> · {mode.description}</Text></Text>)}
        <Text color={theme.muted}>{"\n"}Type / to list commands. esc closes this help.</Text>
      </Box>
    );
  }
  const items = overlayItems(state);
  const reasoning = overlay.kind === "models" ? state.status.reasoning : undefined;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} width={width} marginTop={1}>
      <Text bold>{overlay.kind === "models" ? "Choose a model" : "Resume a session"}</Text>
      <Text><Text color={theme.accent}>› </Text>{overlay.filter}<Text inverse> </Text>{overlay.filter ? null : <Text color={theme.muted}>type to filter</Text>}</Text>
      {items.length ? <PickList items={items} index={overlay.index} width={width - 4} size={10} /> : <Text color={theme.muted}>No matches</Text>}
      {reasoning ? (
        <Text>Reasoning <Text color={theme.muted}>◂ </Text><Text color={theme.accent}>{reasoning.options.find((option) => option.value === reasoning.currentValue)?.name ?? reasoning.currentValue}</Text><Text color={theme.muted}> ▸</Text></Text>
      ) : null}
      <Text color={theme.muted}>↑↓ select · enter choose{reasoning ? " · ←→ reasoning" : ""} · esc close</Text>
    </Box>
  );
}
