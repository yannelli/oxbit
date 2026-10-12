import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { accept, commandItems, commandToken, fileItems, fileToken, rank, type Command, type Completion, type CompletionItem } from "./complete.js";
import type { TuiConnection } from "./connection.js";
import { draftOf, emptyDraft, insert, type Draft } from "./editor.js";
import { isPanel, PanelController } from "./panel-controller.js";
import { message, type Overlay, type ViewState } from "./session-controller.js";
import { emptyTranscript, expandable } from "./transcript.js";
import { lastReply, osc52, toMarkdown } from "./transcript-export.js";

export type { Overlay, ViewState } from "./session-controller.js";
export interface HistoryStore { load(): string[]; save(entry: string): void }
/** Terminal writes that bypass Ink: escape sequences, and clearing the screen before a redraw. */
export interface Screen { write(sequence: string): void; clear(): void }
export interface ControllerOptions { cwd: string; history?: HistoryStore; screen?: Screen }
/** Fullscreen transcript size in rows, and the id of its first rendered item. */
export interface Viewport { total: number; height: number; first: number }

export const LOCAL_COMMANDS: Command[] = [
  { name: "model", description: "Choose the model and reasoning effort", hint: "[model]" },
  { name: "new", description: "Start a new session" },
  { name: "clear", description: "Clear the conversation and the screen, and start a new session" },
  { name: "resume", description: "Resume a saved session" },
  { name: "config", description: "Settings: permission mode, auto-compact, hooks and MCP trust" },
  { name: "skills", description: "Turn skills on or off, or start a prompt with one" },
  { name: "hooks", description: "Turn hook sources on or off" },
  { name: "mcp", description: "Add, remove, trust and sign in to MCP servers" },
  { name: "instructions", description: "Choose which AGENTS.md and CLAUDE.md files load" },
  { name: "providers", description: "Sign in to providers and set API keys" },
  { name: "copy", description: "Copy the last agent reply to the clipboard" },
  { name: "export", description: "Write the conversation to a Markdown file", hint: "[path]" },
  { name: "init", description: "Ask the agent to create or update AGENTS.md for this repository" },
  { name: "help", description: "Show keys and commands" },
  { name: "exit", description: "Quit" },
];

export const INIT_PROMPT = "Inspect this repository and create or update AGENTS.md at its root. Document the build, test and lint commands, "
  + "the project layout, and the coding conventions an agent needs to work here. Keep existing content that is still accurate.";

const picker = (overlay?: Overlay) => overlay?.kind === "models" || overlay?.kind === "sessions" ? overlay : undefined;

/** Rows of the model or session picker after its filter. */
export function overlayItems(state: ViewState): CompletionItem[] {
  const overlay = state.overlay;
  if (overlay?.kind === "models")
    return rank(state.status.models, (model) => `${model.name} ${model.value}`, overlay.filter, 200)
      .map((model) => ({ value: model.value, label: model.name, ...model.name !== model.value ? { detail: model.value } : {} }));
  if (overlay?.kind === "sessions")
    return rank(overlay.sessions, (session) => session.title ?? session.sessionId, overlay.filter, 200)
      .map((session) => ({ value: session.sessionId, label: session.title || session.sessionId, detail: session.updatedAt?.slice(0, 16).replace("T", " ") }));
  return [];
}

/** Adds the input editor to PanelController: slash and @file completion, history, local commands and Ctrl+C. */
export class Controller extends PanelController {
  private history: string[];
  private historyIndex = -1;
  private stash: Draft = emptyDraft;
  private dismissed?: string;
  private fileTimer?: ReturnType<typeof setTimeout>;
  private files = new Map<string, string[]>();
  private lastInterrupt = 0;
  /** Set by the fullscreen transcript view; reads the current layout. */
  viewport?: () => Viewport;

  constructor(connection: TuiConnection, private options: ControllerOptions) {
    super(connection, options.cwd);
    this.history = options.history?.load() ?? [];
  }

  /** Server commands, then local ones; a panel command shows the server command's hint, since arguments go to the server. */
  override commands(): Command[] {
    const server = this.state.status.commands;
    const local = LOCAL_COMMANDS.filter((command) => command.name === "resume" ? this.connection.listSessions : !isPanel(command.name) || this.connection.settings)
      .map((command) => {
        const hint = isPanel(command.name) ? server.find((item) => item.name === command.name)?.hint : undefined;
        return hint ? { ...command, hint: hint.startsWith("[") ? hint : `[${hint}]` } : command;
      });
    return [...server.filter((command) => !local.some((item) => item.name === command.name)), ...local];
  }

