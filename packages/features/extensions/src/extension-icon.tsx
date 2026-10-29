import type { ContributionKind, ExtensionManifest, Kernel } from "@oxbit/sdk";
import { Icon } from "@oxbit/ui";

const KIND_ICONS: [ContributionKind[], string][] = [
  [["theme"], "sun"],
  [["fileIconTheme", "productIconTheme", "icon"], "files"],
  [["keymap", "shortcut"], "keyboard"],
  [["language", "diagnostics", "completion", "formatter", "codeAction", "semanticTokens", "inlayHints", "navigation"], "languageServer"],
  [["filesystem", "transport"], "cloud"],
];
const CAPABILITY_ICONS: Record<string, string> = {
  terminal: "terminal", tasks: "tasks", git: "git", lsp: "languageServer", collaboration: "users", extensions: "ext",
};
const IMAGE_SOURCE = /^(?:data:image\/|https?:|\/|\.\.?\/)/;

/** The manifest's `icon`, then the icon of its sidebar view, then one for what it contributes. */
export function extensionIcon(manifest: ExtensionManifest, kernel: Kernel): string {
  if (manifest.icon) return manifest.icon;
  const contributions = [...manifest.contributions ?? [], ...kernel.contributions.list().filter(item => item.owner === manifest.id)];
  const view = contributions.find(item => item.kind === "activityView" && typeof (item.data as { icon?: unknown })?.icon === "string");
  if (view) return (view.data as { icon: string }).icon;
  const kinds = new Set(contributions.map(item => item.kind));
  const byKind = KIND_ICONS.find(([group]) => group.some(kind => kinds.has(kind)));
  if (byKind) return byKind[1];
  const byCapability = manifest.capabilities.map(capability => CAPABILITY_ICONS[capability.split(".")[0]!]).find(Boolean);
  if (byCapability) return byCapability;
  return /(?:^|[.-])(?:agent|ai)(?:$|[.-])/.test(manifest.id) ? "agent" : "package";
}

export function ExtensionIcon({ manifest, kernel, size }: { manifest: ExtensionManifest; kernel: Kernel; size: number }) {
  const icon = extensionIcon(manifest, kernel);
  return IMAGE_SOURCE.test(icon) ? <img src={icon} alt="" width={size} height={size} /> : <Icon name={icon} size={size} />;
}
