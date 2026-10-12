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

/** The browser workspace has no runtime. `models` registers a fake agentModels service that keeps keys in page memory and streams `replies` in order.
 * With `chatgpt`, the service signs in once `__models.approve` is set; `__models.expiresIn` shortens the code's lifetime. */
async function open(page: Page, models: boolean, replies: string[][] = [], chatgpt = false) {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await page.evaluate(async ({ models, replies, chatgpt }) => {
    const z = (window as any).__oxbit;
    const saved = new Map<string, string>();
    const calls: [string, unknown][] = [];
    const requests: unknown[] = [];
    const state: Record<string, any> = (window as any).__models = { saved, calls, requests, copied: [] };
    const id = (endpoint: unknown) => JSON.stringify(endpoint);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void state.copied.push(text) } });
    const signIn = {
      start: async () => (calls.push(["start", null]), { deviceAuthId: "auth-1", userCode: "WXYZ-7K3Q", verificationUrl: "https://auth.openai.com/codex/device",
        interval: 0.2, expiresAt: Date.now() + (state.expiresIn ?? 600000) }),
      poll: async (device: { deviceAuthId: string }) => {
        calls.push(["poll", device.deviceAuthId]);
        if (!state.approve) return "pending";
        saved.set(id({ api: "chatgpt" }), "chatgpt-tokens");
        return "complete";
      },
    };
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
        ...(chatgpt ? { chatgpt: signIn } : {}),
      });
    await z.kernel.extensions.activate("oxbit.agent-acp");
    z.workbench.run("agentACP.open");
  }, { models, replies, chatgpt });
  return page.locator(".acp-panel:not(.acp-review-editor):not(.acp-agents-view)");
}
/** Selects openai-compatible at models.test with a saved key and model-b. */
const useCompatible = (page: Page) => page.evaluate(async () => {
  const z = (window as any).__oxbit;
  (window as any).__models.saved.set(JSON.stringify({ api: "openai-compatible", baseUrl: "https://models.test/api" }), "sk-test");
  await z.kernel.configuration.set("agentACP.oxbit.api", "openai-compatible", "user");
  await z.kernel.configuration.set("agentACP.oxbit.baseUrl", "https://models.test/api", "user");
  await z.kernel.configuration.set("agentACP.oxbit.model", "model-b", "user");
});
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

