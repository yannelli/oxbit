import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error plain-node release script without types
import { declareEncryption, distributeTestFlight, loadTestNotes } from "../scripts/ios/distribute-testflight.mjs";

function fixture() {
  const state = {
    processing: ["VALID"], external: "READY_FOR_BETA_SUBMISSION", internal: "READY_FOR_BETA_TESTING", expired: false,
    groups: [
      { id: "public", attributes: { name: "Public Beta", isInternalGroup: false } },
      { id: "internal", attributes: { name: "Internal Testing", isInternalGroup: true } },
    ],
    locales: [{ id: "german", attributes: { locale: "de", whatsNew: "Behalten" } }],
    members: [] as { id: string; type: string }[], reviews: [] as { attributes: { betaReviewState: string } }[],
    notify: false, clock: 0, ignoreAssignment: false, ignoreNotes: false, detailDelay: 0, reviewConflict: false,
    encryption: false, declarations: [] as { id: string; attributes: Record<string, unknown> }[], declaredBuilds: [] as string[],
  };
  const details = () => ({ id: "detail", type: "buildBetaDetails", attributes: { externalBuildState: state.external, internalBuildState: state.internal, autoNotifyEnabled: state.notify } });
  const api = vi.fn(async (method: string, route: string, body?: any): Promise<any> => {
    const url = new URL(route, "https://api.appstoreconnect.apple.com");
    const resource = url.pathname;
    if (method === "GET" && resource === "/v1/apps")
      return { data: [{ id: "app", attributes: { bundleId: "com.yannelli.oxbit" } }] };
    if (method === "GET" && resource === "/v1/apps/app/betaGroups") return { data: state.groups };
    if (method === "GET" && resource === "/v1/builds") {
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        "filter[app]": "app", "filter[version]": "7",
        "filter[preReleaseVersion.version]": "0.3.0", "filter[preReleaseVersion.platform]": "IOS",
      });
      const processingState = state.processing.length > 1 ? state.processing.shift() : state.processing[0];
      if (processingState === "absent") return { data: [] };
      const build = { id: "build", attributes: { version: "7", processingState, expired: state.expired, usesNonExemptEncryption: state.encryption },
        relationships: { preReleaseVersion: { data: { id: "release" } }, buildBetaDetail: { data: { id: "detail" } } } };
      return { data: [
        { ...build, id: "wrong-number", attributes: { ...build.attributes, version: "6" } },
        { ...build, id: "wrong-platform", relationships: { ...build.relationships, preReleaseVersion: { data: { id: "mac" } } } },
        build,
      ], included: [
        { id: "release", type: "preReleaseVersions", attributes: { version: "0.3.0", platform: "IOS" } },
        { id: "mac", type: "preReleaseVersions", attributes: { version: "0.3.0", platform: "MAC_OS" } },
        ...(state.detailDelay-- > 0 ? [] : [details()]),
      ] };
    }
    if (method === "GET" && resource === "/v1/builds/build/buildBetaDetail") return { data: details() };
    if (method === "GET" && resource === "/v1/appEncryptionDeclarations") {
      expect(url.searchParams.get("filter[app]")).toBe("app");
      return { data: state.declarations };
    }
    if (method === "POST" && resource === "/v1/appEncryptionDeclarations") {
      expect(body.data.relationships.app.data).toEqual({ type: "apps", id: "app" });
      return { data: { id: "declared", attributes: { ...body.data.attributes, appEncryptionDeclarationState: "APPROVED" } } };
    }
    const declaration = /^\/v1\/appEncryptionDeclarations\/([\w-]+)\/relationships\/builds$/.exec(resource);
    if (method === "POST" && declaration) {
      expect(body.data).toEqual([{ type: "builds", id: "build" }]);
      state.declaredBuilds.push(declaration[1]);
      if (state.internal === "MISSING_EXPORT_COMPLIANCE") state.internal = "READY_FOR_BETA_TESTING";
      return undefined;
    }
    if (method === "GET" && resource === "/v1/builds/build/betaBuildLocalizations") return { data: state.locales };
    if (method === "POST" && resource === "/v1/betaBuildLocalizations") {
      expect(body.data.relationships.build.data).toEqual({ id: "build", type: "builds" });
      if (!state.ignoreNotes) state.locales.push({ id: "english", attributes: body.data.attributes });
      return { data: { id: "english" } };
    }
    if (method === "PATCH" && resource === "/v1/betaBuildLocalizations/english") {
      Object.assign(state.locales.find((entry) => entry.id === "english")!.attributes, body.data.attributes);
      return { data: {} };
    }
    if (method === "PATCH" && resource === "/v1/buildBetaDetails/detail") {
      state.notify = body.data.attributes.autoNotifyEnabled;
      return { data: details() };
    }
    if (method === "GET" && resource === "/v1/betaAppReviewSubmissions") return { data: state.reviews };
    if (method === "POST" && resource === "/v1/betaAppReviewSubmissions") {
      expect(body.data.relationships.build.data.id).toBe("build");
      state.reviews.push({ attributes: { betaReviewState: "WAITING_FOR_REVIEW" } });
      state.external = "WAITING_FOR_BETA_REVIEW";
      if (state.reviewConflict) throw Object.assign(new Error("Existing submission"), { status: 409 });
      return { data: { id: "review" } };
    }
    if (/^\/v1\/betaGroups\/(public|internal)\/relationships\/builds$/.test(resource)) {
      if (method === "GET") return { data: state.members };
      if (method === "POST") {
        expect(body.data).toEqual([{ type: "builds", id: "build" }]);
        if (!state.ignoreAssignment) state.members.push(...body.data);
        return undefined;
      }
    }
    throw new Error(`Unexpected ${method} ${route}`);
  });
  const options = { api, identifier: "com.yannelli.oxbit", version: "0.3.0", buildNumber: "7", notes: "Test Git.",
    now: () => state.clock, timeoutMs: 100, pollMs: 10,
    sleep: vi.fn(async (ms: number) => { state.clock += ms; }), log: vi.fn() };
  const writes = () => api.mock.calls.filter(([method]) => method !== "GET");
  return { state, api, options, writes };
}

