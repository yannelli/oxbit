import type { WorkbenchController } from "./controller.js";
import {
  detachPanel,
  panelGroups,
  panelLocation,
  redockPanel,
  type PanelBounds,
} from "./panel-layout.js";

/** Related windows share the original session and React tree; no runtime is booted in a float. */
export interface PanelWindowHost {
  open(url: string, name: string, features: string): Window | null;
  restoreAutomatically?: boolean;
  /** Keep the native file-drop handler while moving tool tabs with pointer events. */
  pointerDrag?: boolean;
  close?(id: string): void | Promise<void>;
}
let host: PanelWindowHost | undefined;
export function configurePanelWindows(value: PanelWindowHost) {
  host = value;
}

export class PanelWindows {
  readonly windows = new Map<string, Window>();
  activateOwner?: () => void;
  private pending = new Map<string, Window>();
  private cleanups = new Map<string, () => void>();
  private interval?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private stopped = false;
  private started = false;
  constructor(private readonly workbench: WorkbenchController) {}
  get pointerDrag() {
    return host?.pointerDrag ?? false;
  }
  private close(id: string, child: Window) {
    child.close();
    void Promise.resolve(host?.close?.(id)).catch((error) => {
      if (!this.stopped) this.workbench.notify(String(error), "error");
    });
  }
  has(id: string) {
    return this.windows.has(id);
  }
  setSuspended(value: boolean) {
    for (const child of this.windows.values())
      if (!child.closed) child.document.body.inert = value;
  }
  focusOwner() {
    if (typeof window === "undefined") return false;
    const focused = [...this.windows.values()].some(
      (child) => !child.closed && child.document.hasFocus(),
    );
    if (focused) {
      this.activateOwner?.();
      window.focus();
    }
    return focused;
  }
  start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    this.unsubscribe = this.workbench.subscribe(() => {
      // Let React adopt the panel containers back before destroying a child document.
      queueMicrotask(() => this.reconcile());
    });
    this.interval = setInterval(() => this.reconcile(), 500);
    window.addEventListener("unload", this.dispose);
    window.addEventListener("pagehide", this.dispose);
    if (host?.restoreAutomatically) this.restoreAll();
  }
  private async open(id: string, bounds: PanelBounds): Promise<Window> {
    if (this.stopped) throw new Error("Workspace is closed");
    const existing = this.windows.get(id);
    if (existing && !existing.closed) return existing;
    if (this.pending.has(id))
      throw new Error("This floating window is already opening");
    const url = new URL("panel.html", window.location.href);
    url.searchParams.set("panel", id);
    const screen = window.screen;
    const width = Math.max(
      320,
      Math.min(bounds.width, screen.availWidth || 1920),
    );
    const height = Math.max(
      240,
      Math.min(bounds.height, screen.availHeight || 1080),
    );
    // Native geometry is validated against all monitors in Rust. Browsers constrain their own popups.
    const features = `popup=yes,width=${width},height=${height},left=${bounds.x},top=${bounds.y}`;
    const child = (host ?? { open: window.open.bind(window) }).open(
      url.href,
      id,
      features,
    );
    if (!child)
      throw new Error(
        "The floating window was blocked. Allow pop-ups for Oxbit and try again.",
      );
    this.pending.set(id, child);
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const check = () => {
          if (this.stopped || child.closed)
            return reject(
              new Error("The floating window closed before it was ready"),
            );
          try {
            if (child.document.body?.dataset.oxbitPanelShell === "true")
              return resolve();
          } catch {
            /* wait for the same-origin navigation */
          }
          if (Date.now() >= deadline)
            return reject(
              new Error("The floating window did not become ready"),
            );
          setTimeout(check, 25);
        };
        check();
      });
      const syncStyles = () => {
        child.document.head
          .querySelectorAll("[data-panel-style]")
          .forEach((el) => el.remove());
        for (const source of document.head.querySelectorAll(
          'style, link[rel="stylesheet"]',
        )) {
          const copy = source.cloneNode(true) as HTMLElement;
          copy.setAttribute("data-panel-style", "");
          if (copy.tagName === "LINK")
            (copy as HTMLLinkElement).href = (source as HTMLLinkElement).href;
          child.document.head.append(copy);
        }
      };
      syncStyles();
      const observer = new MutationObserver(syncStyles);
      observer.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      const closed = () => {
        if (!this.stopped) this.returnWindow(id);
      };
      child.addEventListener("pagehide", closed);
      // Existing shortcuts are owned by the workspace. Text input and local handlers get first refusal.
      const keyboard = (event: KeyboardEvent) => {
        if (
          event.defaultPrevented ||
          ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w")
        )
          return;
        if (!(
          event.ctrlKey ||
          event.metaKey ||
          event.key === "Escape" ||
          event.key.startsWith("F")
        ))
          return;
        const forwarded = new KeyboardEvent("keydown", {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          bubbles: true,
          cancelable: true,
        });
        // Preserve the actual target for focus-sensitive keybinding resolution.
        Object.defineProperty(forwarded, "target", { value: event.target });
        window.dispatchEvent(forwarded);
        if (forwarded.defaultPrevented) event.preventDefault();
      };
      const focused = () => this.activateOwner?.();
      child.addEventListener("focus", focused);
      child.addEventListener("keydown", keyboard);
      this.cleanups.set(id, () => {
        observer.disconnect();
        child.removeEventListener("pagehide", closed);
        child.removeEventListener("keydown", keyboard);
        child.removeEventListener("focus", focused);
      });
      this.windows.set(id, child);
      return child;
    } catch (error) {
      this.close(id, child);
      throw error;
    } finally {
      this.pending.delete(id);
    }
  }
  async detach(panel: string) {
    const source = panelLocation(this.workbench.state.panelLayout, panel);
    if (!source) return;
    const id = "panel-" + crypto.randomUUID();
    const bounds = {
      x: window.screenX + 60,
      y: window.screenY + 60,
      width: 640,
      height: 540,
    };
    try {
      await this.open(id, bounds);
      if (this.stopped) return;
      this.workbench.set({
        panelLayout: detachPanel(
          this.workbench.state.panelLayout,
          panel,
          id,
          bounds,
        ),
      });
      this.windows.get(id)?.focus();
    } catch (error) {
      this.workbench.notify(String(error), "error");
    }
  }
  focusOrRestore(id: string) {
    const child = this.windows.get(id);
    if (child && !child.closed) {
      child.focus();
      return;
    }
    const saved = this.workbench.state.panelLayout.floating.find(
      (f) => f.id === id,
    );
    if (saved)
      void this.open(id, saved.bounds)
        .then(() => {
          if (!this.stopped) this.workbench.touch();
        })
        .catch((error) => this.workbench.notify(String(error), "warning"));
  }
  restoreAll = () => {
    // Open synchronously from one user gesture, then complete independent ready handshakes.
    for (const saved of this.workbench.state.panelLayout.floating)
      if (!this.has(saved.id)) this.focusOrRestore(saved.id);
  };
  returnWindow(id: string) {
    const saved = this.workbench.state.panelLayout.floating.find(
      (f) => f.id === id,
    );
    if (!saved) return;
    let layout = this.workbench.state.panelLayout;
    for (const panel of panelGroups(saved.root).flatMap((g) => g.panels))
      layout = redockPanel(layout, panel);
    this.workbench.set({ panelLayout: layout });
  }
  private reconcile() {
    if (this.stopped) return;
    const layout = this.workbench.state.panelLayout;
    for (const [id, child] of this.windows) {
      if (!layout.floating.some((f) => f.id === id)) {
        this.cleanups.get(id)?.();
        this.cleanups.delete(id);
        this.windows.delete(id);
        this.close(id, child);
      } else if (child.closed) {
        this.returnWindow(id);
        return;
      }
    }
    let changed = false;
    const next = structuredClone(layout);
    for (const floating of next.floating) {
      const child = this.windows.get(floating.id);
      if (!child || child.closed) continue;
      const bounds = {
        x: child.screenX,
        y: child.screenY,
        width: child.innerWidth,
        height: child.innerHeight,
      };
      if (
        bounds.width > 0 &&
        bounds.height > 0 &&
        JSON.stringify(bounds) !== JSON.stringify(floating.bounds)
      ) {
        floating.bounds = bounds;
        changed = true;
      }
    }
    if (changed) this.workbench.set({ panelLayout: next });
  }
  dispose = () => {
    this.stopped = true;
    this.unsubscribe?.();
    clearInterval(this.interval);
    if (typeof window !== "undefined") {
      window.removeEventListener("unload", this.dispose);
      window.removeEventListener("pagehide", this.dispose);
    }
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
    for (const [id, child] of [...this.windows, ...this.pending])
      this.close(id, child);
    this.windows.clear();
    this.pending.clear();
  };
}
