import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

async function ready(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
}
async function open(page: Page, id: string) {
  await page.evaluate(
    (id) => (window as any).__oxbit.workbench.openPanel(id),
    id,
  );
}
async function fixture(page: Page) {
  await page.evaluate(() => {
    const win = window as any,
      React = win.__OXBIT_REACT__;
    win.panelMounts = 0;
    win.panelUnmounts = 0;
    win.__oxbit.kernel.contributions.register({
      id: "stateful-panel",
      kind: "panel",
      title: "Stateful panel",
      component: () => {
        const [value, setValue] = React.useState("");
        React.useEffect(() => {
          win.panelMounts++;
          return () => win.panelUnmounts++;
        }, []);
        return React.createElement("input", {
          "aria-label": "Panel draft",
          value,
          onChange: (event: any) => setValue(event.target.value),
        });
      },
    });
    win.__oxbit.workbench.openPanel("stateful-panel");
  });
  await page
    .getByRole("textbox", { name: "Panel draft" })
    .fill("A draft that survives moving");
}
async function move(page: Page, name: string, value: string) {
  await page
    .getByRole("button", { name: "Panel actions: " + name, exact: true })
    .click();
  const labels: Record<string, string> = {
    left: "Move to Left",
    right: "Move to Right",
    bottom: "Move to Bottom",
    "split:top": "Split Above",
    "split:bottom": "Split Below",
    "split:left": "Split Left",
    "split:right": "Split Right",
    float: "Pop Out Panel",
    dock: "Dock Back",
  };
  await page
    .getByRole("menuitem", { name: labels[value], exact: true })
    .click();
}

