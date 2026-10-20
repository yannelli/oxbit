import { describe, expect, it } from "vitest";
import { base64urlDecode, bytesEqual, randomBytes, base64urlEncode } from "./encoding.js";
import { InitiatorHandshake, ResponderHandshake, type HostHello } from "./handshake.js";
import { deviceIdFromKey, generateEd25519KeyPair, generateX25519KeyPair, hostIdFromKey, type KeyPair } from "./keys.js";
import type { TransportCiphers } from "./noise-handshake.js";
import { createOffer, offerLink, parseOfferLink, type Offer } from "./offer.js";

async function hostSetup() {
  const admission = await generateEd25519KeyPair();
  const hostKey = await generateX25519KeyPair();
  const hello: HostHello = { v: 1, id: await hostIdFromKey(admission.publicKey), name: "Studio Mac" };
  const offer = await createOffer({ admissionKey: admission.publicKey, staticKey: hostKey.publicKey, name: hello.name });
  return { hostKey, hello, offer };
}

async function expectConnected(device: TransportCiphers, host: TransportCiphers) {
  expect(bytesEqual(device.handshakeHash, host.handshakeHash)).toBe(true);
  const empty = new Uint8Array(0);
  const up = await device.send.encryptWithAd(empty, new TextEncoder().encode("ping"));
  expect(new TextDecoder().decode(await host.receive.decryptWithAd(empty, up))).toBe("ping");
  const down = await host.send.encryptWithAd(empty, new TextEncoder().encode("pong"));
  expect(new TextDecoder().decode(await device.receive.decryptWithAd(empty, down))).toBe("pong");
}

describe("tunnel handshake", () => {
  it("pairs with IKpsk2, then reconnects with IK", async () => {
    const { hostKey, hello, offer } = await hostSetup();
    const pending = new Map([[offer.o, base64urlDecode(offer.k)]]);
    const devices = new Set<string>();
    const deviceKey = await generateX25519KeyPair();

    const scanned = await parseOfferLink(offerLink(offer));
    const pairing = await InitiatorHandshake.start({ deviceKey, name: "iPhone", offer: scanned });
    expect(pairing.message[0]).toBe(0x02);
    const accepted = await ResponderHandshake.accept(pairing.message, { hostKey });
    expect(accepted.pattern).toBe("IKpsk2");
    expect(accepted.device).toEqual({ v: 1, name: "iPhone", offer: offer.o });
    expect(accepted.deviceId).toBe(deviceIdFromKey(deviceKey.publicKey));
    const psk = pending.get(accepted.device.offer!);
    const reply = await accepted.reply(hello, psk);
    devices.add(accepted.deviceId);
    pending.delete(offer.o);
    const paired = await pairing.finish(reply.message);
    expect(paired.host).toEqual(hello);
    await expectConnected(paired.ciphers, reply.ciphers);

    const reconnect = await InitiatorHandshake.start({ deviceKey, name: "iPhone", hostKey: base64urlDecode(offer.x) });
    expect(reconnect.message[0]).toBe(0x01);
    const known = await ResponderHandshake.accept(reconnect.message, { hostKey });
    expect(known.pattern).toBe("IK");
    expect(known.device).toEqual({ v: 1, name: "iPhone" });
    expect(devices.has(known.deviceId)).toBe(true);
    const second = await known.reply(hello);
    const resumed = await reconnect.finish(second.message);
    expect(resumed.host).toEqual(hello);
    await expectConnected(resumed.ciphers, second.ciphers);
  });

  it("fails on the device when the psk is wrong", async () => {
    const { hostKey, hello, offer } = await hostSetup();
    const forged: Offer = { ...offer, k: base64urlEncode(randomBytes(32)) };
    const device = await InitiatorHandshake.start({ deviceKey: await generateX25519KeyPair(), name: "iPhone", offer: forged });
    const host = await ResponderHandshake.accept(device.message, { hostKey });
    const reply = await host.reply(hello, base64urlDecode(offer.k));
    await expect(device.finish(reply.message)).rejects.toThrow("failed authentication");
  });

  it("exposes an unknown device key before message 2", async () => {
    const { hostKey, offer } = await hostSetup();
    const paired = new Set([deviceIdFromKey((await generateX25519KeyPair()).publicKey)]);
    const stranger: KeyPair = await generateX25519KeyPair();
    const device = await InitiatorHandshake.start({ deviceKey: stranger, name: "Unknown", hostKey: base64urlDecode(offer.x) });
    const host = await ResponderHandshake.accept(device.message, { hostKey });
    expect(bytesEqual(host.deviceKey, stranger.publicKey)).toBe(true);
    expect(paired.has(host.deviceId)).toBe(false);
    expect(host.device.name).toBe("Unknown");
  });

  it("rejects tampered handshake messages and bad modes", async () => {
    const { hostKey, hello, offer } = await hostSetup();
    const deviceKey = await generateX25519KeyPair();
    const start = () => InitiatorHandshake.start({ deviceKey, name: "iPhone", hostKey: base64urlDecode(offer.x) });

    const first = await start();
    const tampered = Uint8Array.from(first.message);
    tampered[40] ^= 1;
    await expect(ResponderHandshake.accept(tampered, { hostKey })).rejects.toThrow("failed authentication");
    await expect(ResponderHandshake.accept(Uint8Array.of(0x03, ...first.message.subarray(1)), { hostKey })).rejects.toThrow("Unknown tunnel handshake mode");
    await expect(ResponderHandshake.accept(first.message, { hostKey: await generateX25519KeyPair() })).rejects.toThrow("failed authentication");

    const device = await start();
    const host = await ResponderHandshake.accept(device.message, { hostKey });
    await expect(host.reply(hello, randomBytes(32))).rejects.toThrow("IK takes no psk");
    const { message } = await host.reply(hello);
    message[message.length - 1] ^= 1;
    await expect(device.finish(message)).rejects.toThrow("failed authentication");
  });

  it("requires a psk to answer IKpsk2", async () => {
    const { hostKey, hello, offer } = await hostSetup();
    const device = await InitiatorHandshake.start({ deviceKey: await generateX25519KeyPair(), name: "iPhone", offer });
    const host = await ResponderHandshake.accept(device.message, { hostKey });
    await expect(host.reply(hello)).rejects.toThrow("IKpsk2 needs a psk");
  });
});
