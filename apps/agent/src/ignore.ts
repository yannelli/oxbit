/** Glob to RegExp for slash-separated paths: `**` spans directories, `*` and `?` stay inside one, `{a,b}` and `[...]` work. */
export function globSource(glob: string) {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      const slash = glob[index + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = glob.indexOf("]", index + 2);
      if (end < 0) source += "\\[";
      else {
        const body = glob.slice(index + 1, end).replace(/\\/g, "\\\\");
        source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        index = end;
      }
    } else if (char === "{") {
      const end = glob.indexOf("}", index);
      if (end < 0) source += "\\{";
      else {
        source += `(?:${glob.slice(index + 1, end).split(",").map(globSource).join("|")})`;
        index = end;
      }
    } else if (char === "\\" && index + 1 < glob.length) source += `\\${glob[++index]}`;
    else source += /[.+^$()|\\/]/.test(char) ? `\\${char}` : char;
  }
  return source;
}

/** Splits a comma-separated glob list, keeping commas inside braces. */
export const splitGlobs = (list: string | undefined) => (list ?? "").split(/,(?![^{]*\})/).map((item) => item.trim()).filter(Boolean);

/** Comma-separated include globs. A glob without a slash matches the file name at any depth. */
export function globFilter(list: string | undefined) {
  const globs = splitGlobs(list);
  if (!globs.length) return undefined;
  const patterns = globs.map((glob) => new RegExp(`^${globSource(glob.includes("/") ? glob.replace(/^\.?\//, "") : `**/${glob}`)}$`));
  return (path: string) => patterns.some((pattern) => pattern.test(path));
}

interface Rule {
  pattern: RegExp;
  negate: boolean;
  directory: boolean;
}

/** Rules of one .gitignore file whose directory is `base` (relative to the walk root, "" for the root). */
export function parseGitignore(text: string, base: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    const directory = line.endsWith("/");
    if (directory) line = line.slice(0, -1);
    if (!line) continue;
    const anchored = line.includes("/");
    const glob = anchored ? line.replace(/^\//, "") : `**/${line}`;
    const prefix = base ? `${base.replace(/[.+^$()|[\]{}*?\\]/g, "\\$&")}/` : "";
    rules.push({ pattern: new RegExp(`^${prefix}${globSource(glob)}$`), negate, directory });
  }
  return rules;
}

/** gitignore rules collected while walking down from the root. The last matching rule decides. */
export class IgnoreRules {
  constructor(private rules: readonly Rule[] = []) {}
  with(text: string, base: string) {
    return new IgnoreRules([...this.rules, ...parseGitignore(text, base)]);
  }
  /** The walker checks each directory before it descends, so a path's parents are already known to be kept. */
  ignores(path: string, directory: boolean) {
    let ignored = false;
    for (const rule of this.rules)
      if ((directory || !rule.directory) && rule.pattern.test(path)) ignored = !rule.negate;
    return ignored;
  }
}
