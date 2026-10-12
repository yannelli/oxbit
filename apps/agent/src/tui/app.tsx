/* @jsxRuntime automatic */
import { Box, Static, Text, useInput, usePaste, useWindowSize } from "ink";
import { useSyncExternalStore } from "react";
import type { Controller } from "./controller.js";
import { OverlayView, PermissionDialog, PickList } from "./dialogs.js";
import { ItemView, type ItemContext } from "./items.js";
import { handleKey } from "./keys.js";
import { PromptBox, StatusLine, Working } from "./prompt.js";
import { ThemeContext, useTheme, type Theme } from "./theme.js";
import { truncate } from "./width.js";

function Screen({ controller, version }: { controller: Controller; version?: string }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  const width = Math.max(20, columns);
  useInput((input, key) => handleKey(controller, input, key));
  usePaste((text) => controller.paste(text));
  const context: ItemContext = { width, rows, expanded: state.expanded, cwd: state.cwd, version, awaiting: state.permission?.request.toolCall.toolCallId };
  return (
    <Box flexDirection="column" width={width}>
      <Static items={state.transcript.flushed}>
        {(item) => <Box key={item.id} width={width} flexDirection="column"><ItemView item={item} context={context} /></Box>}
      </Static>
      {state.transcript.live.map((item) => <ItemView key={item.id} item={item} live context={context} />)}
      {state.permission ? <PermissionDialog pending={state.permission} controller={controller} width={width} cwd={state.cwd} />
        : state.overlay ? <OverlayView state={state} width={width} />
          : (
            <Box flexDirection="column">
              {state.running ? <Working state={state} /> : null}
              <Box flexDirection="column" marginTop={1}>
                {state.queued.map((text, index) => <Text key={index} color={theme.muted} wrap="truncate-end">  ⏎ queued: {truncate(text.replace(/\n/g, " "), width - 14)}</Text>)}
                <PromptBox state={state} width={width} />
              </Box>
              {state.completion ? <PickList items={state.completion.items} index={state.completion.index} width={width} /> : null}
            </Box>
          )}
      <StatusLine state={state} width={width} />
    </Box>
  );
}

export function App({ controller, theme, version }: { controller: Controller; theme: Theme; version?: string }) {
  return <ThemeContext.Provider value={theme}><Screen controller={controller} version={version} /></ThemeContext.Provider>;
}
