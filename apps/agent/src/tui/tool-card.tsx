/* @jsxRuntime automatic */
import { Box, Text, useAnimation } from "ink";
import { useMemo, type ReactNode } from "react";
import { diffLines } from "./diff.js";
import { highlight } from "./highlight.js";
import { useTheme, type Theme } from "./theme.js";
import type { DiffBlock, ToolView } from "./transcript.js";

export const ICONS: Record<string, string> = { read: "→", edit: "✎", delete: "✗", move: "⇄", search: "⌕", execute: "$", think: "∴", fetch: "⇣", other: "◆" };
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SUFFIX: Record<string, string> = { pending: "waiting for approval", failed: "failed", cancelled: "interrupted" };

export const relative = (cwd: string, text: string) => cwd === "/" ? text : text.split(`${cwd}/`).join("");

/** Tool output and messages sit behind a "⎿" gutter under their header. */
export function Gutter({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Box>
      <Box width={5} flexShrink={0}><Text color={theme.muted}>  ⎿ </Text></Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>{children}</Box>
    </Box>
  );
}

export function More({ count, unit = "line" }: { count: number; unit?: string }) {
  const theme = useTheme();
  return count > 0 ? <Text color={theme.muted}>… +{count} {unit}{count === 1 ? "" : "s"} (ctrl+o to expand)</Text> : null;
}

const extension = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "";

export function DiffView({ diff, cwd, limit }: { diff: DiffBlock; cwd: string; limit: number }) {
  const theme = useTheme();
  const { lines, added, removed } = useMemo(() => diffLines(diff.oldText, diff.newText), [diff]);
  const path = relative(cwd, diff.path);
  const numbers = lines.flatMap((line) => line.type === "gap" ? [] : [line.newNo ?? line.oldNo ?? 0]);
  const size = String(Math.max(1, ...numbers)).length;
  const lang = extension(path);
  const summary = diff.oldText === null ? `Created ${path} with ${added} ${added === 1 ? "line" : "lines"}`
    : `Updated ${path}: ${added} added, ${removed} removed`;
  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>{summary}</Text>
      {lines.slice(0, limit).map((line, index) => {
        if (line.type === "gap") return <Text key={index} color={theme.muted}>{" ".repeat(size)}   ⋮ {line.count} unchanged</Text>;
        const sign = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
        const background = line.type === "added" ? theme.addedBg : line.type === "removed" ? theme.removedBg : undefined;
        const color = line.type === "added" ? theme.added : line.type === "removed" ? theme.removed : theme.muted;
        return (
          <Box key={index} backgroundColor={background}>
            <Box width={size + 1} flexShrink={0}><Text color={theme.muted}>{String(line.type === "removed" ? line.oldNo : line.newNo).padStart(size)}</Text></Box>
            <Box width={2} flexShrink={0}><Text color={color} bold>{sign}</Text></Box>
            <Text wrap="wrap">{line.text ? highlight(line.text, lang).map((token, at) => <Text key={at} color={tokenColor(token.kind, theme)}>{token.text}</Text>) : " "}</Text>
          </Box>
        );
      })}
      <More count={lines.length - limit} />
    </Box>
  );
}

function tokenColor(kind: string | undefined, theme: Theme) {
  return kind === "keyword" ? theme.keyword : kind === "string" ? theme.string : kind === "number" ? theme.number : kind === "comment" ? theme.muted : undefined;
}

function Output({ tool, expanded }: { tool: ToolView; expanded: boolean }) {
  const theme = useTheme();
  const lines = (tool.output ?? "").replace(/\s+$/, "").split("\n");
  if (!tool.output?.trim()) return tool.status === "in_progress" && tool.terminal ? <Text color={theme.muted}>Running…</Text> : null;
  if (tool.status === "completed" && tool.kind === "read" && !expanded)
    return <Text color={theme.muted}>{lines.length} {lines.length === 1 ? "line" : "lines"}</Text>;
  const limit = expanded ? 200 : tool.status === "failed" ? 8 : 5;
  const tail = tool.kind === "execute" && tool.status !== "failed";
  const shown = tail ? lines.slice(-limit) : lines.slice(0, limit);
  const hidden = lines.length - shown.length;
  return (
    <Box flexDirection="column">
      {tail && hidden > 0 ? <More count={hidden} /> : null}
      {shown.map((line, index) => <Text key={index} wrap="wrap" color={tool.status === "failed" ? theme.error : undefined}>{line || " "}</Text>)}
      {!tail && hidden > 0 ? <More count={hidden} /> : null}
    </Box>
  );
}

function Icon({ tool, live }: { tool: ToolView; live: boolean }) {
  const theme = useTheme();
  const running = live && tool.status === "in_progress";
  const { frame } = useAnimation({ interval: 80, isActive: running });
  const color = { completed: theme.success, failed: theme.error, cancelled: theme.muted, pending: theme.warning }[tool.status as string] ?? theme.accent;
  return <Text color={color}>{running ? SPINNER[frame % SPINNER.length] : ICONS[tool.kind] ?? ICONS.other}</Text>;
}

/** One tool call: kind icon colored by status, title, then diffs and collapsible output. */
export function ToolCard({ tool: view, live, expanded, cwd, awaiting }: { tool: ToolView; live: boolean; expanded: boolean; cwd: string; awaiting?: boolean }) {
  const theme = useTheme();
  const tool = awaiting && view.status === "in_progress" ? { ...view, status: "pending" as const } : view;
  if (tool.kind === "think" && tool.title === "Update plan" && tool.status !== "failed") return null;
  const title = tool.kind === "execute" ? tool.title.replace(/^\$\s*/, "") : relative(cwd, tool.title);
  const suffix = SUFFIX[tool.status];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box width={2} flexShrink={0}><Icon tool={tool} live={live} /></Box>
        <Text wrap="wrap"><Text bold>{title}</Text>{suffix ? <Text color={tool.status === "failed" ? theme.error : theme.muted}> · {suffix}</Text> : null}</Text>
      </Box>
      {tool.diffs.length || tool.output?.trim() || (tool.terminal && tool.status === "in_progress") ? (
        <Gutter>
          {tool.diffs.map((diff, index) => <DiffView key={index} diff={diff} cwd={cwd} limit={expanded ? 400 : 14} />)}
          {tool.diffs.length && tool.status === "completed" ? null : <Output tool={tool} expanded={expanded} />}
        </Gutter>
      ) : null}
    </Box>
  );
}
