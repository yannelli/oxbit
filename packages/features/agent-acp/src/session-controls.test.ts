import { describe, expect, it } from "vitest";
import type { ACPConnection } from "@oxbit/sdk";
import { sessionControls } from "./session-controls.js";

const connection: ACPConnection = {
  id: "connection",
  provider: "codex",
  root: "/workspace",
  sessionId: "session",
  authMethods: [],
  modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] },
  models: {
    currentModelId: "model-high",
    availableModels: [{ modelId: "model-high", name: "Model (high)" }],
  },
};
describe("ACP session controls", () => {
  it("uses provider config options exclusively, without relying on category or ID conventions", () => {
    const controls = sessionControls({
      ...connection,
      configOptions: [
        {
          id: "permission-policy",
          name: "Permissions",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
        {
          id: "engine",
          name: "Model",
          type: "select",
          currentValue: "model",
          options: [
            { group: "models", options: [{ value: "model", name: "Model" }] },
          ],
        },
      ],
    });
    expect(controls.map((control) => [control.name, control.method])).toEqual([
      ["Permissions", "session/set_config_option"],
      ["Model", "session/set_config_option"],
    ]);
    expect(controls[1].options).toEqual([{ value: "model", label: "Model" }]);
  });
  it("retains mode and model controls for legacy providers", () => {
    expect(
      sessionControls(connection).map((control) => control.method),
    ).toEqual(["session/set_mode", "session/set_model"]);
  });
  it("does not resurrect deprecated controls for empty or unsupported config options", () => {
    expect(sessionControls({ ...connection, configOptions: [] })).toEqual([]);
    expect(
      sessionControls({
        ...connection,
        configOptions: [
          {
            id: "future",
            name: "Future",
            type: "unknown",
            currentValue: "default",
            options: [],
          },
        ],
      }),
    ).toEqual([]);
  });
  it("does not expose settings until a session exists", () => {
    expect(sessionControls({ ...connection, sessionId: undefined })).toEqual(
      [],
    );
  });
});
