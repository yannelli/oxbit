import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuthStore, FileCatalogCache } from "./auth.js";
import { tempDir } from "./testing.js";

describe("FileAuthStore", () => {
  it("writes auth.json with mode 0600 and keeps entries from concurrent writes", async () => {
    const home = await tempDir("oxa-auth-");
    const path = join(home, "auth.json");
    const store = new FileAuthStore(path);
    await Promise.all(Array.from({ length: 8 }, (_, index) => store.set(`apikey:p${index}`, `k${index}`)));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(await readFile(path, "utf8")))).toHaveLength(8);
    expect(await new FileAuthStore(path).get("apikey:p3")).toBe("k3");
    await store.delete("apikey:p3");
    expect(await store.get("apikey:p3")).toBeUndefined();
    expect((await readdir(home)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reads the earlier {<id>: {type: \"api\", key}} entries and migrates them on save or delete", async () => {
    const path = join(await tempDir("oxa-auth-"), "auth.json");
    await writeFile(path, JSON.stringify({ anthropic: { type: "api", key: "sk-old" }, openai: { type: "api", key: "sk-o" }, other: { type: "oauth" } }));
    const store = new FileAuthStore(path);
    expect(await store.get("apikey:anthropic")).toBe("sk-old");
    expect(await store.keys()).toEqual(["apikey:anthropic", "apikey:openai"]);
    await store.set("apikey:anthropic", "sk-new");
    await store.delete("apikey:openai");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ other: { type: "oauth" }, "apikey:anthropic": "sk-new" });
  });

  it("runs locked tasks for one key one at a time", async () => {
    const store = new FileAuthStore(join(await tempDir("oxa-auth-"), "auth.json"));
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`${name} end`);
      return name;
    };
    expect(await Promise.all([store.lock("chatgpt", task("a")), store.lock("chatgpt", task("b"))])).toEqual(["a", "b"]);
    expect(order).toEqual(["a start", "a end", "b start", "b end"]);
    await expect(store.lock("chatgpt", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(await store.lock("chatgpt", async () => "after")).toBe("after");
  });
});

describe("FileCatalogCache", () => {
  it("stores entries as files and reports the save time", async () => {
    const dir = join(await tempDir("oxa-cache-"), "cache");
    const cache = new FileCatalogCache(dir);
    expect(await cache.get("models.dev")).toBeUndefined();
    const before = Date.now();
    await cache.set("models.dev", "{\"a\":1}");
    const entry = await cache.get("models.dev");
    expect(entry?.text).toBe("{\"a\":1}");
    expect(entry!.savedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(await readdir(dir)).toEqual(["models.dev.json"]);
  });
});
