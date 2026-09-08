import { currentTheme } from "@oxbit/workbench";
import { Icon, translate as tr } from "@oxbit/ui";
import React, { useState, useEffect } from "react";
import * as Y from "yjs";
import {
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
} from "y-protocols/awareness";
import { REMOTE_ORIGIN } from "@oxbit/documents";
import type { Extension, FeatureOptions } from "@oxbit/sdk";
const encode = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};
const decode = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export class CollaborationService {
  private attached = new Map<
    string,
    { doc: any; dispose: () => void; pending: boolean; generation: number; synced: number }
  >();
  private offs: (() => void)[] = [];
  private chain = Promise.resolve();
  private resynchronizing?: Promise<void>;
  private disposed = false;
  private listeners = new Set<() => void>();
  following?: number;
  state = "disconnected";
  constructor(private o: FeatureOptions) {
    if (!o.runtime) return;
    this.state = o.runtime.connected ? "connected" : "disconnected";
    this.offs.push(
      o.kernel.events.on("document.open", ({ path }) => this.attach(path))
        .dispose,
      o.kernel.events.on("document.close", () => { for (const [path, item] of this.attached) if (!o.documents.get(path)) { item.dispose(); this.attached.delete(path); (o.filesystem as any).shared?.delete(path); if (o.runtime?.connected) void o.runtime.request("collab.leave", {path}).catch(() => {}); } }).dispose,
      o.runtime.subscribe("collab.update", (p) => {
        const item = this.attached.get(p.path);
        if (item) {
          Y.applyUpdate(item.doc.ydoc, decode(p.update), REMOTE_ORIGIN);
          this.changed();
        }
      }),
      o.runtime.subscribe("collab.awareness", (p) => {
        const item = this.attached.get(p.path);
        if (item) {
          applyAwarenessUpdate(
            item.doc.awareness,
            decode(p.update),
            REMOTE_ORIGIN,
          );
          this.follow(item.doc);
          this.changed();
        }
      }),
      o.runtime.subscribe("collab.saved", (p) => {
        if (p.snapshot) o.documents.markSaved(p.path, p.snapshot);
        else if (p.revision) {
          const doc = o.documents.get(p.path);
          if (doc)
            o.documents.markSaved(p.path, {
              path: p.path,
              text: p.savedText ?? p.text ?? doc.text.toString(),
              revision: p.revision,
              encoding: doc.encoding,
              eol: doc.eol,
            });
        }
      }),
      o.runtime.subscribe("collab.conflict", (p) => {
        const doc = o.documents.get(p.path);
        if (doc) {
          const message = p.kind === "deleted" ? "Shared file was deleted from disk" : "Disk changed while shared edits were unsaved";
          o.documents.setState(p.path, p.kind === "deleted" ? "missing" : "conflict", message);
          o.workbench.notify(message, "warning");
        }
      }),
      o.runtime.subscribe("connection.change", (p) => {
        this.state = p.state;
        this.changed();
        if (p.state === "connected")
          void this.resync().catch((e) =>
            o.workbench.notify(String(e), "error"),
          );
      }),
    );
    for (const doc of o.documents.documents.values()) this.attach(doc.path);
    (o.filesystem as any).beforeWrite = () => this.flush();
  }
  private changed() {
    for (const fn of this.listeners) fn();
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  attach(path: string) {
    if (
      this.attached.has(path) ||
      !(this.o.filesystem as any).shared?.has(path)
    )
      return;
    const doc = this.o.documents.get(path);
    if (!doc) return;
    const room = (this.o.filesystem as any).shared.get(path);
    if (room.conflict) this.o.documents.setState(path, "conflict", "Disk changed while shared edits were unsaved");
    if (room.awareness)
      applyAwarenessUpdate(
        doc.awareness,
        decode(room.awareness),
        REMOTE_ORIGIN,
      );
    const user =
      localStorage.getItem("oxbit.presence.name") ??
      "Guest " + String(doc.ydoc.clientID).slice(-4);
    doc.awareness.setLocalStateField("user", {
      name: user,
      color: currentTheme(this.o.kernel).colors["collaboration.cursor"],
      colorLight: currentTheme(this.o.kernel).colors["collaboration.selection"],
    });
    const update = (bytes: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return;
      const item = this.attached.get(path);
      if (item) { item.pending = true; item.generation++; }
      const generation = item?.generation ?? 0;
      if (this.o.runtime?.connected) {
        this.chain = this.chain
          .then(async () => {
            if (this.disposed) return;
            await this.resynchronizing;
            await this.o.runtime?.request("collab.update", {
              path,
              update: encode(bytes),
            });
            if (item) { item.synced = Math.max(item.synced, generation); item.pending = item.synced < item.generation; }
          })
          .catch((e) => {
            this.state = "unsynced";
            this.o.workbench.notify(String(e), "error");
          });
      }
      this.changed();
    };
    const awareness = (
      {
        added,
        updated,
        removed,
      }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin !== REMOTE_ORIGIN && this.o.runtime?.connected)
        void this.o.runtime
          .request("collab.awareness", {
            path,
            update: encode(
              encodeAwarenessUpdate(doc.awareness, [
                ...added,
                ...updated,
                ...removed,
              ]),
            ),
          })
          .catch(() => {});
      this.changed();
    };
    doc.ydoc.on("update", update);
    doc.awareness.on("update", awareness);
    this.attached.set(path, {
      doc,
      pending: doc.dirty,
      generation: doc.dirty ? 1 : 0,
      synced: 0,
      dispose: () => {
        doc.awareness.setLocalState(null);
        doc.ydoc.off("update", update);
        doc.awareness.off("update", awareness);
      },
    });
    void this.o.runtime
      ?.request("collab.awareness", {
        path,
        update: encode(
          encodeAwarenessUpdate(doc.awareness, [doc.ydoc.clientID]),
        ),
      })
      .catch(() => {});
    if (doc.dirty && this.o.runtime?.connected) void this.flush().catch(error => this.o.workbench.notify(String(error), "error"));
    this.changed();
  }
  async flush() {
    if (!this.o.runtime?.connected)
      throw new Error("Shared file save requires a runtime connection");
    await this.resynchronizing;
    await this.chain;
    for (const [path, item] of this.attached) {
      if (item.pending) {
        const generation = item.generation;
        await this.o.runtime.request("collab.update", {
          path,
          update: encode(Y.encodeStateAsUpdate(item.doc.ydoc)),
        });
        item.synced = Math.max(item.synced, generation); item.pending = item.synced < item.generation;
      }
    }
  }
  async resync() {
    if (this.resynchronizing) return this.resynchronizing;
    this.resynchronizing = (async () => {
      for (const [path, item] of this.attached) {
        if (this.disposed) return;
        const room = await this.o.runtime?.request<any>("collab.join", {path});
        Y.applyUpdate(item.doc.ydoc, decode(room.update), REMOTE_ORIGIN);
        (this.o.filesystem as any).shared.set(path, room);
        if (room.awareness) applyAwarenessUpdate(item.doc.awareness, decode(room.awareness), REMOTE_ORIGIN);
        if (room.conflict) this.o.documents.setState(path, "conflict", "Disk changed while this shared document was offline");
        else if (room.revision) this.o.documents.markSaved(path, {path, text:room.savedText, revision:room.revision, encoding:item.doc.savedEncoding, eol:item.doc.savedEol});
        const generation = item.generation;
        await this.o.runtime?.request("collab.update", {path, update:encode(Y.encodeStateAsUpdate(item.doc.ydoc))});
        item.synced = Math.max(item.synced, generation); item.pending = item.synced < item.generation;
        await this.o.runtime?.request("collab.awareness", {path,update:encode(encodeAwarenessUpdate(item.doc.awareness,[item.doc.ydoc.clientID]))});
      }
      this.state = "connected"; this.changed();
    })();
    try { await this.resynchronizing; } finally { this.resynchronizing = undefined; }
  }
  participants() {
    const users = new Map<
      number,
      { id: number; name: string; path: string; color: string }
    >();
    for (const [path, { doc }] of this.attached)
      for (const [id, value] of doc.awareness.getStates()) {
        if (id !== doc.ydoc.clientID && value.user)
          users.set(id, {
            id,
            name: value.user.name,
            path,
            color: value.user.color,
          });
      }
    return [...users.values()];
  }
  follow(doc: any) {
    if (this.following === undefined) return;
    const state = doc.awareness.getStates().get(this.following);
    const cursor = state?.cursor;
    if (!cursor) return;
    try {
      const pos = Y.createAbsolutePositionFromRelativePosition(
        cursor.head,
        doc.ydoc,
      );
      if (pos)
        void this.o.workbench.openFile(doc.path, {
          from: pos.index,
          to: pos.index,
        });
    } catch {
      /* A participant can close a document while a selection is arriving. */
    }
  }
  dispose() {
    this.disposed = true;
    for (const [path] of this.attached) if (this.o.runtime?.connected) void this.o.runtime.request("collab.leave", {path}).catch(() => {});
    for (const off of this.offs) off();
    for (const item of this.attached.values()) item.dispose();
    this.attached.clear();
    this.listeners.clear();
    delete (this.o.filesystem as any).beforeWrite;
  }
}
export function createFeature(o: FeatureOptions): Extension {
  let service: CollaborationService;
  function Presence() {
    const [, render] = useState(0);
    useEffect(() => service.subscribe(() => render((x) => x + 1)), []);
    return React.createElement(
      "div",
      { className: "presence-panel" },
      React.createElement("div", { className: "presence-heading" },
        React.createElement(Icon, { name: "users", size: 20 }),
        React.createElement("strong", null, tr("Collaboration")),
        React.createElement("span", { className: "presence-status", "data-state": service.state }, service.state)),
      React.createElement("p", { className: "presence-description" }, service.state === "disconnected"
        ? tr("Connect to a shared workspace to collaborate.")
        : tr("Select a participant to follow their active file.")),
      React.createElement("div", { className: "presence-identity" },
        React.createElement("span", { className: "presence-avatar" }, (localStorage.getItem("oxbit.presence.name") || "Guest").slice(0, 1).toUpperCase()),
        React.createElement("span", null, localStorage.getItem("oxbit.presence.name") || "Guest"),
        React.createElement("span", { className: "muted" }, tr("You"))),
      React.createElement(
        "button",
        { className: "button presence-rename",
          onClick: async () => {
            const name = await o.workbench.prompt(
              tr("Display name"),
              localStorage.getItem("oxbit.presence.name") ?? "Guest",
            );
            if (name) {
              localStorage.setItem("oxbit.presence.name", name);
              render(x => x + 1);
              for (const doc of o.documents.documents.values())
                doc.awareness.setLocalStateField("user", {
                  name,
                  color: currentTheme(o.kernel).colors["collaboration.cursor"],
                  colorLight: currentTheme(o.kernel).colors["collaboration.selection"],
                });
            }
          },
        },
        tr("Change name"),
      ),
      ...service.participants().map((user) =>
        React.createElement(
          "button",
          {
            key: user.id,
            className: "button presence-participant",
            "aria-pressed": service.following === user.id,
            onClick: () => {
              service.following = user.id;
              render(x => x + 1);
              void o.workbench.openFile(user.path);
            },
          },
          "Follow " + user.name,
        ),
      ),
      service.following !== undefined &&
        React.createElement(
          "button",
          { className: "button",
            onClick: () => {
              service.following = undefined;
              render(x => x + 1);
            },
          },
          tr("Stop following"),
        ),
    );
  }
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.collaboration",
      name: "Collaboration",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["collaboration"],
    },
    activate(ctx) {
      service = new CollaborationService(o);
      const updateColors = () => {const theme=currentTheme(o.kernel);for(const doc of o.documents.documents.values()){const user=doc.awareness.getLocalState()?.user;if(user)doc.awareness.setLocalStateField('user',{...user,color:theme.colors['collaboration.cursor'],colorLight:theme.colors['collaboration.selection']});}};
      ctx.subscribe(o.kernel.configuration.subscribe(updateColors));
      ctx.subscribe(o.kernel.contributions.subscribe(updateColors));
      ctx.own(service);
      ctx.own(ctx.services.register("collaboration", service));
      ctx.own(
        ctx.contributions.register({
          id: "collaboration",
          kind: "panel",
          title: "Participants",
          component: Presence,
          order: 60,
        }),
      );
      ctx.own(
        ctx.contributions.register({
          id: "collaboration.presence",
          kind: "statusItem",
          title: "Participants",
          command: "collab.follow",
          priority: 80,
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "collab.share",
          title: "Share Workspace",
          run: () =>
            o.workbench.openView(
              "workspace-grants",
              "Workspace access",
              Grants,
              { o },
            ),
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "collab.follow",
          title: "Follow Participant",
          run: () => o.workbench.openPanel("collaboration"),
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "collab.stopFollow",
          title: "Stop Following",
          run: () => {
            service.following = undefined;
          },
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "sync.reconnect",
          title: "Reconnect to Runtime",
          run: async () => {
            await (o.runtime as any)?.connect?.();
            await service.resync();
          },
        }),
      );
    },
  };
}

