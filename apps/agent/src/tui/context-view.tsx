/* @jsxRuntime automatic */
import { Box, Text } from "ink";
import { contextGrid, contextLegend, contextNotes, formatPercent, formatTokens, type ContextUsage } from "@oxbit/agent-core";
import { useTheme, type Theme } from "./theme.js";

const COLUMNS = 20;
const GRID_WIDTH = COLUMNS * 2 - 1;
const glyph = (id: string) => id === "free" ? "□" : id === "buffer" ? "⊠" : "■";
const colors = (theme: Theme): Record<string, string> => ({ system: theme.accent, instructions: theme.keyword, skills: theme.link, context: theme.user,
  tools: theme.number, mcp: theme.removed, messages: theme.success, free: theme.muted, buffer: theme.warning });

/** The /context breakdown from `_meta.oxbit.context`: a colored cell grid with the legend beside it, or below it when narrow. */
export function ContextView({ usage, width }: { usage: ContextUsage; width: number }) {
  const theme = useTheme();
  const known = colors(theme);
  const spare = [theme.code, theme.error, theme.string, theme.added];
  const legend = contextLegend(usage).map((row, index) => ({ ...row, color: known[row.id] ?? spare[index % spare.length] }));
  const color = new Map(legend.map((row) => [row.id, row.color]));
  const grid = contextGrid(usage, COLUMNS * 10);
  const rows = Array.from({ length: grid.length / COLUMNS }, (_, row) => grid.slice(row * COLUMNS, (row + 1) * COLUMNS));
  const label = Math.max(...legend.map((row) => row.label.length));
  const counts = legend.map((row) => formatTokens(row.tokens));
  const digits = Math.max(...counts.map((count) => count.length));
  const side = rows.length > 0 && width >= GRID_WIDTH + 3 + label + digits + 12;
  const { header, footer } = contextNotes(usage);
  return (
    <Box flexDirection="column" marginTop={1} width={width}>
      <Text><Text color={theme.accent}>●</Text> <Text bold>{header}</Text></Text>
      <Box flexDirection={side ? "row" : "column"} marginTop={1} paddingLeft={2}>
        {rows.length ? (
          <Box flexDirection="column" width={GRID_WIDTH} flexShrink={0} marginRight={side ? 3 : 0} marginBottom={side ? 0 : 1}>
            {rows.map((cells, index) => (
              <Text key={index}>{cells.map((id, at) => <Text key={at} color={color.get(id)}>{at ? " " : ""}{glyph(id)}</Text>)}</Text>
            ))}
          </Box>
        ) : null}
        <Box flexDirection="column">
          {legend.map((row, index) => (
            <Text key={index} wrap="truncate-end">
              <Text color={row.color}>{glyph(row.id)}</Text> {row.label.padEnd(label)}  {counts[index].padStart(digits)}
              {usage.window ? <Text color={theme.muted}>  {formatPercent(row.tokens, usage.window).padStart(6)}</Text> : null}
            </Text>
          ))}
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {footer.map((line, index) => <Text key={index} color={theme.muted} wrap="wrap">{line}</Text>)}
      </Box>
    </Box>
  );
}
