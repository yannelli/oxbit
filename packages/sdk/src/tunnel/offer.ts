import { base64urlDecode, base64urlEncode, randomBytes, utf8Decode, utf8Encode } from "./encoding.js";
import { hostIdFromKey } from "./keys.js";

export const DEFAULT_RELAY = "wss://relay.oxbit.dev";
export const OFFER_LINK_BASE = "https://oxbit.dev/c";
/** Pending offers expire after this many milliseconds on the host. */
export const OFFER_TTL_MS = 2 * 60 * 1000;

/** Pairing offer carried in the link fragment. Binary fields are base64url. */
export interface Offer {
  v: 1;
  /** Host id. */
  h: string;
  /** Host Ed25519 public key; hashes to `h`. */
  e: string;
  /** Host X25519 static public key. */
  x: string;
  /** Offer id, 8 bytes. */
  o: string;
  /** Pre-shared key, 32 bytes. */
  k: string;
  /** Relay base URL. */
  r: string;
  /** Host display name. */
  n: string;
  /** LAN addresses as `host:port`. */
  l?: string[];
}

export interface CreateOfferOptions {
  admissionKey: Uint8Array;
  staticKey: Uint8Array;
  name: string;
  relay?: string;
  lan?: string[];
}

/** Builds an offer with a fresh offer id and pre-shared key. */
export async function createOffer(options: CreateOfferOptions): Promise<Offer> {
  const offer: Offer = {
    v: 1,
    h: await hostIdFromKey(options.admissionKey),
    e: base64urlEncode(options.admissionKey),
    x: base64urlEncode(options.staticKey),
    o: base64urlEncode(randomBytes(8)),
    k: base64urlEncode(randomBytes(32)),
    r: options.relay ?? DEFAULT_RELAY,
    n: options.name,
  };
  if (options.lan?.length) offer.l = options.lan;
  return offer;
}

export function encodeOffer(offer: Offer): string {
  return base64urlEncode(utf8Encode(JSON.stringify(offer)));
}

function invalid(field: string): never {
  throw new Error(`Invalid pairing offer: ${field}`);
}

function binaryField(value: unknown, field: string, length: number): string {
  if (typeof value !== "string") invalid(field);
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(value);
  } catch {
    invalid(field);
  }
  if (bytes.length !== length) invalid(field);
  return value;
}

function isLanAddress(value: unknown): value is string {
  const match = typeof value === "string" ? /^(\[[0-9a-fA-F:.]+\]|[^\s:[\]/]+):(\d{1,5})$/.exec(value) : null;
  return match !== null && Number(match[2]) > 0 && Number(match[2]) <= 65535;
}

function isRelayUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return ["wss:", "ws:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Decodes and validates an offer string; throws when a field is invalid or `e` does not hash to `h`. */
export async function decodeOffer(text: string): Promise<Offer> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(utf8Decode(base64urlDecode(text.trim())));
  } catch {
    invalid("not base64url JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalid("not an object");
  if (raw.v !== 1) invalid("unsupported version");
  if (typeof raw.h !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(raw.h)) invalid("h");
  const offer: Offer = {
    v: 1,
    h: raw.h,
    e: binaryField(raw.e, "e", 32),
    x: binaryField(raw.x, "x", 32),
    o: binaryField(raw.o, "o", 8),
    k: binaryField(raw.k, "k", 32),
    r: isRelayUrl(raw.r) ? raw.r : invalid("r"),
    n: typeof raw.n === "string" ? raw.n : invalid("n"),
  };
  if (raw.l !== undefined) offer.l = Array.isArray(raw.l) && raw.l.every(isLanAddress) ? raw.l : invalid("l");
  if ((await hostIdFromKey(base64urlDecode(offer.e))) !== offer.h) invalid("host key does not match host id");
  return offer;
}

/** `<base>#o=<offer>`; the offer stays in the fragment so browsers do not send it to a server. */
export function offerLink(offer: Offer, base = OFFER_LINK_BASE): string {
  return `${base}#o=${encodeOffer(offer)}`;
}

/** Accepts `https://oxbit.dev/c#o=<offer>`, `oxbit://c#o=<offer>`, or a bare offer string. */
export function parseOfferLink(text: string): Promise<Offer> {
  const trimmed = text.trim();
  const hash = trimmed.indexOf("#");
  if (hash === -1) return decodeOffer(trimmed);
  const offer = new URLSearchParams(trimmed.slice(hash + 1)).get("o");
  return offer ? decodeOffer(offer) : Promise.reject(new Error("Invalid pairing link: missing o= in the fragment"));
}
