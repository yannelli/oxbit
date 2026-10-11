import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";

const shots = "/tmp/oxbit-agents/local-panel";
const presets = ["Codex ACP", "Claude Agent", "Gemini CLI", "GitHub Copilot", "Cursor ACP", "Amp Agent ACP"];

const sse = (...events: unknown[]) => [...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"];
const chatTool = (id: string, name: string, args: unknown) => sse(
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
);
const chatText = (text: string) => sse(
  { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
);

/** The browser workspace has no runtime. `models` registers a fake agentModels service that keeps keys in page memory and streams `replies` in order. */
async function open(page: Page, models: boolean, replies: string[][] = []) {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await page.evaluate(async ({ models, replies }) => {
    const z = (window as any).__oxbit;
    const saved = new Map<string, string>();
    const calls: [string, unknown][] = [];
    const requests: unknown[] = [];
    (window as any).__models = { saved, calls, requests };
    const id = (endpoint: unknown) => JSON.stringify(endpoint);
    if (models)
      z.kernel.services.register("agentModels", {
        async *stream(request: { method: string }) {
          requests.push(request);
          if (request.method === "GET") yield JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] });
          else yield* replies.shift() ?? [];
        },
        keys: {
          has: async (endpoint: unknown) => (calls.push(["has", endpoint]), saved.has(id(endpoint))),
          save: async (endpoint: unknown, key: string) => {
            calls.push(["save", endpoint]);
            saved.set(id(endpoint), key);
          },
          remove: async (endpoint: unknown) => {
            calls.push(["remove", endpoint]);
            saved.delete(id(endpoint));
          },
        },
      });
    await z.kernel.extensions.activate("oxbit.agent-acp");
    z.workbench.run("agentACP.open");
  }, { models, replies });
  return page.locator(".acp-panel:not(.acp-review-editor):not(.acp-agents-view)");
}
const savedKeys = (page: Page) =>
  page.evaluate(() => Object.fromEntries((window as any).__models.saved));
const setting = (page: Page, id: string) =>
  page.evaluate((id) => (window as any).__oxbit.kernel.configuration.get(id), id);

