import { describe, expect, it } from "vitest";
import {
  appendTaskChunk,
  finishTask,
  applyTaskSnapshot,
  type Task,
} from "./index.js";
describe("task output recovery", () => {
  it("ignores delayed start and stop responses after newer status events", () => {
    const task: Task = {
      id: "a",
      command: "serve",
      state: "starting",
      output: "",
      seq: 0,
    };
    applyTaskSnapshot(task, { state: "ready", statusVersion: 3, seq: 4 });
    applyTaskSnapshot(task, { state: "starting", statusVersion: 1, seq: 0 });
    expect(task.state).toBe("ready");
    expect(task.seq).toBe(0);
    task.cancelRequested = true;
    applyTaskSnapshot(task, {
      state: "stopped",
      statusVersion: 5,
      exitCode: -1,
      seq: 5,
    });
    applyTaskSnapshot(task, { state: "stopping", statusVersion: 4, seq: 4 });
    expect(task.state).toBe("cancelled");
    expect(task.exitCode).toBe(-1);
    expect(task.statusVersion).toBe(5);
    appendTaskChunk(task, { seq: 1, data: "Output still replays" });
    expect(task.output).toBe("Output still replays");
  });
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
