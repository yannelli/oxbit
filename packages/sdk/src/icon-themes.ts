/** Declarative icon resources. SVG paths retain the original extension API. */
export type IconAsset =
  | { kind: "path"; path: string }
  | { kind: "image"; url: string }
  | { kind: "font"; family: string; character: string; color?: string; size?: string; weight?: string; style?: string };
export type IconVariant = "dark" | "light" | "highContrast";
export type IconThemeKind = "fileIconTheme" | "productIconTheme";
export interface IconResource {
  path: string;
  languageId?: string;
  folder?: boolean;
  expanded?: boolean;
  root?: boolean;
}
export interface IconThemeContributionData {
  packId: string;
  revision: string;
  themeId: string;
}
export interface ColorThemeMetadata {
  mode: "dark" | "light";
  highContrast?: boolean;
}
export interface IconThemeSummary {
  id: string;
  label: string;
  kind: IconThemeKind;
}
export interface IconPackSummary {
  id: string;
  revision: string;
  label: string;
  publisher: string;
  version: string;
  license?: string;
  description?: string;
  enabled: boolean;
  themes: IconThemeSummary[];
  warnings: string[];
}
/** Preview handles are opaque: only the importing service may install them. */
export interface IconPackPreview extends IconPackSummary {
  samples: IconAsset[];
  dispose(): void;
}
export interface IconThemes {
  subscribe(listener: () => void): () => void;
  snapshot(): number;
  list(): IconPackSummary[];
  samples(id: string): IconAsset[];
  themes(kind: IconThemeKind): IconThemeSummary[];
  preview(file: Blob, name: string, signal?: AbortSignal): Promise<IconPackPreview>;
  install(preview: IconPackPreview): Promise<void>;
  enable(id: string, enabled: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  file(resource: IconResource, variant: IconVariant): IconAsset | undefined;
  product(vscodeId: string): IconAsset | undefined;
  hideArrows(resource: IconResource, variant: IconVariant): boolean;
  dispose(): void;
}
export interface FileIconThemeContribution {
  id: string;
  kind: "fileIconTheme";
  title: string;
  data: IconThemeContributionData;
}
export interface ProductIconThemeContribution {
  id: string;
  kind: "productIconTheme";
  title: string;
  data: IconThemeContributionData;
}
