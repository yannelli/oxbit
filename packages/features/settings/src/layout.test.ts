import { describe, expect, it } from "vitest";
import { groupSettings, matchesQuery, orderPages, splitCategory } from "./layout.js";

describe("settings layout", () => {
  it("splits categories into a page and a section", () => {
    expect(splitCategory("Editor · Typography")).toEqual({ page: "Editor", section: "Typography" });
    expect(splitCategory("Language Servers · Bash / sh")).toEqual({ page: "Language Servers", section: "Bash / sh" });
    expect(splitCategory("Terminal")).toEqual({ page: "Terminal", section: "" });
    expect(splitCategory(undefined)).toEqual({ page: "Extensions", section: "" });
    expect(splitCategory("")).toEqual({ page: "Extensions", section: "" });
  });

  it("orders known pages first, then others by first appearance, with Extensions last", () => {
    expect(orderPages(["Extensions", "Zeta", "Terminal", "Agent ACP", "Alpha", "Appearance", "Zeta"]))
      .toEqual(["Appearance", "Terminal", "Agent ACP", "Zeta", "Alpha", "Extensions"]);
  });

  it("groups items by page and puts sectionless items before named sections", () => {
    const pages = groupSettings([
      { id: "a", category: "Editor · Typography" },
      { id: "b", category: "Editor" },
      { id: "c", category: "Editor · Indentation" },
      { id: "d", category: "Editor · Typography" },
      { id: "e" },
      { id: "f", category: "Appearance" },
    ]);
    expect(pages.map(page => page.name)).toEqual(["Appearance", "Editor", "Extensions"]);
    expect(pages[1]!.sections.map(section => [section.name, section.category, section.items.map(item => item.id)])).toEqual([
      ["", "Editor", ["b"]],
      ["Typography", "Editor · Typography", ["a", "d"]],
      ["Indentation", "Editor · Indentation", ["c"]],
    ]);
  });

  it("matches any field case-insensitively and treats a blank query as a match", () => {
    expect(matchesQuery(["Tab Size", "editor.tabSize"], "TABSIZE")).toBe(true);
    expect(matchesQuery(["Tab Size", undefined], "indent")).toBe(false);
    expect(matchesQuery([], "  ")).toBe(true);
  });
});
