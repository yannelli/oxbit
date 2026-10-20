import { describe, expect, it } from "vitest";
import vectors from "./cacophony-vectors.json";
import { hexDecode, hexEncode } from "./encoding.js";
import { keyPairFromRawPrivate } from "./keys.js";
import { HandshakeState, NOISE_PROTOCOLS, type NoisePattern } from "./noise-handshake.js";

// Vectors copied from https://raw.githubusercontent.com/mcginty/snow/main/tests/vectors/cacophony.txt
// (cacophony format), filtered to the two protocols the tunnel uses.
const patternOf = (name: string) => (Object.keys(NOISE_PROTOCOLS) as NoisePattern[]).find((pattern) => NOISE_PROTOCOLS[pattern] === name)!;
const x25519 = (hex: string) => keyPairFromRawPrivate("X25519", hexDecode(hex));

describe("Noise test vectors", () => {
  it("covers both tunnel protocols", () => {
    expect(vectors.map((vector) => vector.protocol_name).sort()).toEqual(Object.values(NOISE_PROTOCOLS).sort());
  });

  for (const vector of vectors) {
    it(`replays ${vector.protocol_name} byte for byte`, async () => {
      const pattern = patternOf(vector.protocol_name);
      const { init_psks: initPsks, resp_psks: respPsks } = vector as { init_psks?: string[]; resp_psks?: string[] };
      const initStatic = await x25519(vector.init_static);
      const initiator = await HandshakeState.create({
        pattern,
        initiator: true,
        prologue: hexDecode(vector.init_prologue),
        staticKey: initStatic,
        remoteStatic: hexDecode(vector.init_remote_static),
        ephemeral: await x25519(vector.init_ephemeral),
        psk: initPsks && hexDecode(initPsks[0]),
      });
      const responder = await HandshakeState.create({
        pattern,
        initiator: false,
        prologue: hexDecode(vector.resp_prologue),
        staticKey: await x25519(vector.resp_static),
        ephemeral: await x25519(vector.resp_ephemeral),
      });
      const [first, second, ...transport] = vector.messages;

      expect(hexEncode(await initiator.writeMessage(hexDecode(first.payload)))).toBe(first.ciphertext);
      expect(hexEncode(await responder.readMessage(hexDecode(first.ciphertext)))).toBe(first.payload);
      expect(hexEncode(responder.remoteStatic!)).toBe(hexEncode(initStatic.publicKey));
      if (respPsks) responder.psk = hexDecode(respPsks[0]);
      expect(hexEncode(await responder.writeMessage(hexDecode(second.payload)))).toBe(second.ciphertext);
      expect(hexEncode(await initiator.readMessage(hexDecode(second.ciphertext)))).toBe(second.payload);

      expect(hexEncode(initiator.handshakeHash)).toBe(vector.handshake_hash);
      expect(hexEncode(responder.handshakeHash)).toBe(vector.handshake_hash);
      const sides = [await initiator.split(), await responder.split()];
      for (const [index, message] of transport.entries()) {
        const [sender, receiver] = index % 2 === 0 ? sides : [sides[1], sides[0]];
        const ciphertext = await sender.send.encryptWithAd(new Uint8Array(0), hexDecode(message.payload));
        expect(hexEncode(ciphertext)).toBe(message.ciphertext);
        expect(hexEncode(await receiver.receive.decryptWithAd(new Uint8Array(0), ciphertext))).toBe(message.payload);
      }
    });
  }

  it("rejects a tampered handshake message", async () => {
    const vector = vectors[0];
    const responder = await HandshakeState.create({
      pattern: "IK",
      initiator: false,
      prologue: hexDecode(vector.resp_prologue),
      staticKey: await x25519(vector.resp_static),
    });
    const message = hexDecode(vector.messages[0].ciphertext);
    message[message.length - 1] ^= 1;
    await expect(responder.readMessage(message)).rejects.toThrow("failed authentication");
  });
});
