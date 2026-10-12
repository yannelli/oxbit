import { expect, test, type Page } from "@playwright/test";
import { AGENT_MODELS_SERVICE } from "../../packages/sdk/src/agent-models.js";
import { installBridge } from "./bridge.js";

const SSE = ["event: response.created\ndata: {\"n\":1}\n\n", "event: response.output_text.delta\ndata: {\"delta\":\"héllo\"}\n\n", "event: response.completed\ndata: {\"n\":3}\n\n"];
const SLOW = Array.from({ length: 8 }, (_, index) => `data: ${index}\n\n`);

async function openDocuments(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await expect(page.locator(".cm-content")).toContainText("/device/Documents");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
}

const bridge = (page: Page) => page.evaluate(() => {
  const test = (window as any).__iosTest;
  return { keys: [...test.agentKeys.entries()], requests: test.agentRequests, cancels: test.agentCancels };
});

test("a device folder registers the agent models service, which saves, checks and removes keys through the bridge", async ({ page }) => {
  await installBridge(page);
  await openDocuments(page);
  const result = await page.evaluate(async (service) => {
    const models = (window as any).__oxbit.kernel.services.get(service);
    const openai = { api: "openai" };
    const router = { api: "openai-compatible", baseUrl: "https://openrouter.ai/api" };
    const before = await models.keys.has(openai);
    await models.keys.save(openai, "sk-openai");
    await models.keys.save(router, "sk-router");
    const saved = [await models.keys.has(openai), await models.keys.has(router), await models.keys.has({ api: "anthropic" })];
    await models.keys.remove(openai);
    return { before, saved, after: await models.keys.has(openai) };
  }, AGENT_MODELS_SERVICE);
  expect(result).toEqual({ before: false, saved: [true, true, false], after: false });
  expect((await bridge(page)).keys).toEqual([["openai-compatible https://openrouter.ai", "sk-router"]]);
});

test("a streamed response arrives in order, a non-2xx answer throws its status and body, and a missing key rejects", async ({ page }) => {
  const denied = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
  await installBridge(page, {
    agentKeys: ["openai https://api.openai.com", "anthropic https://api.anthropic.com"],
    agentResponses: { "/v1/responses": { chunks: SSE }, "/v1/messages": { status: 401, body: denied } },
  });
  await openDocuments(page);
  const result = await page.evaluate(async (service) => {
    const models = (window as any).__oxbit.kernel.services.get(service);
    const chunks: string[] = [];
    for await (const text of models.stream({ api: "openai", method: "POST", path: "/v1/responses", body: { model: "gpt-5", stream: true } }))
      chunks.push(text);
    const failure = async (request: unknown) => {
      try {
        for await (const _ of models.stream(request)) void _;
        return null;
      } catch (error: any) {
        return { name: error.name, message: error.message, status: error.status, body: error.body };
      }
    };
    return {
      chunks,
      denied: await failure({ api: "anthropic", method: "POST", path: "/v1/messages", body: {} }),
      missing: await failure({ api: "openai-compatible", baseUrl: "https://openrouter.ai/api", method: "GET", path: "/v1/models" }),
    };
  }, AGENT_MODELS_SERVICE);
  expect(result.chunks).toEqual(SSE);
  expect(result.denied).toEqual({ name: "AgentModelError", message: "The model API answered 401: invalid x-api-key", status: 401, body: denied });
  expect(result.missing).toMatchObject({ message: "Add an API key in Agent setup" });
  const { requests, cancels } = await bridge(page);
  expect(requests.map(({ id: _, ...request }: { id: string }) => request)).toEqual([
    { api: "openai", method: "POST", path: "/v1/responses", body: { model: "gpt-5", stream: true } },
    { api: "anthropic", method: "POST", path: "/v1/messages", body: {} },
  ]);
  expect(cancels).toEqual([]);
});

