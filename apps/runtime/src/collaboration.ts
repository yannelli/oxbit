import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { Encoding, Eol } from "@zapp/sdk";
import { RpcError } from "@zapp/protocol";
import { WorkspaceFiles } from "./filesystem.js";
import { LanguageServer } from "./lsp.js";
interface Room {
  path: string;
  doc: Y.Doc;
  awareness: Awareness;
  revision: string | null;
  savedText: string;
  members: Set<string>;
  clients: Map<string, Set<number>>;
  persist: Promise<void>;
  saving: boolean;
}
export class Collaboration {
  private rooms = new Map<string, Promise<Room>>();
  constructor(
    private files: WorkspaceFiles,
    private storage: string,
    private lsp: LanguageServer,
    private emit: (
      event: string,
      params: Record<string, unknown>,
      connections: Set<string>,
    ) => void,
  ) {}
  private roomFile(relative: string) {
    return path.join(
      this.storage,
      createHash("sha256").update(relative).digest("hex") + ".json",
    );
  }
  private async room(relative: string) {
    await this.files.resolve(relative, true);
    let room = this.rooms.get(relative);
    if (!room) {
      room = this.load(relative);
      this.rooms.set(relative, room);
      try {
        return await room;
      } catch (error) {
        this.rooms.delete(relative);
        throw error;
      }
    }
    return room;
  }
  private async load(relative: string): Promise<Room> {
    const doc = new Y.Doc(),
      awareness = new Awareness(doc);
    awareness.setLocalState(null);
    let disk;
    try {
      disk = await this.files.read(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const room: Room = {
      path: relative,
      doc,
      awareness,
      revision: disk?.revision ?? null,
      savedText: disk?.text ?? "",
      members: new Set(),
      clients: new Map(),
      persist: Promise.resolve(),
      saving: false,
    };
    let persisted = false;
    try {
      const state = JSON.parse(
        await fs.readFile(this.roomFile(relative), "utf8"),
      );
      if (state.path !== relative) throw new Error("Room path mismatch");
      Y.applyUpdate(doc, Buffer.from(state.update, "base64"));
      room.revision = state.revision;
      room.savedText = state.savedText;
      persisted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new RpcError(
          "COLLAB_RECOVERY",
          "Cannot load saved collaboration state",
          String(error),
        );
    }
    if (!persisted && disk?.text) doc.getText("content").insert(0, disk.text);
    if (
      persisted &&
      disk &&
      disk.revision !== room.revision &&
      doc.getText("content").toString() === room.savedText
    ) {
      doc.transact(() => {
        doc.getText("content").delete(0, doc.getText("content").length);
        doc.getText("content").insert(0, disk?.text ?? "");
      }, "disk");
      room.savedText = disk?.text ?? "";
      room.revision = disk?.revision ?? null;
    }
    doc.on("update", (update: Uint8Array) => {
      this.lsp.canonical(relative, doc.getText("content").toString());
      this.persist(room);
      this.emit(
        "collab.update",
        { path: relative, update: Buffer.from(update).toString("base64") },
        room.members,
      );
    });
    awareness.on(
      "update",
      ({
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => {
        const update = encodeAwarenessUpdate(awareness, [
          ...added,
          ...updated,
          ...removed,
        ]);
        this.emit(
          "collab.awareness",
          { path: relative, update: Buffer.from(update).toString("base64") },
          room.members,
        );
      },
    );
    this.lsp.canonical(relative, doc.getText("content").toString());
    this.persist(room);
    await room.persist;
    return room;
  }
  private persist(room: Room) {
    const payload = JSON.stringify({
      path: room.path,
      revision: room.revision,
      savedText: room.savedText,
      update: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64"),
    });
    room.persist = room.persist
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(this.storage, { recursive: true, mode: 0o700 });
        const file = this.roomFile(room.path);
        await fs.writeFile(file + ".tmp", payload, { mode: 0o600 });
        await fs.rename(file + ".tmp", file);
      });
    room.persist.catch((error) =>
      this.emit(
        "collab.error",
        { path: room.path, message: String(error) },
        room.members,
      ),
    );
  }
  private bytes(encoded: string) {
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      encoded.length > 2 * 1024 * 1024
    )
      throw new RpcError("INVALID_PARAMS", "Invalid collaboration update");
    return Buffer.from(encoded, "base64");
  }
  async join(relative: string, connection: string) {
    const room = await this.room(relative);
    room.members.add(connection);
    return {
      update: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64"),
      awareness: Buffer.from(
        encodeAwarenessUpdate(room.awareness, [
          ...room.awareness.getStates().keys(),
        ]),
      ).toString("base64"),
      revision: room.revision,
      savedText: room.savedText,
      conflict: await this.conflict(room),
    };
  }
  private async conflict(room: Room) {
    try {
      return (await this.files.read(room.path)).revision !== room.revision;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return room.revision !== null;
      throw error;
    }
  }
  private async member(relative: string, connection: string) {
    const room = await this.room(relative);
    if (!room.members.has(connection))
      throw new RpcError("NOT_JOINED", "Join the shared document first");
    return room;
  }
  async update(relative: string, connection: string, encoded: string) {
    const room = await this.member(relative, connection);
    const bytes=this.bytes(encoded);
    try {
      if (room.doc.getText("content").length + bytes.length > 20 * 1024 * 1024) {
        const candidate=new Y.Doc();
        try { Y.applyUpdate(candidate,Y.encodeStateAsUpdate(room.doc));Y.applyUpdate(candidate,bytes);if(candidate.getText("content").length>20*1024*1024)throw new RpcError("FILE_TOO_LARGE","Shared documents are limited to 20 MiB"); } finally {candidate.destroy();}
      }
      Y.applyUpdate(room.doc, bytes, connection);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError("INVALID_UPDATE", "Invalid Yjs update", String(error));
    }
    await room.persist;
    return { ok: true };
  }
  async awareness(relative: string, connection: string, encoded: string) {
    const room = await this.member(relative, connection),
      bytes = this.bytes(encoded);
    if (bytes.length > 64 * 1024)
      throw new RpcError("TOO_LARGE", "Presence update exceeds 64 KiB");
    const ids = this.awarenessIds(bytes),
      own = room.clients.get(connection) ?? new Set<number>();
    for (const id of ids)
      for (const [other, claimed] of room.clients)
        if (other !== connection && claimed.has(id))
          throw new RpcError(
            "FORBIDDEN",
            "Presence client belongs to another connection",
          );
    try {
      applyAwarenessUpdate(room.awareness, bytes, connection);
    } catch {
      throw new RpcError("INVALID_UPDATE", "Invalid presence update");
    }
    for (const id of ids) own.add(id);
    room.clients.set(connection, own);
    return { ok: true };
  }
  private awarenessIds(bytes: Uint8Array) {
    let offset = 0;
    const integer = () => {
      let value = 0,
        shift = 0;
      while (offset < bytes.length && shift < 56) {
        const byte = bytes[offset++]!;
        value += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) return value;
        shift += 7;
      }
      throw new RpcError("INVALID_UPDATE", "Malformed presence integer");
    };
    const count = integer(),
      ids = [];
    if (count > 256) throw new RpcError("LIMIT", "Too many presence clients");
    for (let i = 0; i < count; i++) {
      ids.push(integer());
      integer();
      const size = integer();
      offset += size;
      if (offset > bytes.length)
        throw new RpcError("INVALID_UPDATE", "Malformed presence state");
    }
    return ids;
  }
  async save(
    relative: string,
    connection: string,
    expectedRevision: string | null,
    encoding?: Encoding,
    eol?: Eol,
  ) {
    const room = await this.member(relative, connection);
    room.saving = true;
    try {
      const result = await this.files.write(
        relative,
        room.doc.getText("content").toString(),
        { expectedRevision, encoding, eol },
      );
      room.revision = result.revision;
      room.savedText = result.text;
      this.persist(room);
      await room.persist;
      this.emit(
        "collab.saved",
        {
          path: relative,
          revision: result.revision,
          savedText: result.text,
          snapshot: result,
        },
        room.members,
      );
      return result;
    } finally {
      room.saving = false;
    }
  }
  async changed(relative: string) {
    const entry = this.rooms.get(relative);
    if (!entry) return;
    const room = await entry;
    if (room.saving) return;
    let disk;
    try {
      disk = await this.files.read(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    if (disk?.revision === room.revision) return;
    if (!disk) {
      this.emit(
        "collab.conflict",
        { path: relative, revision: null, kind: "deleted" },
        room.members,
      );
      return;
    }
    if (room.doc.getText("content").toString() !== room.savedText) {
      this.emit(
        "collab.conflict",
        {
          path: relative,
          revision: disk?.revision ?? null,
          kind: disk ? "changed" : "deleted",
        },
        room.members,
      );
      return;
    }
    room.savedText = disk?.text ?? "";
    room.revision = disk?.revision ?? null;
    room.doc.transact(() => {
      const text = room.doc.getText("content");
      text.delete(0, text.length);
      text.insert(0, room.savedText);
    }, "disk");
    this.persist(room);
    this.emit(
      "collab.saved",
      {
        path: relative,
        revision: room.revision,
        savedText: room.savedText,
        snapshot: disk ?? null,
      },
      room.members,
    );
  }
  async leave(connection: string, relative?: string) {
    for (const [key, entry] of this.rooms) {
      if (relative && relative !== key) continue;
      const room = await entry;
      room.members.delete(connection);
      const clients = room.clients.get(connection);
      if (clients)
        removeAwarenessStates(room.awareness, [...clients], "disconnect");
      room.clients.delete(connection);
      if (!room.members.size) { await room.persist; if (!room.members.size && this.rooms.get(key) === entry) { this.rooms.delete(key); this.lsp.closeCanonical(key); room.awareness.destroy(); room.doc.destroy(); } }
    }
  }
  async close() {
    for (const entry of this.rooms.values()) {
      const room = await entry;
      await room.persist;
      room.awareness.destroy();
      room.doc.destroy();
    }
    this.rooms.clear();
  }
}
