import { isIPv4, isIPv6 } from "node:net";
import { RUNTIME_SERVICE_TYPE } from "@oxbit/protocol";

export const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 };
export const FLAGS_RESPONSE = 0x8400;
const QR = 0x8000;
const CACHE_FLUSH = 0x8000;
const CLASS_IN = 1;

export type Name = string[];
export interface Question {
  name: Name;
  type: number;
  qclass: number;
}
export interface ResourceRecord {
  name: Name;
  type: number;
  ttl: number;
  flush: boolean;
  target?: Name;
  port?: number;
  strings?: string[];
  address?: string;
}
export interface Message {
  id: number;
  flags: number;
  questions: Question[];
  answers: ResourceRecord[];
  additionals: ResourceRecord[];
}
export interface AdvertisedRecords {
  name: string;
  id: string;
  version: string;
  port: number;
  v4: string[];
  v6: string[];
}

export function truncateUtf8(value: string, maxBytes: number) {
  let out = "";
  for (const char of value) {
    if (Buffer.byteLength(out + char) > maxBytes) break;
    out += char;
  }
  return out;
}

export function instanceLabel(hostname: string, id: string) {
  const suffix = ` (${id.slice(0, 8)})`;
  const host = hostname.replace(/\.local\.?$/i, "");
  return truncateUtf8(host, 63 - Buffer.byteLength(suffix)) + suffix;
}

export const serviceName = (): Name => [...RUNTIME_SERVICE_TYPE.split("."), "local"];
export const hostName = (id: string): Name => [`oxbit-${id.slice(0, 8)}`, "local"];
export const nameKey = (name: Name) => name.map((l) => l.toLowerCase()).join("\0");

export function records(ad: AdvertisedRecords, ttl?: number): ResourceRecord[] {
  const service = serviceName();
  const instance = [instanceLabel(ad.name, ad.id), ...service];
  const host = hostName(ad.id);
  const rr = (name: Name, type: number, base: number, rest: Partial<ResourceRecord>) => ({
    name,
    type,
    ttl: ttl ?? base,
    flush: type !== TYPE.PTR,
    ...rest,
  });
  const txt = [`id=${ad.id}`, `name=${ad.name}`, `version=${ad.version}`, `port=${ad.port}`];
  return [
    rr(service, TYPE.PTR, 4500, { target: instance }),
    rr(["_services", "_dns-sd", "_udp", "local"], TYPE.PTR, 4500, { target: service }),
    rr(instance, TYPE.SRV, 120, { target: host, port: ad.port }),
    rr(instance, TYPE.TXT, 4500, { strings: txt.map((s) => truncateUtf8(s, 255)) }),
    ...ad.v4.filter((a) => isIPv4(a)).map((address) => rr(host, TYPE.A, 120, { address })),
    ...ad.v6.map((a) => a.split("%")[0]).filter((a) => isIPv6(a)).map((address) => rr(host, TYPE.AAAA, 120, { address })),
  ];
}

/** Answers for the questions we own; unique records not already answered go in additionals. */
export function answer(questions: Question[], all: ResourceRecord[]) {
  const answers = all.filter((r) =>
    questions.some(
      (q) =>
        (q.type === TYPE.ANY || q.type === r.type) &&
        nameKey(q.name) === nameKey(r.name),
    ),
  );
  if (!answers.length) return undefined;
  return { answers, additionals: all.filter((r) => r.flush && !answers.includes(r)) };
}