function Grants({ o }: { o: FeatureOptions }) {
  const [caps, setCaps] = useState([
    "filesystem.read",
    "filesystem.write",
    "collaboration",
  ]);
  const [grants, setGrants] = useState<any[]>([]);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const refresh = () =>
    o.runtime
      ?.request<any[]>("workspace.grants")
      .then(setGrants, (e) => setError(String(e)));
  useEffect(() => {
    void refresh();
  }, []);
  return React.createElement(
    "section",
    { style: { padding: 20, maxWidth: 760 } },
    React.createElement("h2", null, tr("Workspace access")),
    React.createElement(
      "p",
      null,
      tr(
        "Grant each capability separately. The workspace owner controls tool trust.",
      ),
    ),
    ...[
      "filesystem.read",
      "filesystem.write",
      "collaboration",
      "terminal",
      "tasks",
      "git",
      "lsp",
      "extensions",
    ].map((cap) =>
      React.createElement(
        "label",
        { key: cap, style: { display: "block" } },
        React.createElement("input", {
          type: "checkbox",
          checked: caps.includes(cap),
          onChange: (e: any) =>
            setCaps(
              e.target.checked ? [...caps, cap] : caps.filter((c) => c !== cap),
            ),
        }),
        cap,
      ),
    ),
    React.createElement(
      "button",
      {
        onClick: () =>
          void o.runtime
            ?.request<any>("workspace.grant", { capabilities: caps })
            .then(
              (result) => {
                setToken("grant:" + result.token);
                void refresh();
              },
              (e) => setError(String(e)),
            ),
      },
      tr("Create invitation"),
    ),
    token &&
      React.createElement(
        "div",
        null,
        React.createElement(
          "p",
          null,
          tr(
            "Paste this invitation into the Runtime connection pairing field in the other browser.",
          ),
        ),
        React.createElement("input", {
          readOnly: true,
          value: token,
          "aria-label": tr("Workspace invitation"),
        }),
        React.createElement(
          "button",
          { onClick: () => void navigator.clipboard.writeText(token) },
          tr("Copy invitation"),
        ),
      ),
    error && React.createElement("p", { role: "alert" }, error),
    React.createElement("h3", null, tr("Granted sessions")),
    ...grants.map((grant) =>
      React.createElement(
        "div",
        { key: grant.id },
        React.createElement("code", null, grant.id),
        React.createElement(
          "span",
          null,
          grant.owner
            ? tr(" Owner")
            : grant.revoked
              ? tr(" Revoked")
              : " " + grant.capabilities.join(", "),
        ),
        !grant.owner &&
          !grant.revoked &&
          React.createElement(
            "button",
            {
              onClick: () =>
                void o.runtime
                  ?.request("workspace.revoke", { id: grant.id })
                  .then(refresh, (e) => setError(String(e))),
            },
            tr("Revoke"),
          ),
      ),
    ),
  );
}
