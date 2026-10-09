import { afterEach, expect, it, vi } from "vitest";
import type { FeatureOptions } from "@oxbit/sdk";
import { DocumentService } from "@oxbit/documents";
import {
  BrowserFileSystem,
  MemoryPersistence,
} from "../../../host-browser/src/index";
import { SearchService } from "./service";
import { searchText, type SearchOptions } from "./engine";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.unstubAllGlobals();
});
const setup = async () => {
  const filesystem = new BrowserFileSystem(new MemoryPersistence());
  await filesystem.write("first.txt", "match one", { expectedRevision: null });
  await filesystem.write("second.txt", "match two", { expectedRevision: null });
  const documents = new DocumentService(filesystem, new MemoryPersistence());
  const search = new SearchService({ filesystem, documents } as FeatureOptions);
  cleanup.push(() => {
    search.dispose();
    documents.dispose();
    filesystem.dispose();
  });
  return { filesystem, documents, search };
};
it("applies replacements per file and preserves newer unsaved buffers on partial failure", async () => {
  const { filesystem, documents, search } = await setup();
  const a = await documents.open("first.txt");
  const b = await documents.open("second.txt");
  const options = { query: "match" };
  const matches = [a, b].flatMap((doc) =>
    searchText(
      doc.path,
      doc.text.toString(),
      doc.savedRevision,
      options,
      doc.version,
    ),
  );
  const preview = await search.preview(matches, options, "updated");
  a.replace("newer unsaved content");
  const result = await search.apply(preview);
  expect(result.applied).toBe(1);
  expect(result.failures).toEqual([
    expect.objectContaining({ path: "first.txt" }),
  ]);
  expect(a.text.toString()).toBe("newer unsaved content");
  expect(b.text.toString()).toBe("updated two");
  expect((await filesystem.read("second.txt")).text).toBe("match two");
});
it("rejects stale replacement previews", async () => {
  const { documents, search } = await setup();
  const doc = await documents.open("first.txt");
  const matches = searchText(
    doc.path,
    doc.text.toString(),
    doc.savedRevision,
    { query: "match" },
    doc.version,
  );
  doc.replace("another match");
  await expect(
    search.preview(matches, { query: "match" }, "new"),
  ).rejects.toThrow("changed");
});
it("terminates in-flight worker searches on feature disposal", async () => {
  const terminated = vi.fn();
  const posted = vi.fn();
  vi.stubGlobal(
    "Worker",
    class {
      postMessage = posted;
      terminate = terminated;
    },
  );
  const { search } = await setup();
  const result = search.search({ query: "match" });
  await vi.waitFor(() => expect(posted).toHaveBeenCalled());
  search.dispose();
  await expect(result).rejects.toThrow();
  expect(terminated).toHaveBeenCalledOnce();
});
it("reports unreadable files while returning searchable files", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      onmessage?: (event: any) => void;
      terminate() {}
      postMessage({
        files,
        options,
      }: {
        files: any[];
        options: SearchOptions;
      }) {
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              results: files.flatMap((file) =>
                searchText(file.path, file.text, file.revision, options),
              ),
            },
          }),
        );
      }
    },
  );
  const { filesystem, search } = await setup();
  const read = filesystem.read.bind(filesystem);
  vi.spyOn(filesystem, "read").mockImplementation((path) =>
    path === "first.txt"
      ? Promise.reject(new Error("Permission denied"))
      : read(path),
  );
  expect(
    (await search.search({ query: "match" })).map((match) => match.path),
  ).toEqual(["second.txt"]);
  expect(search.warnings).toEqual([
    expect.stringContaining("Permission denied"),
  ]);
});
function stubWorker() {
  vi.stubGlobal(
    "Worker",
    class {
      onmessage?: (event: any) => void;
      terminate() {}
      postMessage({ files, options }: { files: any[]; options: SearchOptions }) {
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              results: files.flatMap((file) =>
                searchText(file.path, file.text, file.revision, options, file.version),
              ),
            },
          }),
        );
      }
    },
  );
}
it("prefers the runtime, then filesystem search, then the worker walk", async () => {
  stubWorker();
  const { filesystem, documents } = await setup();
  const native = {
    path: "native.txt", line: 1, column: 1, from: 0, to: 5, text: "match", revision: "r",
  };
  const nativeSearch = vi.fn(async () => ({ matches: [native], truncated: true }));
  const list = vi.spyOn(filesystem, "list");
  const withNative = Object.assign(Object.create(filesystem), { search: nativeSearch });
  const runtime = { connected: true, request: vi.fn(async () => [{ ...native, path: "runtime.txt" }]) };
  const remote = new SearchService({ filesystem: withNative, documents, runtime } as unknown as FeatureOptions);
  expect((await remote.search({ query: "match" })).map((m) => m.path)).toEqual(["runtime.txt"]);
  expect(nativeSearch).not.toHaveBeenCalled();
  const local = new SearchService({ filesystem: withNative, documents } as unknown as FeatureOptions);
  expect((await local.search({ query: "match", regex: true })).map((m) => m.path)).toEqual(["native.txt"]);
  expect(nativeSearch).toHaveBeenCalledWith(expect.objectContaining({ query: "match", regex: true }), expect.any(AbortSignal));
  expect(local.truncated).toBe(true);
  expect(list).not.toHaveBeenCalled();
  const walk = new SearchService({ filesystem, documents } as FeatureOptions);
  expect((await walk.search({ query: "match" })).map((m) => m.path)).toEqual(["first.txt", "second.txt"]);
  expect(list).toHaveBeenCalled();
});
it("re-searches dirty documents over native results", async () => {
  stubWorker();
  const { filesystem, documents } = await setup();
  const doc = await documents.open("first.txt");
  doc.replace("no hit, then match and match");
  const stale = { path: "first.txt", line: 1, column: 1, from: 0, to: 5, text: "match one", revision: doc.savedRevision };
  const native = Object.assign(Object.create(filesystem), {
    search: vi.fn(async () => ({ matches: [stale], truncated: false })),
  });
  const search = new SearchService({ filesystem: native, documents } as unknown as FeatureOptions);
  const matches = await search.search({ query: "match" });
  expect(matches.map((m) => [m.path, m.from, m.version])).toEqual([
    ["first.txt", 13, doc.version],
    ["first.txt", 23, doc.version],
  ]);
});
