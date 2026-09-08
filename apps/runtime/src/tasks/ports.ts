import net, { type Server } from "node:net";
import { createHash } from "node:crypto";
import type { ConfiguredTask, TaskPort } from "@oxbit/sdk";
import { RpcError } from "@oxbit/protocol";
import { variableKey } from "./validation.js";
export interface PortPlan {
  host: string;
  hostname: string;
  port: number;
  ports: Record<string, number>;
  sockets: Server[];
  fingerprint: string;
}
export function serviceUrl(plan: PortPlan) {
  const host =
    plan.host === "0.0.0.0"
      ? "127.0.0.1"
      : plan.host === "::"
        ? "::1"
        : plan.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${plan.port}`;
}
const listen = (host: string, port: number) =>
  new Promise<Server>((resolve, reject) => {
    const socket = net.createServer((connection) => connection.destroy());
    socket.unref();
    socket.once("error", reject);
    socket.listen({ host, port, exclusive: true }, () => {
      socket.removeListener("error", reject);
      socket.on("error", () => {});
      resolve(socket);
    });
  });
const close = (socket: Server) =>
  new Promise<void>((resolve) => socket.close(() => resolve()));
export class TaskPorts {
  private plans = new Map<string, PortPlan>();
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private workspace: string) {}
  async ensure(tasks: ConfiguredTask[], live: Set<string>) {
    const work = this.serial.then(async () => {
      const services = tasks.filter(
        (t) =>
          !t.disabledReason &&
          (t.type === "service" || t.port !== undefined || t.ports),
      );
      if (services.length > 32)
        throw new RpcError("LIMIT", "Maximum 32 configured services");
      const names = new Set<string>();
      for (const task of services) {
        const name = variableKey(task.name);
        if (names.has(name))
          throw new RpcError(
            "INVALID_TASK_CONFIG",
            `Service variable collision for ${task.name}; give services distinct names`,
          );
        names.add(name);
      }
      for (const [id, plan] of this.plans) {
        const task = services.find((task) => task.id === id);
        const fingerprint = task
          ? JSON.stringify([task.host, task.hostname, task.port, task.ports])
          : "";
        if (!live.has(id) && plan.fingerprint !== fingerprint) {
          await Promise.all(plan.sockets.map(close));
          this.plans.delete(id);
        }
      }
      const added: string[] = [];
      try {
        for (const task of services) {
          if (this.plans.has(task.id)) continue;
          const host = task.host || "127.0.0.1";
          if (!net.isIP(host) && host !== "localhost")
            throw new RpcError(
              "INVALID_TASK_CONFIG",
              "Service host must be an IP address or localhost",
            );
          const label =
            task.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 30) || "service";
          const hostname =
            task.hostname ||
            `${label}-${createHash("sha256").update(this.workspace).digest("hex").slice(0, 8)}.localhost`;
          if (!/^[a-zA-Z0-9.-]+$/.test(hostname) || hostname.length > 253)
            throw new RpcError(
              "INVALID_TASK_CONFIG",
              "Invalid service hostname",
            );
          const sockets: Server[] = [];
          const allocate = async (spec: TaskPort) => {
            const ports =
              typeof spec === "number"
                ? [spec]
                : spec === "auto"
                  ? [0]
                  : Array.from(
                      { length: Math.min(spec.max - spec.min + 1, 65535) },
                      (_, i) => spec.min + i,
                    );
            for (const port of ports) {
              try {
                const socket = await listen(host, port);
                sockets.push(socket);
                return (socket.address() as net.AddressInfo).port;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE")
                  throw error;
              }
            }
            throw new RpcError(
              "PORT_BUSY",
              `No available port for ${task.name}; the configured port/range is occupied`,
            );
          };
          try {
            const port = await allocate(task.port ?? "auto"),
              ports: Record<string, number> = {};
            for (const [name, spec] of Object.entries(task.ports ?? {}))
              ports[name] = await allocate(spec);
            this.plans.set(task.id, {
              host,
              hostname,
              port,
              ports,
              sockets,
              fingerprint: JSON.stringify([
                task.host,
                task.hostname,
                task.port,
                task.ports,
              ]),
            });
            added.push(task.id);
          } catch (error) {
            await Promise.all(sockets.map(close));
            throw error;
          }
        }
      } catch (error) {
        for (const id of added) {
          await Promise.all(this.plans.get(id)!.sockets.map(close));
          this.plans.delete(id);
        }
        throw error;
      }
    });
    this.serial = work.catch(() => {});
    await work;
  }
  get(id: string) {
    return this.plans.get(id);
  }
  async release(id: string) {
    const plan = this.plans.get(id);
    if (plan) {
      const sockets = plan.sockets.splice(0);
      await Promise.all(sockets.map(close));
    }
  }
  async reserveAgain(id: string) {
    const plan = this.plans.get(id);
    if (!plan || plan.sockets.length) return;
    const sockets: Server[] = [];
    try {
      for (const port of [plan.port, ...Object.values(plan.ports)])
        sockets.push(await listen(plan.host, port));
      plan.sockets = sockets;
    } catch (error) {
      await Promise.all(sockets.map(close));
      throw new RpcError(
        "PORT_BUSY",
        `Service port was taken after exit: ${String(error)}`,
      );
    }
  }
  peers(tasks: ConfiguredTask[]) {
    const vars: Record<string, string> = {};
    for (const task of tasks) {
      const plan = this.plans.get(task.id);
      if (!plan) continue;
      const prefix = `OXBIT_SERVICE_${variableKey(task.name)}`;
      vars[`${prefix}_PORT`] = String(plan.port);
      vars[`${prefix}_HOST`] = plan.host;
      vars[`${prefix}_HOSTNAME`] = plan.hostname;
      vars[`${prefix}_URL`] = serviceUrl(plan);
      for (const [name, port] of Object.entries(plan.ports))
        vars[`${prefix}_${name.toUpperCase()}_PORT`] = String(port);
    }
    return vars;
  }
  async close() {
    await this.serial;
    await Promise.all(
      [...this.plans.values()].flatMap((plan) => plan.sockets.map(close)),
    );
    this.plans.clear();
  }
}
export function tcpReady(host: string, port: number, timeoutMs = 1000) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({
      host: host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host,
      port,
    });
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
