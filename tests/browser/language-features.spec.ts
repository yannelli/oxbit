import { expect, test } from "@playwright/test";
test("snippets, signature help, keyboard hover, semantic tokens and hints stay in the active document", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    await app.runtime.request("fs.write", { path: "features.fixture", text: "call", expectedRevision: null });
    app.kernel.contributions.register({ id: "fixture.language", kind: "language", title: "Fixture", data: { id: "fixture", extensions: [".fixture"] } });
    const listeners = new Set<(method: string, params: any) => void>();
    (window as any).__tokenRequests = 0;
    app.kernel.contributions.register({ id: "fixture.server", kind: "transport", title: "Feature fixture", data: { languages: ["fixture"], createTransport: () => ({
      async request(method: string) {
        if (method === "initialize") return { capabilities: { textDocumentSync: 1, completionProvider: { resolveProvider: true }, hoverProvider: true, signatureHelpProvider: { triggerCharacters: ["("] }, semanticTokensProvider: { legend: { tokenTypes: ["function"], tokenModifiers: [] }, full: { delta: true } }, inlayHintProvider: true } };
        if (method === "textDocument/completion") return { items: [{ label: "call", insertTextFormat: 2, insertText: "call(${1:value}, ${2:other})$0", documentation: { kind: "markdown", value: "**Call** a function." } }] };
        if (method === "completionItem/resolve") return { label: "call", documentation: { kind: "markdown", value: "**Resolved** documentation." } };
        if (method === "textDocument/hover") return { contents: { kind: "markdown", value: "**Keyboard hover**\n\n```ts\nfunction call(value: string): void\n```" } };
        if (method === "textDocument/signatureHelp") return { signatures: [{ label: "call(value: string, other: number)", parameters: [{ label: [5, 18] }, { label: [20, 33] }] }, { label: "call(value: number)", parameters: [{ label: "value: number" }] }], activeSignature: 0, activeParameter: 0 };
        if (method === "textDocument/semanticTokens/full") { (window as any).__tokenRequests++; return { resultId: "one", data: [0, 0, 4, 0, 0] }; }
        if (method === "textDocument/semanticTokens/full/delta") return { resultId: "two", edits: [{ start: 99, deleteCount: 2 }] };
        if (method === "textDocument/inlayHint") return [{ position: { line: 0, character: 4 }, label: ": void", kind: 1 }];
        return null;
      }, notify() {}, onNotification(fn: (method: string, params: any) => void) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; }, dispose() {},
    }) } });
    await app.openFile("features.fixture");
    await app.kernel.services.get("language").serviceForPath("features.fixture").start(true);
    (window as any).__featureFail = () => { for (const listener of listeners) listener("oxbit/serverState", { state: "stopped", error: "Fixture stopped" }); };
  });
  await expect(page.locator(".lsp-semantic")).toContainText("call");
  await expect(page.locator(".lsp-inlay-hint")).toContainText(": void");
  await page.evaluate(() => { const app = (window as any).__oxbit, view = app.workbench.activeEditor(); view.dispatch({ selection: { anchor: 4 } }); view.focus(); });
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();
  await expect(page.locator(".cm-completionInfo")).toContainText("Resolved documentation.");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.documents.get("features.fixture").text.toString())).toBe("call(value, other)");
  const selection = () => page.evaluate(() => { const view = (window as any).__oxbit.workbench.activeEditor(), range = view.state.selection.main; return view.state.sliceDoc(range.from, range.to); });
  expect(await selection()).toBe("value");
  await page.keyboard.press("Tab"); expect(await selection()).toBe("other");
  await page.keyboard.press("Shift+Tab"); expect(await selection()).toBe("value");
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as any).__oxbit.kernel.commands.execute("editor.signature"));
  await expect(page.locator(".lsp-signature strong")).toHaveText("value: string");
  await page.getByRole("button", { name: "Next overload" }).click();
  await expect(page.locator(".lsp-signature pre")).toHaveText("call(value: number)");
  await page.locator(".lsp-signature").focus(); await page.keyboard.press("Escape");
  await expect(page.locator(".lsp-signature")).toHaveCount(0);
  await page.evaluate(() => (window as any).__oxbit.kernel.commands.execute("editor.hover"));
  await expect(page.locator(".lsp-tooltip")).toContainText("Keyboard hover");
  await page.keyboard.press("Escape");
  await expect(page.locator(".lsp-tooltip")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__tokenRequests)).toBeGreaterThanOrEqual(2);
  const tokenRequests = await page.evaluate(() => (window as any).__tokenRequests);
  await page.evaluate(() => (window as any).__oxbit.workbench.split("row"));
  await expect(page.locator(".lsp-semantic")).toHaveCount(2);
  await expect(page.locator(".lsp-inlay-hint")).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).__tokenRequests)).toBe(tokenRequests);
  await page.evaluate(() => (window as any).__featureFail());
  await expect(page.locator(".lsp-semantic")).toHaveCount(0);
  await expect(page.locator(".lsp-inlay-hint")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("navigation selects deduplicated results, preserves history and loads hierarchy children lazily", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit; await app.runtime.trust(true);
    for (const file of ["navigation.nav", "target-a.nav", "target-b.nav"]) await app.runtime.request("fs.write", { path: file, text: "symbol", expectedRevision: null });
    app.kernel.contributions.register({ id: "nav.language", kind: "language", title: "Navigation fixture", data: { id: "nav", extensions: [".nav"] } });
    (window as any).__hierarchyRequests = 0;
    app.kernel.contributions.register({ id: "nav.server", kind: "transport", title: "Navigation fixture", data: { languages: ["nav"], createTransport: () => ({
      async request(method: string, params: any) {
        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, uri = "file:///workspace/target-a.nav";
        if (method === "initialize") return { capabilities: { textDocumentSync: 1, declarationProvider: true, referencesProvider: true, callHierarchyProvider: true, workspaceSymbolProvider: true } };
        if (method === "textDocument/declaration") return [{ targetUri: uri, targetRange: range, targetSelectionRange: range }];
        if (method === "textDocument/references") return [{ uri, range }, { uri, range }, { uri: "file:///workspace/target-b.nav", range }];
        if (method === "textDocument/prepareCallHierarchy") return [{ name: "Caller", uri, range, selectionRange: range, kind: 12 }];
        if (method === "callHierarchy/incomingCalls") { (window as any).__hierarchyRequests++; return [{ from: { name: "Parent", uri, range, selectionRange: range, kind: 12 }, fromRanges: [range] }]; }
        if (method === "workspace/symbol") return [{ name: params.query || "Workspace symbol", kind: 12, location: { uri, range } }];
        return null;
      }, notify() {}, onNotification() { return { dispose() {} }; }, dispose() {},
    }) } });
    await app.openFile("navigation.nav"); await app.kernel.services.get("language").serviceForPath("navigation.nav").start(true);
    await app.kernel.commands.execute("editor.gotoDeclaration");
  });
  const activePath = () => page.evaluate(() => (window as any).__oxbit.workbench.activePath());
  const command = (id: string) => page.evaluate(id => (window as any).__oxbit.kernel.commands.execute(id), id);
  await expect.poll(activePath).toBe("target-a.nav");
  await command("editor.navigateBack"); await expect.poll(activePath).toBe("navigation.nav");
  await command("editor.navigateForward"); await expect.poll(activePath).toBe("target-a.nav");
  await command("editor.navigateBack"); await command("editor.references");
  await expect(page.getByRole("button", { name: "file:///workspace/target-a.nav:1", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "file:///workspace/target-b.nav:1", exact: true }).click();
  await expect.poll(activePath).toBe("target-b.nav");
  await command("editor.navigateBack"); await expect.poll(activePath).toBe("navigation.nav");
  await command("editor.incomingCalls");
  expect(await page.evaluate(() => (window as any).__hierarchyRequests)).toBe(0);
  await page.getByRole("button", { name: "Expand Caller", exact: true }).click();
  await expect(page.getByRole("button", { name: "Parent", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__hierarchyRequests)).toBe(1);
  await command("editor.workspaceSymbols");
  await page.getByRole("textbox", { name: "Search workspace symbols" }).fill("Found symbol");
  await page.getByRole("button", { name: "Found symbol", exact: true }).click();
  await expect.poll(activePath).toBe("target-a.nav");
  expect(errors).toEqual([]);
});

