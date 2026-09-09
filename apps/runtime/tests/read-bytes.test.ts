import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { READ_CHUNK_BYTES } from "@oxbit/protocol";
import { WorkspaceFiles } from "../src/filesystem.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-bytes-")); roots.push(root);
  return { root, files: new WorkspaceFiles(root) };
}
const collect = async (files: WorkspaceFiles, name: string) => {
  const parts: Buffer[] = [];
  let total = 0, size = 0, token: string | undefined;
  do {
    const chunk = await files.readBytes(name, total, READ_CHUNK_BYTES);
    expect(token === undefined || chunk.token === token).toBe(true);
    token = chunk.token; size = chunk.size;
    const bytes = Buffer.from(chunk.base64, "base64");
    expect(bytes.length).toBeLessThanOrEqual(READ_CHUNK_BYTES);
    parts.push(bytes); total += bytes.length;
  } while (total < size);
  return { bytes: Buffer.concat(parts), requests: parts.length };
};

it("returns bytes that a text read cannot represent, in bounded chunks", async () => {
  const { root, files } = await workspace();
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(Array.from({ length: 3000 }, (_, index) => index % 256)),
  ]);
  await fs.writeFile(path.join(root, "logo.png"), png);
  await expect(files.read("logo.png")).rejects.toMatchObject({ code: "ENCODING" });
  const single = await collect(files, "logo.png");
  expect(single.requests).toBe(1);
  expect(single.bytes.equals(png)).toBe(true);

  const large = Buffer.alloc(READ_CHUNK_BYTES * 2 + 17, 0xab);
  large.write("edge", large.length - 4);
  await fs.writeFile(path.join(root, "large.bin"), large);
  const chunked = await collect(files, "large.bin");
  expect(chunked.requests).toBe(3);
  expect(chunked.bytes.equals(large)).toBe(true);
});

it("reports a fresh token after a write so a partial read is not stitched together", async () => {
  const { root, files } = await workspace();
  await fs.writeFile(path.join(root, "icon.svg"), "<svg/>");
  const before = await files.readBytes("icon.svg", 0, READ_CHUNK_BYTES);
  await fs.writeFile(path.join(root, "icon.svg"), "<svg viewBox='0 0 2 2'/>");
  const after = await files.readBytes("icon.svg", 0, READ_CHUNK_BYTES);
  expect(after.token).not.toBe(before.token);
  expect(Buffer.from(after.base64, "base64").toString()).toBe("<svg viewBox='0 0 2 2'/>");
});

it("reads an empty file and rejects offsets and lengths outside the file", async () => {
  const { root, files } = await workspace();
  await fs.writeFile(path.join(root, "empty.png"), "");
  expect(await files.readBytes("empty.png", 0, READ_CHUNK_BYTES)).toMatchObject({ base64: "", size: 0 });
  await expect(files.readBytes("empty.png", 1, READ_CHUNK_BYTES)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  await expect(files.readBytes("empty.png", 0, 0)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  await fs.mkdir(path.join(root, "assets"));
  await expect(files.readBytes("assets", 0, READ_CHUNK_BYTES)).rejects.toMatchObject({ code: "NOT_FILE" });
  await expect(files.readBytes("../outside.png", 0, READ_CHUNK_BYTES)).rejects.toMatchObject({ code: "PATH_DENIED" });
});
