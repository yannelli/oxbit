import { describe, expect, it } from "vitest";
import { agentLogoMask } from "./agent-logo.js";
import { AGENT_LOGOS } from "./agent-logos.js";

describe("agent logos", () => {
  it("maps built-ins to their registry icon and registry agents by ID", () => {
    expect(agentLogoMask("codex")).toBe(`url("data:image/svg+xml,${encodeURIComponent(AGENT_LOGOS["codex-acp"]!)}")`);
    expect(agentLogoMask("copilot")).toContain(encodeURIComponent(AGENT_LOGOS["github-copilot-cli"]!));
    expect(agentLogoMask("opencode")).toContain(encodeURIComponent(AGENT_LOGOS.opencode!));
  });
  it("uses the Oxbit mark for the Oxbit agent", () => {
    expect(agentLogoMask("oxbit")).toBe('url("/brand/oxbit-mark.svg")');
  });
  it("has no icon for custom, unknown, or prototype names", () => {
    for (const provider of ["custom", "mystery-agent", "constructor", "__proto__"])
      expect(agentLogoMask(provider)).toBeUndefined();
  });
});