test("simultaneous docks, both split directions, keyboard tabs and saved layout", async ({
  page,
}) => {
  await ready(page);
  await open(page, "search");
  await move(page, "Search", "right");
  await expect(
    page.locator('[data-dock="left"] [data-panel-instance="explorer"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-dock="right"] [data-panel-instance="search"]'),
  ).toBeVisible();
  await open(page, "terminal");
  await move(page, "Terminal", "right");
  await move(page, "Terminal", "split:bottom");
  await open(page, "output");
  await move(page, "Output", "right");
  await move(page, "Output", "split:right");
  await expect(page.locator('[data-dock="right"] .dock-group')).toHaveCount(3);
  await expect(
    page.getByRole("separator", { name: "Resize panel rows", exact: true }),
  ).toBeVisible();
  const columns = page.getByRole("separator", {
    name: "Resize panel columns",
    exact: true,
  });
  await columns.focus();
  await columns.press("ArrowRight");
  expect(Number(await columns.getAttribute("aria-valuenow"))).toBeGreaterThan(
    50,
  );
  const before = await page.evaluate(async () => {
    const wb = (window as any).__oxbit.workbench;
    await wb.persist();
    return wb.state.panelLayout;
  });
  await page.reload();
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  expect(
    await page.evaluate(
      () => (window as any).__oxbit.workbench.state.panelLayout,
    ),
  ).toEqual(before);
  await expect(page.locator('[data-dock="right"] .dock-group')).toHaveCount(3);
  await page.screenshot({ path: "test-results/panel-docks.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-dock="right"]')).toBeVisible();
  await expect(page.locator('[data-dock="left"]')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('[data-dock="left"]')).toBeVisible();
});

test("phone panels open on the first tap and closing the overlay preserves desktop docks", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await expect(page.locator('[data-dock="left"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await expect(page.locator('[data-dock="left"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-dock="left"]')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('[data-dock="left"]')).toBeVisible();
});

test("drag and drop moves a panel and keeps its mounted state", async ({
  page,
}) => {
  await ready(page);
  await fixture(page);
  const tab = page.getByRole("tab", { name: "Stateful panel", exact: true });
  const target = page.locator('[data-dock="left"] .panel-slot');
  await tab.dragTo(target, { targetPosition: { x: 130, y: 180 } });
  await expect(
    page.locator('[data-dock="left"] input[aria-label="Panel draft"]'),
  ).toHaveValue("A draft that survives moving");
  expect(
    await page.evaluate(() => [
      (window as any).panelMounts,
      (window as any).panelUnmounts,
    ]),
  ).toEqual([1, 0]);
  await move(page, "Stateful panel", "bottom");
  await expect(
    page.locator('[data-dock="bottom"] input[aria-label="Panel draft"]'),
  ).toHaveValue("A draft that survives moving");
});

test("native-style pointer dragging supports moving and Escape cancellation", async ({
  page,
}) => {
  await ready(page);
  await fixture(page);
  await page.evaluate(() =>
    Object.defineProperty(
      (window as any).__oxbit.workbench.panelWindows,
      "pointerDrag",
      { value: true },
    ),
  );
  // Trigger a render after enabling the native host's pointer strategy.
  await open(page, "stateful-panel");
  const source = await page
    .getByRole("tab", { name: "Stateful panel", exact: true })
    .boundingBox();
  const target = await page.locator(".dock-left .panel-slot").boundingBox();
  await page.mouse.move(
    source!.x + source!.width / 2,
    source!.y + source!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    target!.x + target!.width / 2,
    target!.y + target!.height / 2,
    { steps: 10 },
  );
  await expect(page.locator(".dock-left .panel-drop-preview")).toBeVisible();
  await page.mouse.up();
  await expect(
    page.locator('.dock-left [aria-label="Panel draft"]'),
  ).toHaveValue("A draft that survives moving");
  const relocated = await page
    .getByRole("tab", { name: "Stateful panel", exact: true })
    .boundingBox();
  await page.mouse.move(
    relocated!.x + relocated!.width / 2,
    relocated!.y + relocated!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(1000, 850, { steps: 10 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(
    page.locator('.dock-left [aria-label="Panel draft"]'),
  ).toHaveValue("A draft that survives moving");
  expect(await page.evaluate(() => (window as any).panelMounts)).toBe(1);
});

test("real pop-outs preserve React state, apply theme changes, and dock back on close", async ({
  page,
}) => {
  await ready(page);
  await fixture(page);
  const popupPromise = page.waitForEvent("popup");
  await move(page, "Stateful panel", "float");
  const popup = await popupPromise;
  await expect(popup.getByRole("textbox", { name: "Panel draft" })).toHaveValue(
    "A draft that survives moving",
  );
  await expect(page.getByRole("textbox", { name: "Panel draft" })).toHaveCount(
    0,
  );
  await popup
    .getByRole("textbox", { name: "Panel draft" })
    .fill("Changed in another window");
  expect(
    await page.evaluate(() => [
      (window as any).panelMounts,
      (window as any).panelUnmounts,
    ]),
  ).toEqual([1, 0]);
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.configuration.set(
      "workbench.colorTheme",
      "Paper (light)",
    ),
  );
  await expect(popup.locator(".floating-workbench")).toHaveAttribute(
    "data-theme",
    "light",
  );
  await popup.screenshot({ path: "test-results/panel-floating.png" });
  await popup.close();
  await expect(page.getByRole("textbox", { name: "Panel draft" })).toHaveValue(
    "Changed in another window",
  );
  expect(
    await page.evaluate(() => [
      (window as any).panelMounts,
      (window as any).panelUnmounts,
    ]),
  ).toEqual([1, 0]);
});

test("blocked windows leave panels docked and browser restoration requires a gesture", async ({
  page,
}) => {
  await ready(page);
  await open(page, "terminal");
  await page.evaluate(() => {
    (window as any).savedWindowOpen = window.open;
    window.open = () => null;
  });
  await move(page, "Terminal", "float");
  await expect(
    page.locator('[data-dock="bottom"] [data-panel-instance="terminal"]'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).__oxbit.workbench.state.panelLayout.floating,
    ),
  ).toHaveLength(0);
  await page.evaluate(() => {
    window.open = (window as any).savedWindowOpen;
  });
  const popupPromise = page.waitForEvent("popup");
  await move(page, "Terminal", "float");
  const popup = await popupPromise;
  await expect(popup.locator('[data-panel-instance="terminal"]')).toBeVisible();
  await page.evaluate(() => (window as any).__oxbit.workbench.persist());
  await page.reload();
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await expect(
    page.getByRole("button", { name: "Restore floating panels" }),
  ).toBeVisible();
  const restoredPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Restore floating panels" }).click();
  const restored = await restoredPromise;
  await expect(
    restored.locator('[data-panel-instance="terminal"]'),
  ).toBeVisible();
  await restored
    .getByRole("button", { name: "Dock Back", exact: true })
    .first()
    .click();
  await expect(
    page.locator('[data-dock="bottom"] [data-panel-instance="terminal"]'),
  ).toBeVisible();
});

test("a running terminal keeps its process, output, input and resizing across windows", async ({
  page,
}) => {
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  const id = await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    await z.runtime.trust(true);
    const terminal = await z.kernel.services.get("terminal").create();
    await z.runtime.request("terminal.input", {
      id: terminal.id,
      data: "printf 'BEFORE_FLOAT\\n'\r",
    });
    return terminal.id as string;
  });
  const text = () =>
    page.evaluate((id) => {
      const terminal = (window as any).__oxbit.kernel.services
        .get("terminal")
        .sessions.get(id).terminal;
      if (!terminal) return "";
      const buffer = terminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, i) =>
        buffer.getLine(i)?.translateToString(),
      ).join("\n");
    }, id);
  await expect.poll(text).toContain("BEFORE_FLOAT");
  const popupPromise = page.waitForEvent("popup");
  await move(page, "Terminal", "float");
  const popup = await popupPromise;
  await expect(popup.locator(".xterm")).toBeVisible();
  await expect.poll(text).toContain("BEFORE_FLOAT");
  await popup.locator(".xterm-helper-textarea").fill("printf 'AFTER_FLOAT\\n'");
  await popup.locator(".xterm-helper-textarea").press("Enter");
  await expect.poll(text).toContain("AFTER_FLOAT");
  await popup.setViewportSize({ width: 800, height: 600 });
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).__oxbit.kernel.services
            .get("terminal")
            .sessions.get(id).terminal.cols,
        id,
      ),
    )
    .toBeGreaterThan(50);
  await popup.close();
  await expect(page.locator(".xterm")).toBeVisible();
  await expect.poll(text).toContain("AFTER_FLOAT");
  expect(
    await page.evaluate(
      () =>
        (window as any).__oxbit.kernel.services.get("terminal").sessions.size,
    ),
  ).toBe(1);
  await page.evaluate(
    (id) => (window as any).__oxbit.runtime.request("terminal.kill", { id }),
    id,
  );
});

