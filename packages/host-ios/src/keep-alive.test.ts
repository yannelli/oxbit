import { describe, expect, it, vi } from "vitest";
import { BackgroundKeepAlive, type BackgroundLocationResult } from "./keep-alive.js";

function setup(authorization: BackgroundLocationResult["authorization"] = "granted") {
  let visible = true;
  const request = vi.fn(async (enabled: boolean): Promise<BackgroundLocationResult> =>
    ({ active: enabled && authorization === "granted", authorization }));
  const denied = vi.fn();
  const keepAlive = new BackgroundKeepAlive(request, () => visible, denied);
  return { keepAlive, request, denied, hide: () => { visible = false; }, show: () => { visible = true; } };
}

describe("BackgroundKeepAlive", () => {
  it("runs only while the setting is on and a connection or agent turn is open", async () => {
    const { keepAlive, request } = setup();
    await keepAlive.update({ connected: true });
    expect(request).not.toHaveBeenCalled();
    await keepAlive.update({ enabled: true });
    expect(request.mock.calls).toEqual([[true]]);
    await keepAlive.update({ working: true });
    await keepAlive.update({ connected: false });
    expect(request.mock.calls).toEqual([[true]]);
    await keepAlive.update({ working: false });
    expect(request.mock.calls).toEqual([[true], [false]]);
    await keepAlive.update({ working: true });
    await keepAlive.update({ enabled: false });
    expect(request.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("waits for the app to be visible before starting and stops while hidden", async () => {
    const { keepAlive, request, hide, show } = setup();
    hide();
    await keepAlive.update({ enabled: true, working: true });
    expect(request).not.toHaveBeenCalled();
    show();
    await keepAlive.visible();
    expect(request.mock.calls).toEqual([[true]]);
    hide();
    await keepAlive.update({ working: false });
    expect(request.mock.calls).toEqual([[true], [false]]);
  });

  it("reports a denied permission once and retries after the setting is turned on again", async () => {
    const { keepAlive, request, denied } = setup("denied");
    await keepAlive.update({ enabled: true, connected: true });
    await keepAlive.update({ working: true });
    await keepAlive.visible();
    expect(request.mock.calls).toEqual([[true]]);
    expect(denied).toHaveBeenCalledTimes(1);
    await keepAlive.update({ enabled: false });
    await keepAlive.update({ enabled: true });
    expect(request.mock.calls).toEqual([[true], [true]]);
  });

  it("stops on dispose", async () => {
    const { keepAlive, request } = setup();
    await keepAlive.update({ enabled: true, connected: true });
    await keepAlive.dispose();
    expect(request.mock.calls).toEqual([[true], [false]]);
  });
});
