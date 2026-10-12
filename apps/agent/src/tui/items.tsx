/* @jsxRuntime automatic */
import { Box, Text } from "ink";
import { Markdown } from "./markdown.js";
import { Gutter, More, ToolCard } from "./tool-card.js";
import { useTheme } from "./theme.js";
import type { Item, PlanEntry } from "./transcript.js";
import { truncateStart } from "./width.js";

export interface ItemContext {
  width: number;
  rows: number;
  expanded: boolean;
  cwd: string;
  version?: string;
  /** toolCallId of the open permission dialog. */
  awaiting?: string;
}

const home = (path: string) => {
  const user = process.env.HOME;
  return user && (path === user || path.startsWith(`${user}/`)) ? `~${path.slice(user.length)}` : path;
};

function Banner({ width, cwd, version }: ItemContext) {
  const theme = useTheme();
  const size = Math.min(width, 64);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} width={size}>
      <Text><Text color={theme.accent}>✻</Text> <Text bold>Oxbit Agent</Text>{version ? <Text color={theme.muted}> {version}</Text> : null}</Text>
      <Text color={theme.muted}>{truncateStart(home(cwd), size - 4)}</Text>
      <Text color={theme.muted}>/help for help · shift+tab to switch modes</Text>
    </Box>
  );
}

const PLAN_ICONS: Record<string, string> = { completed: "☒", in_progress: "▶", pending: "☐" };

function Plan({ entries, expanded }: { entries: PlanEntry[]; expanded: boolean }) {
  const theme = useTheme();
  const done = entries.filter((entry) => entry.status === "completed").length;
  const limit = expanded ? entries.length : 12;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text><Text color={theme.accent}>☰</Text> <Text bold>Plan</Text><Text color={theme.muted}> · {done}/{entries.length} done</Text></Text>
      <Gutter>
        {entries.slice(0, limit).map((entry, index) => {
          const active = entry.status === "in_progress";
          const finished = entry.status === "completed";
          return (
            <Box key={index}>
              <Box width={2} flexShrink={0}><Text color={active ? theme.accent : finished ? theme.success : theme.muted}>{PLAN_ICONS[entry.status] ?? "☐"}</Text></Box>
              <Text wrap="wrap" bold={active} dimColor={finished} strikethrough={finished}>{entry.content}</Text>
            </Box>
          );
        })}
        <More count={entries.length - limit} unit="step" />
      </Gutter>
    </Box>
  );
}

function Thought({ text, live, expanded, width }: { text: string; live: boolean; expanded: boolean; width: number }) {
  const theme = useTheme();
  const lines = text.trim().split("\n").filter((line) => line.trim());
  const shown = expanded ? lines : live ? lines.slice(-3) : [];
  return (
    <Box flexDirection="column" marginTop={1} width={width}>
      <Text color={theme.muted} italic>∴ {live ? "Thinking…" : "Thought"}{!expanded && !live && lines.length ? " (ctrl+o to expand)" : ""}</Text>
      {shown.length ? <Gutter>{shown.map((line, index) => <Text key={index} color={theme.muted} italic wrap="wrap">{line}</Text>)}</Gutter> : null}
    </Box>
  );
}

/** One transcript entry. `live` items can still change; the rest render once into <Static>. */
export function ItemView({ item, live = false, context }: { item: Item; live?: boolean; context: ItemContext }) {
  const theme = useTheme();
  const { width, rows, expanded, cwd } = context;
  switch (item.type) {
    case "banner": return <Banner {...context} />;
    case "user": {
      const lines = item.text.split("\n");
      const shown = item.continuation && !expanded ? lines.slice(0, 3) : lines;
      return (
        <Box marginTop={1} width={width}>
          <Box width={2} flexShrink={0}><Text color={item.continuation ? theme.muted : theme.accent} bold>{item.continuation ? "↻" : "›"}</Text></Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text color={item.continuation ? theme.muted : theme.user} wrap="wrap">{shown.join("\n")}</Text>
            <More count={lines.length - shown.length} />
          </Box>
        </Box>
      );
    }
    case "assistant": {
      const text = item.text.replace(/^\n+|\s+$/g, "");
      if (!text) return null;
      return (
        <Box marginTop={1} width={width}>
          <Box width={2} flexShrink={0}><Text color={theme.accent}>{item.part ? " " : "●"}</Text></Box>
          <Markdown text={text} width={Math.max(10, width - 2)} tail={live ? Math.max(6, rows - 14) : undefined} />
        </Box>
      );
    }
    case "thought": return item.text.trim() ? <Thought text={item.text} live={live && !item.done} expanded={expanded} width={width} /> : null;
    case "tool": return <ToolCard tool={item.tool} live={live} expanded={expanded} cwd={cwd} awaiting={context.awaiting === item.tool.toolCallId} />;
    case "plan": return <Plan entries={item.entries} expanded={expanded} />;
    case "notice": return item.tone === "error"
      ? <Box marginTop={1} width={width}><Box width={2} flexShrink={0}><Text color={theme.error}>✗</Text></Box><Text color={theme.error} wrap="wrap">{item.text}</Text></Box>
      : <Box width={width}><Gutter><Text color={item.tone === "warn" ? theme.warning : theme.muted} wrap="wrap">{item.text}</Text></Gutter></Box>;
    case "divider": {
      const label = ` ${item.text} `;
      return <Box marginTop={1}><Text color={theme.muted} wrap="truncate-end">──{label}{"─".repeat(Math.max(0, width - label.length - 2))}</Text></Box>;
    }
  }
}
