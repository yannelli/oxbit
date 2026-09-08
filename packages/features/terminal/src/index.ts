import { currentTheme, themeTypography } from "@oxbit/workbench";
import { terminalTheme, terminalSearch, fontFamily } from "@oxbit/themes";
import { Icon, IconButton, translate as tr } from "@oxbit/ui";
import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import type { Extension, FeatureOptions } from "@oxbit/sdk";
import { loadOptionalAddons } from "./addons.js";
type Chunk = { seq: number; data: string };
type Session = {
  id: string;
  name: string;
  state: string;
  seq: number;
  rendered: number;
  history: Chunk[];
  bytes: number;
  pending: Chunk[];
  replaying: boolean;
  truncated: boolean;
  exitCode?: number;
  terminal?: Terminal;
  search?: SearchAddon;
  fit?: FitAddon;
  revealSearch?: () => void;
};
export function createFeature(o: FeatureOptions): Extension {
  const sessions = new Map<string, Session>(),
    listeners = new Set<() => void>(),
    early = new Map<string, Chunk[]>();
  const emittedStates = new Map<string,string>();
  let active: string | undefined,
    split = false,
    splitIds: string[] = [],
    disposed = false;
  const changed = () => {
    o.kernel.context.set("terminal", sessions.size > 0);
    for (const session of sessions.values()) if (emittedStates.get(session.id) !== session.state) {emittedStates.set(session.id,session.state);o.kernel.events.emit("terminal.change",{id:session.id,state:session.state});}
    for (const id of emittedStates.keys()) if (!sessions.has(id)) {emittedStates.delete(id);o.kernel.events.emit("terminal.change",{id,state:"closed"});}
    for (const listener of listeners) listener();
  };
  const request = <T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    if (!o.runtime?.connected)
      throw new Error(
        "Connect to a trusted runtime workspace to use terminals",
      );
    return o.runtime.request<T>(method, params);
  };
  const ack = (session: Session, seq: number) => {
    if (o.runtime?.connected)
      void request("terminal.ack", { id: session.id, seq }).catch(() => {});
  };
  const renderChunk = (session: Session, chunk: Chunk) => {
    if (!session.terminal || chunk.seq <= session.rendered) return;
    session.rendered = chunk.seq;
    session.terminal.write(chunk.data, () => ack(session, chunk.seq));
  };
  const receive = (session: Session, chunk: Chunk) => {
    if (chunk.seq <= session.seq) return;
    session.seq = chunk.seq;
    session.history.push(chunk);
    session.bytes += chunk.data.length;
    while (session.bytes > 1048576 && session.history.length > 1) {
      session.bytes -= session.history.shift()!.data.length;
      session.truncated = true;
    }
    if (session.terminal) renderChunk(session, chunk);
    else ack(session, chunk.seq);
  };
  const add = (record: any) => {
    for (const [id, item] of sessions) if (sessions.size >= 64 && item.exitCode !== undefined && id !== active) sessions.delete(id);
    let session = sessions.get(record.id);
    if (!session) {
      session = {
        id: record.id,
        name: record.name ?? `Terminal ${sessions.size + 1}`,
        state:
          record.exitCode === undefined
            ? "running"
            : `terminated (${record.exitCode})`,
        seq: 0,
        rendered: 0,
        history: [],
        bytes: 0,
        pending: [],
        replaying: false,
        truncated: false,
        exitCode: record.exitCode,
      };
      sessions.set(session.id, session);
      for (const chunk of (early.get(session.id) ?? []).sort(
        (a, b) => a.seq - b.seq,
      ))
        receive(session, chunk);
      early.delete(session.id);
    }
    return session;
  };
  const attach = async (session: Session) => {
    if (session.replaying) return;
    session.replaying = true;
    try {
      const replay = await request("terminal.attach", {
        id: session.id,
        afterSeq: session.seq,
      });
      session.truncated ||= replay.truncated === true;
      session.exitCode = replay.exitCode;
      session.state =
        replay.exitCode === undefined
          ? "running"
          : `terminated (${replay.exitCode})`;
      for (const chunk of [...replay.chunks, ...session.pending].sort(
        (a, b) => a.seq - b.seq,
      ))
        receive(session, chunk);
      session.pending = [];
      if (replay.truncated)
        o.workbench.notify(
          `${session.name}: older terminal output is no longer available`,
        );
      if (replay.seq === session.seq) ack(session, session.seq);
    } catch (error) {
      session.state = o.runtime?.connected
        ? "terminated (runtime session unavailable)"
        : "disconnected";
      if (o.runtime?.connected)
        session.terminal?.writeln(`\r\n${String(error)}`);
    } finally {
      session.replaying = false;
      changed();
    }
  };
  const restore = async () => {
    try {
      const records = await request<any[]>("terminal.list");
      if (disposed) return;
      const ids = new Set(records.map((record) => record.id));
      for (const session of sessions.values())
        if (!ids.has(session.id)) {
          session.state = "terminated (runtime restarted)";
          session.exitCode ??= -1;
        }
      for (const record of records) {
        const session = add(record);
        await attach(session);
      }
      changed();
    } catch {
      /* Connection and trust states are shown by the workbench. */
    }
  };
  const create = async () => {
    const result = await request("terminal.create", { cols: 100, rows: 24 });
    const session = add(result);
    active = session.id;
    changed();
    o.workbench.openPanel("terminal");
    return session;
  };
  async function kill(id: string) {
    const session = sessions.get(id);
    if (!session) return;
    if (
      session.exitCode === undefined &&
      o.kernel.configuration.get("terminal.confirmOnKill") !== false &&
      (await o.workbench.ask(
        tr("Terminate terminal?"),
        tr("Stop {0} and its running process?", { "0": session.name }),
        ["Terminate", "Cancel"],
        true,
      )) !== "Terminate"
    )
      return;
    if (session.exitCode === undefined) await request("terminal.kill", { id });
    sessions.delete(id);
    if (splitIds.includes(id)) split = false;
    if (active === id) active = sessions.keys().next().value;
    changed();
  }
  const select = (id: string) => {
    active = id;
    changed();
  };
  const selected = () =>
    sessions.get(active ?? "") ?? sessions.values().next().value;
  const theme = () => terminalTheme(currentTheme(o.kernel));
  const fontOptions = () => { const font=themeTypography(o.kernel,'terminal');return {fontFamily:fontFamily(font),fontSize:font.size,fontWeight:font.weight as 400,fontWeightBold:Math.min(900,font.weight+300) as 700,lineHeight:font.lineHeight,letterSpacing:font.letterSpacing}; };
  function TerminalPane({ session }: { session: Session }) {
    const ref = useRef<HTMLDivElement>(null),
      searchRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [searching, setSearching] = useState(false);
    useEffect(() => { if (searching) searchRef.current?.focus(); }, [searching]);
    useEffect(() => {
      session.revealSearch = () => { setSearching(true); searchRef.current?.focus(); };
      return () => { session.revealSearch = undefined; };
    }, [session]);
    useEffect(() => {
      if (!ref.current) return;
      const terminal = new Terminal({
        ...fontOptions(),
        scrollback:
          o.kernel.configuration.get<number>("terminal.scrollback") ?? 5000,
        allowProposedApi: true,
        theme: theme(),
        convertEol: false,
      });
      const fit = new FitAddon(),
        finder = new SearchAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(finder);
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = "11";
      terminal.loadAddon(
        new WebLinksAddon((_event, uri) => {
          if (/^https?:\/\//i.test(uri))
            window.open(uri, "_blank", "noopener,noreferrer");
        }),
      );
      terminal.loadAddon(new ClipboardAddon());
      terminal.open(ref.current);
      session.terminal = terminal;
      session.search = finder;
      session.fit = fit;
      session.rendered = 0;
      let mounted = true;
      const optionalAddons = loadOptionalAddons(terminal, () => mounted);
      optionalAddons.setLigatures(themeTypography(o.kernel,"terminal").ligatures);
      if (session.truncated)
        terminal.writeln("[Earlier terminal output is no longer available]");
      for (const chunk of session.history) renderChunk(session, chunk);
      const resize = () => {
        try {
          fit.fit();
          if (session.exitCode === undefined && o.runtime?.connected)
            void request("terminal.resize", {
              id: session.id,
              cols: terminal.cols,
              rows: terminal.rows,
            }).catch(() => {});
        } catch {
          /* A hidden pane has no measurable dimensions. */
        }
      };
      const observer = new ResizeObserver(resize);
      observer.observe(ref.current);
      resize();
      const data = terminal.onData((input) => {
        if (session.exitCode !== undefined) return;
        void request("terminal.input", { id: session.id, data: input }).catch(
          (error) => o.workbench.notify(String(error), "error"),
        );
      });
      const updateTheme = () => {
        Object.assign(terminal.options, fontOptions());
        optionalAddons.setLigatures(themeTypography(o.kernel,"terminal").ligatures);
        terminal.options.scrollback = o.kernel.configuration.get<number>("terminal.scrollback") ?? 5000;
        terminal.options.theme = theme(); resize();
      };
      const configuration = o.kernel.configuration.subscribe(updateTheme);
      const contributions = o.kernel.contributions.subscribe(updateTheme);
      document.fonts?.addEventListener('loadingdone', resize);
      document.addEventListener('oxbit-fonts-loaded', resize);
      return () => {
        mounted = false;
        configuration();
        contributions();
        document.fonts?.removeEventListener("loadingdone", resize);
        document.removeEventListener("oxbit-fonts-loaded", resize);
        observer.disconnect();
        data.dispose();
        terminal.dispose();
        if (session.terminal === terminal) {
          session.terminal = undefined;
          session.search = undefined;
          session.fit = undefined;
          session.rendered = 0;
        }
      };
    }, [session]);
    return React.createElement(
      "div",
      {
        className: "terminal-session",
        style: {
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          flex: 1,
          height: "100%",
        },
      },
      React.createElement(
        "div",
        {
          className: "terminal-pane-toolbar",
        },
        React.createElement("span", { className: "terminal-pane-name", title: session.name }, session.name),
        React.createElement("span", { className: "terminal-state", "data-state": session.state }, session.state),
        React.createElement(IconButton, { icon: "search", label: tr("Search terminal"), "aria-pressed": searching,
          onClick: () => { setSearching(!searching); if (searching) session.search?.clearDecorations(); } }),
        searching &&
        React.createElement("input", {
          ref: searchRef,
          "aria-label": tr("Search terminal"),
          placeholder: tr("Find"),
          value: query,
          onChange: (event: any) => {
            setQuery(event.target.value);
            session.search?.findNext(event.target.value, {decorations:terminalSearch(currentTheme(o.kernel))});
          },
          onKeyDown: (event: any) => {
            if (event.key === "Enter") {
              if (event.shiftKey) session.search?.findPrevious(query, {decorations:terminalSearch(currentTheme(o.kernel))});
              else session.search?.findNext(query, {decorations:terminalSearch(currentTheme(o.kernel))});
            }
            if (event.key === "Escape") {
              setQuery("");
              setSearching(false);
              session.search?.clearDecorations();
              session.terminal?.focus();
            }
          },
        }),
        React.createElement(
          IconButton,
          { icon: "pencil", label: tr("Rename"),
            onClick: () => {
              void o.workbench
                .prompt(tr("Terminal name"), session.name)
                .then((name) => {
                  if (name?.trim()) {
                    session.name = name.trim();
                    changed();
                  }
                });
            },
          },
        ),
        React.createElement(
          IconButton,
          { icon: "trash", label: session.exitCode === undefined ? tr("Terminate") : tr("Close"),
            onClick: () => {
              void kill(session.id).catch((error) =>
                o.workbench.notify(String(error), "error"),
              );
            },
          },
        ),
      ),
      session.truncated &&
        React.createElement(
          "span",
          { role: "status", style: { fontSize: "var(--font-small-font-size)", padding: "0 10px" } },
          tr("Earlier terminal output is no longer available"),
        ),
      React.createElement("div", {
        ref,
        style: { flex: 1, minHeight: 0, padding: 4 },
        onFocus: () => select(session.id),
      }),
    );
  }
  function Panel() {
    const [, render] = useState(0);
    useEffect(() => {
      const listener = () => render((value) => value + 1);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);
    const list = [...sessions.values()],
      current = selected();
    return React.createElement(
      "div",
      {
        className: "terminal-panel",
        onContextMenu:(event:React.MouseEvent)=>{event.preventDefault();o.workbench.showContextMenu("terminal",event.clientX,event.clientY);},
        style: { height: "100%", display: "flex", flexDirection: "column" },
      },
      React.createElement("div", { className: "terminal-tabs-toolbar" },
        React.createElement("div", { role: "tablist", "aria-label": tr("Terminal sessions"), className: "terminal-tabs" },
          ...list.map((session, index) => React.createElement("button", {
            key: session.id, id: "terminal-tab-" + session.id, role: "tab", className: "terminal-tab",
            "aria-selected": session === current, "aria-controls": "terminal-panes", title: session.name,
            tabIndex: session === current ? 0 : -1,
            onClick: () => { split = false; select(session.id); },
            onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
              split = false; select(list[next].id);
              document.getElementById("terminal-tab-" + list[next].id)?.focus();
            },
          }, React.createElement(Icon, { name: "terminal", size: 14 }),
            React.createElement("span", null, session.name),
            React.createElement("span", { className: "terminal-state-dot", "data-state": session.state, title: session.state })))),
        React.createElement("div", { className: "terminal-actions" },
          React.createElement("button", { className: "button terminal-new", disabled: !o.runtime?.connected,
            onClick: () => { void o.kernel.commands.execute("terminal.new").catch(error => o.workbench.notify(String(error), "error")); } },
            React.createElement(Icon, { name: "plus", size: 14 }), tr("New terminal")),
          React.createElement(IconButton, { icon: "splitR", label: tr("Split terminal"), disabled: !current || !o.runtime?.connected,
            onClick: () => { void o.kernel.commands.execute("terminal.split").catch(error => o.workbench.notify(String(error), "error")); } }),
          split && React.createElement(IconButton, { icon: "layoutSide", label: tr("Show single terminal"), onClick: () => { split = false; changed(); } }))),
      !current &&
        React.createElement(
          "p",
          { style: { padding: 16 } },
          o.runtime?.connected
            ? tr("Create a terminal to run workspace commands.")
            : tr("Connect to a runtime workspace to open a terminal."),
        ),
      React.createElement(
        "div",
        { id: "terminal-panes", role: "tabpanel", "aria-labelledby": current ? "terminal-tab-" + current.id : undefined, className: "terminal-panes" },
        ...(split ? splitIds.map(id => sessions.get(id)).filter((session): session is Session => !!session) : current ? [current] : []).map((session) =>
          React.createElement(TerminalPane, { key: session.id, session }),
        ),
      ),
    );
  }
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.terminal",
      name: "Terminal",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["terminal"],
    },
    activate(ctx) {
      disposed = false;
      ctx.own(ctx.services.register("terminal", { create, sessions, kill }));
      ctx.own(
        ctx.contributions.register({
          id: "terminal",
          kind: "panel",
          title: "Terminal",
          component: Panel,
          order: 10,
        }),
      );
      const commands: [string, string, () => unknown][] = [
        ["terminal.new", "New Terminal", async () => { const session = await create(); split = false; changed(); return session; }],
        [
          "terminal.toggle",
          "Toggle Terminal",
          () => o.workbench.togglePanel("terminal"),
        ],
        [
          "terminal.split",
          "Split Terminal",
          async () => {
            const previous = selected();
            const session = await create();
            splitIds = previous ? [previous.id, session.id] : [session.id];
            split = !!previous;
            changed();
          },
        ],
        [
          "terminal.kill",
          "Kill Active Terminal",
          () => {
            const session = selected();
            if (session) return kill(session.id);
          },
        ],
        [
          "terminal.clear",
          "Clear Terminal",
          () => {
            const session = selected();
            if (session) {
              session.terminal?.clear();
              session.history = [];
              session.bytes = 0;
              session.truncated = false;
            }
          },
        ],
        [
          "terminal.search",
          "Find in Terminal",
          () => {
            o.workbench.openPanel("terminal");
            requestAnimationFrame(() => selected()?.revealSearch?.());
          },
        ],
      ];
      for (const [id, title, run] of commands)
        ctx.own(ctx.commands.register({ id, title, run }));
      if (o.runtime) {
        ctx.subscribe(
          o.runtime.subscribe("terminal.data", (params) => {
            const chunk = { seq: params.seq, data: params.data },
              session = sessions.get(params.id);
            if (session) {
              if (session.replaying) session.pending.push(chunk);
              else receive(session, chunk);
            } else {
              const chunks = early.get(params.id) ?? [];
              chunks.push(chunk);
              while (
                chunks.reduce((size, c) => size + c.data.length, 0) > 1048576
              )
                chunks.shift();
              early.set(params.id, chunks);
            }
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("terminal.exit", (params) => {
            const session = sessions.get(params.id);
            if (session) {
              session.exitCode = params.exitCode;
              session.state = `terminated (${params.exitCode})`;
              changed();
            }
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("connection.change", (params) => {
            if (params.state === "connected") void restore();
            else {
              for (const session of sessions.values())
                if (session.exitCode === undefined)
                  session.state = "disconnected";
              changed();
            }
          }),
        );
        ctx.subscribe(o.runtime.subscribe("runtime.terminated", () => {
          for (const session of sessions.values()) if (session.exitCode === undefined) {
            session.exitCode = -1; session.state = "terminated (runtime stopped)";
          }
          changed();
        }));
        void restore();
      }
      ctx.subscribe(() => {
        disposed = true;
        for (const session of sessions.values()) session.terminal?.dispose();
        sessions.clear();
        changed();
        early.clear();
        listeners.clear();
      });
    },
  };
}
