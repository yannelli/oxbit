import React, { useEffect, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import type { Extension, FeatureOptions } from "@oxbit/sdk";
import { translate as tr } from "@oxbit/ui";
import { resolvePreviewLink, headingId, scrollFraction } from "./policy.js";
import { createHtmlPreview } from "./html-preview.js";
import { isHtmlPath } from "./html.js";
import { audioTypes, createMediaPreview } from "./media-preview.js";
export { resolvePreviewLink, headingId, scrollFraction } from "./policy.js";
const renderer = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});
renderer.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  const text = tokens[index + 1]?.content || "";
  const base = headingId(text);
  const counts: Map<string, number> = env.headings;
  const count = counts.get(base) || 0;
  counts.set(base, count + 1);
  tokens[index]!.attrSet("id", base + (count ? "-" + count : ""));
  if (tokens[index]!.map)
    tokens[index]!.attrSet("data-source-line", String(tokens[index]!.map![0]));
  return self.renderToken(tokens, index, options);
};
export function renderMarkdown(text: string) {
  return DOMPurify.sanitize(renderer.render(text, { headings: new Map() }), {
    FORBID_TAGS: [
      "style",
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "video",
      "audio",
      "img",
    ],
    FORBID_ATTR: ["style", "srcset", "target"],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["data-source-line"],
  });
}
export function createFeature(o: FeatureOptions): Extension {
  const ownedViews = new Set<string>();
  const HtmlPreview = createHtmlPreview(o);
  const PdfPreview = createMediaPreview(o, "pdf");
  const AudioPreview = createMediaPreview(o, "audio");
  function Preview({ path }: { path: string }) {
    const [html, setHtml] = useState(""),
      [error, setError] = useState("");
    const ref = useRef<HTMLElement>(null);
    useEffect(() => {
      let stopped = false,
        frame = 0,
        scrollFrame = 0,
        source: HTMLElement | undefined;
      let syncing = false;
      const preview = ref.current;
      const update = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const doc = o.documents.get(path);
          if (doc && !stopped) {
            try {
              setHtml(renderMarkdown(doc.text.toString()));
              setError("");
            } catch (failure) {
              setError(String(failure));
            }
          }
        });
      };
      void o.documents
        .open(path)
        .then(update)
        .catch((failure: unknown) => setError(String(failure)));
      const onChange = o.kernel.events.on("document.change", ({ id }) => {
        if (o.documents.get(path)?.id === id) update();
      });
      const scroll = (from: HTMLElement, to: HTMLElement) => {
        if (syncing) return;
        syncing = true;
        to.scrollTop =
          scrollFraction(from) * Math.max(0, to.scrollHeight - to.clientHeight);
        cancelAnimationFrame(scrollFrame);
        scrollFrame = requestAnimationFrame(() => {
          syncing = false;
        });
      };
      const fromSource = () => {
        if (source && preview) scroll(source, preview);
      };
      const fromPreview = () => {
        if (source && preview) scroll(preview, source);
      };
      const attach = () => {
        const next = o.workbench.editorForPath(path)?.scrollDOM as
          HTMLElement | undefined;
        if (source !== next) {
          source?.removeEventListener("scroll", fromSource);
          source = next;
          source?.addEventListener("scroll", fromSource, { passive: true });
        }
      };
      const active = o.kernel.events.on("editor.active", () =>
        requestAnimationFrame(attach),
      );
      requestAnimationFrame(attach);
      preview?.addEventListener("scroll", fromPreview, { passive: true });
      return () => {
        stopped = true;
        cancelAnimationFrame(frame);
        cancelAnimationFrame(scrollFrame);
        onChange.dispose();
        active.dispose();
        source?.removeEventListener("scroll", fromSource);
        preview?.removeEventListener("scroll", fromPreview);
      };
    }, [path]);
    return React.createElement(
      "div",
      { className: "markdown-document" },
      React.createElement(
        "div",
        { className: "preview-toolbar" },
        React.createElement("span", null, path),
        React.createElement(
          "button",
          {
            className: "button",
            onClick: () => void o.workbench.openFile(path, { preview: false }),
          },
          tr("Open source"),
        ),
      ),
      error &&
        React.createElement(
          "p",
          { role: "alert", className: "error-text" },
          error,
        ),
      React.createElement("article", {
        ref,
        className: "markdown-preview",
        tabIndex: 0,
        "aria-label": tr("Markdown preview"),
        onClick: (event: React.MouseEvent) => {
          const link = (event.target as HTMLElement).closest("a");
          if (!link) return;
          event.preventDefault();
          const target = resolvePreviewLink(
            path,
            link.getAttribute("href") || "",
          );
          if (target.kind === "blocked") {
            o.workbench.notify(target.reason, "warning");
            return;
          }
          if (target.kind === "external") {
            window.open(target.url, "_blank", "noopener,noreferrer");
            return;
          }
          if (target.kind === "anchor") {
            ref.current
              ?.querySelector("#" + CSS.escape(target.id))
              ?.scrollIntoView();
            return;
          }
          void (async () => {
            let line: number | undefined;
            if (target.anchor) {
              const doc = await o.documents.open(target.path);
              line =
                doc.text
                  .toString()
                  .split("\n")
                  .findIndex(
                    (text: string) =>
                      /^#{1,6}\s/.test(text) &&
                      headingId(text.replace(/^#{1,6}\s+/, "")) ===
                        target.anchor,
                  ) + 1;
              if (!line) line = undefined;
            }
            await o.workbench.openFile(target.path, { line });
          })().catch((error) => o.workbench.notify(String(error), "error"));
        },
        dangerouslySetInnerHTML: { __html: html },
      }),
    );
  }
  const open = async (side = false) => {
    const path = o.workbench.activePath();
    if (!path || !/\.md$/i.test(path))
      throw new Error("Open a Markdown document first");
    let groupId: string | undefined;
    if (side) {
      groupId = o.workbench.split("row");
      if (!groupId) return;
    }
    const id = "preview:" + path;
    ownedViews.add(id);
    o.workbench.openView(
      id,
      tr("{0} Preview", { 0: path.split("/").pop() }),
      Preview,
      { path },
      { groupId, path, contributionId: "markdown.preview" },
    );
  };
  const openHtml = (side = false) => {
    const path = o.workbench.activePath();
    if (!path || !isHtmlPath(path)) throw new Error("Open an HTML document first");
    const groupId = side ? o.workbench.split("row") : undefined;
    if (side && !groupId) return;
    const id = "html-preview:" + path;
    ownedViews.add(id);
    o.workbench.openView(id, tr("{0} Preview", { 0: path.split("/").pop() }), HtmlPreview,
      { path }, { groupId, path, contributionId: "html.preview" });
  };
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.previews",
      name: "Document & Media Previews",
      description: "Markdown and HTML/CSS previews, PDF viewing, and audio playback for MP3, WAV, M4A, FLAC, Ogg, and more.",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["filesystem.read"],
    },
    activate(ctx) {
      ctx.own(ctx.contributions.register({
        id: "pdf.preview", kind: "documentView", title: "PDF Viewer", component: PdfPreview,
        data: { binary: true, extensions: ["pdf"] },
      }));
      ctx.own(ctx.contributions.register({
        id: "audio.preview", kind: "documentView", title: "Audio Player", component: AudioPreview,
        data: { binary: true, extensions: Object.keys(audioTypes) },
      }));
      ctx.own(ctx.contributions.register({
        id: "html.preview", kind: "documentView", title: "HTML preview", component: HtmlPreview,
      }));
      ctx.own(ctx.commands.register({
        id: "preview.html", title: "Open HTML Preview", when: "html", shortcut: "Ctrl+Shift+V", run: () => openHtml(),
      }));
      ctx.own(ctx.commands.register({
        id: "preview.htmlSide", title: "Open HTML Preview to the Side", when: "html", shortcut: "Ctrl+K V", run: () => openHtml(true),
      }));
      ctx.own(
        ctx.contributions.register({
          id: "markdown.preview",
          kind: "documentView",
          title: "Markdown preview",
          component: Preview,
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "preview.markdown",
          title: "Open Markdown Preview",
          when: "markdown",
          shortcut: "Ctrl+Shift+V",
          run: () => open(),
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "preview.markdownSide",
          title: "Open Markdown Preview to the Side",
          when: "markdown",
          shortcut: "Ctrl+K V",
          run: () => open(true),
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "preview.toggle",
          title: "Toggle Markdown Preview",
          when: "markdown",
          run: () => {
            const path = o.workbench.activePath();
            if (path && !o.workbench.activeEditor()) {
              o.workbench.closeView("preview:" + path);
              return o.workbench.openFile(path, { preview: false });
            }
            return open();
          },
        }),
      );
      ctx.subscribe(() => {
        for (const id of ownedViews) o.workbench.closeView(id);
        ownedViews.clear();
      });
    },
  };
}
