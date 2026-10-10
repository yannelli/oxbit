import { useSyncExternalStore } from "react";
import type { ConfigurationService } from "@oxbit/sdk";

export interface SendMode {
  coarse: boolean;
  modifierOnly: boolean;
}
type Key = {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

/** True when the key press sends the draft; false leaves the default newline. */
export function sendsOnKey(event: Key, mode: SendMode) {
  // Safari reports keyCode 229 for the Enter that commits an IME composition.
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return false;
  if (event.ctrlKey || event.metaKey) return true;
  if (event.shiftKey || event.altKey) return false;
  return !mode.coarse && !mode.modifierOnly;
}

export function sendHint(mode: SendMode) {
  if (mode.coarse) return undefined;
  return mode.modifierOnly
    ? "Ctrl/Cmd+Enter to send"
    : "Enter to send · Shift+Enter for new line";
}

const coarseQuery = "(pointer: coarse)";
const subscribe = (listener: () => void) => {
  const query = globalThis.matchMedia?.(coarseQuery);
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
};
export const useCoarsePointer = () =>
  useSyncExternalStore(subscribe, () => !!globalThis.matchMedia?.(coarseQuery).matches, () => false);

export function useSendMode(configuration: ConfigurationService): SendMode {
  const coarse = useCoarsePointer();
  const modifierOnly = useSyncExternalStore(
    configuration.subscribe,
    () => configuration.get<boolean>("agentACP.useModifierToSend") === true,
  );
  return { coarse, modifierOnly };
}
