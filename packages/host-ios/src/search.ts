import type { WorkspaceSearchOptions, WorkspaceSearchResult } from "@oxbit/sdk";
import { search } from "./native.js";

async function request<T>(id: string, method: "search" | "files", params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const cancel = () => void search.cancel(id, requestId).catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await search.request<T>(id, requestId, method, params);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/** Content search on a device root, run by the Rust host with ripgrep's walker and matcher. */
export function searchRoot(id: string, options: WorkspaceSearchOptions, signal?: AbortSignal): Promise<WorkspaceSearchResult> {
  const { query, caseSensitive, wholeWord, regex, include, exclude } = options;
  return request(id, "search", { query, caseSensitive, wholeWord, regex, include, exclude }, signal);
}

/** Quick-open paths on a device root, filtered natively with the workbench's subsequence test. */
export function findRootFiles(id: string, query: string, signal?: AbortSignal): Promise<string[]> {
  return request(id, "files", { query }, signal);
}