  submit() {
    const text = this.state.draft.text.replace(/\s+$/, "");
    if (!text.trim()) return;
    if (this.history.at(-1) !== text) {
      this.history.push(text);
      this.options.history?.save(text);
    }
    this.historyIndex = -1;
    this.dismissed = undefined;
    this.set({ draft: emptyDraft, completion: undefined });
    if (text.startsWith("/") && this.local(text)) return;
    this.prompt(text);
  }

  private prompt(text: string) {
    if (this.state.running) this.set({ queued: [...this.state.queued, text] });
    else void this.send(text);
  }

  private local(text: string) {
    const [, name, rest] = /^\/(\S+)\s*([\s\S]*)$/.exec(text) ?? [];
    const args = rest?.trim() ?? "";
    switch (name) {
      case "model": if (args) void this.chooseModel(args); else this.openModels(); return true;
      case "new": void this.open(undefined, "New session"); return true;
      case "clear": void this.clear(); return true;
      case "copy": this.copyReply(); return true;
      case "export": void this.exportTo(args); return true;
      case "init": this.prompt(INIT_PROMPT); return true;
      case "resume":
        if (!this.connection.listSessions && !args) return false;
        if (args) void this.open(args, "Resumed session"); else void this.openSessions();
        return true;
      case "config": case "skills": case "hooks": case "mcp": case "instructions": case "providers": {
        const use = name === "providers" && this.connection.settings ? /^use\s+(\S+)$/i.exec(args) : null;
        if (use) {
          void this.useProvider(use[1]);
          return true;
        }
        if (!this.connection.settings || args) return false;
        this.openPanel(name);
        return true;
      }
      case "help": this.set({ overlay: { kind: "help" } }); return true;
      case "exit": case "quit": this.exit(); return true;
    }
    return false;
  }

  protected override commandsChanged() {
    if (commandToken(this.state.draft)) this.set({ completion: this.completionFor(this.state.draft) }, true);
  }

  /** Sets the draft and recomputes slash and @file completion. */
  setDraft(draft: Draft) {
    this.set({ draft, completion: this.completionFor(draft) });
  }
  paste(text: string) {
    const clean = text.replace(/\r\n?/g, "\n");
    const overlay = this.state.overlay;
    if (picker(overlay)) return this.filter(picker(overlay)!.filter + clean.replace(/\n/g, " "));
    if (overlay?.kind === "panel") return this.pastePanelInput(clean);
    if (overlay) return;
    this.setDraft(insert(this.state.draft, clean));
  }
  private completionFor(draft: Draft): Completion | undefined {
    if (this.dismissed === draft.text) return undefined;
    this.dismissed = undefined;
    const command = commandToken(draft);
    if (command) {
      const items = commandItems(this.commands(), command.query);
      return items.length ? { kind: "command", items, index: 0, ...command } : undefined;
    }
    const file = fileToken(draft);
    if (!file || !this.connection.listFiles) return undefined;
    const known = this.files.get(file.query);
    if (!known) this.lookup(file.query);
    const items = fileItems(known ?? [...new Set([...this.files.values()].flat())], file.query);
    return items.length ? { kind: "file", items, index: 0, ...file } : undefined;
  }
  private lookup(query: string) {
    clearTimeout(this.fileTimer);
    this.fileTimer = setTimeout(() => {
      void this.connection.listFiles!(query, this.options.cwd).then((paths) => {
        this.files.set(query, paths);
        if (fileToken(this.state.draft)?.query === query) this.set({ completion: this.completionFor(this.state.draft) });
      }, () => {});
    }, 50);
  }
  moveCompletion(step: number) {
    const completion = this.state.completion;
    if (completion) this.set({ completion: { ...completion, index: (completion.index + step + completion.items.length) % completion.items.length } });
  }
  dismissCompletion() {
    this.dismissed = this.state.draft.text;
    this.set({ completion: undefined });
  }
  /** Inserts the selected item; with `run`, a command that takes no arguments is sent at once. */
  acceptCompletion(run: boolean) {
    const completion = this.state.completion;
    if (!completion) return;
    const item = completion.items[completion.index];
    const command = completion.kind === "command" ? this.commands().find((entry) => `/${entry.name}` === item.value) : undefined;
    if (run && command && (!command.hint || (isPanel(command.name) && this.connection.settings))) {
      this.set({ draft: draftOf(item.value) });
      return this.submit();
    }
    this.setDraft(accept(this.state.draft, completion, item));
  }

