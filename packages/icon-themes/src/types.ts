import type { IconPackSummary, IconThemeKind } from "@oxbit/sdk";
export interface Font { id: string; src: { path: string; format: string }[]; size?: string; weight?: string; style?: string }
export interface Definition { iconPath?: string; fontCharacter?: string; fontId?: string; fontColor?: string; fontSize?: string }
export interface Associations {
  file?: string; folder?: string; folderExpanded?: string; rootFolder?: string; rootFolderExpanded?: string;
  fileNames?: Record<string, string>; fileExtensions?: Record<string, string>; languageIds?: Record<string, string>;
  folderNames?: Record<string, string>; folderNamesExpanded?: Record<string, string>;
  rootFolderNames?: Record<string, string>; rootFolderNamesExpanded?: Record<string, string>;
}
export interface Theme extends Associations {
  iconDefinitions: Record<string, Definition>;
  fonts?: Font[];
  light?: Associations;
  highContrast?: Associations;
  hidesExplorerArrows?: boolean;
  showLanguageModeIcons?: boolean;
}
export interface Manifest {
  publisher: string; name: string; version: string; displayName?: string; description?: string; license?: string;
  contributes: { iconThemes?: ThemeEntry[]; productIconThemes?: ThemeEntry[]; [key: string]: unknown };
}
export interface ThemeEntry { id: string; label?: string; path: string }
export interface StoredTheme { id: string; label: string; kind: IconThemeKind; data: Theme; path: string }
export interface Pack extends IconPackSummary {
  formatVersion: 1;
  themes: StoredTheme[];
  /** Only validated, referenced resources and legal/attribution text. Base64 is portable to desktop JSON. */
  assets: Record<string, { mime: string; base64: string }>;
}
export interface PackStore {
  read(): Promise<Pack[]>;
  put(pack: Pack): Promise<void>;
  remove(id: string): Promise<void>;
  enable(id: string, enabled: boolean): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
