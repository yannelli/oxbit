import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";

const shots = "/tmp/oxbit-agents/local-panel";
const presets = ["Oxbit Agent CLI", "Codex ACP", "Claude Agent", "Gemini CLI", "GitHub Copilot", "Cursor ACP", "Amp Agent ACP"];

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
  const oxbit = picker.getByRole("radio", { name: /Runs in Oxbit with your API key/ });
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
  const header = panel.locator(".acp-header");
  expect(await header.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(0);
  await setup.getByRole("button", { name: "Remove" }).click();
  await expect(setup.getByText("No key saved")).toBeVisible();
  expect(await savedKeys(page)).toEqual({ '{"api":"openai"}': "sk-local-test" });
});

test("without a model service the browser workspace keeps the runtime prompt and built-in agents", async ({ page }) => {
  const panel = await open(page, false);
  await expect(panel.getByText("Connect to a runtime workspace to use agents.")).toBeVisible();
  const picker = panel.getByRole("radiogroup", { name: "Agent", exact: true });
  await expect(picker.getByRole("radio")).toHaveCount(7);
  await expect(picker.getByRole("radio", { name: /Runs in Oxbit with your API key/ })).toHaveCount(0);
  await expect(picker.getByRole("radio", { name: /Codex ACP/ })).toBeEnabled();
  await expect(picker.getByRole("radio", { name: /Codex ACP/ })).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByRole("button", { name: "Start Codex ACP" })).toBeDisabled();
});

test("the Oxbit agent runs a turn in the app: its file write waits for review, a phone keeps the panel open after Apply, and the conversation gets a title", async ({ page }) => {
  const panel = await open(page, true, [
    chatTool("call_1", "write_file", { path: "notes.md", content: "agent note\n" }),
    chatText("Wrote notes.md."),
    chatText("Agent note file"),
  ]);
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    (window as any).__models.saved.set(JSON.stringify({ api: "openai-compatible", baseUrl: "https://models.test/api" }), "sk-test");
    await z.kernel.configuration.set("agentACP.oxbit.api", "openai-compatible", "user");
    await z.kernel.configuration.set("agentACP.oxbit.baseUrl", "https://models.test/api", "user");
    await z.kernel.configuration.set("agentACP.oxbit.model", "model-b", "user");
  });
  await panel.getByRole("button", { name: "More agent actions" }).click();
  await page.getByRole("menuitem", { name: "Agent setup" }).click();
  await expect(panel.getByRole("form", { name: "Oxbit Agent setup" })).toBeVisible();
  await panel.getByRole("button", { name: "Start Oxbit Agent" }).click();
  const composer = panel.getByRole("textbox", { name: "Message agent" });
  await expect(composer).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.kernel.services.get("agentACP").connection?.sessionId)).toBeTruthy();
  await expect(panel.getByRole("form", { name: "Oxbit Agent setup" })).toHaveCount(0);
  await composer.fill("Write a note");
  await panel.getByRole("button", { name: "Send", exact: true }).click();

  await expect(panel.getByText("notes.md").first()).toBeVisible();
  await expect(panel.getByLabel("File change diff").last()).toContainText("+agent note");
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.filesystem.read("notes.md").then(() => true, () => false))).toBe(false);
  await panel.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect(panel.getByText("Wrote notes.md.")).toBeVisible();
  const phone = (page.viewportSize()?.width ?? 1440) < 1100;
  expect(await page.evaluate(() => (window as any).__oxbit.workbench.panelVisible("agent-acp"))).toBe(true);
  expect(await page.evaluate(() => (window as any).__oxbit.workbench.state.groups.some((group: any) => group.tabs.some((tab: any) => tab.path === "notes.md")))).toBe(!phone);
  await expect(page.locator(".toasts .notification").filter({ hasText: "Agent finished" })).toHaveCount(0);
  expect(await page.evaluate(async () => (await (window as any).__oxbit.filesystem.read("notes.md")).text)).toBe("agent note\n");

  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.kernel.services.get("agentACP").title)).toBe("Agent note file");
  const requests = await page.evaluate(() => (window as any).__models.requests);
  expect(requests.map((request: any) => [request.method, request.path])).toEqual([
    ["GET", "/v1/models"], ["POST", "/v1/chat/completions"], ["POST", "/v1/chat/completions"], ["POST", "/v1/chat/completions"],
  ]);
  expect(requests[3].body.tools).toBeUndefined();
  expect(requests[1]).toEqual(expect.objectContaining({ api: "openai-compatible", baseUrl: "https://models.test/api" }));
  expect(requests[1].body.model).toBe("model-b");
  expect(JSON.stringify(requests)).not.toContain("sk-test");
});

test("with the keyboard open the @ list sits between the status bar and the composer, and tapping an entry attaches it", async ({ page }, info) => {
  const panel = await open(page, true);
  await page.evaluate(() => (window as any).__oxbit.filesystem.write("pelican-notes.md", "tide table\n", { expectedRevision: null }));
  const composer = panel.getByRole("textbox", { name: "Message agent" });
  await expect(composer).toBeEnabled();
  const before = (await composer.boundingBox())!;
  const keyboard = Math.round(before.y - 300);
  const statusBar = 59;
  // iOS WebKit with the keyboard open: client rects follow the visual viewport, which sits `keyboard` px down the layout viewport.
  await composer.evaluate((input, { keyboard, statusBar }) => {
    const view = input.ownerDocument.defaultView!;
    Object.defineProperty(view.visualViewport, "offsetTop", { configurable: true, get: () => keyboard });
    Object.defineProperty(view.visualViewport, "height", { configurable: true, get: () => view.innerHeight });
    const measure = Element.prototype.getBoundingClientRect;
    for (const element of [input, input.parentElement!.querySelector(".acp-slash-commands")!])
      element.getBoundingClientRect = function () {
        const rect = measure.call(this);
        return new DOMRect(rect.x, rect.y - keyboard, rect.width, rect.height);
      };
    input.ownerDocument.documentElement.style.setProperty("--safe-area-top", `${statusBar}px`);
  }, { keyboard, statusBar });
  expect((await composer.boundingBox())!.y).toBe(before.y);

  await composer.fill("explain @pelican");
  const mentions = page.getByRole("listbox", { name: "Mention files and context" });
  const option = mentions.getByRole("option", { name: /pelican-notes\.md/ });
  await expect(option).toBeVisible();
  await expect(mentions.getByRole("option")).toHaveCount(1);
  const list = (await mentions.boundingBox())!;
  expect(list.y).toBeGreaterThanOrEqual(keyboard + statusBar);
  expect(list.y + list.height).toBeLessThanOrEqual(before.y);
  await (info.project.use.hasTouch ? option.tap() : option.click());
  await expect(panel.getByRole("button", { name: "Remove attachment pelican-notes.md" })).toBeVisible();
  await expect(composer).toHaveValue("explain @pelican-notes.md ");
});
