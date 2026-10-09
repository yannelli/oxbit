import { RuntimeClient } from "@oxbit/app-workbench";
import { native } from "@oxbit/host-ios";
import { RUNTIME_OUTPUT_SEPARATOR } from "@oxbit/protocol";

export function runtimeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("Enter the runtime's http:// or https:// address."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Use the runtime address without a path, password, or query string.");
  return url.origin;
}

export async function connectRuntime(address: string, code?: string, runtimeId?: string): Promise<RuntimeClient> {
  const url = runtimeUrl(address);
  const credential = await native.runtimeCredentials({
    operation: code?.trim() ? "pair" : "get", url, code: code?.trim(), runtimeId,
  });
  if (!credential.token) throw new Error("Enter the pairing code shown by the runtime on your computer.");
  const runtime = new RuntimeClient(url, "default", { token: credential.token, persistToken: false });
  try {
    await runtime.connect();
    return runtime;
  } catch (error) {
    runtime.dispose();
    throw new Error(await explainFailure(url, error));
  }
}

/** Says whether anything answered at the address when the WebSocket could not connect. */
async function explainFailure(url: string, error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (!/cannot connect|connection closed|timed out|failed to fetch|load failed/i.test(text)) return text;
  try {
    const { runtime } = await native.runtimeCredentials({ operation: "health", url });
    return `${runtime?.name ?? url} is running but did not accept this device. Pair it again with its pairing code.`;
  } catch (health) {
    return `No runtime answered at ${url}. Start one with oxbit --lan on your computer and check the address.` +
      RUNTIME_OUTPUT_SEPARATOR + (health instanceof Error ? health.message : String(health));
  }
}

export async function runtimeScope(runtime: RuntimeClient): Promise<string> {
  const identity = `runtime:${new URL(runtime.url).hostname}:${runtime.session?.workspaceKey ?? `${runtime.url}/${runtime.workspaceId}`}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return "ios:" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
