import type { ChatGPTDeviceCode, ChatGPTSignIn } from "@oxbit/sdk";

export const SIGN_IN_EXPIRED = "The sign-in code expired. Sign in again.";
const SLOW_DOWN_SECONDS = 5;

export function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Polls every `device.interval` seconds, 5 s longer after each `slow_down`, until `complete`. Rejects once `expiresAt` passes. */
export async function waitForSignIn(signIn: ChatGPTSignIn, device: ChatGPTDeviceCode, signal: AbortSignal,
  clock: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> } = { now: Date.now, sleep: delay }) {
  let interval = device.interval;
  for (;;) {
    await clock.sleep(interval * 1000, signal);
    if (clock.now() >= device.expiresAt) throw new Error(SIGN_IN_EXPIRED);
    const state = await signIn.poll(device, signal);
    if (state === "complete") return;
    if (state === "slow_down") interval += SLOW_DOWN_SECONDS;
  }
}