test("aborting a stream cancels the native request and stops its chunks", async ({ page }) => {
  await installBridge(page, { agentKeys: ["openai https://api.openai.com"], agentResponses: { "/v1/responses": { chunks: SLOW, delay: 60 } } });
  await openDocuments(page);
  const result = await page.evaluate(async (service) => {
    const models = (window as any).__oxbit.kernel.services.get(service);
    const controller = new AbortController();
    const chunks: string[] = [];
    let error = "";
    try {
      for await (const text of models.stream({ api: "openai", method: "POST", path: "/v1/responses", body: {} }, controller.signal)) {
        chunks.push(text);
        if (chunks.length === 2) controller.abort();
      }
    } catch (caught: any) {
      error = caught.name;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { chunks, error };
  }, AGENT_MODELS_SERVICE);
  expect(result).toEqual({ chunks: SLOW.slice(0, 2), error: "AbortError" });
  const { requests, cancels } = await bridge(page);
  expect(cancels).toEqual([requests[0].id]);
});

test("a runtime workspace registers the agent models service for conversation titles", async ({ page }) => {
  const url = "http://127.0.0.1:2";
  const recent = { id: "runtime:laptop", kind: "runtime", name: "laptop", url, runtimeId: "abc12345-0000-4000-8000-000000000002", lastOpened: 1 };
  await installBridge(page, { stored: { "session:recents": [recent], "session:last-workspace": recent.id } });
  await page.routeWebSocket(url.replace("http", "ws") + "/ws", socket => {
    socket.onMessage(message => {
      const request = JSON.parse(String(message)) as { id: string; method: string };
      const result = request.method === "auth.authenticate"
        ? { workspaceId: "default", capabilities: ["files"], trusted: false, owner: true, workspaceKey: "b".repeat(64), workspaceName: "project" }
        : request.method.endsWith(".list") ? [] : {};
      socket.send(JSON.stringify({ v: 1, type: "response", id: request.id, result }));
    });
  });
  await page.goto("/");
  await expect(page.locator(".workspace-title")).toHaveText("project");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  expect(await page.evaluate((service) => (window as any).__oxbit.kernel.services.optional(service) !== undefined, AGENT_MODELS_SERVICE)).toBe(true);
});

test("Agent setup signs in with ChatGPT through the bridge, opens the sign-in page in the system browser, and signs out", async ({ page }) => {
  await installBridge(page, { agentResponses: { "/codex/responses": { chunks: SSE } } });
  await openDocuments(page);
  const rejected = await page.evaluate(async (service) => {
    const models = (window as any).__oxbit.kernel.services.get(service);
    return models.keys.save({ api: "chatgpt" }, "sk-ignored").then(() => "", (error: Error) => error.message);
  }, AGENT_MODELS_SERVICE);
  expect(rejected).toBe("Sign in with ChatGPT in Agent setup");
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    await z.kernel.configuration.set("agentACP.oxbit.api", "chatgpt", "user");
    await z.kernel.extensions.activate("oxbit.agent-acp");
    z.workbench.run("agentACP.open");
  });
  const panel = page.locator(".acp-panel:not(.acp-review-editor):not(.acp-agents-view)");
  await panel.getByRole("button", { name: "Start Oxbit Agent" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Sign in with ChatGPT in Agent setup");
  await panel.getByRole("button", { name: "Agent setup", exact: true }).click();
  const setup = panel.getByRole("form", { name: "Oxbit Agent setup" });
  await expect(setup.getByText("Not signed in")).toBeVisible();
  await setup.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(setup.getByRole("status", { name: "ChatGPT sign-in code" })).toHaveText("ABCD-1234");
  await setup.getByRole("link", { name: "Open sign-in page" }).click();
  await expect(setup.getByText("Signed in with ChatGPT")).toBeVisible({ timeout: 15000 });
  const signedIn = await page.evaluate(() => {
    const test = (window as any).__iosTest;
    return { externals: test.externals, calls: test.agentChatGPT, keys: [...test.agentKeys.keys()] };
  });
  expect(signedIn).toEqual({
    externals: ["https://auth.openai.com/codex/device"],
    calls: [
      { operation: "start" },
      { operation: "poll", deviceAuthId: "device-1", userCode: "ABCD-1234" },
      { operation: "poll", deviceAuthId: "device-1", userCode: "ABCD-1234" },
    ],
    keys: ["chatgpt https://chatgpt.com"],
  });

  const chunks = await page.evaluate(async (service) => {
    const models = (window as any).__oxbit.kernel.services.get(service);
    const chunks: string[] = [];
    for await (const text of models.stream({ api: "chatgpt", method: "POST", path: "/codex/responses", body: {} })) chunks.push(text);
    return chunks;
  }, AGENT_MODELS_SERVICE);
  expect(chunks).toEqual(SSE);

  await setup.getByRole("button", { name: "Sign out" }).click();
  await expect(setup.getByText("Not signed in")).toBeVisible();
  expect((await bridge(page)).keys).toEqual([]);
});

test("the in-app agent lists its slash commands, saves a conversation in app storage, and reopens it after a relaunch", async ({ page, context }) => {
  const chat = (text: string) => ({ chunks: [`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n"] });
  const models = { chunks: [JSON.stringify({ data: [{ id: "model-a" }] })] };
  const agentKeys = ["openai-compatible https://models.test"];
  const launch = async (target: Page, stored: Record<string, unknown>, replies: ReturnType<typeof chat>[]) => {
    await installBridge(target, { stored, agentKeys, agentResponses: { "/v1/models": models, "/v1/chat/completions": replies } });
    await openDocuments(target);
    await target.evaluate(async () => {
      const z = (window as any).__oxbit;
      await z.kernel.configuration.set("agentACP.oxbit.api", "openai-compatible", "user");
      await z.kernel.configuration.set("agentACP.oxbit.baseUrl", "https://models.test/api", "user");
      await z.kernel.extensions.activate("oxbit.agent-acp");
      z.workbench.run("agentACP.open");
    });
    const panel = target.locator(".acp-panel:not(.acp-review-editor):not(.acp-agents-view)");
    await panel.getByRole("button", { name: "Start Oxbit Agent" }).click();
    await expect(panel.getByRole("textbox", { name: "Message agent" })).toBeEnabled();
    return panel;
  };
  let panel = await launch(page, {}, [chat("The door is blue."), chat("Blue door")]);
  const composer = panel.getByRole("textbox", { name: "Message agent" });
  await composer.fill("/");
  const commands = page.getByRole("listbox", { name: "Agent slash commands" });
  for (const name of ["compact", "context", "goal", "loop", "config", "skills"])
    await expect(commands.getByRole("option", { name: new RegExp(`^/${name}\\b`) })).toBeVisible();
  await composer.fill("Remember the blue door");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByText("The door is blue.")).toBeVisible();
  const storage = () => page.evaluate(() => Object.fromEntries((window as any).__iosTest.storage) as Record<string, unknown>);
  await expect.poll(async () => Object.keys(await storage()).filter((key) => key.startsWith("/device/Documents:oxbit-agent-session:"))).toHaveLength(1);
  const stored = await storage();
  await page.close();

  const relaunched = await context.newPage();
  panel = await launch(relaunched, stored, []);
  await panel.getByRole("button", { name: "History" }).click();
  await panel.getByRole("button", { name: "Find provider conversations" }).click();
  await panel.getByRole("button", { name: "Open conversation" }).click();
  await expect(panel.getByText("The door is blue.")).toBeVisible();
  await expect(panel.locator(".acp-user-text").filter({ hasText: "Remember the blue door" })).toHaveCount(1);
});
