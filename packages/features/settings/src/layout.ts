export const PAGE_ORDER = ["Appearance", "Editor", "Formatting", "Files", "Terminal", "Source Control", "Language Servers", "Runtime", "Desktop", "Agent ACP"];
export const FALLBACK_PAGE = "Extensions";
const SEPARATOR = " · ";

export interface SettingSection<T> {
  /** Empty for items whose category names only the page. */
  name: string;
  category: string;
  items: T[];
}
export interface SettingPage<T> {
  name: string;
  sections: SettingSection<T>[];
}

export function splitCategory(category?: string): { page: string; section: string } {
  if (!category) return { page: FALLBACK_PAGE, section: "" };
  const at = category.indexOf(SEPARATOR);
  return at < 0 ? { page: category, section: "" } : { page: category.slice(0, at), section: category.slice(at + SEPARATOR.length) };
}

export function orderPages(names: string[]): string[] {
  const unique = [...new Set(names)];
  const rank = (name: string) => {
    const known = PAGE_ORDER.indexOf(name);
    if (known >= 0) return known;
    return name === FALLBACK_PAGE ? Number.MAX_SAFE_INTEGER : PAGE_ORDER.length + unique.indexOf(name);
  };
  return unique.sort((a, b) => rank(a) - rank(b));
}

/** Groups items by page and section. Sectionless items lead their page; other sections keep first-seen order. */
export function groupSettings<T extends { category?: string }>(items: T[]): SettingPage<T>[] {
  const pages = new Map<string, Map<string, SettingSection<T>>>();
  for (const item of items) {
    const { page, section } = splitCategory(item.category);
    const sections = pages.get(page) ?? new Map<string, SettingSection<T>>();
    pages.set(page, sections);
    const group = sections.get(section) ?? { name: section, category: section ? `${page}${SEPARATOR}${section}` : page, items: [] };
    sections.set(section, group);
    group.items.push(item);
  }
  return orderPages([...pages.keys()]).map(name => {
    const sections = [...pages.get(name)!.values()];
    return { name, sections: [...sections.filter(section => !section.name), ...sections.filter(section => section.name)] };
  });
}

export function matchesQuery(fields: (string | undefined)[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || fields.some(field => !!field && field.toLowerCase().includes(needle));
}
