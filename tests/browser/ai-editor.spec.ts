import { test, expect, type Page } from "@playwright/test";

const chatText = (text: string) => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: text } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  "data: [DONE]\n\n",
];

/** The browser workspace has no runtime, so a fake agentModels service with a saved key answers AI requests with `replies` in order. */
async function open(page: Page, replies: string[][]) {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await page.evaluate(async (replies) => {
    const z = (window as any).__oxbit;
    const requests: any[] = (window as any).__aiRequests = [];
    z.kernel.services.register("agentModels", {
      async *stream(request: any) { requests.push(request); yield* replies.shift() ?? []; },
      keys: { has: async () => true, save: async () => {}, remove: async () => {} },
    });
    for (const [id, value] of Object.entries({
      "agentACP.oxbit.api": "openai-compatible", "agentACP.oxbit.baseUrl": "https://models.test/api", "agentACP.oxbit.model": "agent-model",
      "ai.model": "fast-model", "ai.inlineCompletions.enabled": true, "ai.inlineCompletions.delay": 100,
    })) await z.kernel.configuration.set(id, value, "user");
    await z.workbench.openFile("src/App.tsx");
  }, replies);
  await page.locator(".cm-content[contenteditable=true]").click();
  await page.keyboard.press("ControlOrMeta+End");
}
const text = (page: Page) => page.evaluate(() => (window as any).__oxbit.workbench.activeEditor().state.doc.toString() as string);

test("ghost text appears after typing and Tab accepts it", async ({ page }) => {
  await open(page, [chatText("\"hello\";")]);
  await page.keyboard.press("Enter");
  await page.keyboard.type("const greeting = ");
  const ghost = page.locator(".cm-ai-ghost");
  await expect(ghost).toHaveText("\"hello\";");
  const request = await page.evaluate(() => (window as any).__aiRequests[0]);
  expect(request).toMatchObject({ api: "openai-compatible", path: "/v1/chat/completions", body: { model: "fast-model" } });
  expect(JSON.stringify(request.body.messages)).toContain("const greeting = <|cursor|>");
  await page.keyboard.press("Tab");
  await expect(ghost).toHaveCount(0);
  expect(await text(page)).toContain("const greeting = \"hello\";");
});

test("Escape dismisses ghost text and leaves the document unchanged", async ({ page }) => {
  await open(page, [chatText("42;")]);
  await page.keyboard.press("Enter");
  await page.keyboard.type("const answer = ");
  await expect(page.locator(".cm-ai-ghost")).toHaveText("42;");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-ai-ghost")).toHaveCount(0);
  expect(await text(page)).toMatch(/const answer = $/);
});

test("Ctrl/Cmd+Right accepts the suggestion one word at a time", async ({ page }) => {
  await open(page, [chatText("items.length > 0;")]);
  await page.keyboard.press("Enter");
  await page.keyboard.type("return ");
  const ghost = page.locator(".cm-ai-ghost");
  await expect(ghost).toHaveText("items.length > 0;");
  await page.keyboard.press("ControlOrMeta+ArrowRight");
  await expect(ghost).toHaveText(".length > 0;");
  expect(await text(page)).toMatch(/return items$/);
});

test("Edit Selection with AI replaces the selection after the instruction", async ({ page }) => {
  await open(page, [chatText("```ts\nconst total = a + b;\n```")]);
  await page.evaluate(() => {
    const z = (window as any).__oxbit;
    const view = z.workbench.activeEditor();
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: "\nconst total = a+b;" }, selection: { anchor: end + 1, head: end + 19 } });
    view.focus();
  });
  await page.keyboard.press("ControlOrMeta+Alt+K");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("add spaces around +");
  await dialog.getByRole("textbox").press("Enter");
  await expect(page.locator(".cm-ai-edit-applied")).toHaveText("const total = a + b;");
  expect(await text(page)).toMatch(/\nconst total = a \+ b;$/);
  const request = await page.evaluate(() => (window as any).__aiRequests[0]);
  expect(JSON.stringify(request.body.messages)).toContain("Instruction: add spaces around +");
  await page.keyboard.press("ControlOrMeta+z");
  expect(await text(page)).toMatch(/\nconst total = a\+b;$/);
});
