import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { loadWebglRenderer } from "./webgl";

const webgl = vi.hoisted(() => ({ instances: [] as Array<{ loseContext(): void; disposed: boolean }>, failNext: false }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    disposed = false;
    private lost?: () => void;
    constructor() { webgl.instances.push(this); }
    onContextLoss(listener: () => void) { this.lost = listener; }
    loseContext() { this.lost?.(); }
    activate() { if (webgl.failNext) { webgl.failNext = false; throw new Error("no WebGL2 context"); } }
    dispose() { this.disposed = true; }
  },
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function terminal() {
  const textarea = new EventTarget();
  const loadAddon = vi.fn((addon: { activate?(): void }) => addon.activate?.());
  return { term: { textarea, loadAddon } as unknown as Terminal, textarea, loadAddon };
}

describe("terminal WebGL renderer", () => {
  afterEach(() => { webgl.instances.length = 0; vi.unstubAllGlobals(); });

  it("reloads WebGL on focus after the context is lost", async () => {
    vi.stubGlobal("WebGL2RenderingContext", class {});
    const { term, textarea } = terminal();
    loadWebglRenderer(term, () => true);
    await flush();
    expect(webgl.instances).toHaveLength(1);
    textarea.dispatchEvent(new Event("focus"));
    await flush();
    expect(webgl.instances).toHaveLength(1);
    webgl.instances[0].loseContext();
    expect(webgl.instances[0].disposed).toBe(true);
    textarea.dispatchEvent(new Event("focus"));
    await flush();
    expect(webgl.instances).toHaveLength(2);
    expect(webgl.instances[1].disposed).toBe(false);
  });

  it("retries on focus when the first context is refused", async () => {
    vi.stubGlobal("WebGL2RenderingContext", class {});
    webgl.failNext = true;
    const { term, textarea, loadAddon } = terminal();
    loadWebglRenderer(term, () => true);
    await flush();
    expect(webgl.instances[0].disposed).toBe(true);
    textarea.dispatchEvent(new Event("focus"));
    await flush();
    expect(webgl.instances).toHaveLength(2);
    expect(loadAddon).toHaveBeenLastCalledWith(webgl.instances[1]);
  });

  it("skips WebGL after the terminal unmounts", async () => {
    vi.stubGlobal("WebGL2RenderingContext", class {});
    const { term } = terminal();
    loadWebglRenderer(term, () => false);
    await flush();
    expect(webgl.instances).toHaveLength(0);
  });
});