test("a local workspace offers the Oxbit agent, asks for a key on Start, and saves it through the host", async ({ page }, info) => {
  const panel = await open(page, true);
  const picker = panel.getByRole("radiogroup", { name: "Agent", exact: true });
  const oxbit = picker.getByRole("radio", { name: /Oxbit Agent/ });
  await expect(oxbit).toBeEnabled();
  await expect(oxbit).toHaveAttribute("aria-checked", "true");
  await expect(oxbit.locator(".acp-agent-logo")).toHaveAttribute("data-agent", "oxbit");
  for (const name of presets) {
    const row = picker.getByRole("radio", { name: new RegExp(name) });
    await expect(row).toBeDisabled();
    await expect(row).toContainText("Needs a runtime workspace");
  }
  for (const name of [/More agents…/, /Custom agent…/]) {
    await expect(panel.getByRole("button", { name })).toBeDisabled();
    await expect(panel.getByRole("button", { name })).toContainText("Needs a runtime workspace");
  }
  await expect(panel.getByText("Connect to a runtime workspace to use agents.")).toHaveCount(0);
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${info.project.name}-1-picker.png` });

  await panel.getByRole("button", { name: "Start Oxbit Agent" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Add an API key in Agent setup");
  await panel.getByRole("button", { name: "Agent setup", exact: true }).click();
  const setup = panel.getByRole("form", { name: "Oxbit Agent setup" });
  await expect(setup.getByText("No key saved")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Remove" })).toBeDisabled();
  const key = setup.getByLabel("API key", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("sk-local-test");
  await setup.getByRole("button", { name: "Save" }).click();
  await expect(setup.getByText("Key saved", { exact: true })).toBeVisible();
  await expect(key).toHaveValue("");
  expect(await savedKeys(page)).toEqual({ '{"api":"openai"}': "sk-local-test" });
  for (const id of ["agentACP.oxbit.api", "agentACP.oxbit.baseUrl", "agentACP.oxbit.model"])
    expect(await setting(page, id)).not.toContain("sk-local-test");
  await page.screenshot({ path: `${shots}/${info.project.name}-2-setup.png` });

  await setup.getByRole("combobox", { name: "API" }).click();
  await page.getByRole("option", { name: "OpenAI-compatible" }).click();
  await expect(setup.getByText("No key saved")).toBeVisible();
  await key.fill("sk-router");
  await expect(setup.getByRole("button", { name: "Save" })).toBeDisabled();
  await setup.getByLabel("Base URL", { exact: true }).fill("https://openrouter.ai/api");
  await setup.getByRole("button", { name: "Save" }).click();
  await expect(setup.getByText("Key saved", { exact: true })).toBeVisible();
  expect(await setting(page, "agentACP.oxbit.api")).toBe("openai-compatible");
  expect(await setting(page, "agentACP.oxbit.baseUrl")).toBe("https://openrouter.ai/api");
  await setup.getByRole("button", { name: "Remove" }).click();
  await expect(setup.getByText("No key saved")).toBeVisible();
  expect(await savedKeys(page)).toEqual({ '{"api":"openai"}': "sk-local-test" });
});

test("without a model service the browser workspace keeps the runtime prompt and built-in agents", async ({ page }) => {
  const panel = await open(page, false);
  await expect(panel.getByText("Connect to a runtime workspace to use agents.")).toBeVisible();
  const picker = panel.getByRole("radiogroup", { name: "Agent", exact: true });
  await expect(picker.getByRole("radio")).toHaveCount(6);
  await expect(picker.getByRole("radio", { name: /Oxbit Agent/ })).toHaveCount(0);
  await expect(picker.getByRole("radio", { name: /Codex ACP/ })).toBeEnabled();
  await expect(picker.getByRole("radio", { name: /Codex ACP/ })).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByRole("button", { name: "Start Codex ACP" })).toBeDisabled();
});

test("the Oxbit agent runs a turn in the app: it streams a reply and its file write waits for review", async ({ page }) => {
  const panel = await open(page, true, [
    chatTool("call_1", "write_file", { path: "notes.md", content: "agent note\n" }),
    chatText("Wrote notes.md."),
  ]);
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    (window as any).__models.saved.set(JSON.stringify({ api: "openai-compatible", baseUrl: "https://models.test/api" }), "sk-test");
    await z.kernel.configuration.set("agentACP.oxbit.api", "openai-compatible", "user");
    await z.kernel.configuration.set("agentACP.oxbit.baseUrl", "https://models.test/api", "user");
    await z.kernel.configuration.set("agentACP.oxbit.model", "model-b", "user");
  });
  await panel.getByRole("button", { name: "Start Oxbit Agent" }).click();
  const composer = panel.getByRole("textbox", { name: "Message agent" });
  await expect(composer).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.kernel.services.get("agentACP").connection?.sessionId)).toBeTruthy();
  await composer.fill("Write a note");
  await panel.getByRole("button", { name: "Send", exact: true }).click();

  await expect(panel.getByText("notes.md").first()).toBeVisible();
  await expect(panel.getByLabel("File change diff").last()).toContainText("+agent note");
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.filesystem.read("notes.md").then(() => true, () => false))).toBe(false);
  await panel.getByRole("button", { name: "Apply change", exact: true }).click();
  // Applying opens notes.md; below 1100px the editor closes the agent panel.
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.workbench.activePath())).toBe("notes.md");
  await page.evaluate(() => (window as any).__oxbit.workbench.run("agentACP.open"));
  await expect(panel.getByText("Wrote notes.md.")).toBeVisible();
  expect(await page.evaluate(async () => (await (window as any).__oxbit.filesystem.read("notes.md")).text)).toBe("agent note\n");

  const requests = await page.evaluate(() => (window as any).__models.requests);
  expect(requests.map((request: any) => [request.method, request.path])).toEqual([
    ["GET", "/v1/models"], ["POST", "/v1/chat/completions"], ["POST", "/v1/chat/completions"],
  ]);
  expect(requests[1]).toEqual(expect.objectContaining({ api: "openai-compatible", baseUrl: "https://models.test/api" }));
  expect(requests[1].body.model).toBe("model-b");
  expect(JSON.stringify(requests)).not.toContain("sk-test");
});
