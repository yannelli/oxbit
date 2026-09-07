import MarkdownIt from "markdown-it";
import { javascriptLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { highlightTree, classHighlighter } from "@lezer/highlight";

const markdown = new MarkdownIt({ html: false, linkify: true });
const escape = (value: string) => markdown.utils.escapeHtml(value);
function codeBlock(value: string, language: string) {
  const name = language.trim().split(/\s/)[0].toLowerCase();
  const parser = /^(ts|typescript|tsx)$/.test(name) ? typescriptLanguage.parser
    : /^(js|javascript|jsx)$/.test(name) ? javascriptLanguage.parser : undefined;
  let code = "", end = 0;
  if (parser) highlightTree(parser.parse(value), classHighlighter, (from, to, classes) => {
    code += escape(value.slice(end, from)) + `<span class="${classes}">${escape(value.slice(from, to))}</span>`;
    end = to;
  });
  code += escape(value.slice(end));
  return `<div class="lsp-code-block">${name ? `<div class="lsp-code-language">${escape(name)}</div>` : ""}<pre><code>${code}</code></pre></div>`;
}
markdown.renderer.rules.fence = (tokens, index) => codeBlock(tokens[index].content, tokens[index].info);
markdown.renderer.rules.code_block = (tokens, index) => codeBlock(tokens[index].content, "");
// Documentation is untrusted. Do not load remote images or execute command/file links.
markdown.disable("image");
markdown.validateLink = (url) => /^(https?:|mailto:)/i.test(url);
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};

/** LSP MarkupContent, MarkedString, and legacy MarkedString arrays. */
export function renderHover(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderHover).filter(Boolean).join('<hr class="lsp-hover-divider">');
  if (typeof value === "string") return markdown.render(value);
  if (!value || typeof value !== "object" || !("value" in value) || typeof value.value !== "string") return "";
  if ("kind" in value && value.kind === "plaintext") return `<div class="lsp-plaintext">${escape(value.value)}</div>`;
  if ("language" in value && typeof value.language === "string") return codeBlock(value.value, value.language);
  return markdown.render(value.value);
}

export function hoverDOM(contents: unknown) {
  const dom = document.createElement("div");
  dom.className = "lsp-tooltip";
  dom.setAttribute("aria-label", "Symbol documentation");
  dom.tabIndex = 0;
  dom.innerHTML = renderHover(contents);
  return dom;
}
