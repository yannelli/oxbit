import { describe, expect, it } from "vitest";
import { applyStatus, emptyStatus, fromConfig } from "./status.js";

const option = (id: string, category: string, currentValue: string, values: string[]) =>
  ({ id, name: id, category, type: "select", currentValue, options: values.map((value) => ({ value, name: value })) });

describe("TUI status from config options", () => {
  it("replaces the reasoning levels on a model change and clears them when the model has none", () => {
    const first = { ...emptyStatus(), ...fromConfig([option("model", "model", "a", ["a", "b"]), option("reasoning", "thought_level", "high", ["default", "low", "high"])]) };
    expect(first.reasoning?.options.map((item) => item.value)).toEqual(["default", "low", "high"]);
    const switched = { ...first, ...fromConfig([option("model", "model", "b", ["a", "b"]), option("mode", "mode", "ask", ["ask"])]) };
    expect([switched.model, switched.reasoning]).toEqual(["b", undefined]);
    const updated = applyStatus(switched, { sessionUpdate: "config_option_update",
      configOptions: [option("model", "model", "a", ["a", "b"]), option("reasoning", "thought_level", "default", ["default", "max"])] });
    expect(updated.reasoning?.options.map((item) => item.value)).toEqual(["default", "max"]);
    expect(fromConfig(undefined)).toEqual({});
  });
});
