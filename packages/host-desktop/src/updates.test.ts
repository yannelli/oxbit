import { afterEach, describe, expect, it, vi } from "vitest";
import { UPDATE_INTERVAL, watchUpdates, type UpdateStatus } from "./updates.js";

describe("automatic update checks", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks at launch and every hour, and announces each new version once", async () => {
    vi.useFakeTimers();
    let latest: UpdateStatus = { status: "current" };
    const check = vi.fn(async () => latest);
    const announce = vi.fn();
    const stop = watchUpdates({ check, enabled: () => true, announce });
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    expect(announce).not.toHaveBeenCalled();

    latest = { status: "available", version: "0.12.0" };
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL);
    expect(check).toHaveBeenCalledTimes(3);
    expect(announce.mock.calls).toEqual([[{ status: "available", version: "0.12.0" }]]);

    latest = { status: "available", version: "0.12.1" };
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL);
    expect(announce).toHaveBeenLastCalledWith({ status: "available", version: "0.12.1" });

    stop();
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL * 2);
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("skips checks while the setting is off and stays quiet on errors", async () => {
    vi.useFakeTimers();
    let enabled = false;
    const check = vi.fn(async (): Promise<UpdateStatus> => {
      throw new Error("offline");
    });
    const announce = vi.fn();
    const stop = watchUpdates({ check, enabled: () => enabled, announce });
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL);
    expect(check).not.toHaveBeenCalled();

    enabled = true;
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL);
    expect(check).toHaveBeenCalledTimes(1);
    expect(announce).not.toHaveBeenCalled();
    stop();
  });
});
