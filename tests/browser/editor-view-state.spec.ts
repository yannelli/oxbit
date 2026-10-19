import { test, expect } from "@playwright/test";

test("returning to a tab restores its scroll position and cursor", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    await app.workbench.openFile("src/App.tsx", { preview: false });
    const view = app.workbench.activeEditor();
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n" + Array.from({ length: 400 }, (_, i) => `// line ${i}`).join("\n") } });
    await app.workbench.openFile("src/main.tsx", { preview: false });
    await app.workbench.openFile("src/App.tsx", { preview: false });
  });
  const editor = () => page.evaluate(() => { const view = (window as any).__oxbit.workbench.activeEditor(); return { path: view.state.doc.length, scroll: view.scrollDOM.scrollTop, head: view.state.selection.main.head }; });
  await page.evaluate(() => { const view = (window as any).__oxbit.workbench.activeEditor(); view.dispatch({ selection: { anchor: view.state.doc.line(300).from + 3 }, scrollIntoView: true }); });
  await expect.poll(async () => (await editor()).scroll).toBeGreaterThan(1000);
  const before = await editor();
  await page.getByRole("tab", { name: /main\.tsx/ }).first().click();
  await expect.poll(async () => (await editor()).path).not.toBe(before.path);
  await page.getByRole("tab", { name: /App\.tsx/ }).first().click();
  await expect.poll(async () => (await editor()).path).toBe(before.path);
  await expect.poll(async () => Math.abs((await editor()).scroll - before.scroll)).toBeLessThan(5);
  expect((await editor()).head).toBe(before.head);
  expect(errors).toEqual([]);
});