test("modifier-click uses the clicked symbol and split for definition navigation", async ({ page }) => {
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    await app.filesystem.write("click.nav", "first second", { expectedRevision: null });
    await app.filesystem.write("definition.nav", "second", { expectedRevision: null });
    app.kernel.contributions.register({ id: "click.language", kind: "language", title: "Click fixture", data: { id: "nav", extensions: [".nav"] } });
    app.kernel.contributions.register({ id: "click.server", kind: "transport", title: "Click fixture", data: { languages: ["nav"], createTransport: () => ({
      async request(method: string, params: any) {
        if (method === "initialize") return { capabilities: { textDocumentSync: 1, definitionProvider: true } };
        if (method === "textDocument/definition") {
          (window as any).__definitionRequest = params;
          return { uri: "file:///workspace/definition.nav", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } };
        }
        return null;
      }, notify() {}, onNotification() { return { dispose() {} }; }, dispose() {},
    }) } });
    await app.openFile("click.nav");
    await app.kernel.services.get("language").serviceForPath("click.nav").start(true);
    (window as any).__sourceGroup = app.workbench.state.activeGroup;
    const otherGroup = app.workbench.split("row");
    await app.workbench.openFile("README.md", { groupId: otherGroup, preview: false });
  });
  const point = await page.evaluate(() => {
    const app = (window as any).__oxbit;
    const view = app.workbench.editors.get((window as any).__sourceGroup);
    const coords = view.coordsAtPos(8);
    return { x: coords.left + 1, y: (coords.top + coords.bottom) / 2, mac: /Mac|iPhone|iPad/.test(navigator.platform) };
  });
  await page.mouse.click(point.x, point.y);
  expect(await page.evaluate(() => (window as any).__definitionRequest)).toBeUndefined();
  await page.keyboard.down(point.mac ? "Meta" : "Control");
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up(point.mac ? "Meta" : "Control");
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.workbench.activePath())).toBe("definition.nav");
  expect(await page.evaluate(() => (window as any).__definitionRequest.position.character)).toBe(8);
  expect(await page.evaluate(() => (window as any).__oxbit.workbench.state.activeGroup)).toBe(await page.evaluate(() => (window as any).__sourceGroup));
});
