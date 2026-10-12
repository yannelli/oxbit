/* @jsxRuntime automatic */
import { Box, renderToString, Text } from "ink";
import { parseBlocks, parseInline, plainText, tailLines, type Align, type Block, type ListItem, type Span } from "./markdown-parse.js";
import { highlight, languageLabel, type TokenKind } from "./highlight.js";
import { THEMES, ThemeContext, useTheme, type Theme } from "./theme.js";
import { width as cells } from "./width.js";

const BULLETS = ["•", "◦", "▪"];
const JUSTIFY = { left: "flex-start", center: "center", right: "flex-end" } as const;

export function spanNodes(spans: Span[], theme: Theme) {
  return spans.flatMap((span, index) => {
    const node = <Text key={index} bold={span.bold} italic={span.italic} strikethrough={span.strike} underline={!!span.link}
      color={span.code ? theme.code : span.link ? theme.link : undefined}>{span.text}</Text>;
    return span.link && span.link !== span.text && !span.link.startsWith("#")
      ? [node, <Text key={`${index}-url`} color={theme.muted}> ({span.link})</Text>] : [node];
  });
}

export function Inline({ text, color, dim, bold }: { text: string; color?: string; dim?: boolean; bold?: boolean }) {
  const theme = useTheme();
  return <Text color={color} dimColor={dim} bold={bold} wrap="wrap">{spanNodes(parseInline(text), theme)}</Text>;
}

function tokenColor(kind: TokenKind | undefined, theme: Theme) {
  if (!kind) return undefined;
  if (kind === "comment" || kind === "meta") return theme.muted;
  if (kind === "added") return theme.added;
  if (kind === "removed") return theme.removed;
  return theme[kind];
}

function Code({ lang, lines, open }: { lang: string; lines: string[]; open: boolean }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={theme.border}>╭─{lang ? <Text color={theme.muted}> {languageLabel(lang)}</Text> : null}</Text>
      <Box flexDirection="column" borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderColor={theme.border} paddingLeft={1}>
        {(lines.length ? lines : [""]).map((line, index) => (
          <Text key={index} wrap="wrap">{line ? highlight(line, lang).map((token, at) =>
            <Text key={at} color={tokenColor(token.kind, theme)} italic={token.kind === "comment"}>{token.text}</Text>) : " "}</Text>
        ))}
      </Box>
      {open ? null : <Text color={theme.border}>╰─</Text>}
    </Box>
  );
}

function List({ items }: { items: ListItem[] }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        const marker = item.checked !== undefined ? item.checked ? "☒" : "☐" : item.marker === "-" ? BULLETS[item.depth % BULLETS.length] : item.marker;
        return (
          <Box key={index} marginLeft={item.depth * 2}>
            <Box flexShrink={0} width={cells(marker) + 1}><Text color={theme.accent}>{marker}</Text></Box>
            <Box flexGrow={1} flexShrink={1}><Inline text={item.text} dim={item.checked} /></Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** Column widths that fit `available` cells by shrinking the widest column; undefined when even 3-cell columns do not fit. */
export function fitColumns(natural: number[], available: number) {
  const widths = natural.map((value) => Math.max(1, value));
  if (widths.length * 3 > available) return undefined;
  while (widths.reduce((sum, value) => sum + value, 0) > available) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest]--;
  }
  return widths;
}

function Table({ head, align, rows, width }: { head: string[]; align: Align[]; rows: string[][]; width: number }) {
  const theme = useTheme();
  const count = Math.max(head.length, ...rows.map((row) => row.length));
  const grid = [head, ...rows].map((row) => Array.from({ length: count }, (_, index) => row[index] ?? ""));
  const natural = Array.from({ length: count }, (_, column) => Math.max(...grid.map((row) => cells(plainText(row[column])))));
  const widths = fitColumns(natural, width - count * 3 - 1);
  if (!widths) return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <Box key={index} flexDirection="column" marginTop={index ? 1 : 0}>
          {head.map((name, column) => <Inline key={column} text={`**${name}:** ${row[column] ?? ""}`} />)}
        </Box>
      ))}
    </Box>
  );
  const line = (left: string, middle: string, right: string) =>
    <Text color={theme.border}>{left}{widths.map((size) => "─".repeat(size + 2)).join(middle)}{right}</Text>;
  const row = (values: string[], header: boolean) => (
    <Box>
      {values.map((value, column) => (
        <Box key={column} width={widths[column] + 3 + (column === count - 1 ? 1 : 0)} borderStyle="single" borderTop={false} borderBottom={false}
          borderRight={column === count - 1} borderColor={theme.border} paddingX={1} justifyContent={JUSTIFY[align[column] ?? "left"]}>
          <Inline text={value} bold={header} />
        </Box>
      ))}
    </Box>
  );
  return (
    <Box flexDirection="column">
      {line("┌", "┬", "┐")}
      {row(grid[0], true)}
      {line("├", "┼", "┤")}
      {grid.slice(1).map((values, index) => <Box key={index}>{row(values, false)}</Box>)}
      {line("└", "┴", "┘")}
    </Box>
  );
}

function BlockView({ block, width, dim }: { block: Block; width: number; dim?: boolean }) {
  const theme = useTheme();
  switch (block.type) {
    case "heading": return (
      <Text bold underline={block.level === 1} color={block.level <= 2 ? theme.accent : undefined} wrap="wrap">
        {spanNodes(parseInline(block.text), theme)}
      </Text>
    );
    case "paragraph": return <Inline text={block.text} dim={dim} />;
    case "code": return <Code {...block} />;
    case "list": return <List items={block.items} />;
    case "rule": return <Text color={theme.border}>{"─".repeat(Math.max(1, Math.min(width, 80)))}</Text>;
    case "table": return <Table {...block} width={width} />;
    case "quote": return (
      <Box borderStyle="bold" borderTop={false} borderRight={false} borderBottom={false} borderColor={theme.border} paddingLeft={1} flexDirection="column">
        {block.blocks.map((inner, index) => <Box key={index} marginTop={index ? 1 : 0}><BlockView block={inner} width={width - 2} dim /></Box>)}
      </Box>
    );
  }
}

/** Markdown as Ink elements. `tail` keeps the last source lines of a long streaming message. */
export function Markdown({ text, width, tail, dim }: { text: string; width: number; tail?: number; dim?: boolean }) {
  const theme = useTheme();
  const cut = tail ? tailLines(text, tail) : { text, hidden: 0 };
  const blocks = parseBlocks(cut.text);
  return (
    <Box flexDirection="column" width={width}>
      {cut.hidden ? <Text color={theme.muted}>… {cut.hidden} lines above</Text> : null}
      {blocks.map((block, index) => (
        <Box key={index} marginTop={index ? 1 : 0} flexDirection="column"><BlockView block={block} width={width} dim={dim} /></Box>
      ))}
    </Box>
  );
}

/** Markdown rendered to an ANSI string at `columns`, for print mode and tests. */
export function markdownToAnsi(text: string, columns = 80, theme: Theme = THEMES.dark) {
  return renderToString(<ThemeContext.Provider value={theme}><Markdown text={text} width={columns} /></ThemeContext.Provider>, { columns });
}
