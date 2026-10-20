import { WebSocket } from "ws";
import { ControlChannel, InitiatorHandshake, TunnelSession, type HostHello, type InitiatorOptions } from "@oxbit/sdk/tunnel";
import { toBytes } from "../src/remote/link.js";

export interface DeviceClient {
  socket: WebSocket;
  session: TunnelSession;
  control: ControlChannel;
  host: HostHello;
  /** Resolves with the socket close code and reason. */
  closed: Promise<{ code: number; reason: string }>;
}

/** Device side of the tunnel over one WebSocket, such as the LAN listener or the relay's `/v1/connect`. */
export async function connectDevice(url: string, options: InitiatorOptions): Promise<DeviceClient> {
  const handshake = await InitiatorHandshake.start(options);
  const socket = new WebSocket(url, { perMessageDeflate: false });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const reply = await new Promise<Uint8Array>((resolve, reject) => {
    socket.once("open", () => socket.send(handshake.message));
    socket.once("error", reject);
    socket.once("message", (data) => resolve(toBytes(data as Buffer)));
    void closed.then(({ code, reason }) => reject(Object.assign(new Error(`Closed ${code} ${reason}`), { code, reason })));
  });
  let finished: Awaited<ReturnType<InitiatorHandshake["finish"]>>;
  try {
    finished = await handshake.finish(reply);
  } catch (error) {
    socket.close();
    throw error;
  }
  const session = new TunnelSession(finished.ciphers, {
    send: (bytes) => socket.send(bytes),
    close: () => socket.close(),
  });
  socket.on("message", (data, binary) => {
    if (binary) void session.receive(toBytes(data as Buffer));
  });
  void closed.then(({ reason }) => session.close(reason || "closed"));
  return { socket, session, control: new ControlChannel(session), host: finished.host, closed };
}
