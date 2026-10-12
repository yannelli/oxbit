export type TokenKind = "keyword" | "string" | "comment" | "number" | "added" | "removed" | "meta";
export interface Token { text: string; kind?: TokenKind }

const KEYWORDS = new Set(("abstract as async await break case catch class const continue def default defer del do elif else enum export extends "
  + "false final finally fn for from func function go if impl import in interface is lambda let loop match mod module mut new nil none None "
  + "null package pass private protected pub public raise return self static struct super switch this throw throws trait true True False "
  + "try type typeof undefined unless use val var void where while with yield echo then fi esac done local readonly").split(" "));
const HASH = new Set(["sh", "bash", "zsh", "shell", "console", "py", "python", "rb", "ruby", "yaml", "yml", "toml", "ini", "conf", "dockerfile", "make", "makefile", "r", "perl", "pl", "nix"]);
const SLASH = /(\/\/.*$|\/\*.*?(?:\*\/|$))/;
const POUND = /((?:^|\s)#.*$)/;
const COMMON = /("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?|\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[\da-f]+\b|[A-Za-z_$][\w$]*)/i;
const NAMES: Record<string, string> = { js: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx", py: "python", rb: "ruby", sh: "shell", rs: "rust", md: "markdown", yml: "yaml" };

export const languageLabel = (lang: string) => NAMES[lang.toLowerCase()] ?? lang.toLowerCase();

/** Line-local highlighting for common languages; multi-line strings and comments are not tracked. */
export function highlight(line: string, lang: string): Token[] {
  const name = lang.toLowerCase();
  if (name === "diff" || name === "patch") {
    const kind = line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : line.startsWith("@@") ? "meta" : undefined;
    return [{ text: line, ...(kind ? { kind } : {}) }];
  }
  if (!name || name === "text" || name === "txt" || name === "markdown" || name === "md") return [{ text: line }];
  const comment = HASH.has(name) ? POUND : name === "json" ? undefined : SLASH;
  const pattern = new RegExp(`${comment ? `${comment.source}|` : ""}${COMMON.source}`, "gi");
  const tokens: Token[] = [];
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const text = match[0];
    const at = match.index;
    if (at > last) tokens.push({ text: line.slice(last, at) });
    const first = text.trimStart()[0];
    const kind: TokenKind | undefined = comment && match[1] !== undefined ? "comment"
      : first === "\"" || first === "'" || first === "`" ? "string"
        : /^\d/.test(text) ? "number"
          : KEYWORDS.has(text) ? "keyword" : undefined;
    tokens.push({ text, ...(kind ? { kind } : {}) });
    last = at + text.length;
  }
  if (last < line.length) tokens.push({ text: line.slice(last) });
  return tokens;
}
