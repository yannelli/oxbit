import { describe, expect, it } from "vitest";
// @ts-expect-error plain-node publish script without types
import { assertTag, cliManifest, distTag, sdkManifest, versionUrl } from "../scripts/npm/publish.mjs";

const author = { name: "Ryan Yannelli" };

describe("npm publishing", () => {
  it("publishes prereleases under next and releases under latest", () => {
    expect(distTag("0.3.0-alpha.6")).toBe("next");
    expect(distTag("1.0.0")).toBe("latest");
  });
  it("checks the scoped version document", () => {
    expect(versionUrl("@oxbit/sdk", "1.0.0")).toBe("https://registry.npmjs.org/@oxbit%2fsdk/1.0.0");
  });
  it("requires the tag to name the package version", () => {
    expect(() => assertTag("v0.4.0", "0.4.0")).not.toThrow();
    expect(() => assertTag("v0.3.1", "0.4.0")).toThrow("does not match");
  });
  it("points the SDK at built files with provenance metadata", () => {
    const manifest = sdkManifest({ name: "@oxbit/sdk", version: "1.0.0", license: "MIT", author });
    expect(manifest.exports["."]).toEqual({ types: "./dist/index.d.ts", import: "./dist/index.js" });
    expect(manifest.repository).toMatchObject({ url: "git+https://github.com/yannelli/oxbit.git", directory: "packages/sdk" });
    expect(manifest.peerDependenciesMeta["@types/react"].optional).toBe(true);
  });
  it("drops bundled workspace packages from CLI dependencies and pins the rest", () => {
    const app = { version: "0.4.0", license: "MIT", author, engines: { node: ">=24 <25" } };
    const runtime = { dependencies: { "@oxbit/core": "workspace:*", ws: "^8.20.0", "node-pty": "^1.1.0" } };
    const installed: Record<string, string> = { ws: "8.21.3", "node-pty": "1.1.0" };
    const manifest = cliManifest(app, runtime, (name: string) => installed[name]);
    expect(manifest.dependencies).toEqual({ "node-pty": "1.1.0", ws: "8.21.3" });
    expect(manifest.bin).toEqual({ oxbit: "runtime/dist/index.js" });
    expect(manifest.version).toBe("0.4.0");
  });
});
