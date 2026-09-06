import { afterEach, expect, it, vi } from "vitest";
import type { FeatureOptions } from "@zapp/sdk";
import { DocumentService } from "@zapp/documents";
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
