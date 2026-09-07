import { currentTheme } from "@oxbit/workbench";
import { fontFamily } from "@oxbit/themes";
import type { Kernel, Setting } from "@oxbit/sdk";
type Layers = {
  user: Record<string, unknown>;
  workspace: Record<string, unknown>;
  userLanguages: Record<string, Record<string, unknown>>;
  workspaceLanguages: Record<string, Record<string, unknown>>;
};
export function scopedSetting(
  kernel: Kernel,
  setting: Setting,
  scope: "user" | "workspace",
  language?: string,
) {
  const data = kernel.configuration.export() as Layers;
  const base = scope === "user" ? data.user : data.workspace;
  const own = language
    ? (scope === "user" ? data.userLanguages : data.workspaceLanguages)[
        language
      ] || {}
    : base;
  const layers = [
    data.user,
    ...(scope === "workspace" ? [data.workspace] : []),
    ...(language
      ? [
          data.userLanguages[language],
          ...(scope === "workspace" ? [data.workspaceLanguages[language]] : []),
        ]
      : []),
  ];
  let value: unknown = setting.default;
  const match = setting.id.match(
    /^(ui|editor|terminal)\.(fontFamily|fontSize|fontWeight|fontStyle|lineHeight|letterSpacing|fontLigatures)$/,
  );
  if (match) {
    const theme = currentTheme(kernel);
    const font =
      theme.typography[
        match[1] === "ui" ? "body" : (match[1] as "editor" | "terminal")
      ];
    const values: Record<string, unknown> = {
      fontFamily: fontFamily(font),
      fontSize: font.size,
      fontWeight: font.weight,
      fontStyle: font.style,
      lineHeight:
        match[1] === "editor" ? font.lineHeight * font.size : font.lineHeight,
      letterSpacing: font.letterSpacing,
      fontLigatures: font.ligatures,
    };
    value = values[match[2]];
  }

  for (const layer of layers)
    if (layer && Object.hasOwn(layer, setting.id)) value = layer[setting.id];
  return { value, modified: Object.hasOwn(own, setting.id) };
}