describe("TestFlight external distribution", () => {
  it("waits for the exact processed iOS build, preserves other locales, submits review before assigning Public Beta", async () => {
    const { state, options, writes } = fixture();
    state.processing = ["absent", "PROCESSING", "VALID"];
    const result = await distributeTestFlight(options);
    expect(options.sleep).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ buildId: "build", groupId: "public", externalBuildState: "WAITING_FOR_BETA_REVIEW" });
    expect(state.locales).toContainEqual({ id: "german", attributes: { locale: "de", whatsNew: "Behalten" } });
    expect(writes().map(([, route]) => route)).toEqual([
      "/v1/betaBuildLocalizations", "/v1/buildBetaDetails/detail", "/v1/betaAppReviewSubmissions", "/v1/betaGroups/public/relationships/builds",
    ]);
  });

  it("waits for beta details after binary processing finishes", async () => {
    const { state, options } = fixture();
    state.detailDelay = 2;
    await distributeTestFlight(options);
    expect(options.sleep).toHaveBeenCalledTimes(2);
  });

  it("updates the existing English localization and retries without duplicate writes", async () => {
    const { state, options, api, writes } = fixture();
    state.locales.push({ id: "english", attributes: { locale: "en-US", whatsNew: "Old notes" } });
    await distributeTestFlight(options);
    expect(writes()[0].slice(0, 2)).toEqual(["PATCH", "/v1/betaBuildLocalizations/english"]);
    api.mockClear();
    await distributeTestFlight(options);
    expect(writes()).toEqual([]);
  });

  it.each(["WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW", "BETA_APPROVED", "READY_FOR_BETA_TESTING", "IN_BETA_TESTING"])("assigns %s builds without submitting another review", async (external) => {
    const { state, options, writes } = fixture();
    state.external = external;
    await distributeTestFlight(options);
    expect(writes().some(([, route]) => route === "/v1/betaAppReviewSubmissions")).toBe(false);
    expect(state.members).toContainEqual({ id: "build", type: "builds" });
  });

  it("recognizes an existing review when the build detail has not caught up", async () => {
    const { state, options, writes } = fixture();
    state.reviews.push({ attributes: { betaReviewState: "IN_REVIEW" } });
    await distributeTestFlight(options);
    expect(writes().some(([, route]) => route === "/v1/betaAppReviewSubmissions")).toBe(false);
  });

  it("reconciles a concurrent review submission conflict", async () => {
    const { state, options } = fixture();
    state.reviewConflict = true;
    await expect(distributeTestFlight(options)).resolves.toMatchObject({ groupId: "public" });
  });

  it("follows group membership pagination before deciding to assign", async () => {
    const { state, options, api, writes } = fixture();
    state.members = [{ id: "build", type: "builds" }];
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (method, route, body) => {
      if (route === "/v1/betaGroups/public/relationships/builds?limit=200")
        return { data: [], links: { next: "https://api.appstoreconnect.apple.com/v1/betaGroups/public/relationships/builds?cursor=next" } };
      return original(method, route, body);
    });
    await distributeTestFlight(options);
    expect(writes().some(([, route]) => route.endsWith("/relationships/builds"))).toBe(false);
  });

  it.each(["FAILED", "INVALID"])("stops on %s processing before any mutations", async (processing) => {
    const { state, options, writes } = fixture();
    state.processing = [processing];
    await expect(distributeTestFlight(options)).rejects.toThrow(processing);
    expect(writes()).toEqual([]);
  });

  it.each(["BETA_REJECTED", "MISSING_EXPORT_COMPLIANCE"])("surfaces %s without distributing", async (external) => {
    const { state, options, writes } = fixture();
    state.external = external;
    await expect(distributeTestFlight(options)).rejects.toThrow(external);
    expect(writes()).toEqual([]);
  });

  it("rejects an internal group with the same name", async () => {
    const { state, options, writes } = fixture();
    state.groups = [{ id: "public", attributes: { name: "Public Beta", isInternalGroup: true } }];
    await expect(distributeTestFlight(options)).rejects.toThrow("external Public Beta");
    expect(writes()).toEqual([]);
  });

  it("times out while processing without distributing", async () => {
    const { state, options, writes } = fixture();
    state.processing = ["PROCESSING"];
    await expect(distributeTestFlight(options)).rejects.toThrow("Timed out");
    expect(state.clock).toBe(100);
    expect(writes()).toEqual([]);
  });

  it.each(["ignoreNotes", "ignoreAssignment"] as const)("fails readback when Apple does not persist %s", async (flag) => {
    const { state, options } = fixture();
    state[flag] = true;
    await expect(distributeTestFlight(options)).rejects.toThrow("failed verification");
  });
});

