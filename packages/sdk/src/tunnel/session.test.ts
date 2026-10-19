import { describe, expect, it } from "vitest";
import { ControlChannel, ControlError } from "./control.js";
import { InitiatorHandshake, ResponderHandshake } from "./handshake.js";
import { generateX25519KeyPair } from "./keys.js";
import { MAX_FRAGMENT, TunnelSession, type TunnelSessionEvents } from "./session.js";
import { TunnelSocket } from "./socket.js";

/** Connected device and host sessions over an in-memory wire; `hold` keeps device-to-host bytes for manual delivery. */
async function connectPair(hold = false) {
  const hostKey = await generateX25519KeyPair();
  const initiator = await InitiatorHandshake.start({ deviceKey: await generateX25519KeyPair(), name: "iPhone", hostKey: hostKey.publicKey });
  const responder = await ResponderHandshake.accept(initiator.message, { hostKey });
  const reply = await responder.reply({ v: 1, id: "host", name: "Studio Mac" });
  const { ciphers } = await initiator.finish(reply.message);
  const toHost: Uint8Array[] = [];
  const toDevice: Uint8Array[] = [];
  const device: TunnelSession = new TunnelSession(ciphers, {
    send: (bytes) => {
      toHost.push(bytes);
      if (!hold) void host.receive(bytes);
    },
    close: (reason) => host.close(reason),
  });
  const host: TunnelSession = new TunnelSession(reply.ciphers, {
    send: (bytes) => {
      toDevice.push(bytes);
      void device.receive(bytes);
    },
    close: (reason) => device.close(reason),
  });
  return { device, host, toHost, toDevice };
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 1));
}

function next<K extends keyof TunnelSessionEvents>(session: TunnelSession, event: K): Promise<Parameters<TunnelSessionEvents[K]>> {
  return new Promise((resolve) => {
    const off = session.on(event, ((...args: Parameters<TunnelSessionEvents[K]>) => {
      off();
      resolve(args);
    }) as TunnelSessionEvents[K]);
  });
}

describe("TunnelSession", () => {
  it("fragments and reassembles a 25 MiB message", async () => {
    const { device, host, toHost } = await connectPair();
    const text = "aé😀".repeat(Math.ceil((25 * 1024 * 1024) / 7));
    const bytes = new TextEncoder().encode(text).length;
    const received = next(host, "message");
    await device.send(9, text);
    const [stream, value] = await received;
    expect(stream).toBe(9);
    expect(value === text).toBe(true);
    expect(toHost).toHaveLength(Math.ceil(bytes / MAX_FRAGMENT));
    expect(Math.max(...toHost.map((message) => message.length))).toBeLessThanOrEqual(65535);
  });

  it("sends an empty message as one frame and keeps send order", async () => {
    const { device, host, toHost } = await connectPair();
    const seen: Array<[number, string]> = [];
    host.on("message", (stream, text) => seen.push([stream, text]));
    await device.send(1, "");
    expect(toHost).toHaveLength(1);
    await Promise.all([device.send(1, "a"), device.send(2, "b".repeat(200_000)), device.send(1, "c")]);
    await until(() => seen.length === 4);
    expect(seen.map(([stream, text]) => [stream, text.length])).toEqual([[1, 0], [1, 1], [2, 200_000], [1, 1]]);
  });

  it("propagates CLOSE with its reason", async () => {
    const { device, host } = await connectPair();
    const closed = next(host, "streamClosed");
    await device.closeStream(4, "runtime exited");
    expect(await closed).toEqual([4, "runtime exited"]);
    expect(host.closed).toBe(false);
  });

  it("closes with an error when a message fails to decrypt", async () => {
    const { device, host, toHost } = await connectPair(true);
    await device.send(1, "hello");
    const tampered = Uint8Array.from(toHost[0]);
    tampered[3] ^= 0x80;
    const errored = next(host, "error");
    const closed = next(host, "close");
    await host.receive(tampered);
    expect((await errored)[0].message).toContain("failed authentication");
    expect((await closed)[0]).toContain("failed authentication");
    expect(host.closed).toBe(true);
    await expect(host.send(1, "after")).rejects.toThrow("closed");
  });
});

