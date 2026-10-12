/* @jsxRuntime automatic */
import { Box, measureElement, Text, useInput, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import { ItemView, type ItemContext } from "./items.js";
import { useTheme } from "./theme.js";
import { expandable, type Transcript } from "./transcript.js";

/** Ctrl+O viewer: one item rendered in full in a scrolling box, since scrollback above cannot change. */
export function Details({ id, transcript, context }: { id: number; transcript: Transcript; context: ItemContext }) {
  const theme = useTheme();
  const items = [...transcript.flushed, ...transcript.live].filter(expandable);
  const at = Math.max(0, items.findIndex((entry) => entry.id === id));
  const item = items[at];
  const height = Math.max(4, context.rows - 9);
  const [scroll, setScroll] = useState(0);
  const [total, setTotal] = useState(0);
  const content = useRef<DOMElement>(null);
  useEffect(() => {
    if (content.current) setTotal(measureElement(content.current).height);
  });
  const max = Math.max(0, total - height);
  const top = Math.min(scroll, max);
  useInput((_input, key) => {
    const page = height - 1;
    const step = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -page : key.pageDown ? page : key.home ? -total : key.end ? total : 0;
    if (step) setScroll(Math.min(max, Math.max(0, top + step)));
  });
  if (!item) return null;
  const live = transcript.live.includes(item);
  const position = max ? ` · lines ${top + 1}-${Math.min(total, top + height)} of ${total}` : "";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} width={context.width} marginTop={1}>
      <Text bold wrap="truncate-end">Details <Text color={theme.muted}>{at + 1}/{items.length}{position}</Text></Text>
      <Box height={total ? Math.min(height, total) : height} overflow="hidden" flexDirection="column">
        <Box ref={content} flexDirection="column" flexShrink={0} marginTop={-top}>
          <ItemView item={item} live={live} context={{ ...context, width: context.width - 4, expanded: true }} />
        </Box>
      </Box>
      <Text color={theme.muted} wrap="truncate-end">{max ? "↑↓ pgup pgdn scroll · " : ""}←→ earlier/later · esc close</Text>
    </Box>
  );
}
