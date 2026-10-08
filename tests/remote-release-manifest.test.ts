import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error plain-node release script without types
import { buildReleaseManifest, writeReleaseAssets } from "../scripts/remote/release-manifest.mjs";

const temps: string[] = [];
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function payloads(contents: Record<string, string>, manifest?: Record<string, { sha256: string }>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oxbit-remote-manifest-"));
  temps.push(directory);
  const platforms: Record<string, { sha256: string }> = {};
  for (const [platform, text] of Object.entries(contents)) {
    const bytes = Buffer.from(text);
    fs.writeFileSync(path.join(directory, `${platform}.tar.gz`), bytes);
    platforms[platform] = { sha256: sha256(bytes) };
  }
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ version: 1, platforms: manifest ?? platforms }));
  return directory;
}

afterEach(() => {
  for (const directory of temps.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("remote runtime release manifest", () => {
  it("combines per-platform artifact directories with sizes and the version", async () => {
    const linux = payloads({ "linux-x64": "linux payload" });
    const darwin = payloads({ "darwin-arm64": "darwin" });
    const { manifest } = await buildReleaseManifest([linux, darwin], "0.4.0-alpha.1");
    expect(manifest).toEqual({
      version: "0.4.0-alpha.1",
      platforms: {
        "darwin-arm64": { sha256: sha256(Buffer.from("darwin")), size: 6 },
        "linux-x64": { sha256: sha256(Buffer.from("linux payload")), size: 13 },
      },
    });
  });

  it("copies the archives byte for byte and writes the manifest", async () => {
    const bundled = payloads({ "darwin-arm64": "signed darwin", "linux-x64": "linux" });
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "oxbit-release-files-"));
    temps.push(output);
    const manifest = await writeReleaseAssets(output, [bundled], "0.3.4");
    expect(fs.readdirSync(output).sort()).toEqual([
      "remote-runtime-darwin-arm64.tar.gz",
      "remote-runtime-linux-x64.tar.gz",
      "remote-runtime-manifest.json",
    ]);
    for (const platform of ["darwin-arm64", "linux-x64"]) {
      const published = fs.readFileSync(path.join(output, `remote-runtime-${platform}.tar.gz`));
      expect(published.equals(fs.readFileSync(path.join(bundled, `${platform}.tar.gz`)))).toBe(true);
      expect(sha256(published)).toBe(manifest.platforms[platform].sha256);
    }
    expect(JSON.parse(fs.readFileSync(path.join(output, "remote-runtime-manifest.json"), "utf8"))).toEqual(manifest);
  });

  it("rejects an archive that does not match its manifest", async () => {
    const directory = payloads({ "darwin-arm64": "a", "linux-x64": "b" }, {
      "darwin-arm64": { sha256: sha256(Buffer.from("a")) },
      "linux-x64": { sha256: sha256(Buffer.from("rebuilt")) },
    });
    await expect(buildReleaseManifest([directory], "0.3.4")).rejects.toThrow("Remote payload checksum mismatch: linux-x64");
  });

  it("rejects missing, duplicate, and unknown platforms", async () => {
    const linux = payloads({ "linux-x64": "linux" });
    await expect(buildReleaseManifest([linux], "0.3.4")).rejects.toThrow("Missing remote payloads: darwin-arm64");
    await expect(buildReleaseManifest([linux, linux], "0.3.4")).rejects.toThrow("Duplicate remote platform: linux-x64");
    const intel = payloads({ "darwin-x64": "intel" });
    await expect(buildReleaseManifest([intel], "0.3.4")).rejects.toThrow("Unsupported remote platform: darwin-x64");
  });
});
