import { describe, expect, it, vi } from "vitest";

vi.mock("@oxbit/host-ios", () => ({ native: {} }));
const { giteaServerUrl, remoteHost } = await import("./git-settings.js");

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

describe("Repository remote host", () => {
  it("prefers the upstream remote, then origin, then the first remote", () => {
    const remotes = [
      { name: "mirror", url: "https://git.example.test:3000/owner/repo.git" },
      { name: "origin", url: "https://GitHub.com/owner/repo.git" },
      { name: "fork", url: "https://github.com:443/fork/repo.git" },
    ];
    expect(remoteHost({ upstream: "mirror/main", remotes })).toBe("git.example.test:3000");
    expect(remoteHost({ upstream: null, remotes })).toBe("github.com");
    expect(remoteHost({ remotes: [remotes[2]] })).toBe("github.com");
  });

  it("ignores remotes without an HTTPS host", () => {
    expect(remoteHost({ remotes: [] })).toBeUndefined();
    expect(remoteHost({ remotes: [{ name: "origin", url: "file:///device/remote.git" }] })).toBeUndefined();
    expect(remoteHost({ remotes: [{ name: "origin", url: "git@github.com:owner/repo.git" }] })).toBeUndefined();
  });
});
