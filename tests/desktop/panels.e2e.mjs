/* global browser, $, describe, it */
import assert from "node:assert/strict";
import path from "node:path";

describe("Native floating panels", () => {
  it("opens a related native panel window and docks its live state back", async () => {
    await browser.waitUntil(
      () => browser.execute(() => !!globalThis.__oxbitDesktop),
      { timeout: 30000 },
    );
    await browser.execute(
      async (project) => {
        await globalThis.__oxbitDesktop.native.open(project);
      },
      path.join(process.env.OXBIT_NATIVE_FIXTURES, "Alpha project"),
    );
    await browser.waitUntil(
      () => browser.execute(() => !!globalThis.__oxbit?.ready),
      { timeout: 40000 },
    );
    await browser.execute(() => {
      const React = globalThis.__OXBIT_REACT__;
      globalThis.panelMounts = 0;
      globalThis.__oxbit.kernel.contributions.register({
        id: "native-panel",
        kind: "panel",
        title: "Native test panel",
        component: () => {
          const [draft, setDraft] = React.useState("Native draft");
          React.useEffect(() => {
            globalThis.panelMounts++;
          }, []);
          return React.createElement("input", {
            "aria-label": "Native panel draft",
            value: draft,
            onChange: (e) => setDraft(e.target.value),
          });
        },
      });
      globalThis.__oxbit.workbench.openPanel("native-panel");
    });
    await $('[aria-label="Native panel draft"]').waitForDisplayed();
    await $('.dock-bottom [aria-label="Pop Out Panel"]').click();
    await browser
      .waitUntil(
        () =>
          browser.execute(() => {
            const wb = globalThis.__oxbit.workbench;
            const child = [...wb.panelWindows.windows.values()][0];
            return !!child?.document.querySelector(
              '[aria-label="Native panel draft"]',
            );
          }),
        {
          timeout: 15000,
          timeoutMsg: "Native popup did not receive the original panel",
        },
      )
      .catch(async (error) => {
        const diagnostic = await browser.execute(() => ({
          notifications: globalThis.__oxbit.workbench.state.notifications.map(
            (n) => n.message,
          ),
          windows: globalThis.__oxbit.workbench.panelWindows.windows.size,
          floats:
            globalThis.__oxbit.workbench.state.panelLayout.floating.length,
        }));
        assert.fail(String(error) + ": " + JSON.stringify(diagnostic));
      });
    const result = await browser.execute(() => {
      const wb = globalThis.__oxbit.workbench,
        child = [...wb.panelWindows.windows.values()][0];
      return {
        count: wb.state.panelLayout.floating.length,
        mounts: globalThis.panelMounts,
        value: child.document.querySelector("input").value,
        mainCount: document.querySelectorAll(
          '[aria-label="Native panel draft"]',
        ).length,
        url: child.location.href,
        size: [child.innerWidth, child.innerHeight],
      };
    });
    assert.equal(result.count, 1);
    assert.equal(result.mounts, 1);
    assert.equal(result.value, "Native draft");
    assert.equal(result.mainCount, 0);
    assert.match(result.url, /^about:blank/);
    assert.ok(result.size[0] >= 320);
    await browser.execute(() =>
      [
        ...globalThis.__oxbit.workbench.panelWindows.windows.values(),
      ][0].close(),
    );
    await $('[aria-label="Native panel draft"]').waitForDisplayed();
    assert.equal(await browser.execute(() => globalThis.panelMounts), 1);
    await browser.waitUntil(
      () =>
        browser.execute(
          async () =>
            (await globalThis.__TAURI__.webviewWindow.getAllWebviewWindows())
              .length === 1,
        ),
      {
        timeout: 5000,
        timeoutMsg: "Docked panel left an empty native window behind",
      },
    );
  });

  // WDIO 1.4.0 emits MouseEvent, not PointerEvent, for pointer actions.
  // This opt-in case lets a real OS drag verify WebKit pointer capture.
  (process.env.OXBIT_PANEL_MANUAL ? it : it.skip)(
    "drags a native panel without replacing the native file drop handler",
    async () => {
      await $('.dock-left [aria-label="Native panel draft"]').waitForDisplayed({
        timeout: 60000,
      });
      assert.equal(await browser.execute(() => globalThis.panelMounts), 1);
      await browser.execute(() =>
        globalThis.__oxbit.workbench.movePanel("native-panel", {
          container: "bottom",
        }),
      );
      await $(
        '.dock-bottom [aria-label="Native panel draft"]',
      ).waitForDisplayed();
    },
  );

  it("keeps a floating panel mounted while another project is active", async () => {
    await browser.execute(
      async (project) => {
        globalThis.panelOwner = globalThis.__oxbit.workbench;
        globalThis.panelOwnerKey =
          globalThis.__oxbitDesktop.manager.active.project.key;
        await globalThis.panelOwner.detachPanel("native-panel");
        await globalThis.__oxbitDesktop.native.open(project);
      },
      path.join(process.env.OXBIT_NATIVE_FIXTURES, "Beta 项目"),
    );
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          globalThis.__oxbitDesktop.manager.active?.project.name ===
          "Beta 项目",
      ),
    );
    assert.equal(
      await browser.execute(() => {
        const child = [
          ...globalThis.panelOwner.panelWindows.windows.values(),
        ][0];
        return child?.document.querySelector(
          '[aria-label="Native panel draft"]',
        )?.value;
      }),
      "Native draft",
    );
    assert.equal(await browser.execute(() => globalThis.panelMounts), 1);
    await browser.execute(() =>
      globalThis.__oxbitDesktop.native.activate(globalThis.panelOwnerKey),
    );
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          globalThis.__oxbitDesktop.manager.active?.project.name ===
          "Alpha project",
      ),
    );
    await browser.execute(() =>
      globalThis.panelOwner.panelWindows.returnWindow(
        globalThis.panelOwner.state.panelLayout.floating[0].id,
      ),
    );
    await $('[aria-label="Native panel draft"]').waitForDisplayed();
  });

  it("retains floats when a dirty workspace close is cancelled", async () => {
    await browser.execute(async () => {
      const wb = globalThis.__oxbit.workbench;
      await wb.openFile("hello.ts", { preview: false });
      globalThis.__oxbit.documents
        .get("hello.ts")
        .replace("export const unsaved = 2;\n");
      await wb.detachPanel("native-panel");
      await globalThis.__oxbitDesktop.native.close("window");
    });
    await $('[aria-label="Close projects?"] button')
      .waitForDisplayed({ timeout: 5000 })
      .catch(async (error) => {
        const diagnostic = await browser.execute(() => ({
          dialogs: [...document.querySelectorAll(".dialog")].map((el) => ({
            text: el.textContent,
            rect: JSON.stringify(el.getBoundingClientRect()),
            opacity: getComputedStyle(el).opacity,
            display: getComputedStyle(el).display,
            visibility: getComputedStyle(el).visibility,
            parent: el.parentElement.outerHTML.slice(0, 200),
          })),
          hasFocus: document.hasFocus(),
          height: innerHeight,
          width: innerWidth,
          closing: globalThis.__oxbitDesktop.manager.isClosing,
        }));
        assert.fail(String(error) + JSON.stringify(diagnostic));
      });
    await $('[aria-label="Close projects?"]').$("button=Cancel").click();
    assert.equal(
      await browser.execute(() => {
        const wb = globalThis.__oxbit.workbench;
        return (
          wb.state.panelLayout.floating.length === 1 &&
          ![...wb.panelWindows.windows.values()][0].closed
        );
      }),
      true,
    );
    await browser.execute(() => {
      const wb = globalThis.__oxbit.workbench;
      wb.panelWindows.returnWindow(wb.state.panelLayout.floating[0].id);
    });
    await $('[aria-label="Native panel draft"]').waitForDisplayed();
  });

  it("restores saved native floats after the workspace reloads", async () => {
    await browser.execute(async () => {
      const wb = globalThis.__oxbit.workbench;
      await wb.detachPanel("explorer");
      await wb.persist();
    });
    await browser.refresh();
    await browser.waitUntil(
      () => browser.execute(() => !!globalThis.__oxbit?.ready),
      { timeout: 40000 },
    );
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const wb = globalThis.__oxbit.workbench;
          return (
            wb.state.panelLayout.floating.length === 1 &&
            [...wb.panelWindows.windows.values()].some(
              (child) =>
                !!child.document.querySelector(
                  '[data-panel-instance="explorer"]',
                ),
            )
          );
        }),
      { timeout: 15000 },
    );
    await browser.execute(() => {
      const wb = globalThis.__oxbit.workbench;
      wb.panelWindows.returnWindow(wb.state.panelLayout.floating[0].id);
    });
    await $('[data-panel-instance="explorer"]').waitForDisplayed();
  });
});
