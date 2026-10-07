import { describe, expect, it, vi } from "vitest";

vi.mock("@oxbit/host-ios", () => ({ native: {} }));
const { giteaServerUrl } = await import("./git-settings.js");

describe("Gitea server URL", () => {
  it("returns an HTTPS base without a trailing slash", () => {
    expect(giteaServerUrl(" https://Git.Example.test/ ")).toBe("https://git.example.test");
    expect(giteaServerUrl("https://git.example.test:3000/gitea/")).toBe("https://git.example.test:3000/gitea");
  });

  it("ignores incomplete or unsafe addresses", () => {
    for (const value of ["", "git.example.test", "http://git.example.test", "https://user:secret@git.example.test", "https://git.example.test/?next=x", "https://git.example.test/#top"])
      expect(giteaServerUrl(value)).toBeUndefined();
  });
});
