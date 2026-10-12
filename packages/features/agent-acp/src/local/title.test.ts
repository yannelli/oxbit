import { describe, expect, it } from "vitest";
import { cleanTitle } from "./title.js";
import { anthropicMessages, chatCompletions, openaiResponses } from "@oxbit/agent-core";

describe("generated conversation titles", () => {
  it("keeps the first line without wrapping quotes or trailing punctuation, up to 80 characters", () => {
    expect(cleanTitle("\"Fix the login bug.\"")).toBe("Fix the login bug");
    expect(cleanTitle("\n  “Refactor   the parser”!\nThis title covers the parser work.")).toBe("Refactor the parser");
    expect(cleanTitle("'Add queue tests'...")).toBe("Add queue tests");
    expect(cleanTitle("Explain `useEffect` cleanup?")).toBe("Explain `useEffect` cleanup");
    const long = cleanTitle("word ".repeat(30));
    expect(long).toHaveLength(79);
    expect(long.startsWith("word word")).toBe(true);
    expect(cleanTitle(" \".\" \n")).toBe("");
  });
  it("leaves out the tools key when a request has no tools", () => {
    const input = { model: "m", system: "s", turns: [{ role: "user" as const, text: "t" }], tools: [], maxTokens: 30 };
    for (const adapter of [openaiResponses, anthropicMessages, chatCompletions])
      expect(adapter.request(input).body).not.toHaveProperty("tools");
    expect(anthropicMessages.request(input).body).toMatchObject({ max_tokens: 30 });
  });
});