  /** Walks prompt history; false when there is nothing to recall, so the caller can move the cursor instead. */
  recall(step: -1 | 1) {
    if (!this.history.length || (this.historyIndex < 0 && step > 0)) return false;
    if (this.historyIndex < 0) this.stash = this.state.draft;
    const index = this.historyIndex < 0 ? this.history.length - 1 : this.historyIndex + step;
    if (index < 0) return true;
    this.historyIndex = index >= this.history.length ? -1 : index;
    const draft = this.historyIndex < 0 ? this.stash : draftOf(this.history[index]);
    // A recalled "/command" would open the menu and take over the arrow keys.
    this.dismissed = draft.text;
    this.setDraft(draft);
    return true;
  }

  filter(text: string) {
    const overlay = picker(this.state.overlay);
    if (overlay) this.set({ overlay: { ...overlay, filter: text, index: 0 } });
  }
  moveOverlay(step: number) {
    const overlay = picker(this.state.overlay);
    const count = overlayItems(this.state).length;
    if (overlay && count) this.set({ overlay: { ...overlay, index: (overlay.index + step + count) % count } });
  }
  confirmOverlay() {
    const overlay = picker(this.state.overlay);
    const item = overlay ? overlayItems(this.state)[overlay.index] : undefined;
    this.set({ overlay: undefined });
    if (item && overlay?.kind === "models") void this.chooseModel(item.value);
    if (item && overlay?.kind === "sessions") void this.open(item.value, `Resumed ${item.label}`);
  }

  /** Ctrl+O: shows the latest thought, tool output or diff in full; `step` moves to an earlier or later one. */
  showDetails(step = 0) {
    const { transcript, overlay } = this.state;
    const items = [...transcript.flushed, ...transcript.live].filter(expandable);
    if (!items.length) return this.flash("Nothing to expand yet");
    const at = overlay?.kind === "details" ? items.findIndex((item) => item.id === overlay.id) : items.length;
    const next = items[Math.min(items.length - 1, Math.max(0, at + step - (overlay?.kind === "details" ? 0 : 1)))];
    this.set({ overlay: { kind: "details", id: next.id } });
  }

  /** /clear: empties the transcript, queue and screen, then opens a new session. */
  async clear() {
    if (this.state.running) return this.notice("Wait for the agent to finish, or press Esc to stop it", "warn");
    this.options.screen?.clear();
    this.set({ transcript: emptyTranscript(), queued: [], overlay: undefined, completion: undefined, scroll: undefined, generation: this.state.generation + 1 });
    await this.open();
  }

  /** Ctrl+L: clears the terminal and draws the current frame again at the newest output. */
  redraw() {
    this.options.screen?.clear();
    this.set({ scroll: undefined });
  }

  copyReply() {
    const { flushed, live } = this.state.transcript;
    const reply = lastReply([...flushed, ...live]);
    if (!reply) return this.flash("There is no agent reply to copy yet");
    this.options.screen?.write(osc52(reply));
    this.flash("Copied the last reply to the clipboard");
  }

  /** Writes the conversation as Markdown; an existing file is left alone. */
  async exportTo(path: string) {
    const { transcript: { flushed, live }, status: { sessionId, title } } = this.state;
    const target = resolve(this.options.cwd, path.replace(/^~(?=$|\/)/, homedir()) || `oxbit-session-${sessionId?.slice(0, 8) ?? "new"}.md`);
    try {
      await writeFile(target, toMarkdown([...flushed, ...live], title, sessionId), { flag: "wx" });
      this.notice(`Exported the conversation to ${target}`);
    } catch (error) {
      this.notice((error as NodeJS.ErrnoException).code === "EEXIST" ? `${target} already exists. Choose another path.` : message(error), "error");
    }
  }

  /** PageUp and PageDown in fullscreen; reaching the bottom follows the newest output again. */
  scrollBy(pages: number) {
    const viewport = this.viewport?.();
    if (!viewport) return;
    const { total, height, first } = viewport;
    const max = Math.max(0, total - height);
    const scroll = this.state.scroll;
    const top = Math.min(max, Math.max(0, Math.min(scroll?.top ?? max, max) + pages * Math.max(1, height - 2)));
    this.set({ scroll: top >= max ? undefined : { top, from: scroll?.from ?? first } });
  }

  scrollEnd() {
    if (this.state.scroll) this.set({ scroll: undefined });
  }

  /** Ctrl+C: stop the turn, close or clear, and exit on a second press within two seconds. */
  interrupt() {
    const now = Date.now();
    if (now - this.lastInterrupt < 2000) return this.exit();
    this.lastInterrupt = now;
    if (this.state.running || this.state.permission) this.cancel();
    else if (this.state.overlay) this.closeOverlay();
    else if (this.state.draft.text) this.setDraft(emptyDraft);
    this.flash("Press Ctrl+C again to exit");
  }

  override dispose() {
    super.dispose();
    clearTimeout(this.fileTimer);
  }
}
