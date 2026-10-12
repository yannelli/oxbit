import type { Panel, PanelAction, PanelChange, PanelContext, PanelId, PanelRow, SettingsManager } from "./connection.js";
import { draftOf, insert, type Draft } from "./editor.js";
import { message, SessionController, type PanelOverlay } from "./session-controller.js";

export const PANELS: readonly string[] = ["config", "skills", "hooks", "mcp", "instructions", "providers"] satisfies PanelId[];
export const isPanel = (name: string): name is PanelId => PANELS.includes(name);

/** Rows with each section's rows together, sections in the order they first appear. */
export function panelRows(panel?: Panel): PanelRow[] {
  const rows = panel?.rows ?? [];
  return [...new Set(rows.map((row) => row.section))].flatMap((section) => rows.filter((row) => row.section === section));
}

type Call<T> = (settings: SettingsManager, id: PanelId, context: PanelContext) => Promise<T>;

/** Adds the /config, /skills, /hooks, /mcp, /instructions and /providers panels to SessionController. */
export class PanelController extends SessionController {
  private panelAbort?: AbortController;

  private panelOverlay() {
    const overlay = this.state.overlay;
    return overlay?.kind === "panel" ? overlay : undefined;
  }
  private patchPanel(patch: Partial<PanelOverlay>) {
    const overlay = this.panelOverlay();
    if (overlay) this.set({ overlay: { ...overlay, ...patch } });
  }
  private selectedRow() {
    const overlay = this.panelOverlay();
    return overlay && panelRows(overlay.panel)[overlay.index];
  }

  openPanel(id: PanelId) {
    this.closeOverlay();
    this.set({ overlay: { kind: "panel", id, index: 0, loading: true } });
    void this.loadPanel();
  }
  /** Closes any overlay and cancels the panel request in flight. */
  closeOverlay() {
    this.panelAbort?.abort();
    this.panelAbort = undefined;
    if (this.state.overlay) this.set({ overlay: undefined });
  }

  /** Runs one SettingsManager call; undefined when it failed, was cancelled or another call replaced it. */
  private async call<T>(run: Call<T>): Promise<T | undefined> {
    const overlay = this.panelOverlay();
    const settings = this.connection.settings;
    if (!overlay || !settings) return undefined;
    this.panelAbort?.abort();
    const abort = this.panelAbort = new AbortController();
    const current = () => this.panelAbort === abort;
    const context: PanelContext = { cwd: this.cwd, sessionId: this.state.status.sessionId, signal: abort.signal,
      progress: (text) => current() && this.patchPanel({ progress: text }) };
    try {
      const result = await run(settings, overlay.id, context);
      return current() ? result : undefined;
    } catch (error) {
      if (current()) this.patchPanel({ error: message(error), loading: false, busy: false, progress: undefined });
      return undefined;
    } finally {
      if (current()) this.panelAbort = undefined;
    }
  }

  private async loadPanel() {
    const panel = await this.call((settings, id, context) => settings.panel(id, context));
    const overlay = this.panelOverlay();
    if (!panel || !overlay) return;
    const rows = panelRows(panel);
    const selected = rows.findIndex((row) => row.id === panelRows(overlay.panel)[overlay.index]?.id);
    const index = selected >= 0 ? selected : Math.min(overlay.index, Math.max(0, rows.length - 1));
    this.patchPanel({ panel, index, loading: false, busy: false, progress: undefined });
  }

  private async change(run: Call<PanelChange>) {
    const overlay = this.panelOverlay();
    if (!overlay?.panel || overlay.busy) return;
    this.patchPanel({ busy: true, progress: undefined, error: undefined, menu: undefined, input: undefined });
    const change = await this.call(run);
    if (!change) return;
    if (change.reloaded) await this.reload();
    if (change.mode) this.setMode(change.mode);
    if (change.draft !== undefined) {
      this.closeOverlay();
      this.set({ draft: draftOf(change.draft), completion: undefined });
    } else await this.loadPanel();
    if (change.message) this.flash(change.message);
  }

  movePanel(step: number) {
    const overlay = this.panelOverlay();
    const row = this.selectedRow();
    if (!overlay || overlay.busy) return;
    if (overlay.menu !== undefined && row?.actions) {
      const count = row.actions.length;
      return this.patchPanel({ menu: (overlay.menu + step + count) % count });
    }
    const count = panelRows(overlay.panel).length;
    if (count) this.patchPanel({ index: (overlay.index + step + count) % count });
  }

  togglePanelRow() {
    const row = this.selectedRow();
    if (row?.enabled !== undefined) void this.change((settings, id, context) => settings.toggle(id, row.id, !row.enabled, context));
  }

  cyclePanelChoice(step: 1 | -1) {
    const row = this.selectedRow();
    const options = row?.choice?.options ?? [];
    if (!row?.choice || !options.length) return;
    const at = options.findIndex((option) => option.value === row.choice!.value);
    const value = options[(at + step + options.length) % options.length].value;
    void this.change((settings, id, context) => settings.choose(id, row.id, value, context));
  }

  /** Enter: runs the row's only action, lists several, or runs the one picked from that list. */
  enterPanel() {
    const overlay = this.panelOverlay();
    const row = this.selectedRow();
    if (!overlay || !row || overlay.busy) return;
    const actions = row.actions ?? [];
    if (overlay.menu !== undefined) return this.startAction(row, actions[overlay.menu]);
    if (actions.length === 1) return this.startAction(row, actions[0]);
    if (actions.length) return this.patchPanel({ menu: 0 });
    if (row.enabled !== undefined) return this.togglePanelRow();
    this.cyclePanelChoice(1);
  }

  private startAction(row: PanelRow, action?: PanelAction) {
    if (!action) return;
    if (action.reloads && this.state.running) {
      this.patchPanel({ menu: undefined });
      return this.flash("Wait for the turn to finish");
    }
    const first = action.inputs?.[0];
    if (first) return this.patchPanel({ menu: undefined, input: { rowId: row.id, action, values: [], draft: draftOf(first.value ?? "") } });
    void this.change((settings, id, context) => settings.act(id, row.id, action.id, [], context));
  }

  editPanelInput(draft: Draft) {
    const input = this.panelOverlay()?.input;
    if (input) this.patchPanel({ input: { ...input, draft } });
  }
  pastePanelInput(text: string) {
    const input = this.panelOverlay()?.input;
    if (input) this.editPanelInput(insert(input.draft, text.replace(/\n+$/, "").replace(/\n/g, " ")));
  }

  /** Enter in the input field: asks the next input, or runs the action with every answer. */
  submitPanelInput() {
    const input = this.panelOverlay()?.input;
    if (!input) return;
    const values = [...input.values, input.draft.text];
    const next = input.action.inputs?.[values.length];
    if (next) return this.patchPanel({ input: { ...input, values, draft: draftOf(next.value ?? "") } });
    if (input.action.reloads && this.state.running) {
      this.patchPanel({ input: undefined });
      return this.flash("Wait for the turn to finish");
    }
    void this.change((settings, id, context) => settings.act(id, input.rowId, input.action.id, values, context));
  }

  /** Esc: cancels the running call, then leaves the input or action list, then closes the panel. */
  escapePanel() {
    const overlay = this.panelOverlay();
    if (overlay?.busy) {
      this.panelAbort?.abort();
      this.panelAbort = undefined;
      return this.patchPanel({ busy: false, progress: undefined });
    }
    if (overlay?.input || overlay?.menu !== undefined) return this.patchPanel({ input: undefined, menu: undefined });
    this.closeOverlay();
  }
}
