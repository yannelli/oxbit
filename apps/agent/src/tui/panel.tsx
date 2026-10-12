/* @jsxRuntime automatic */
import { Box, Text, useAnimation } from "ink";
import type { PanelRow } from "./connection.js";
import { windowOf } from "./dialogs.js";
import { cursorLines } from "./editor.js";
import { panelRows } from "./panel-controller.js";
import type { PanelOverlay } from "./session-controller.js";
import { SPINNER } from "./tool-card.js";
import { useTheme } from "./theme.js";
import { graphemes } from "./width.js";

const SIZE = 12;
type Line = { heading: string } | { row: PanelRow; at: number };

/** Keys that apply to the selected row. */
function hints(overlay: PanelOverlay, row?: PanelRow) {
  if (overlay.input) return "enter submit · esc cancel";
  if (overlay.busy) return "esc cancel";
  if (overlay.menu !== undefined) return "↑↓ select · enter run · esc back";
  const actions = row?.actions ?? [];
  return ["↑↓ move", row?.enabled !== undefined ? "space toggle" : "", row?.choice ? "←→ change" : "",
    actions.length === 1 ? `enter ${actions[0].label.toLowerCase()}` : actions.length ? "enter actions" : "", "esc close"].filter(Boolean).join(" · ");
}

function Busy() {
  const theme = useTheme();
  const { frame } = useAnimation({ interval: 100 });
  return <Text color={theme.accent}>{SPINNER[frame % SPINNER.length]} Working…</Text>;
}

function RowLine({ row, selected }: { row: PanelRow; selected: boolean }) {
  const theme = useTheme();
  const value = row.choice && (row.choice.options.find((option) => option.value === row.choice!.value)?.name ?? row.choice.value);
  return (
    <Text wrap="truncate-end">
      <Text color={selected ? theme.accent : undefined} bold={selected}>
        {selected ? "❯ " : "  "}{row.enabled === undefined ? "" : row.enabled ? "[x] " : "[ ] "}{row.label}
      </Text>
      {row.choice ? <Text><Text color={theme.muted}> ◂ </Text><Text color={theme.accent}>{value}</Text><Text color={theme.muted}> ▸</Text></Text> : null}
      {row.detail ? <Text color={theme.muted}>  {row.detail}</Text> : null}
    </Text>
  );
}

function Rows({ overlay }: { overlay: PanelOverlay }) {
  const theme = useTheme();
  const lines: Line[] = [];
  panelRows(overlay.panel).forEach((row, at, rows) => {
    if (row.section && row.section !== rows[at - 1]?.section) lines.push({ heading: row.section });
    lines.push({ row, at });
  });
  if (!lines.length) return <Text color={theme.muted}>Nothing to show</Text>;
  const { start, rows } = windowOf(lines, lines.findIndex((line) => "row" in line && line.at === overlay.index), SIZE);
  return (
    <Box flexDirection="column">
      {start > 0 ? <Text color={theme.muted}>  ↑ {start} more</Text> : null}
      {rows.map((line, at) => "heading" in line
        ? <Text key={`h${start + at}`} bold color={theme.muted} wrap="truncate-end">{line.heading}</Text>
        : <RowLine key={line.row.id} row={line.row} selected={line.at === overlay.index} />)}
      {start + rows.length < lines.length ? <Text color={theme.muted}>  ↓ {lines.length - start - rows.length} more</Text> : null}
    </Box>
  );
}

function Menu({ row, index }: { row: PanelRow; index: number }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">{row.label}</Text>
      {(row.actions ?? []).map((action, at) => (
        <Text key={action.id} color={at === index ? theme.accent : undefined} bold={at === index} wrap="truncate-end">{at === index ? "❯ " : "  "}{action.label}</Text>
      ))}
    </Box>
  );
}

function Field({ input }: { input: NonNullable<PanelOverlay["input"]> }) {
  const theme = useTheme();
  const inputs = input.action.inputs ?? [];
  const field = inputs[input.values.length];
  const mask = (text = "") => field?.secret ? "•".repeat(graphemes(text).length) : text;
  const line = cursorLines(input.draft)[0];
  const under = input.draft.cursor < input.draft.text.length ? mask(line.under) : " ";
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">{input.action.label}{inputs.length > 1 ? <Text color={theme.muted}> ({input.values.length + 1}/{inputs.length})</Text> : null}</Text>
      <Text wrap="wrap">
        <Text color={theme.accent}>{field?.label}: </Text>
        {mask(line.before)}<Text inverse>{under}</Text>{mask(line.after)}
        {input.draft.text ? null : <Text color={theme.muted}>{field?.placeholder ?? ""}</Text>}
      </Text>
    </Box>
  );
}

/** A settings panel in the overlay box; progress text sits below the border so an address copies without border characters. */
export function PanelView({ overlay, width }: { overlay: PanelOverlay; width: number }) {
  const theme = useTheme();
  const { panel } = overlay;
  const row = panelRows(panel)[overlay.index];
  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} width={width} marginTop={1}>
        <Text bold wrap="truncate-end">{panel?.title ?? `/${overlay.id}`}</Text>
        {overlay.loading && !panel ? <Text color={theme.muted}>Loading…</Text> : null}
        {!panel ? null : overlay.input ? <Field input={overlay.input} /> : overlay.menu !== undefined && row ? <Menu row={row} index={overlay.menu} /> : <Rows overlay={overlay} />}
        {overlay.busy ? <Busy /> : null}
        {overlay.error ? <Text color={theme.error} wrap="wrap">{overlay.error}</Text> : null}
        {panel?.footer ? <Text color={theme.muted} wrap="wrap">{panel.footer}</Text> : null}
        <Text color={theme.muted} wrap="truncate-end">{hints(overlay, row)}</Text>
      </Box>
      {overlay.progress ? <Text wrap="wrap">{overlay.progress}</Text> : null}
    </Box>
  );
}