describe("ControlChannel", () => {
  it("answers requests, reports errors, and delivers events", async () => {
    const { device, host } = await connectPair();
    const client = new ControlChannel(device);
    const server = new ControlChannel(host);
    server.handle("host.info", () => ({ id: "h1", name: "Studio Mac" }));
    server.handle("host.list", async (params: { path: string }) => {
      throw new ControlError("PATH_DENIED", `${params.path} is hidden`);
    });
    server.handle("host.crash", () => {
      throw new Error("boom");
    });
    expect(await client.request("host.info")).toEqual({ id: "h1", name: "Studio Mac" });
    await expect(client.request("host.list", { path: "~/.ssh" })).rejects.toMatchObject({ code: "PATH_DENIED", message: "~/.ssh is hidden" });
    await expect(client.request("host.crash")).rejects.toMatchObject({ code: "INTERNAL", message: "boom" });
    await expect(client.request("host.nope")).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });

    const event = new Promise((resolve) => client.on("stream.closed", resolve));
    await server.emit("stream.closed", { stream: 3, reason: "runtime exited" });
    expect(await event).toEqual({ stream: 3, reason: "runtime exited" });
  });

  it("times out, and rejects pending requests when the session closes", async () => {
    const { device, host } = await connectPair();
    const client = new ControlChannel(device);
    new ControlChannel(host).handle("host.open", () => new Promise(() => undefined));
    await expect(client.request("host.open", { path: "~" }, 20)).rejects.toMatchObject({ code: "TIMEOUT" });
    const pending = client.request("host.open", { path: "~" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.close("relay closed");
    await expect(pending).rejects.toMatchObject({ code: "CLOSED", message: "Tunnel closed: relay closed" });
    await expect(client.request("host.info")).rejects.toMatchObject({ code: "CLOSED" });
  });
});

describe("TunnelSocket", () => {
  type Socket = Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "close" | "onopen" | "onmessage" | "onerror" | "onclose">;

  async function runtimeLike(open: () => Promise<number>) {
    const pair = await connectPair();
    const log: string[] = [];
    const socket: Socket = new TunnelSocket(pair.device, open);
    log.push(`constructed:${socket.readyState}`);
    socket.onopen = () => {
      log.push(`open:${socket.readyState}`);
      socket.send(JSON.stringify({ v: 1, type: "request", id: "1", method: "auth.authenticate", params: { token: "t" } }));
    };
    socket.onmessage = (event) => log.push(`message:${String(event.data)}`);
    socket.onerror = () => log.push("error");
    const closed = new Promise<void>((resolve) => {
      socket.onclose = (event) => {
        log.push(`close:${event.code}:${event.reason}:${socket.readyState}`);
        resolve();
      };
    });
    return { ...pair, socket, log, closed };
  }

  it("drives open, message, and close in WebSocket order", async () => {
    const { host, log, closed } = await runtimeLike(async () => 7);
    const [stream, auth] = await next(host, "message");
    expect(stream).toBe(7);
    expect(JSON.parse(auth).method).toBe("auth.authenticate");
    await host.send(7, '{"v":1,"type":"response","id":"1","result":{}}');
    await until(() => log.length === 3);
    await host.closeStream(7, "runtime closed");
    await closed;
    expect(log).toEqual(["constructed:0", "open:1", 'message:{"v":1,"type":"response","id":"1","result":{}}', "close:1000:runtime closed:3"]);
  });

  it("reports a failed open as error then close 1006", async () => {
    const { log, closed } = await runtimeLike(async () => {
      throw new ControlError("PATH_DENIED", "denied");
    });
    await closed;
    expect(log).toEqual(["constructed:0", "error", "close:1006:denied:3"]);
  });

  it("closes the stream locally and on session loss", async () => {
    const local = await runtimeLike(async () => 5);
    await next(local.host, "message");
    const hostSaw = next(local.host, "streamClosed");
    local.socket.close(4000, "bye");
    expect(local.socket.readyState).toBe(2);
    await local.closed;
    expect(await hostSaw).toEqual([5, "bye"]);
    expect(local.log.at(-1)).toBe("close:4000:bye:3");

    const lost = await runtimeLike(async () => 6);
    await next(lost.host, "message");
    lost.device.close("relay closed");
    await lost.closed;
    expect(lost.log.at(-1)).toBe("close:1006:relay closed:3");
    expect(() => lost.socket.send("late")).not.toThrow();
  });
});
