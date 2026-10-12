import type { Key } from "ink";
import type { Controller } from "./controller.js";
import { backspace, deleteForward, deleteWordLeft, end, home, insert, killLineLeft, killLineRight, left, right, vertical, wordLeft, wordRight } from "./editor.js";
import { DECISIONS } from "./permission.js";

function permissionKey(controller: Controller, input: string, key: Key) {
  const pending = controller.getState().permission!;
  const choose = (index: number) => controller.decide(DECISIONS[index]);
  if (key.upArrow || key.downArrow) {
    const index = (pending.index + (key.upArrow ? -1 : 1) + DECISIONS.length) % DECISIONS.length;
    return controller.set({ permission: { ...pending, index } });
  }
  if (key.return) return choose(pending.index);
  if (key.escape) return controller.decide("deny");
  const shortcut = { 1: 0, 2: 1, 3: 2, y: 0, a: 1, n: 2 }[input.toLowerCase()];
  if (shortcut !== undefined) choose(shortcut);
}

function overlayKey(controller: Controller, input: string, key: Key) {
  const overlay = controller.getState().overlay!;
  if (overlay.kind === "help") {
    if (key.escape || key.return || input === "q") controller.set({ overlay: undefined });
    return;
  }
  if (key.escape) return controller.set({ overlay: undefined });
  if (key.upArrow || key.downArrow) return controller.moveOverlay(key.upArrow ? -1 : 1);
  if (key.return) return controller.confirmOverlay();
  if (overlay.kind === "models" && (key.leftArrow || key.rightArrow)) return void controller.cycleReasoning(key.leftArrow ? -1 : 1);
  if (key.backspace || key.delete) return controller.filter(overlay.filter.slice(0, -1));
  if (input && !key.ctrl && !key.meta && !key.tab) controller.filter(overlay.filter + input);
}

/** Routes one key press: Ctrl+C first, then the permission dialog, an open overlay, completion, and the editor. */
export function handleKey(controller: Controller, input: string, key: Key) {
  const state = controller.getState();
  const draft = state.draft;
  const edit = controller.setDraft.bind(controller);
  if (key.ctrl && input === "c") return controller.interrupt();
  if (state.permission) return permissionKey(controller, input, key);
  if (state.overlay) return overlayKey(controller, input, key);
  if (key.tab && key.shift) return controller.cycleMode();
  if (key.ctrl && input === "o") return controller.set({ expanded: !state.expanded });
  if (key.ctrl && input === "p") return controller.openModels();
  if (key.ctrl && input === "d") return draft.text ? edit(deleteForward(draft)) : controller.exit();
  if (key.escape) {
    if (state.completion) return controller.dismissCompletion();
    if (state.running) return controller.cancel();
    return;
  }
  if (state.completion) {
    if (key.upArrow || key.downArrow) return controller.moveCompletion(key.upArrow ? -1 : 1);
    if (key.tab) return controller.acceptCompletion(false);
    if (key.return && !key.shift && !key.meta) return controller.acceptCompletion(true);
  }
  if (key.return) {
    if (key.shift || key.meta) return edit(insert(draft, "\n"));
    if (draft.text[draft.cursor - 1] === "\\") return edit(insert(backspace(draft), "\n"));
    return controller.submit();
  }
  if (input === "\n" || (key.ctrl && input === "j")) return edit(insert(draft, "\n"));
  if (key.upArrow || key.downArrow) {
    const step = key.upArrow ? -1 : 1;
    const moved = vertical(draft, step);
    if (moved) return edit(moved);
    return void controller.recall(step);
  }
  if (key.leftArrow) return edit(key.meta || key.ctrl ? wordLeft(draft) : left(draft));
  if (key.rightArrow) return edit(key.meta || key.ctrl ? wordRight(draft) : right(draft));
  if (key.home || (key.ctrl && input === "a")) return edit(home(draft));
  if (key.end || (key.ctrl && input === "e")) return edit(end(draft));
  if (key.backspace) return edit(key.meta || key.ctrl ? deleteWordLeft(draft) : backspace(draft));
  if (key.delete) return edit(deleteForward(draft));
  if (key.ctrl && input === "w") return edit(deleteWordLeft(draft));
  if (key.ctrl && input === "u") return edit(killLineLeft(draft));
  if (key.ctrl && input === "k") return edit(killLineRight(draft));
  if (key.meta && input === "b") return edit(wordLeft(draft));
  if (key.meta && input === "f") return edit(wordRight(draft));
  if (input && !key.ctrl && !key.meta && !key.tab) edit(insert(draft, input.replace(/\r\n?/g, "\n")));
}
