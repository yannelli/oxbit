import { describe, expect, it, vi } from "vitest";
import { desktopRemoteAccess, type Invoke, type Listen } from "./remote-access.js";

const offer = { link: "https://oxbit.dev/c#o=abc", expiresAt: 1_000, host: { id: "h1", name: "studio" } };
type Payload = { request: string; line: Record<string, unknown> };

function fakes(answer: (args: Record<string, unknown>, emit: (line: Record<string, unknown>) => void) => Promise<unknown[]>) {
  let handler: ((event: { payload: Payload }) => void) | undefined;
  const unlisten = vi.fn();
  const listen = vi.fn(async (_event: string, next: (event: { payload: Payload }) => void) => {
    handler = next;
    return unlisten;
  }) as unknown as Listen;
  const invoke = vi.fn(async (_command: string, args: Record<string, unknown> = {}) =>
    answer(args, (line) => handler?.({ payload: { request: args.request as string, line } }))) as unknown as Invoke;
  return { invoke, listen, unlisten, emitOther: (line: Record<string, unknown>) => handler?.({ payload: { request: "other", line } }) };
}

describe("desktop remote access", () => {
  it("maps actions to the desktop_remote_access command", async () => {
    const status = { enabled: true, running: true, hostId: "h1", name: "studio", relay: { url: "wss://relay.oxbit.dev", connected: true }, lan: { port: 4100, addresses: ["10.0.0.2:4100"] }, devices: [] };
    const { invoke, listen } = fakes(async (args) => (args.action === "status" ? [status] : [{}]));
    const remote = desktopRemoteAccess(invoke, listen);
    expect(await remote.status()).toEqual(status);
    await remote.enable();
    await remote.disable();
    await remote.revoke("dev-1");
    expect(vi.mocked(invoke).mock.calls.map(([, args]) => args)).toEqual([
      { action: "status" },
      { action: "enable" },
      { action: "disable" },
      { action: "revoke", device: "dev-1" },
    ]);
  });

  it("streams the link for its own request and resolves with the paired device", async () => {
    const { invoke, listen, unlisten, emitOther } = fakes(async (args, emit) => {
      emitOther({ ...offer, link: "https://oxbit.dev/c#o=other" });
      emit(offer);
      return [offer, { paired: { id: "d1", name: "iPhone" } }];
    });
    const onOffer = vi.fn();
    const result = await desktopRemoteAccess(invoke, listen).pair(onOffer);
    expect(result).toEqual({ paired: { id: "d1", name: "iPhone" } });
    expect(onOffer.mock.calls).toEqual([[offer]]);
    expect(listen).toHaveBeenCalledBefore(vi.mocked(invoke));
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("uses the returned lines when no event arrived and reports expiry", async () => {
    const { invoke, listen } = fakes(async () => [offer, { expired: true }]);
    const onOffer = vi.fn();
    expect(await desktopRemoteAccess(invoke, listen).pair(onOffer)).toEqual({ expired: true });
    expect(onOffer).toHaveBeenCalledWith(offer);
  });

  it("cancels the CLI when the signal aborts", async () => {
    let finish: (lines: unknown[]) => void = () => {};
    const { invoke, listen } = fakes(async (args) => (args.action === "pair" ? new Promise((resolve) => (finish = resolve)) : []));
    const controller = new AbortController();
    const pairing = desktopRemoteAccess(invoke, listen).pair(() => {}, controller.signal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    controller.abort();
    expect(invoke).toHaveBeenLastCalledWith("desktop_remote_access", { action: "cancel" });
    finish([offer]);
    await expect(pairing).rejects.toThrow(/abort/i);
  });

  it("rejects when the CLI stops without an outcome", async () => {
    const { invoke, listen } = fakes(async () => [offer]);
    await expect(desktopRemoteAccess(invoke, listen).pair(() => {})).rejects.toThrow("Pairing stopped before a device paired");
  });
});
