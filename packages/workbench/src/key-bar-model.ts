export type KeyBarAction =
  | { kind: "key"; key: string; code: string; keyCode: number; shift?: boolean; mod?: boolean }
  | { kind: "insert"; text: string }
  | { kind: "dismiss" };

export interface KeyBarItem {
  id: string;
  label: string;
  title: string;
  action: KeyBarAction;
}

export interface KeyInit {
  key: string;
  code: string;
  keyCode: number;
  shiftKey: boolean;
  metaKey: boolean;
}

const key = (id: string, label: string, title: string, key: string, code: string, keyCode: number, extra: Partial<Extract<KeyBarAction, { kind: "key" }>> = {}): KeyBarItem => ({
  id,
  label,
  title,
  action: { kind: "key", key, code, keyCode, ...extra },
});
const insert = (text: string): KeyBarItem => ({ id: `insert-${text}`, label: text, title: `Insert ${text}`, action: { kind: "insert", text } });

export const KEY_BAR_ITEMS: readonly KeyBarItem[] = [
  key("escape", "esc", "Escape", "Escape", "Escape", 27),
  key("tab", "tab", "Indent", "Tab", "Tab", 9),
  key("shift-tab", "⇤", "Outdent", "Tab", "Tab", 9, { shift: true }),
  key("undo", "↶", "Undo", "z", "KeyZ", 90, { mod: true }),
  key("redo", "↷", "Redo", "z", "KeyZ", 90, { mod: true, shift: true }),
  key("left", "←", "Left", "ArrowLeft", "ArrowLeft", 37),
  key("up", "↑", "Up", "ArrowUp", "ArrowUp", 38),
  key("down", "↓", "Down", "ArrowDown", "ArrowDown", 40),
  key("right", "→", "Right", "ArrowRight", "ArrowRight", 39),
  key("home", "⇱", "Line start", "Home", "Home", 36),
  key("end", "⇲", "Line end", "End", "End", 35),
  ...["{", "}", "(", ")", "[", "]", "<", ">", "=", ";", ":", "'", '"', "`", "/", "\\", "|", "&", "*", "#", "$", "_", "-", "+", "!", "?", "~", "^", "%", "@"].map(insert),
  { id: "dismiss", label: "⌨︎", title: "Hide keyboard", action: { kind: "dismiss" } },
];

/** The sticky modifier applies to the next key only, like a one-shot Ctrl key. */
export class KeyBarModel {
  sticky = false;
  toggleSticky() {
    this.sticky = !this.sticky;
    return this.sticky;
  }
  /** Returns the keyboard event fields for a key action, consuming the sticky modifier. */
  init(action: Extract<KeyBarAction, { kind: "key" }>): KeyInit {
    const mod = !!action.mod || this.sticky;
    this.sticky = false;
    return { key: action.key, code: action.code, keyCode: action.keyCode, shiftKey: !!action.shift, metaKey: mod };
  }
}
