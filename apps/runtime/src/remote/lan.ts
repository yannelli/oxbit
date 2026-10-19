import http from "node:http";
import os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { toBytes, type AcceptLink, type DeviceLink } from "./link.js";

export const REMOTE_SERVICE_TYPE = "_oxbit-remote._tcp";
export const LAN_PATH = "/v1/connect";
const MAX_SOCKETS = 32;

type Interfaces = ReturnType<typeof os.networkInterfaces>;

/** IPv4 LAN addresses as `host:port`, leaving out VPN tunnels, AWDL and link-local addresses. */
export function lanEndpoints(port: number, interfaces: Interfaces = os.networkInterfaces()) {
  const addresses = Object.entries(interfaces)
    .filter(([name]) => !/^(utun|awdl|llw|bridge)/.test(name))
    .flatMap(([, entries]) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
    .map((entry) => `${entry.address}:${port}`);
  return [...new Set(addresses)].slice(0, 4);
}

export interface LanOptions {
  port: number;
  /** Bind address; every interface when omitted. */
  host?: string;
  accept: AcceptLink;
}

/** `ws://<address>:<port>/v1/connect`: the relay's device socket without connection ids. */
export class LanListener {
  private constructor(
    private readonly server: http.Server,
    private readonly sockets: WebSocketServer,
    readonly port: number,
  ) {}

  static async start(options: LanOptions): Promise<LanListener> {
    const server = http.createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const sockets = new WebSocketServer({ server, path: LAN_PATH, perMessageDeflate: false, maxPayload: 1024 * 1024 });
    sockets.on("connection", (socket) => {
      if (sockets.clients.size > MAX_SOCKETS) return socket.close(1013, "busy");
      const link: DeviceLink = {
        path: "lan",
        send: (bytes) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
        },
        close: (reason) => socket.close(4403, reason),
        established: () => {},
      };
      const handler = options.accept(link);
      socket.on("message", (data, binary) => {
        if (binary) handler.receive(toBytes(data));
        else if (data.toString() === "ping" && socket.readyState === WebSocket.OPEN) socket.send("pong");
      });
      socket.on("close", () => handler.closed());
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    return new LanListener(server, sockets, address && typeof address === "object" ? address.port : options.port);
  }

  async close(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate();
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
