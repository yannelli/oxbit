import { describe, expect, it } from "vitest";
import { base64urlDecode, base64urlEncode, bytesEqual, hexEncode, randomBytes, utf8Encode } from "./encoding.js";
import {
  exportKeyPair,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  hostIdFromKey,
  importKeyPair,
  sha256,
  signRelayChallenge,
  verifyRelayChallenge,
  x25519,
} from "./keys.js";
import { createOffer, decodeOffer, encodeOffer, offerLink, parseOfferLink, type Offer } from "./offer.js";

async function sampleOffer(lan?: string[]): Promise<Offer> {
  const admission = await generateEd25519KeyPair();
  const host = await generateX25519KeyPair();
  return createOffer({ admissionKey: admission.publicKey, staticKey: host.publicKey, name: "Studio Mac", lan });
}

const encodeJson = (value: unknown) => base64urlEncode(utf8Encode(JSON.stringify(value)));

describe("base64url", () => {
  it("round-trips every length without padding", () => {
    for (let length = 0; length < 40; length++) {
      const bytes = randomBytes(length);
      const text = base64urlEncode(bytes);
      expect(text).toBe(Buffer.from(bytes).toString("base64url"));
      expect(bytesEqual(base64urlDecode(text), bytes)).toBe(true);
    }
  });

  it("rejects padding, other alphabets, and impossible lengths", () => {
    expect(() => base64urlDecode("AA==")).toThrow("character");
    expect(() => base64urlDecode("A+/A")).toThrow("character");
    expect(() => base64urlDecode("AAAAA")).toThrow("length");
    expect(() => base64urlDecode("AB")).toThrow("trailing bits");
  });
});

describe("keys", () => {
  it("exports and imports both key types", async () => {
    for (const [name, generate] of [["X25519", generateX25519KeyPair], ["Ed25519", generateEd25519KeyPair]] as const) {
      const pair = await generate();
      const stored = await exportKeyPair(pair);
      expect(base64urlDecode(stored.publicKey)).toHaveLength(32);
      const restored = await importKeyPair(name, stored);
      expect(bytesEqual(restored.publicKey, pair.publicKey)).toBe(true);
      const other = await exportKeyPair(await generate());
      await expect(importKeyPair(name, { ...stored, publicKey: other.publicKey })).rejects.toThrow("does not match");
    }
  });

  it("agrees on X25519 secrets after a restore", async () => {
    const a = await generateX25519KeyPair();
    const b = await importKeyPair("X25519", await exportKeyPair(await generateX25519KeyPair()));
    expect(hexEncode(await x25519(a.privateKey, b.publicKey))).toBe(hexEncode(await x25519(b.privateKey, a.publicKey)));
  });

  it("derives the host id from the Ed25519 key", async () => {
    const { publicKey } = await generateEd25519KeyPair();
    const id = await hostIdFromKey(publicKey);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(id).toBe(base64urlEncode(await sha256(publicKey)).slice(0, 22));
  });

  it("signs and verifies the relay challenge", async () => {
    const pair = await importKeyPair("Ed25519", await exportKeyPair(await generateEd25519KeyPair()));
    const hostId = await hostIdFromKey(pair.publicKey);
    const nonce = base64urlEncode(randomBytes(32));
    const sig = await signRelayChallenge(pair.privateKey, hostId, nonce);
    expect(await verifyRelayChallenge(pair.publicKey, hostId, nonce, sig)).toBe(true);
    expect(await verifyRelayChallenge(pair.publicKey, hostId, base64urlEncode(randomBytes(32)), sig)).toBe(false);
    expect(await verifyRelayChallenge((await generateEd25519KeyPair()).publicKey, hostId, nonce, sig)).toBe(false);
    expect(await verifyRelayChallenge(pair.publicKey, hostId, nonce, "not*base64")).toBe(false);
  });
});

describe("offers", () => {
  it("round-trips through every link form", async () => {
    const offer = await sampleOffer(["192.168.1.20:9280", "[fe80::1]:9280"]);
    const encoded = encodeOffer(offer);
    expect(await decodeOffer(encoded)).toEqual(offer);
    expect(offerLink(offer)).toBe(`https://oxbit.dev/c#o=${encoded}`);
    for (const text of [offerLink(offer), offerLink(offer, "oxbit://c"), encoded, `  \n${offerLink(offer)}\t `]) {
      expect(await parseOfferLink(text)).toEqual(offer);
    }
    expect(base64urlDecode(offer.o)).toHaveLength(8);
    expect(base64urlDecode(offer.k)).toHaveLength(32);
    expect(offer.r).toBe("wss://relay.oxbit.dev");
  });

  it("rejects a host key that does not hash to the host id", async () => {
    const offer = await sampleOffer();
    const other = await sampleOffer();
    await expect(decodeOffer(encodeOffer({ ...offer, e: other.e }))).rejects.toThrow("host key does not match host id");
    await expect(parseOfferLink(offerLink({ ...offer, h: other.h }))).rejects.toThrow("host key does not match host id");
  });

  it("rejects malformed fields", async () => {
    const offer = await sampleOffer();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...offer, v: 2 }, "unsupported version"],
      [{ ...offer, h: "short" }, ": h"],
      [{ ...offer, x: base64urlEncode(randomBytes(31)) }, ": x"],
      [{ ...offer, o: base64urlEncode(randomBytes(16)) }, ": o"],
      [{ ...offer, k: "!!" }, ": k"],
      [{ ...offer, r: "https://relay.oxbit.dev" }, ": r"],
      [{ ...offer, n: 5 }, ": n"],
      [{ ...offer, l: ["no-port"] }, ": l"],
      [{ ...offer, l: ["host:70000"] }, ": l"],
    ];
    for (const [value, message] of cases) await expect(decodeOffer(encodeJson(value))).rejects.toThrow(message);
    await expect(decodeOffer("%%%")).rejects.toThrow("not base64url JSON");
    await expect(decodeOffer(encodeJson([offer]))).rejects.toThrow("not an object");
    await expect(parseOfferLink("https://oxbit.dev/c#x=1")).rejects.toThrow("missing o=");
  });
});
