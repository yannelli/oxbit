import type { CSSProperties } from "react";
import { cssVariables, typographyCSS, type ColorsToken, type ResolvedTheme, type SyntaxToken } from "@oxbit/themes";
import { translate as tr } from "@oxbit/ui";

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const CODE: [SyntaxToken, string][][] = [
  [["comment", "// Totals each line item"]],
  [["keyword", "export function "], ["function", "total"], ["punct", "("], ["variable", "items"], ["punct", ": "], ["type", "Item"], ["punct", "[]) {"]],
  [["keyword", "  const "], ["variable", "tax "], ["operator", "= "], ["number", "0.08"], ["punct", ";"]],
  [["keyword", "  return "], ["variable", "items"], ["punct", "."], ["property", "reduce"], ["punct", "(("], ["variable", "sum"], ["punct", ", "], ["variable", "item"], ["punct", ") "], ["operator", "=> "], ["variable", "sum "], ["operator", "+ "], ["variable", "item"], ["punct", "."], ["property", "price"], ["punct", ", "], ["number", "0"], ["punct", ");"]],
  [["text", "  "], ["tag", "<Label "], ["attr", "title"], ["operator", "="], ["string", "\"Total\""], ["tag", " />"]],
  [["punct", "}"]],
];

export function ThemePreview({ theme }: { theme: ResolvedTheme }) {
  const c = (key: ColorsToken) => theme.colors[key];
  const token = (role: SyntaxToken): CSSProperties => {
    const style = theme.syntax[role];
    return {
      color: style.foreground,
      background: style.background,
      fontWeight: style.weight,
      fontStyle: style.italic ? "italic" : "normal",
      textDecoration: style.underline ? "underline" : "none",
    };
  };
  const font = (role: keyof ResolvedTheme["typography"]) => typographyCSS(theme.typography[role]) as CSSProperties;
  const badge = (kind: "typescript" | "javascript" | "css" | "html", label: string) => (
    <span className="theme-preview-badge" style={{ color: c(`fileBadge.${kind}.foreground`), background: c(`fileBadge.${kind}.background`) }}>{label}</span>
  );
  return (
    <div
      className="theme-preview"
      role="img"
      aria-label={tr("Preview of {name}", { name: theme.name })}
      data-preview-mode={theme.mode}
      style={{ ...(cssVariables(theme) as CSSProperties), background: c("workbench.background"), color: c("text.primary"), borderColor: c("border.strong"), ...font("body") }}
    >
      <div className="theme-preview-tabs" style={{ borderColor: c("border.default"), ...font("label") }}>
        <span style={{ background: c("editor.background"), color: c("tab.active.foreground"), borderColor: c("accent.primary") }}>total.ts</span>
        <span style={{ color: c("tab.inactive.foreground"), background: c("tab.hover.background") }}>styles.css</span>
        <span style={{ color: c("tab.inactive.foreground") }}>README.md</span>
      </div>
      <div className="theme-preview-body">
        <div className="theme-preview-sidebar" style={{ background: c("surface.background"), borderColor: c("border.default") }}>
          <small style={{ color: c("text.muted"), ...font("small") }}>EXPLORER</small>
          <div style={{ background: c("list.selection.background") }}>{badge("typescript", "TS")} <span>total.ts</span> <b style={{ color: c("git.modified") }}>M</b></div>
          <div style={{ background: c("control.hover.background") }}>{badge("css", "#")} <span>styles.css</span> <b style={{ color: c("git.added") }}>A</b></div>
          <div>{badge("javascript", "JS")} <span style={{ color: c("text.secondary") }}>legacy.js</span> <b style={{ color: c("git.deleted") }}>D</b></div>
          <div>{badge("html", "<>")} <span style={{ color: c("text.disabled") }}>index.html</span> <b style={{ color: c("git.conflict") }}>!</b></div>
        </div>
        <div className="theme-preview-editor" style={{ background: c("editor.background"), ...font("editor") }}>
          {CODE.map((line, index) => (
            <div
              key={index}
              className="theme-preview-line"
              style={index === 2 ? { background: c("editor.activeLine.background") } : undefined}
            >
              <span className="theme-preview-gutter" style={{ background: c("editor.gutter.background"), color: c("editor.gutter.foreground") }}>{index + 1}</span>
              <code style={{ borderLeft: index > 1 && index < 5 ? `1px solid ${c("editor.guide")}` : undefined }}>
                {line.map(([role, text], part) => (
                  <span
                    key={part}
                    style={{
                      ...token(role),
                      ...(index === 1 && role === "function" ? { background: c("editor.selection.background"), color: c("editor.selection.foreground") } : {}),
                      ...(index === 3 && role === "property" && text === "price" ? { background: c("editor.search.activeBackground") } : {}),
                      ...(index === 3 && role === "variable" && text === "item" ? { background: c("editor.occurrence.background") } : {}),
                      ...(index === 4 && role === "attr" ? { textDecoration: `wavy underline ${c("diagnostic.error")}` } : {}),
                    }}
                  >
                    {text}
                  </span>
                ))}
                {index === 2 && <span className="theme-preview-cursor" style={{ background: c("editor.cursor") }} />}
              </code>
            </div>
          ))}
          <div className="theme-preview-popover" style={{ background: c("popover.background"), color: c("popover.foreground"), borderColor: c("border.default"), boxShadow: cssVariables(theme)["--shadow"] }}>
            <div style={{ background: c("list.selection.background") }}><span style={token("function")}>reduce</span> <small style={{ color: c("text.muted") }}>method</small></div>
            <div><span style={token("property")}>price</span> <small style={{ color: c("text.muted") }}>number</small></div>
          </div>
        </div>
      </div>
      <div className="theme-preview-controls" style={{ background: c("surface.background"), borderColor: c("border.default") }}>
        <span className="theme-preview-button" style={{ background: c("button.primary.background"), color: c("button.primary.foreground") }}>Commit</span>
        <span className="theme-preview-button" style={{ background: c("control.active.background"), borderColor: c("border.strong") }}>Cancel</span>
        <span className="theme-preview-input" style={{ background: c("input.background"), color: c("input.placeholder"), borderColor: c("focus.border") }}>Search files</span>
        <span style={{ color: c("link.foreground"), textDecoration: "underline" }}>Open docs</span>
        <span style={{ color: c("control.disabled.foreground") }}>Disabled</span>
        <span style={{ background: c("accent.background"), color: c("accent.primary") }} className="theme-preview-chip">Accent</span>
      </div>
      <div className="theme-preview-diagnostics" style={{ ...font("small") }}>
        {(["error", "warning", "info"] as const).map((kind) => (
          <span key={kind} style={{ color: c(`diagnostic.${kind}`), background: c(`diagnostic.${kind}.background`) }}>{kind}</span>
        ))}
        <span style={{ color: c("diagnostic.success") }}>success</span>
        <span style={{ background: c("diff.added.background") }}>+ added</span>
        <span style={{ background: c("diff.deleted.background") }}>- deleted</span>
      </div>
      <div className="theme-preview-terminal" style={{ background: c("terminal.background"), color: c("terminal.foreground"), ...font("terminal") }}>
        <div>
          <span style={{ color: c("terminal.green") }}>~/oxbit</span> <span style={{ color: c("terminal.blue") }}>main</span> ${" "}
          <span style={{ background: c("terminal.selectionBackground"), color: c("terminal.selectionForeground") }}>bun test</span>
          <span className="theme-preview-cursor" style={{ background: c("terminal.cursor") }} />
        </div>
        <div className="theme-preview-ansi">
          {ANSI.map((name) => (
            <span key={name} title={name} style={{ background: c(`terminal.${name}`) }} />
          ))}
          {ANSI.map((name) => {
            const bright = `terminal.bright${name[0].toUpperCase()}${name.slice(1)}` as ColorsToken;
            return <span key={bright} title={bright} style={{ background: c(bright) }} />;
          })}
        </div>
      </div>
      <div className="theme-preview-document" style={{ background: c("preview.background"), color: c("preview.foreground"), ...font("document") }}>
        <strong style={{ ...token("heading"), ...font("heading"), fontSize: undefined }}>Release notes</strong>{" "}
        <span style={token("strong")}>Faster</span> builds with <span style={token("emphasis")}>fewer</span> steps.{" "}
        <span style={token("link")}>Read more</span>
      </div>
    </div>
  );
}
