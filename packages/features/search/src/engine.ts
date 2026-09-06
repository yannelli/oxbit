export interface SearchOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  include?: string;
  exclude?: string;
}
export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  from: number;
  to: number;
  text: string;
  revision: string;
  version?: number;
  replacement?: string;
}
export function matcher(options: SearchOptions): RegExp {
  if (!options.query) throw new Error("Enter search text");
  let pattern = options.regex
    ? options.query
    : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  return new RegExp(pattern, options.caseSensitive ? "gu" : "giu");
}
export function globMatch(path: string, patterns: string | undefined): boolean {
  if (!patterns?.trim()) return true;
  return patterns.split(",").some((raw) => {
    let p = raw.trim();
    if (!p) return false;
    if (!p.includes("/")) p = "**/" + p;
    const expression = p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\x01")
      .replace(/\*\*/g, "\x02")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\x01/g, "(?:.*/)?")
      .replace(/\x02/g, ".*");
    return new RegExp("^" + expression + "$").test(path);
  });
}
export function searchText(
  path: string,
  text: string,
  revision: string,
  options: SearchOptions,
  version?: number,
): SearchMatch[] {
  if (
    !globMatch(path, options.include) ||
    (options.exclude?.trim() && globMatch(path, options.exclude))
  )
    return [];
  const regex = matcher(options);
  const results: SearchMatch[] = [];
  let line = 1;
  let lineStart = 0;
  let nextLine = text.indexOf("\n");
  for (const m of text.matchAll(regex)) {
    const from = m.index;
    while (nextLine >= 0 && nextLine < from) {
      line++;
      lineStart = nextLine + 1;
      nextLine = text.indexOf("\n", lineStart);
    }
    results.push({
      path,
      line,
      column: from - lineStart + 1,
      from,
      to: from + m[0].length,
      text: text.slice(lineStart, nextLine < 0 ? text.length : nextLine),
      revision,
      version,
    });
    if (results.length >= 10000) break;
  }
  return results;
}
export function replaceMatch(
  text: string,
  from: number,
  to: number,
  options: SearchOptions,
  replacement: string,
) {
  const re = matcher(options);
  for (const match of text.matchAll(re)) {
    if (match.index !== from || from + match[0].length !== to) continue;
    return replacement.replace(
      /\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g,
      (token, key: string) => {
        if (key === "$") return "$";
        if (key === "&") return match[0];
        if (key === "`") return text.slice(0, from);
        if (key === "'") return text.slice(to);
        if (key.startsWith("<")) return match.groups?.[key.slice(1, -1)] ?? "";
        return match[Number(key)] ?? token;
      },
    );
  }
  throw new Error("Search match changed");
}