describe("TestFlight internal distribution", () => {
  it("sets notes and assigns Internal Testing without submitting beta review", async () => {
    const { state, options, writes } = fixture();
    const result = await distributeTestFlight({ ...options, internal: true });
    expect(result).toEqual({ buildId: "build", groupId: "internal", internalBuildState: "READY_FOR_BETA_TESTING" });
    expect(writes().map(([, route]) => route)).toEqual([
      "/v1/betaBuildLocalizations", "/v1/buildBetaDetails/detail", "/v1/betaGroups/internal/relationships/builds",
    ]);
    expect(state.external).toBe("READY_FOR_BETA_SUBMISSION");
  });

  it("rejects an external group named Internal Testing", async () => {
    const { state, options, writes } = fixture();
    state.groups = [{ id: "internal", attributes: { name: "Internal Testing", isInternalGroup: false } }];
    await expect(distributeTestFlight({ ...options, internal: true })).rejects.toThrow("internal Internal Testing");
    expect(writes()).toEqual([]);
  });

  it("surfaces an internal build that cannot be tested", async () => {
    const { state, options, writes } = fixture();
    state.internal = "MISSING_EXPORT_COMPLIANCE";
    await expect(distributeTestFlight({ ...options, internal: true })).rejects.toThrow("MISSING_EXPORT_COMPLIANCE");
    expect(writes()).toEqual([]);
  });
});

