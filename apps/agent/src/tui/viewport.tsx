/* @jsxRuntime automatic */
import { Box, measureElement, type DOMElement } from "ink";
import { memo, useEffect, useRef } from "react";
import type { Controller, ViewState } from "./controller.js";
import { ItemView, type ItemContext } from "./items.js";
import type { Item } from "./transcript.js";

/** Newest transcript items the fullscreen view renders; Ctrl+O still reaches every item. */
export const TRANSCRIPT_LIMIT = 200;

interface EntryProps { item: Item; live: boolean; context: ItemContext }
const same = (a: EntryProps, b: EntryProps) => a.item === b.item && a.live === b.live && a.context.width === b.context.width
  && a.context.rows === b.context.rows && a.context.cwd === b.context.cwd && a.context.awaiting === b.context.awaiting;

const Entry = memo(function Entry({ item, live, context }: EntryProps) {
  return <Box width={context.width} flexDirection="column" flexShrink={0}><ItemView item={item} live={live} context={context} /></Box>;
}, same);

const heightOf = (ref: { current: DOMElement | null }) => ref.current ? measureElement(ref.current).height : 0;

/** Fullscreen transcript: bottom-aligned while following, else shifted `scroll.top` rows from item `scroll.from`. */
export function Viewport({ controller, state, context }: { controller: Controller; state: ViewState; context: ItemContext }) {
  const outer = useRef<DOMElement>(null);
  const inner = useRef<DOMElement>(null);
  const { flushed, live } = state.transcript;
  const items = [...flushed, ...live];
  const { scroll } = state;
  const pinned = scroll ? items.findIndex((item) => item.id === scroll.from) : -1;
  const start = pinned >= 0 ? pinned : Math.max(0, items.length - TRANSCRIPT_LIMIT);
  const first = items[start]?.id ?? 0;
  useEffect(() => {
    controller.viewport = () => ({ total: heightOf(inner), height: heightOf(outer), first });
  });
  useEffect(() => () => { controller.viewport = undefined; }, [controller]);
  const max = inner.current && outer.current ? Math.max(0, heightOf(inner) - heightOf(outer)) : Infinity;
  return (
    <Box ref={outer} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden"
      justifyContent={scroll ? "flex-start" : "flex-end"} contentOffsetY={scroll ? Math.min(scroll.top, max) : 0}>
      <Box ref={inner} flexDirection="column" flexGrow={1} flexShrink={0}>
        {items.slice(start).map((item, at) => <Entry key={item.id} item={item} live={start + at >= flushed.length} context={context} />)}
      </Box>
    </Box>
  );
}