export function encodeName(name: Name) {
  const parts = name.map((label) => {
    const bytes = Buffer.from(label, "utf8");
    if (!bytes.length || bytes.length > 63) throw new Error(`Invalid DNS label: ${label}`);
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  const out = Buffer.concat([...parts, Buffer.from([0])]);
  if (out.length > 255) throw new Error("DNS name too long");
  return out;
}

function ipv6Bytes(address: string) {
  const [head, tail] = address.includes("::") ? address.split("::") : [address, undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

function rdata(r: ResourceRecord) {
  if (r.type === TYPE.PTR) return encodeName(r.target!);
  if (r.type === TYPE.SRV) {
    const head = Buffer.alloc(6);
    head.writeUInt16BE(r.port!, 4);
    return Buffer.concat([head, encodeName(r.target!)]);
  }
  if (r.type === TYPE.TXT)
    return Buffer.concat(r.strings!.map((s) => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)])));
  if (r.type === TYPE.A) return Buffer.from(r.address!.split(".").map(Number));
  return ipv6Bytes(r.address!);
}

export function encodeMessage(m: Partial<Message> & Pick<Message, "answers">) {
  const header = Buffer.alloc(12);
  const questions = m.questions ?? [];
  const additionals = m.additionals ?? [];
  header.writeUInt16BE(m.id ?? 0, 0);
  header.writeUInt16BE(m.flags ?? FLAGS_RESPONSE, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(m.answers.length, 6);
  header.writeUInt16BE(additionals.length, 10);
  const body = [
    ...questions.map((q) => {
      const tail = Buffer.alloc(4);
      tail.writeUInt16BE(q.type, 0);
      tail.writeUInt16BE(q.qclass, 2);
      return Buffer.concat([encodeName(q.name), tail]);
    }),
    ...[...m.answers, ...additionals].map((r) => {
      const data = rdata(r);
      const fixed = Buffer.alloc(10);
      fixed.writeUInt16BE(r.type, 0);
      fixed.writeUInt16BE(CLASS_IN | (r.flush ? CACHE_FLUSH : 0), 2);
      fixed.writeUInt32BE(r.ttl, 4);
      fixed.writeUInt16BE(data.length, 8);
      return Buffer.concat([encodeName(r.name), fixed, data]);
    }),
  ];
  return Buffer.concat([header, ...body]);
}

export function readName(buf: Buffer, offset: number): { name: Name; next: number } {
  const name: Name = [];
  let pos = offset;
  let next = -1;
  let size = 1;
  for (;;) {
    if (pos >= buf.length) throw new Error("DNS name out of bounds");
    const len = buf[pos];
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error("DNS pointer out of bounds");
      const target = ((len & 0x3f) << 8) | buf[pos + 1];
      // Pointers must go strictly backward, which rules out loops.
      if (target >= pos) throw new Error("DNS pointer loop");
      if (next < 0) next = pos + 2;
      pos = target;
      continue;
    }
    if (len & 0xc0) throw new Error("Invalid DNS label type");
    if (len === 0) return { name, next: next < 0 ? pos + 1 : next };
    if (pos + 1 + len > buf.length) throw new Error("DNS label out of bounds");
    if ((size += len + 1) > 255) throw new Error("DNS name too long");
    name.push(buf.toString("utf8", pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
}

function need(buf: Buffer, end: number) {
  if (end > buf.length) throw new Error("DNS message truncated");
}

function readRecord(buf: Buffer, offset: number) {
  const { name, next } = readName(buf, offset);
  need(buf, next + 10);
  const type = buf.readUInt16BE(next);
  const rclass = buf.readUInt16BE(next + 2);
  const ttl = buf.readUInt32BE(next + 4);
  const start = next + 10;
  const end = start + buf.readUInt16BE(next + 8);
  need(buf, end);
  const r: ResourceRecord = { name, type, ttl, flush: (rclass & CACHE_FLUSH) !== 0 };
  if (type === TYPE.PTR) r.target = readName(buf, start).name;
  if (type === TYPE.SRV) {
    need(buf, start + 6);
    r.port = buf.readUInt16BE(start + 4);
    r.target = readName(buf, start + 6).name;
  }
  if (type === TYPE.TXT) {
    r.strings = [];
    for (let p = start; p < end; p += 1 + buf[p]) {
      need(buf, p + 1 + buf[p]);
      r.strings.push(buf.toString("utf8", p + 1, p + 1 + buf[p]));
    }
  }
  if (type === TYPE.A && end - start === 4) r.address = [...buf.subarray(start, end)].join(".");
  if (type === TYPE.AAAA && end - start === 16)
    r.address = Array.from({ length: 8 }, (_, i) => buf.readUInt16BE(start + i * 2).toString(16)).join(":");
  return { record: r, next: end };
}

export function parseMessage(buf: Buffer): Message {
  need(buf, 12);
  const count = (i: number) => buf.readUInt16BE(4 + i * 2);
  const m: Message = { id: buf.readUInt16BE(0), flags: buf.readUInt16BE(2), questions: [], answers: [], additionals: [] };
  let pos = 12;
  for (let i = 0; i < count(0); i++) {
    const { name, next } = readName(buf, pos);
    need(buf, next + 4);
    m.questions.push({ name, type: buf.readUInt16BE(next), qclass: buf.readUInt16BE(next + 2) });
    pos = next + 4;
  }
  if (!(m.flags & QR)) return m;
  for (let i = 0; i < count(1) + count(2) + count(3); i++) {
    const { record, next } = readRecord(buf, pos);
    (i < count(1) ? m.answers : m.additionals).push(record);
    pos = next;
  }
  return m;
}