test("the ChatGPT plan signs in with a device code, shows expiry inline, cancels, signs out, and starts on /codex endpoints", async ({ page }, info) => {
  const panel = await open(page, true, [], true);
  const state = (values: Record<string, unknown>) => page.evaluate((values) => Object.assign((window as any).__models, values), values);
  await expect(panel.getByRole("radio", { name: /Runs in Oxbit with your API key or ChatGPT plan/ })).toBeVisible();
  await page.evaluate(() => (window as any).__oxbit.kernel.configuration.set("agentACP.oxbit.api", "chatgpt", "user"));
  await panel.getByRole("button", { name: "Start Oxbit Agent" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Sign in with ChatGPT in Agent setup");
  await panel.getByRole("button", { name: "Agent setup", exact: true }).click();
  const setup = panel.getByRole("form", { name: "Oxbit Agent setup" });
  await expect(setup.getByText(/calls the Codex models in your ChatGPT plan\. The sign-in tokens are stored in the system keychain\./)).toBeVisible();
  await expect(setup.getByText("Not signed in")).toBeVisible();
  await expect(setup.getByLabel("API key", { exact: true })).toHaveCount(0);
  await setup.getByRole("combobox", { name: "API" }).click();
  await page.getByRole("option", { name: "OpenAI", exact: true }).click();
  await expect(setup.getByLabel("API key", { exact: true })).toBeVisible();
  await setup.getByRole("combobox", { name: "API" }).click();
  await page.getByRole("option", { name: "ChatGPT plan" }).click();
  const signIn = setup.getByRole("button", { name: "Sign in with ChatGPT" });
  const code = setup.getByRole("status", { name: "ChatGPT sign-in code" });

  await state({ expiresIn: 1500 });
  await signIn.click();
  await expect(code).toHaveText("WXYZ-7K3Q");
  await expect(setup.getByRole("alert")).toHaveText("The sign-in code expired. Sign in again.");
  await expect(code).toHaveCount(0);
  await state({ expiresIn: undefined });
  await signIn.click();
  await expect(code).toBeVisible();
  await expect(setup.getByRole("alert")).toHaveCount(0);
  await setup.getByRole("button", { name: "Cancel" }).click();
  await expect(code).toHaveCount(0);
  await expect(setup.getByText("Not signed in")).toBeVisible();

  await signIn.click();
  await expect(code).toHaveText("WXYZ-7K3Q");
  const link = setup.getByRole("link", { name: "Open sign-in page" });
  await expect(link).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(setup.getByText("Waiting for you to sign in")).toBeVisible();
  await setup.getByRole("button", { name: "Copy code" }).click();
  await expect(setup.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__models.copied)).toEqual(["WXYZ-7K3Q"]);
  await fs.mkdir("/tmp/oxbit-chatgpt/shots", { recursive: true });
  await code.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/oxbit-chatgpt/shots/${info.project.name}-1-code.png` });
  await state({ approve: true });
  await expect(setup.getByText("Signed in with ChatGPT")).toBeVisible();
  await expect(code).toHaveCount(0);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(await savedKeys(page)).toEqual({ '{"api":"chatgpt"}': "chatgpt-tokens" });
  await page.screenshot({ path: `/tmp/oxbit-chatgpt/shots/${info.project.name}-2-signed-in.png` });

  await setup.getByRole("button", { name: "Sign out" }).click();
  await expect(setup.getByText("Not signed in")).toBeVisible();
  expect(await savedKeys(page)).toEqual({});
  await signIn.click();
  await expect(setup.getByText("Signed in with ChatGPT")).toBeVisible();
  await panel.getByRole("button", { name: "Start Oxbit Agent" }).click();
  await expect(panel.getByRole("textbox", { name: "Message agent" })).toBeEnabled();
  const requests = await page.evaluate(() => (window as any).__models.requests);
  expect(requests[0]).toEqual({ api: "chatgpt", method: "GET", path: "/codex/models?client_version=0.162.1" });
  expect(await page.evaluate(() => (window as any).__oxbit.kernel.services.get("agentACP").connection?.provider)).toBe("oxbit");
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
  await useCompatible(page);
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

test("the Oxbit agent delegates a task to a subagent whose file write is applied from the Agents view", async ({ page }) => {
  const prompt = "Write agent note to notes.md";
  const panel = await open(page, true, [
    chatTool("call_1", "task", { description: "Write the note", prompt }),
    chatTool("child_1", "write_file", { path: "notes.md", content: "agent note\n" }),
    chatText("Wrote notes.md."),
    chatText("The subagent wrote the note."),
    chatText("Delegated note"),
  ]);
  await useCompatible(page);
  await panel.getByRole("button", { name: "Start Oxbit Agent" }).click();
  const composer = panel.getByRole("textbox", { name: "Message agent" });
  await expect(composer).toBeEnabled();
  await composer.fill("Delegate a note");
  await panel.getByRole("button", { name: "Send", exact: true }).click();

  await panel.getByRole("button", { name: "Delegated: Write the note" }).click();
  const agents = page.locator(".acp-agents-view");
  await expect(agents.getByRole("tree", { name: "Dispatched subagents" }).getByRole("treeitem", { name: /^Write the note/ })).toBeVisible();
  const details = agents.getByRole("region", { name: "Subagent details" });
  await expect(details.getByRole("heading", { name: "Write the note" })).toBeVisible();
  await expect(details.getByText(prompt).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.filesystem.read("notes.md").then(() => true, () => false))).toBe(false);
  await details.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect(details.getByText("Wrote notes.md.").first()).toBeVisible();
  expect(await page.evaluate(async () => (await (window as any).__oxbit.filesystem.read("notes.md")).text)).toBe("agent note\n");

  await page.evaluate(() => (window as any).__oxbit.workbench.openPanel("agent-acp"));
  await expect(panel.getByText("The subagent wrote the note.")).toBeVisible();
  const requests = await page.evaluate(() => (window as any).__models.requests);
  expect(requests.map((request: any) => [request.method, request.path])).toEqual([["GET", "/v1/models"], ...Array(5).fill(["POST", "/v1/chat/completions"])]);
  const tools = (request: any) => request.body.tools.map((tool: any) => tool.function.name);
  expect(tools(requests[1])).toContain("task");
  expect(tools(requests[2])).not.toContain("task");
  expect(requests[2].body.messages.filter((message: any) => message.role === "user").map((message: any) => message.content)).toEqual([prompt]);
});

test("the Oxbit agent lists its slash commands and reopens a saved conversation after a reload", async ({ page }, info) => {
  let panel = await open(page, true, [chatText("The door is blue."), chatText("Blue door")]);
  await page.evaluate(() => (window as any).__oxbit.filesystem.write(".agents/skills/review/SKILL.md",
    "---\nname: review\ndescription: Review the diff\n---\nReview it.\n", { expectedRevision: null }));
  await useCompatible(page);
  await panel.getByRole("button", { name: "Start Oxbit Agent" }).click();
  let composer = panel.getByRole("textbox", { name: "Message agent" });
  await expect(composer).toBeEnabled();
  await composer.fill("/");
  const commands = page.getByRole("listbox", { name: "Agent slash commands" });
  for (const name of ["compact", "context", "goal", "loop", "config", "skills", "review"])
    await expect(commands.getByRole("option", { name: new RegExp(`^/${name}\\b`) })).toBeVisible();
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${info.project.name}-3-commands.png` });
  await composer.fill("Remember the blue door");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByText("The door is blue.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.kernel.services.get("agentACP").title)).toBe("Blue door");

  await page.reload();
  panel = await open(page, true, []);
  await useCompatible(page);
  await panel.getByRole("button", { name: "Start Oxbit Agent" }).click();
  composer = panel.getByRole("textbox", { name: "Message agent" });
  await expect(composer).toBeEnabled();
  await panel.getByRole("button", { name: "History" }).click();
  await panel.getByRole("button", { name: "Find provider conversations" }).click();
  const found = panel.locator(".acp-history-entry").filter({ has: page.getByRole("button", { name: "Open conversation" }) });
  await expect(found).toHaveCount(1);
  await found.getByRole("button", { name: "Open conversation" }).click();
  await expect(panel.getByText("The door is blue.")).toBeVisible();
  await expect(panel.locator(".acp-user-text").filter({ hasText: "Remember the blue door" })).toHaveCount(1);
  await page.screenshot({ path: `${shots}/${info.project.name}-4-reopened.png` });
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
