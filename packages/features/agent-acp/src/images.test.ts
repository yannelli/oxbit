import { describe, expect, it } from "vitest";
import { base64, encodeImage, imageContext, imageError, MAX_IMAGE_BYTES, withoutImageData } from "./images.js";
import { sendHint, sendsOnKey } from "./send-keys.js";

describe("image attachments", () => {
  it("validates capability, type, size and count", () => {
    const png = { type: "image/png", size: 1024 };
    expect(imageError(png, 0, false)).toBe("This agent does not accept images");
    expect(imageError(png, 0, true)).toBeUndefined();
    for (const type of ["image/jpeg", "image/gif", "image/webp"])
      expect(imageError({ type, size: 1 }, 3, true)).toBeUndefined();
    expect(imageError({ type: "image/svg+xml", size: 1 }, 0, true)).toBe("Attach PNG, JPEG, GIF or WebP images");
    expect(imageError({ type: "image/png", size: MAX_IMAGE_BYTES + 1 }, 0, true)).toBe("Images must be 5 MB or smaller");
    expect(imageError(png, 4, true)).toBe("Attach up to 4 images per message");
  });
  it("encodes small images unchanged and keeps a placeholder without bytes", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(base64(bytes)).toBe("iVBORw0KGgo=");
    expect(base64(new Uint8Array(70000).fill(65))).toBe(btoa("A".repeat(70000)));
    const encoded = await encodeImage(new Blob([bytes], { type: "image/png" }));
    expect(encoded).toEqual({ mimeType: "image/png", data: "iVBORw0KGgo=" });
    const context = imageContext("shot.png", encoded.mimeType, encoded.data);
    expect(context).toMatchObject({ kind: "image", path: "shot.png", mimeType: "image/png", data: "iVBORw0KGgo=" });
    expect(withoutImageData([context])[0]).not.toHaveProperty("data");
    expect(withoutImageData([context])[0].text).toBe("image/png · 1 KB");
  });
});

describe("send keys", () => {
  const key = (init: Partial<Parameters<typeof sendsOnKey>[0]>) =>
    ({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...init });
  const fine = { coarse: false, modifierOnly: false };
  it("sends on Enter with a fine pointer and keeps Shift+Enter as a newline", () => {
    expect(sendsOnKey(key({}), fine)).toBe(true);
    expect(sendsOnKey(key({ shiftKey: true }), fine)).toBe(false);
    expect(sendsOnKey(key({ ctrlKey: true }), fine)).toBe(true);
    expect(sendsOnKey(key({ metaKey: true }), fine)).toBe(true);
    expect(sendsOnKey(key({ key: "a" }), fine)).toBe(false);
  });
  it("never sends while composing text", () => {
    expect(sendsOnKey(key({ isComposing: true }), fine)).toBe(false);
    expect(sendsOnKey(key({ keyCode: 229, ctrlKey: true }), fine)).toBe(false);
  });
  it("uses modifier-only sending for the setting and coarse pointers", () => {
    for (const mode of [{ coarse: false, modifierOnly: true }, { coarse: true, modifierOnly: false }]) {
      expect(sendsOnKey(key({}), mode)).toBe(false);
      expect(sendsOnKey(key({ ctrlKey: true }), mode)).toBe(true);
    }
    expect(sendHint(fine)).toBe("Enter to send · Shift+Enter for new line");
    expect(sendHint({ coarse: false, modifierOnly: true })).toBe("Ctrl/Cmd+Enter to send");
    expect(sendHint({ coarse: true, modifierOnly: false })).toBeUndefined();
  });
});
