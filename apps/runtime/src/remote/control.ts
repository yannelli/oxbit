import * as fs from "node:fs/promises";
import path from "node:path";
import type { WebSocket } from "ws";
import { CONTROL_STREAM, ControlError, type ControlChannel, type TunnelSession } from "@oxbit/sdk/tunnel";
import { listDirectory, type PathPolicy } from "./browse.js";
import type { RuntimeBridge, RuntimeLauncher } from "./runtimes.js";
import type { ProjectRecord } from "./state.js";

export interface HostInfo {
  id: string;
  name: string;
  version: string;
  platform: string;
  home: string;
}
export interface Project {
  path: string;
  name: string;
  running: boolean;
  lastOpened?: number;
}
export interface ControlContext {
  info(): HostInfo;
  policy: PathPolicy;
  bridge: RuntimeBridge;
  projects(): Promise<Project[]>;
  opened(root: string): void;
}

/** Serves `host.*` on stream 0 and forwards each opened stream to a runtime `/ws` socket. */
export function serveControl(session: TunnelSession, control: ControlChannel, context: ControlContext): () => void {
  const streams = new Map<number, WebSocket>();
  let nextStream = 1;

  const end = (stream: number, reason: string) => {
    const socket = streams.get(stream);
    if (!socket) return;
    streams.delete(stream);
    socket.close(1000);
    if (session.closed) return;
    void session.closeStream(stream, reason).catch(() => undefined);
    void control.emit("stream.closed", { stream, reason }).catch(() => undefined);
  };

  control.handle("host.info", () => context.info());
  control.handle("host.list", (params) => listDirectory(context.policy, params?.path));
  control.handle("host.projects", async () => ({ projects: await context.projects() }));
  control.handle("host.open", async (params) => {
    const root = await context.policy.directory(params?.path);
    const { daemon, token, runtime } = await context.bridge.open(root);
    const socket = await context.bridge.connect(daemon);
    if (session.closed) {
      socket.close(1000);
      throw new ControlError("CLOSED", "The tunnel closed");
    }
    const stream = nextStream++;
    streams.set(stream, socket);
    socket.on("message", (data) => {
      if (streams.get(stream) === socket) void session.send(stream, data.toString()).catch(() => undefined);
    });
    socket.on("close", (code, reason) => end(stream, reason.toString() || `runtime closed (${code})`));
    socket.on("error", () => undefined);
    context.opened(root);
    return { stream, token, runtime, workspace: { root, name: path.basename(root) || root } };
  });
  control.handle("host.close", (params) => {
    if (typeof params?.stream !== "number") throw new ControlError("INVALID_PARAMS", "stream must be a number");
    end(params.stream, "closed");
    return {};
  });

  const detach = [
    session.on("message", (stream, text) => {
      if (stream === CONTROL_STREAM) return;
      const socket = streams.get(stream);
      if (socket) socket.send(text);
      else void session.closeStream(stream, "unknown stream").catch(() => undefined);
    }),
    session.on("streamClosed", (stream) => {
      const socket = streams.get(stream);
      streams.delete(stream);
      socket?.close(1000);
    }),
  ];
  return () => {
    detach.forEach((off) => off());
    for (const socket of streams.values()) socket.close(1000);
    streams.clear();
  };
}

/** `host.projects`: folders opened through the host, then live CLI runtimes, newest first. */
export async function listProjects(records: ProjectRecord[], launcher: RuntimeLauncher, policy: PathPolicy): Promise<Project[]> {
  const live = await launcher.list();
  const running = new Set(live.map((daemon) => daemon.root));
  const found = new Map<string, Project>();
  for (const entry of records)
    found.set(entry.path, { path: entry.path, name: path.basename(entry.path), running: running.has(entry.path), lastOpened: entry.lastOpened });
  for (const daemon of live) if (!found.has(daemon.root)) found.set(daemon.root, { path: daemon.root, name: path.basename(daemon.root), running: true });
  const hidden = await policy.hidden();
  const candidates = [...found.values()].filter((project) => policy.allowed(project.path, hidden));
  const present = await Promise.all(candidates.map((project) => fs.stat(project.path).then((stat) => stat.isDirectory(), () => false)));
  return candidates
    .filter((_, index) => present[index])
    .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0) || a.name.localeCompare(b.name));
}
