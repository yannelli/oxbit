/** LSP glob syntax, kept separate from literal filename-association patterns. */
export function lspGlobMatches(pattern: string, file: string): boolean {
  if (typeof pattern !== "string" || pattern.length > 2048 || file.length > 8192) return false;
  let index = 0, groups = 0;
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function expression(depth = 0): string {
    if (depth > 8) throw new Error("Glob nesting limit");
    let result = "";
    while (index < pattern.length) {
      const character = pattern[index++];
      if (depth && (character === "," || character === "}")) { index--; break; }
      if (character === "*") {
        if (pattern[index] === "*") { index++; if (pattern[index] === "/") { index++; result += "(?:.*/)?"; } else result += ".*"; }
        else result += "[^/]*";
      } else if (character === "?") result += "[^/]";
      else if (character === "{") {
        if (++groups > 32) throw new Error("Glob alternative limit");
        const choices = [expression(depth + 1)];
        while (pattern[index] === ",") { index++; choices.push(expression(depth + 1)); }
        if (pattern[index++] !== "}") throw new Error("Unclosed glob group");
        result += "(?:" + choices.join("|") + ")";
      } else if (character === "[") {
        const end = pattern.indexOf("]", index);
        if (end < 0) throw new Error("Unclosed character class");
        let contents = pattern.slice(index, end); index = end + 1;
        const negate = contents[0] === "!";
        if (negate) contents = contents.slice(1);
        if (!contents || /[\\/[]/.test(contents)) throw new Error("Invalid character class");
        result += "(?!/)[" + (negate ? "^" : "") + contents.replace(/\^/g, "\\^") + "]";
      } else if (character === "\\") result += literal(pattern[index++] ?? "\\");
      else result += literal(character);
    }
    return result;
  }
  try { return new RegExp("^" + expression() + "$", "u").test(file); } catch { return false; }
}

/** Normalize watcher globs to one authorized root; registrations never grant roots. */
export function lspWatchPattern(glob: unknown, rootUri: string): string | undefined {
  try {
    const rootUrl = new URL(rootUri);
    if (rootUrl.protocol !== "file:" || rootUrl.host) return;
    const root = decodeURIComponent(rootUrl.pathname).replace(/\/$/, "");
    let pattern: string, base = root;
    if (typeof glob === "string") pattern = glob;
    else if (glob && typeof glob === "object" && "pattern" in glob && "baseUri" in glob && typeof glob.pattern === "string") {
      pattern = glob.pattern;
      const uri = typeof glob.baseUri === "string" ? glob.baseUri : (glob.baseUri as { uri?: string })?.uri;
      if (!uri) return;
      const url = new URL(uri);
      if (url.protocol !== "file:" || url.host || url.search || url.hash) return;
      base = decodeURIComponent(url.pathname).replace(/\/$/, "");
      if (pattern.startsWith("/")) return;
    } else return;
    if (base !== root && !base.startsWith(root + "/")) return;
    if (pattern.startsWith("/")) {
      if (!pattern.startsWith(root + "/")) return;
      pattern = pattern.slice(root.length + 1);
    }
    if (!pattern || pattern.length > 2048 || pattern.includes("\0") || pattern.split("/").includes("..")) return;
    return (base === root ? "" : base.slice(root.length + 1) + "/") + pattern;
  } catch { return; }
}
