import { expect, test, type Page } from "@playwright/test";
import { PUSH_RELAY_URL } from "../../packages/sdk/src/push.js";
import { installBridge } from "./bridge.js";

const RUNTIME_URL = "http://127.0.0.1:2";
const recent = { id: "runtime:laptop", kind: "runtime", name: "laptop", url: RUNTIME_URL, runtimeId: "abc12345-0000-4000-8000-000000000002", lastOpened: 1 };
const stored = { "session:recents": [recent], "session:last-workspace": recent.id };

type Call = { method: string; params: Record<string, unknown> };

/** Answers the runtime protocol for an empty project; `pushMissing` answers `push.*` the way runtime 0.8.0 does. */
async function mockRuntime(page: Page, { pushMissing = false } = {}) {
  const calls: Call[] = [];
  await page.routeWebSocket(RUNTIME_URL.replace("http", "ws") + "/ws", socket => {
    socket.onMessage(message => {
      const request = JSON.parse(String(message)) as { id: string; method: string; params: Record<string, unknown> };
      if (request.method.startsWith("push.")) calls.push({ method: request.method, params: request.params });
      if (pushMissing && request.method.startsWith("push.")) {
        socket.send(JSON.stringify({ v: 1, type: "response", id: request.id, error: { code: "METHOD_NOT_FOUND", message: `Unknown runtime method ${request.method}` } }));
        return;
      }
      const result = request.method === "auth.authenticate"
        ? { workspaceId: "default", capabilities: ["files"], trusted: false, owner: true, workspaceKey: "b".repeat(64), workspaceName: "project" }
        : request.method === "fs.list" || request.method.endsWith(".list") ? [] : {};
      socket.send(JSON.stringify({ v: 1, type: "response", id: request.id, result }));
    });
  });
  return calls;
}

async function mockRelay(page: Page) {
  const requests: Record<string, unknown>[] = [];
  await page.route(`${PUSH_RELAY_URL}/v1/devices`, async route => {
    const body = route.request().postDataJSON() as { kind: string };
    requests.push({ method: route.request().method(), body });
    await route.fulfill({ json: { handle: `sealed-${body.kind}` }, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  return requests;
}

function setVisibility(page: Page, state: "hidden" | "visible") {
  return page.evaluate(state => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("a runtime workspace registers relay handles with the runtime and reports foreground state", async ({ page }) => {
  await installBridge(page, { notificationPermission: "granted", stored });
  const relay = await mockRelay(page);
  const calls = await mockRuntime(page);
  await page.goto("/");
  await expect(page.locator(".workspace-title")).toHaveText("project");
  await expect.poll(() => calls.map(call => call.method)).toEqual(["push.register", "push.state"]);
  expect(relay).toEqual([{ method: "POST", body: { token: "a1b2c3d4", environment: "development", kind: "alert" } }]);
  const deviceId = await page.evaluate(() => (window as any).__iosTest.storage.get("session:push-device"));
  expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[0]!.params).toEqual({ workspaceId: "default", deviceId, alert: "sealed-alert" });
  expect(calls[1]!.params).toEqual({ workspaceId: "default", deviceId, active: true });

  await page.evaluate(() => (window as any).__iosTest.liveActivityToken("feed01"));
  await expect.poll(() => calls.length).toBe(4);
  expect(relay[1]).toEqual({ method: "POST", body: { token: "feed01", environment: "development", kind: "liveactivity" } });
  expect(calls[2]).toEqual({ method: "push.register", params: { workspaceId: "default", deviceId, alert: "sealed-alert", liveActivity: "sealed-liveactivity" } });

  await setVisibility(page, "hidden");
  await expect.poll(() => calls.at(-1)).toEqual({ method: "push.state", params: { workspaceId: "default", deviceId, active: false, activity: null } });
  await setVisibility(page, "visible");
  await expect.poll(() => calls.at(-1)).toEqual({ method: "push.state", params: { workspaceId: "default", deviceId, active: true } });
  expect(relay).toHaveLength(2);
});

test("a runtime without push methods opens normally and nothing reports an error", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", message => { if (["warning", "error"].includes(message.type())) warnings.push(message.text()); });
  await installBridge(page, { notificationPermission: "granted", stored });
  await mockRelay(page);
  const calls = await mockRuntime(page, { pushMissing: true });
  await page.goto("/");
  await expect(page.locator(".workspace-title")).toHaveText("project");
  await expect.poll(() => calls.map(call => call.method)).toEqual(["push.register"]);
  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
  await page.waitForTimeout(300);
  expect(calls.map(call => call.method)).toEqual(["push.register"]);
  expect(warnings.filter(text => /push/i.test(text))).toEqual([]);
  await expect(page.getByText(/push/i)).toHaveCount(0);
});

test("no permission means no remote registration and no relay request", async ({ page }) => {
  await installBridge(page, { stored });
  const relay = await mockRelay(page);
  const calls = await mockRuntime(page);
  await page.goto("/");
  await expect(page.locator(".workspace-title")).toHaveText("project");
  await page.waitForTimeout(300);
  expect(relay).toEqual([]);
  expect(calls).toEqual([]);
});
