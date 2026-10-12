/* @jsxRuntime automatic */
import { Box, Text, useAnimation } from "ink";
import type { ViewState } from "./controller.js";
import { cursorLines } from "./editor.js";
import { modelName } from "./status.js";
import { SPINNER } from "./tool-card.js";
import { useTheme } from "./theme.js";
import { truncate, truncateStart, width as cells } from "./width.js";

const MODE_LABELS: Record<string, string> = { ask: "◇ ask", "accept-edits": "⏵⏵ accept edits", "full-auto": "⏵⏵⏵ full auto" };

export function PromptBox({ state, width }: { state: ViewState; width: number }) {
  const theme = useTheme();
  const empty = !state.draft.text;
  const placeholder = state.running ? "Queue a message · esc to stop the agent" : "Ask anything · / for commands · @ for files";
  return (
    <Box borderStyle="round" borderColor={theme.border} paddingX={1} width={width}>
      <Box width={2} flexShrink={0}><Text color={theme.accent} bold>›</Text></Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {empty
          ? <Text wrap="truncate-end"><Text inverse> </Text><Text color={theme.muted}>{placeholder}</Text></Text>
          : cursorLines(state.draft).map((line, index) => (
            <Text key={index} wrap="wrap">{line.before}{line.under === undefined ? (line.before ? "" : " ") : <Text inverse>{line.under}</Text>}{line.after ?? ""}</Text>
          ))}
      </Box>
    </Box>
  );
}

const elapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

export function Working({ state }: { state: ViewState }) {
  const theme = useTheme();
  const { frame } = useAnimation({ interval: 100 });
  const last = state.transcript.live.at(-1);
  const label = last?.type === "thought" && !last.done ? "Thinking" : last?.type === "tool" && !last.done ? "Running" : "Working";
  return (
    <Box marginTop={1}>
      <Text wrap="truncate-end">
        <Text color={theme.accent}>{SPINNER[frame % SPINNER.length]} {label}…</Text>
        <Text color={theme.muted}> ({elapsed(Date.now() - (state.startedAt ?? Date.now()))} · esc to interrupt)</Text>
      </Text>
    </Box>
  );
}

interface Segment { text: string; color?: string; priority: number }

/** Keeps the highest-priority segments that fit in `budget` cells, in their original order. */
export function fitSegments(segments: Segment[], budget: number, separator = " · ") {
  const kept = new Set<Segment>();
  let used = 0;
  for (const segment of [...segments].sort((a, b) => a.priority - b.priority)) {
    const size = cells(segment.text) + (kept.size ? cells(separator) : 0);
    if (used + size <= budget) {
      kept.add(segment);
      used += size;
    }
  }
  return segments.filter((segment) => kept.has(segment));
}

export function StatusLine({ state, width }: { state: ViewState; width: number }) {
  const theme = useTheme();
  const { status, info, hint } = state;
  const usage = status.usage ? Math.min(100, Math.round((status.usage.used / status.usage.size) * 100)) : undefined;
  const effort = status.reasoning && status.reasoning.currentValue !== "default" ? ` (${status.reasoning.currentValue})` : "";
  const model = modelName(status);
  const budget = Math.max(10, width - 2);
  const loopText = status.loop && [`↻ loop`, status.loop.iteration ? ` ${status.loop.iteration}${status.loop.max ? `/${status.loop.max}` : ""}` : "",
    status.loop.status ? ` ${status.loop.status}` : "", status.loop.interval ? ` · every ${status.loop.interval}` : ""].join("");
  const left = fitSegments([
    hint ? { text: hint, color: theme.warning, priority: 0 }
      : state.scroll ? { text: "↑ scrolled up · pgdn or end returns to the latest", color: theme.warning, priority: 0 }
      : { text: `${MODE_LABELS[status.mode] ?? status.mode}${width >= 80 ? " (shift+tab)" : ""}`, color: theme.modes[status.mode], priority: 0 },
    ...status.goal ? [{ text: `◎ goal ${status.goal.status}`, color: theme.accent, priority: 1 }] : [],
    ...loopText ? [{ text: loopText, color: theme.accent, priority: 2 }] : [],
  ], budget, "  ");
  const beside = budget - cells(left.map((segment) => segment.text).join("  ")) - 2;
  const segments: Segment[] = [
    ...status.title ? [{ text: truncate(status.title, 32), priority: 4 }] : [],
    ...model ? [{ text: truncate(`${model}${effort}`, 40), priority: 0 }] : [],
    ...info.usingChatGPTPlan ? [{ text: "Using ChatGPT plan", color: theme.success, priority: 1 }] : info.provider ? [{ text: info.provider, priority: 3 }] : [],
    ...usage !== undefined ? [{ text: `${usage}% context`, color: usage >= 90 ? theme.error : usage >= 70 ? theme.warning : undefined, priority: 2 }] : [],
    { text: truncateStart(state.cwd.replace(process.env.HOME ?? "\0", "~"), 30), priority: 5 },
  ];
  const inline = fitSegments(segments, beside);
  const right = inline.length >= segments.filter((segment) => segment.priority < 5).length ? inline : fitSegments(segments, budget);
  return (
    <Box width={width} paddingX={1} flexWrap="wrap" justifyContent="space-between" columnGap={2}>
      <Text wrap="truncate-end">{left.map((segment, index) => <Text key={index} color={segment.color}>{index ? "  " : ""}{segment.text}</Text>)}</Text>
      <Text wrap="truncate-end" color={theme.muted}>{right.map((segment, index) => <Text key={index} color={segment.color}>{index ? <Text color={theme.muted}> · </Text> : null}{segment.text}</Text>)}</Text>
    </Box>
  );
}
