import type { IconResource, IconVariant } from "@oxbit/sdk";
import type { Theme } from "./types.js";
import { variantAssociations } from "./import.js";
export function resolveDefinition(theme: Theme, resource: IconResource, variant: IconVariant): string | undefined {
  const a = variantAssociations(theme, variant);
  const parts = resource.path.replaceAll('\\', '/').toLowerCase().split('/').filter(Boolean);
  const name = parts.at(-1) ?? '', parent = parts.at(-2) ?? '';
  const named = (map?: Record<string, string>, root = false) => (!root && map?.[`${parent}/${name}`]) || map?.[name];
  if (resource.folder) {
    if (resource.root) {
      return (resource.expanded && (named(a.rootFolderNamesExpanded, true) || named(a.rootFolderNames, true) || a.rootFolderExpanded || a.rootFolder || a.folderExpanded || a.folder)) || named(a.rootFolderNames, true) || a.rootFolder || a.folder;
    }
    return (resource.expanded && (named(a.folderNamesExpanded) || named(a.folderNames) || a.folderExpanded || a.folder)) || named(a.folderNames) || a.folder;
  }
  const byName = named(a.fileNames);
  if (byName) return byName;
  const extensions: string[] = [];
  for (let at = name.indexOf('.'); at !== -1; at = name.indexOf('.', at + 1)) extensions.push(name.slice(at + 1));
  // VS Code gives all parent-qualified extensions precedence, then prefers compounds.
  for (const prefix of [`${parent}/`, '']) for (const ext of extensions) {
    const match = a.fileExtensions?.[prefix + ext];
    if (match) return match;
  }
  return (resource.languageId && a.languageIds?.[resource.languageId.toLowerCase()]) || a.file;
}
