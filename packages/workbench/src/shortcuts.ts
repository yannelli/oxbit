import type { Command, Kernel } from "@zapp/sdk";
import catalog from "./catalog.json";
export function normalizeShortcut(value: string): string {
  return value
    .replace(/Mod|Meta|Cmd/g, "Ctrl")
    .replace(/(?<!Arrow)Right/g, "ArrowRight")
    .replace(/(?<!Arrow)Left/g, "ArrowLeft")
    .split(" ")
    .map((chord) => {
      const parts = chord.toLowerCase().split("+");
      const key = parts.pop();
      return [
        ...["ctrl", "shift", "alt"].filter((modifier) =>
          parts.includes(modifier),
        ),
        key,
      ].join("+");
    })
    .join(" ");
}
export function keyboardShortcut(
  event: Pick<
    KeyboardEvent,
    "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "key"
  >,
): string {
  return [
    event.ctrlKey || event.metaKey ? "Ctrl" : undefined,
    event.shiftKey ? "Shift" : undefined,
    event.altKey ? "Alt" : undefined,
    event.key === " "
      ? "Space"
      : event.key.length === 1
        ? event.key.toUpperCase()
        : event.key,
  ]
    .filter(Boolean)
    .join("+");
}
export function shortcutCandidates(
  kernel: Kernel,
  overrides: Record<string, string>,
  focus: "editor" | "terminal" | "explorer" | "other" = "other",
): { command: Command; key: string; priority: number }[] {
  const commands = kernel.commands.list();
  const result = commands.map((command) => ({
    command,
    key:
      overrides[command.id] ??
      command.shortcut ??
      catalog.commands.find((item) => item.id === command.id)?.win ??
      "",
    priority:
      (Object.hasOwn(overrides, command.id) ? 10000 : 0) +
      (command.priority || 0),
  }));
  for (const item of kernel.contributions.list("shortcut")) {
    const command = commands.find((command) => command.id === item.command);
    const key =
      typeof item.data === "string"
        ? item.data
        : (item.data as { key?: string } | undefined)?.key;
    if (
      command &&
      key &&
      !Object.hasOwn(overrides, command.id) &&
      kernel.context.matches(item.when)
    )
      result.push({
        command,
        key,
        priority: item.priority || command.priority || 0,
      });
  }
  return result
    .filter(
      (item) => item.key && kernel.commands.available(item.command.id).enabled,
    )
    .map((item) => ({
      ...item,
      priority:
        item.priority +
        ((focus === "terminal" && item.command.id.startsWith("terminal.")) ||
        (focus === "editor" && item.command.id.startsWith("editor.")) ||
        (focus === "explorer" && item.command.id.startsWith("file."))
          ? 1000
          : 0),
    }))
    .sort(
      (a, b) =>
        b.priority - a.priority || a.command.id.localeCompare(b.command.id),
    );
}
export function resolveWorkbenchShortcut(
  kernel: Kernel,
  overrides: Record<string, string>,
  key: string,
  focus: "editor" | "terminal" | "explorer" | "other" = "other",
): Command | undefined {
  return shortcutCandidates(kernel, overrides, focus).find(
    (item) => normalizeShortcut(item.key) === normalizeShortcut(key),
  )?.command;
}
export function displayShortcut(key: string | undefined): string {
  if (!key) return "";
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform);
  return mac
    ? key
        .replace(/Ctrl\+|Mod\+/g, "⌘")
        .replace(/Shift\+/g, "⇧")
        .replace(/Alt\+/g, "⌥")
        .replace(/ArrowRight/g, "→")
        .replace(/ArrowLeft/g, "←")
        .replace(/Enter/g, "↩")
    : key.replace(/Mod/g, "Ctrl");
}
