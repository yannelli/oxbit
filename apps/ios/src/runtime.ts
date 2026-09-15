import { RuntimeClient } from "@oxbit/app-workbench";
import { native } from "@oxbit/host-ios";

export function runtimeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("Enter the runtime's http:// or https:// address."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Use the runtime address without a path, password, or query string.");
  return url.origin;
}

export async function connectRuntime(address: string, code?: string): Promise<RuntimeClient> {
  const url = runtimeUrl(address);
  const credential = await native.runtimeCredentials({
    operation: code?.trim() ? "pair" : "get", url, code: code?.trim(),
  });
  if (!credential.token) throw new Error("Enter the pairing code shown by the runtime on your computer.");
  const runtime = new RuntimeClient(url, "default", { token: credential.token, persistToken: false });
  try {
    await runtime.connect();
    return runtime;
  } catch (error) {
    runtime.dispose();
    throw error;
  }
}

export async function runtimeScope(runtime: RuntimeClient): Promise<string> {
  const identity = `runtime:${new URL(runtime.url).hostname}:${runtime.session?.workspaceKey ?? `${runtime.url}/${runtime.workspaceId}`}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return "ios:" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
