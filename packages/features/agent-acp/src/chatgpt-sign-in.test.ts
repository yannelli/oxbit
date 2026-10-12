import { describe, expect, it, vi } from "vitest";
import type { ChatGPTDeviceCode, ChatGPTSignIn } from "@oxbit/sdk";
import { SIGN_IN_EXPIRED, delay, waitForSignIn } from "./chatgpt-sign-in.js";

const device: ChatGPTDeviceCode = { deviceAuthId: "auth", userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device", interval: 5, expiresAt: 60000 };
function fake(states: ("pending" | "slow_down" | "complete")[]) {
  let time = 0;
  const waits: number[] = [];
  const signIn: ChatGPTSignIn = { start: async () => device, poll: vi.fn(async () => states.shift() ?? "pending") };
  const clock = { now: () => time, sleep: async (ms: number) => void (waits.push(ms), (time += ms)) };
  return { signIn, clock, waits };
}

describe("waitForSignIn", () => {
  it("polls every interval and adds 5 s after slow_down until complete", async () => {
    const { signIn, clock, waits } = fake(["pending", "slow_down", "pending", "complete"]);
    await waitForSignIn(signIn, device, new AbortController().signal, clock);
    expect(waits).toEqual([5000, 5000, 10000, 10000]);
    expect(signIn.poll).toHaveBeenCalledTimes(4);
  });
  it("rejects once expiresAt passes", async () => {
    const { signIn, clock } = fake([]);
    await expect(waitForSignIn(signIn, device, new AbortController().signal, clock)).rejects.toThrow(SIGN_IN_EXPIRED);
    expect(signIn.poll).toHaveBeenCalledTimes(11);
  });
  it("stops waiting when the signal aborts", async () => {
    const controller = new AbortController();
    const signIn: ChatGPTSignIn = { start: async () => device, poll: vi.fn(async () => "pending" as const) };
    const waiting = waitForSignIn(signIn, { ...device, interval: 60 }, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    expect(signIn.poll).not.toHaveBeenCalled();
    await expect(delay(1, AbortSignal.abort())).rejects.toThrow();
  });
});
