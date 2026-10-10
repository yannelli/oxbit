import type { ACPContext } from "@oxbit/sdk";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Base64 characters per image; four images plus text stay under the 2 MiB runtime request limit. */
export const IMAGE_DATA_BUDGET = 225_000;
const MAX_EDGE = 1568;

export function imageError(
  file: { type: string; size: number },
  attached: number,
  accepted: boolean,
) {
  if (!accepted) return "This agent does not accept images";
  if (!IMAGE_TYPES.includes(file.type)) return "Attach PNG, JPEG, GIF or WebP images";
  if (file.size > MAX_IMAGE_BYTES) return "Images must be 5 MB or smaller";
  if (attached >= MAX_IMAGES) return "Attach up to 4 images per message";
  return undefined;
}

export function imageFiles(transfer: DataTransfer | null) {
  return [...(transfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
}

export function base64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function blobBase64(blob: Blob) {
  return base64(new Uint8Array(await blob.arrayBuffer()));
}

/** Re-encodes images above the transport budget at a smaller size. */
export async function encodeImage(file: Blob): Promise<{ mimeType: string; data: string }> {
  const data = await blobBase64(file);
  if (data.length <= IMAGE_DATA_BUDGET) return { mimeType: file.type, data };
  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const type of ["image/webp", "image/jpeg"]) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
        if (blob?.type !== type) continue;
        const encoded = await blobBase64(blob);
        if (encoded.length <= IMAGE_DATA_BUDGET) return { mimeType: type, data: encoded };
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("This image is too large to send");
}

export function imageContext(name: string, mimeType: string, data: string): ACPContext {
  const kilobytes = Math.max(1, Math.round((data.length * 3) / 4 / 1024));
  return {
    kind: "image",
    path: name || "image",
    label: name || "image",
    mimeType,
    data,
    text: `${mimeType} · ${kilobytes.toLocaleString()} KB`,
  };
}

/** Saved transcripts keep a placeholder in place of the image bytes. */
export function withoutImageData(context: ACPContext[]) {
  return context.map(({ data: _data, ...item }) => item);
}
