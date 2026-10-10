import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { operationId } from "@oxbit/protocol";
import { MAX_OPERATION_RESULT_BYTES, MAX_RETAINED_OPERATIONS, MAX_RUNNING_OPERATIONS, OPERATIONS_PER_EPOCH, OperationHistory, type Operation } from "../src/operations.js";

const id = (history: OperationHistory) => operationId(history.epoch, randomUUID());
function complete(history: OperationHistory, result: unknown = { ok: true }) {
  const operation = history.begin("owner", id(history), "fs.mkdir");
  history.complete(operation, result);
  return operation;
}
const restore = (history: OperationHistory) => new OperationHistory(
  JSON.parse(JSON.stringify(history.checkpoint())),
  JSON.parse(JSON.stringify([...history.values()])),
);

describe("bounded operation history", () => {
  it("retains current and previous IDs and expires retired IDs without admitting them again", () => {
    const history = new OperationHistory();
    const first = complete(history);
    const issuedBeforeRotation = id(history);
    for (let count = 1; count < OPERATIONS_PER_EPOCH; count++) complete(history);
    const delayed = history.begin("owner", issuedBeforeRotation, "fs.mkdir");
    history.complete(delayed, { ok: true });
    expect(history.get("owner", first.id)?.result).toEqual({ ok: true });
    for (let count = 1; count < OPERATIONS_PER_EPOCH; count++) complete(history);
    expect(history.status("owner", first.id)).toMatchObject({ status: "expired", error: { code: "OPERATION_EXPIRED" } });
    expect(() => history.begin("owner", first.id, "fs.delete")).toThrow(/expired/);
    expect(restore(history).status("owner", first.id).status).toBe("expired");
    expect(history.status("owner", id(history)).status).toBe("unknown");
  });

  it("preserves live retired operations and records interruption across restart", () => {
    const history = new OperationHistory();
    const live = history.begin("owner", id(history), "git.push");
    for (let count = 0; count < OPERATIONS_PER_EPOCH * 3; count++) complete(history);
    expect(history.get("owner", live.id)?.status).toBe("running");
    expect(() => history.begin("owner", live.id, "git.push")).toThrow(/already exists/);
    expect(restore(history).get("owner", live.id)).toMatchObject({ status: "interrupted", error: { code: "INTERRUPTED" } });
    history.complete(live, { pushed: true });
    expect(history.get("owner", live.id)?.result).toEqual({ pushed: true });
  });

  it("bounds live records, retained records and result bytes", () => {
    const history = new OperationHistory();
    const live = Array.from({ length: MAX_RUNNING_OPERATIONS }, () => history.begin("owner", id(history), "git.push"));
    expect(() => history.begin("owner", id(history), "fs.mkdir")).toThrow(/Maximum 64/);
    history.complete(live[0], { pushed: true });
    for (let count = 0; count < OPERATIONS_PER_EPOCH * 4; count++) {
      complete(history, { text: "x".repeat(64 * 1024) });
      expect([...history.values()].length).toBeLessThanOrEqual(MAX_RETAINED_OPERATIONS + MAX_RUNNING_OPERATIONS);
    }
    const records = [...history.values()];
    expect(records.some(operation => operation.resultExpired)).toBe(true);
    const resultBytes = records.reduce((sum, operation) => sum + (operation.result === undefined ? 0 : Buffer.byteLength(JSON.stringify(operation.result))), 0);
    expect(resultBytes).toBeLessThanOrEqual(MAX_OPERATION_RESULT_BYTES);
    expect(records.filter(operation => operation.status === "running")).toHaveLength(MAX_RUNNING_OPERATIONS - 1);
  });

  it("compacts large saved snapshots without changing the completed outcome", () => {
    const history = new OperationHistory();
    for (const method of ["fs.write", "collab.save"]) {
      const operation = history.begin("owner", id(history), method);
      const result = { text: "x".repeat(MAX_OPERATION_RESULT_BYTES + 1), revision: "saved" };
      history.complete(operation, result);
      expect(history.status("owner", operation.id)).toMatchObject({ status: "completed", resultExpired: true });
      expect(history.get("owner", operation.id)?.result).toBeUndefined();
      expect(result.text.length).toBe(MAX_OPERATION_RESULT_BYTES + 1);
      expect(restore(history).status("owner", operation.id)).toMatchObject({ status: "completed", resultExpired: true });
    }
  });

  it("compacts legacy history and closes opaque IDs before discarding their records", () => {
    const legacy: Operation[] = Array.from({ length: MAX_RETAINED_OPERATIONS + 1 }, (_, index) => ({
      id: `legacy-${index}`, owner: "owner", method: "git.commit", status: "completed", startedAt: index, result: { commit: String(index) },
    }));
    const history = new OperationHistory(undefined, legacy);
    expect([...history.values()]).toHaveLength(OPERATIONS_PER_EPOCH);
    expect(history.status("owner", legacy[0].id).status).toBe("expired");
    expect(history.get("owner", legacy.at(-1)!.id)?.result).toEqual({ commit: String(MAX_RETAINED_OPERATIONS) });
    expect(() => history.begin("owner", legacy[0].id, "git.commit")).toThrow(/expired/);
    expect(() => history.begin("owner", "another-opaque-id", "git.commit")).toThrow(/expired/);
    expect(complete(history).status).toBe("completed");
  });
});