describe("TestFlight export compliance", () => {
  const approved = (id: string, createdDate: string) => ({ id, attributes: { appEncryptionDeclarationState: "APPROVED", createdDate } });

  it("links a non-exempt build to the newest approved declaration, then distributes", async () => {
    const { state, options, writes } = fixture();
    state.encryption = true;
    state.internal = "MISSING_EXPORT_COMPLIANCE";
    state.declarations = [approved("old", "2026-01-01T00:00:00Z"), { id: "pending", attributes: { appEncryptionDeclarationState: "IN_REVIEW", createdDate: "2026-12-01T00:00:00Z" } }, approved("new", "2026-10-01T00:00:00Z")];
    const result = await distributeTestFlight({ ...options, internal: true });
    expect(state.declaredBuilds).toEqual(["new"]);
    expect(result.internalBuildState).toBe("READY_FOR_BETA_TESTING");
    expect(writes().map(([, route]) => route)[0]).toBe("/v1/appEncryptionDeclarations/new/relationships/builds");
  });

  it("stops before other writes when no declaration is approved", async () => {
    const { state, options, writes } = fixture();
    state.encryption = true;
    state.internal = "MISSING_EXPORT_COMPLIANCE";
    state.declarations = [{ id: "pending", attributes: { appEncryptionDeclarationState: "IN_REVIEW", createdDate: "2026-10-01T00:00:00Z" } }];
    await expect(distributeTestFlight({ ...options, internal: true })).rejects.toThrow("--declare-encryption");
    expect(writes()).toEqual([]);
  });

  it("times out when the build stays without compliance after linking", async () => {
    const { state, options } = fixture();
    state.encryption = true;
    state.external = "MISSING_EXPORT_COMPLIANCE";
    state.declarations = [approved("only", "2026-10-01T00:00:00Z")];
    await expect(distributeTestFlight(options)).rejects.toThrow("Timed out");
    expect(state.declaredBuilds).toEqual(["only"]);
    expect(state.members).toEqual([]);
  });

  it("declares standard third-party cryptography outside the French App Store", async () => {
    const { api } = fixture();
    const result = await declareEncryption({ api, identifier: "com.yannelli.oxbit" });
    expect(result).toMatchObject({ id: "declared", containsProprietaryCryptography: false, containsThirdPartyCryptography: true, availableOnFrenchStore: false });
    expect(result.appDescription).toContain("SSH");
  });
});

describe("versioned TestFlight notes", () => {
  const temporary: string[] = [];
  afterEach(() => temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  it("loads the current checklist and prefixes the actual TestFlight version and build", () => {
    const notes = loadTestNotes("0.3.0-alpha.5", "7");
    expect(notes).toMatch(/^Oxbit 0\.3\.0 \(7\): Git, GitHub, and on-device editing/);
    expect(notes).toContain('"GitHub and Commit Author"');
    expect(notes.length).toBeLessThanOrEqual(4000);
  });

  it("rejects missing, empty, or oversized notes instead of using another version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxbit-testflight-"));
    temporary.push(dir);
    fs.mkdirSync(path.join(dir, "docs/testflight"), { recursive: true });
    expect(() => loadTestNotes("0.3.0-alpha.6", "8", dir)).toThrow("ENOENT");
    const file = path.join(dir, "docs/testflight/0.3.0-alpha.6.md");
    for (const text of ["  ", "x".repeat(4000)]) {
      fs.writeFileSync(file, text);
      expect(() => loadTestNotes("0.3.0-alpha.6", "8", dir)).toThrow("1 to 4000");
    }
  });
});
