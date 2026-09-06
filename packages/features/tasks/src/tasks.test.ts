import { describe, expect, it } from "vitest";
import { appendTaskChunk, finishTask, type Task } from "./index.js";
describe("task output recovery", () => {
  it("ignores replayed chunks while preserving subsequent output", () => {
    const task: Task = {
      id: "a",
      command: "build",
      state: "running",
      output: "",
      seq: 0,
    };
    expect(appendTaskChunk(task, { seq: 1, data: "one" })).toBe(true);
    expect(appendTaskChunk(task, { seq: 1, data: "one" })).toBe(false);
    appendTaskChunk(task, { seq: 2, data: "two" });
    expect(task.output).toBe("onetwo");
  });
  it("records cancelled tasks separately from command failures", () => {
    const task: Task = {
      id: "a",
      command: "build",
      state: "cancelling",
      output: "",
      seq: 0,
      cancelRequested: true,
    };
    finishTask(task, -1);
    expect(task.state).toBe("cancelled");
    expect(task.exitCode).toBe(-1);
  });
});
