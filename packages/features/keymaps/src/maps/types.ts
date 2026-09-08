export interface Keymap {
  stableId: string;
  title: string;
  description: string;
  /** Command id to shortcut, in catalog vocabulary; "" removes the default binding. */
  bindings: Record<string, string>;
}
