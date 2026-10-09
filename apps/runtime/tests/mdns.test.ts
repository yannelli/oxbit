import { describe, expect, it } from "vitest";
import {
  answer,
  encodeMessage,
  encodeName,
  instanceLabel,
  parseMessage,
  readName,
  records,
  TYPE,
} from "../src/mdns.js";

const id = "1234abcd-0000-4000-8000-000000000000";
const ad = {
  id,
  name: "Ryans-Mac.local",
  version: "1.2.3",
  port: 45678,
  v4: ["192.168.1.20"],
  v6: ["fe80::1c2b:3d4e%en0"],
};
const header = (flags: number, qd: number, an = 0) => {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(flags, 2);
  h.writeUInt16BE(qd, 4);
  h.writeUInt16BE(an, 6);
  return h;
};
const tail = (type: number) => Buffer.from([0, type, 0x80, 1]);

describe("mDNS wire format", () => {
  it("round trips encoded names", () => {
    const name = ["Ryans-Mac (1234abcd)", "_oxbit", "_tcp", "local"];
    const encoded = encodeName(name);
    expect(encoded[0]).toBe(20);
    expect(readName(encoded, 0)).toEqual({ name, next: encoded.length });
    expect(() => encodeName(["x".repeat(64)])).toThrow();
  });

  it("parses a query whose second name is a compression pointer", () => {
    const service = encodeName(["_oxbit", "_tcp", "local"]);
    const packet = Buffer.concat([
      header(0, 2),
      service,
      tail(TYPE.PTR),
      Buffer.from([4, ..."host".split("").map((c) => c.charCodeAt(0)), 0xc0, 12]),
      tail(TYPE.SRV),
    ]);
    const { questions } = parseMessage(packet);
    expect(questions[0]).toEqual({ name: ["_oxbit", "_tcp", "local"], type: TYPE.PTR, qclass: 0x8001 });
    expect(questions[1].name).toEqual(["host", "_oxbit", "_tcp", "local"]);
    expect(questions[1].type).toBe(TYPE.SRV);
  });

  it("rejects pointer loops, out-of-bounds pointers and truncated labels", () => {
    for (const name of [[0xc0, 12], [0xc0, 13], [0xff, 0xff], [5, 97, 98], [0xc0]]) {
      const packet = Buffer.concat([header(0, 1), Buffer.from(name), tail(TYPE.PTR)]);
      expect(() => parseMessage(packet)).toThrow();
    }
  });

  it("answers a PTR query with PTR, SRV, TXT, A and AAAA", () => {
    const query = parseMessage(
      Buffer.concat([header(0, 1), encodeName(["_OXBIT", "_tcp", "local"]), tail(TYPE.PTR)]),
    );
    const reply = answer(query.questions, records(ad))!;
    const parsed = parseMessage(encodeMessage(reply));
    expect(parsed.id).toBe(0);
    expect(parsed.flags).toBe(0x8400);
    const instance = ["Ryans-Mac (1234abcd)", "_oxbit", "_tcp", "local"];
    expect(parsed.answers).toEqual([
      { name: ["_oxbit", "_tcp", "local"], type: TYPE.PTR, ttl: 4500, flush: false, target: instance },
    ]);
    const byType = (type: number) => parsed.additionals.find((r) => r.type === type)!;
    expect(byType(TYPE.SRV)).toMatchObject({
      name: instance,
      port: 45678,
      target: ["oxbit-1234abcd", "local"],
      flush: true,
      ttl: 120,
    });
    expect(byType(TYPE.TXT).strings).toEqual([
      `id=${id}`,
      "name=Ryans-Mac.local",
      "version=1.2.3",
      "port=45678",
    ]);
    expect(byType(TYPE.A)).toMatchObject({ name: ["oxbit-1234abcd", "local"], address: "192.168.1.20", flush: true });
    expect(byType(TYPE.AAAA).address).toBe("fe80:0:0:0:0:0:1c2b:3d4e");
    expect(answer([{ name: ["_other", "_tcp", "local"], type: TYPE.PTR, qclass: 1 }], records(ad))).toBeUndefined();
  });

  it("encodes goodbyes with TTL 0", () => {
    const parsed = parseMessage(encodeMessage({ answers: records(ad, 0) }));
    expect(parsed.answers.length).toBe(6);
    expect(parsed.answers.every((r) => r.ttl === 0)).toBe(true);
  });

  it("strips .local and truncates the instance label to 63 bytes", () => {
    expect(instanceLabel("Ryans-Mac.local", id)).toBe("Ryans-Mac (1234abcd)");
    const long = instanceLabel("é".repeat(40), id);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(63);
    expect(long).toBe("é".repeat(26) + " (1234abcd)");
    expect(Buffer.byteLength(instanceLabel("h".repeat(80), id))).toBe(63);
  });
});