test("an agent conversation and its unsent draft follow the same live panel", async ({
  page,
}) => {
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  const id = await page.evaluate(
    async (launch) => {
      const z = (window as any).__oxbit;
      await z.runtime.trust(true);
      await z.kernel.extensions.activate("oxbit.agent-acp");
      const agent = z.kernel.services.get("agentACP");
      await agent.connect(launch);
      if (!agent.connection) throw new Error(agent.error);
      agent.draft = "Existing conversation";
      await agent.send();
      agent.draft = "An unsent draft";
      agent.changed();
      z.workbench.openPanel("agent-acp");
      return agent.connection.id as string;
    },
    {
      provider: "codex",
      command: process.execPath,
      args: [path.resolve("tests/fixtures/agent-acp/agent.mjs")],
    },
  );
  await expect(
    page.getByRole("textbox", { name: "Message agent" }),
  ).toHaveValue("An unsent draft");
  await expect(
    page.getByRole("log", { name: "Agent conversation" }),
  ).toContainText("Existing conversation");
  const popupPromise = page.waitForEvent("popup");
  await move(page, "Agent ACP", "float");
  const popup = await popupPromise;
  await expect(
    popup.getByRole("log", { name: "Agent conversation" }),
  ).toContainText("Existing conversation");
  await popup
    .getByRole("textbox", { name: "Message agent" })
    .fill("Edited in the floating agent");
  await popup.close();
  await expect(
    page.getByRole("textbox", { name: "Message agent" }),
  ).toHaveValue("Edited in the floating agent");
  expect(
    await page.evaluate(
      () =>
        (window as any).__oxbit.kernel.services.get("agentACP").connection.id,
    ),
  ).toBe(id);
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.services.get("agentACP").disconnect(),
  );
});
