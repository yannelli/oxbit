import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { html } from "@codemirror/legacy-modes/mode/xml";
import { typescript } from "@codemirror/legacy-modes/mode/javascript";

export function astroSyntax() {
  return StreamLanguage.define({
    startState: () => ({ first: true, frontmatter: false, js: typescript.startState!(2), html: html.startState!(2) }),
    copyState: state => ({ ...state, js: typescript.copyState ? typescript.copyState(state.js) : { ...(state.js as object) }, html: html.copyState ? html.copyState(state.html) : { ...(state.html as object) } }),
    token(stream, state) {
      if (stream.sol() && (state.first || state.frontmatter) && stream.match(/^---\s*$/)) {
        state.first = false; state.frontmatter = !state.frontmatter; return "meta";
      }
      state.first = false;
      return state.frontmatter ? typescript.token(stream, state.js) : html.token(stream, state.html);
    },
  });
}

export function localSyntax(language: string): StreamParser<{ quote: string; column: number; blockComment: boolean }> {
  return {
    startState: () => ({ quote: "", column: 0, blockComment: false }),
    token(stream, state) {
      if (language === "csv") {
        if (stream.sol() && !state.quote) state.column = 0;
        const style = ["string", "number", "propertyName", "atom", "variableName"][state.column % 5];
        if (!state.quote && stream.peek() === ",") { stream.next(); state.column++; return "punctuation"; }
        if (stream.peek() === '"') {
          stream.next();
          if (state.quote && stream.eat('"')) return style;
          state.quote = state.quote ? "" : '"'; return style;
        }
        while (!stream.eol() && stream.peek() !== '"' && (state.quote || stream.peek() !== ",")) stream.next();
        return style;
      }
      if (language === "log") {
        if (stream.match(/\b(?:ERROR|FATAL|CRITICAL)\b/i)) return "invalid";
        if (stream.match(/\b(?:WARN(?:ING)?)\b/i)) return "keyword";
        if (stream.match(/\b(?:INFO|DEBUG|TRACE)\b/i)) return "comment";
        if (stream.match(/\d{4}-\d\d-\d\d[T ][\d:.+Z-]+/)) return "number";
        stream.next(); return null;
      }
      if (language === "jsonc" || language === "jsonl") {
        if (state.blockComment) { if (stream.skipTo("*/")) { stream.match("*/"); state.blockComment = false; } else stream.skipToEnd(); return "comment"; }
        if (language === "jsonc" && stream.match("//")) { stream.skipToEnd(); return "comment"; }
        if (language === "jsonc" && stream.match("/*")) { state.blockComment = true; return "comment"; }
        if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return stream.match(/^\s*:/, false) ? "propertyName" : "string";
        if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";
        if (stream.match(/^(true|false|null)\b/)) return "atom";
        if (stream.match(/^[{}[\],:]/)) return "punctuation";
        stream.next(); return null;
      }
      if (stream.eatSpace()) return null;
      if (stream.match(language === "ini" ? /^[;#].*/ : /^#.*/)) return "comment";
      if (language === "ini" && stream.match(/^\[[^\]]*\]/)) return "heading";
      if (stream.match(/^(?:export\s+)?[\w.-]+(?=\s*=)/)) return "propertyName";
      if (stream.match(/^(?:"(?:[^"\\]|\\.)*"|'[^']*')/)) return "string";
      if (language === "zsh") {
        if (stream.match(/^\$(?:\{[^}]*\}|[\w@?#*!-]+)/)) return "variableName";
        if (stream.match(/^(?:if|then|else|elif|fi|case|esac|for|foreach|while|do|done|function|end|repeat|select|in|autoload|typeset|setopt|unsetopt|zmodload|emulate)\b/)) return "keyword";
        if (stream.match(/^[\w-]+(?=\s*\(\))/)) return "def";
      }
      if (stream.match(/^\d+(?:\.\d+)?\b/)) return "number";
      if (stream.match(/^[=|&;(){}<>]/)) return "operator";
      stream.next(); return null;
    },
    languageData: { commentTokens: { line: language === "ini" ? ";" : "#" } },
  };
}
