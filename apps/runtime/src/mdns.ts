import { createSocket, type RemoteInfo } from "node:dgram";
import os from "node:os";
import {
  answer,
  encodeMessage,
  instanceLabel,
  parseMessage,
  records,
  FLAGS_RESPONSE,
  type ResourceRecord,
} from "./mdns-wire.js";

export * from "./mdns-wire.js";

export interface Advertisement {
  id: string;
  name: string;
  version: string;
  port: number;
  /** Defaults to non-internal addresses from os.networkInterfaces(), read at each announce/answer. */
  addresses?: () => { v4: string[]; v6: string[] };
}
export interface Advertiser {
  instance: string;
  close(): Promise<void>;
}

const GROUP = "224.0.0.251";
const PORT = 5353;

// Tunnel, AWDL, and link-local addresses push announcements past one MTU and are not reachable LAN routes.
function lanAddresses() {
  const all = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(utun|awdl|llw)/.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .filter((a) => !a.internal && !/^fe80:/i.test(a.address));
  const of = (family: string) => [...new Set(all.filter((a) => a.family === family).map((a) => a.address))];
  return { v4: of("IPv4"), v6: of("IPv6") };
}

const stderrLog = (line: string) => process.stderr.write(line + "\n");

export function advertise(ad: Advertisement, log: (line: string) => void = stderrLog): Advertiser {
  const instance = instanceLabel(ad.name, ad.id);
  const current = (ttl?: number) => records({ ...ad, ...(ad.addresses ?? lanAddresses)() }, ttl);
  const timers: NodeJS.Timeout[] = [];
  let closing: Promise<void> | undefined;
  let closed = false;
  let sendFailed = false;
  // reusePort fails bind with ENOTSUP on macOS; reuseAddr alone binds beside mDNSResponder there.
  const socket = createSocket({ type: "udp4", reuseAddr: true, reusePort: process.platform === "linux" });

  const stop = () => {
    if (closed) return;
    closed = true;
    timers.forEach(clearTimeout);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };
  const fail = (error: Error) => {
    if (closed) return;
    log(`mDNS advertising disabled: ${error.message}`);
    stop();
  };
  const sendFailure = (error: Error) => {
    if (!sendFailed) log(`mDNS send failed: ${error.message}`);
    sendFailed = true;
  };
  const send = (packet: Buffer, port = PORT, address = GROUP, done?: () => void) => {
    if (closed) return done?.();
    try {
      socket.send(packet, port, address, (error) => {
        if (error) sendFailure(error);
        done?.();
      });
    } catch (error) {
      sendFailure(error as Error);
      done?.();
    }
  };
  const announce = () => send(encodeMessage({ answers: current() }));

  const onMessage = (packet: Buffer, from: RemoteInfo) => {
    try {
      const query = parseMessage(packet);
      if (query.flags & 0x8000) return;
      const reply = answer(query.questions, current());
      if (!reply) return;
      if (from.port === PORT) return send(encodeMessage(reply));
      const legacy = (r: ResourceRecord) => ({ ...r, ttl: Math.min(r.ttl, 10), flush: false });
      send(
        encodeMessage({
          id: query.id,
          flags: FLAGS_RESPONSE,
          questions: query.questions,
          answers: reply.answers.map(legacy),
          additionals: reply.additionals.map(legacy),
        }),
        from.port,
        from.address,
      );
    } catch {
      /* malformed packets are ignored */
    }
  };

  socket.on("error", fail);
  socket.on("message", onMessage);
  try {
    socket.bind({ port: PORT, address: "0.0.0.0" }, () => {
      try {
        socket.setMulticastTTL(255);
        socket.setMulticastLoopback(true);
      } catch (error) {
        return fail(error as Error);
      }
      for (const address of lanAddresses().v4) {
        try {
          socket.addMembership(GROUP, address);
        } catch {
          /* interfaces without multicast reject membership */
        }
      }
      announce();
      for (const delay of [1000, 2000]) timers.push(setTimeout(announce, delay).unref());
    });
  } catch (error) {
    fail(error as Error);
  }

  return {
    instance,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        if (closed) return resolve();
        socket.once("close", resolve);
        timers.forEach(clearTimeout);
        send(encodeMessage({ answers: current(0) }), PORT, GROUP, stop);
      })),
  };
}
