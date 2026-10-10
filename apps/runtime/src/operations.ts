import { randomUUID } from "node:crypto";
import { operationEpoch, RpcError } from "@oxbit/protocol";

export const OPERATIONS_PER_EPOCH = 128;
export const MAX_RETAINED_OPERATIONS = OPERATIONS_PER_EPOCH * 2;
export const MAX_RUNNING_OPERATIONS = 64;
export const MAX_OPERATION_RESULT_BYTES = 1024 * 1024;

export interface Operation {
  id: string;
  owner: string;
  method: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: number;
  result?: unknown;
  resultExpired?: boolean;
  error?: { code: string; message: string; data?: unknown };
}
export interface OperationHistoryState {
  epoch: string;
  previousEpoch?: string;
  admitted: number;
}

export class OperationHistory {
  private records = new Map<string, Operation>();
  private state: OperationHistoryState;
  constructor(state?: OperationHistoryState, records: Operation[] = []) {
    this.state = state ? { ...state } : { epoch: randomUUID(), admitted: 0 };
    for (const record of records) {
      const operation = { ...record };
      if (operation.status === "running") {
        operation.status = "interrupted";
        operation.error = { code: "INTERRUPTED", message: "Runtime stopped before operation completion was recorded; inspect state before retrying with a new request ID" };
      }
      this.records.set(this.key(operation.owner, operation.id), operation);
    }
    if ((!state && this.records.size > OPERATIONS_PER_EPOCH) || this.records.size > MAX_RETAINED_OPERATIONS + MAX_RUNNING_OPERATIONS) {
      // Retire the whole ID namespace before dropping records from an older journal.
      this.state = { epoch: randomUUID(), admitted: 0 };
      while (this.records.size > OPERATIONS_PER_EPOCH) this.records.delete(this.records.keys().next().value!);
    } else if (!state) this.state.admitted = this.records.size;
    this.compactResults();
  }
  get epoch() { return this.state.epoch; }
  checkpoint() { return { ...this.state }; }
  values() { return this.records.values(); }
  private key(owner: string, id: string) { return `${owner}:${id}`; }
  get(owner: string, id: string) { return this.records.get(this.key(owner, id)); }
  private accepts(id: string) {
    const epoch = operationEpoch(id);
    // Clients before 0.6.2 send plain IDs; they stay accepted, and lose duplicate detection once their record is dropped.
    return epoch === undefined ? !id.startsWith("op:") : epoch === this.state.epoch || epoch === this.state.previousEpoch;
  }
  status(owner: string, id: string) {
    return this.get(owner, id) ?? (this.accepts(id)
      ? { id, status: "unknown" }
      : { id, status: "expired", error: { code: "OPERATION_EXPIRED", message: "Operation history expired; inspect current state before submitting a new operation" } });
  }
  begin(owner: string, id: string, method: string) {
    if (this.get(owner, id)) throw new RpcError("DUPLICATE_ID", "Operation already exists");
    if (!this.accepts(id)) throw new RpcError("OPERATION_EXPIRED", "Operation ID expired; inspect current state before submitting a new operation");
    if ([...this.records.values()].filter(operation => operation.status === "running").length >= MAX_RUNNING_OPERATIONS)
      throw new RpcError("BUSY", "Maximum 64 concurrent operations");
    const operation: Operation = { id, owner, method, status: "running", startedAt: Date.now() };
    this.records.set(this.key(owner, id), operation);
    if (++this.state.admitted >= OPERATIONS_PER_EPOCH) {
      this.state = { epoch: randomUUID(), previousEpoch: this.state.epoch, admitted: 0 };
      let retained = 0;
      for (const [key, record] of [...this.records].reverse())
        if (record.status !== "running" && (!this.accepts(record.id) || ++retained > OPERATIONS_PER_EPOCH)) this.records.delete(key);
    }
    return operation;
  }
  complete(operation: Operation, result: unknown) {
    operation.status = "completed";
    operation.result = result;
    this.compactResults();
  }
  fail(operation: Operation, error: NonNullable<Operation["error"]>) {
    operation.status = "failed";
    operation.error = error;
    delete operation.result;
    this.compactResults();
  }
  private compactResults() {
    let remaining = MAX_OPERATION_RESULT_BYTES;
    for (const operation of [...this.records.values()].reverse()) {
      if (operation.error) {
        operation.error.code = operation.error.code.slice(0, 128);
        if (operation.error.message.length > 4096) {
          operation.error.message = operation.error.message.slice(0, 4096);
          operation.resultExpired = true;
        }
      }
      const result = operation.result as { text?: unknown } | undefined;
      const largeText = (operation.method === "fs.write" || operation.method === "collab.save") && typeof result?.text === "string" && result.text.length > remaining;
      const body = largeText ? undefined : JSON.stringify({ result: operation.result, data: operation.error?.data });
      const bytes = body === undefined ? remaining + 1 : body === "{}" ? 0 : Buffer.byteLength(body);
      if (bytes > remaining) {
        delete operation.result;
        if (operation.error) delete operation.error.data;
        operation.resultExpired = true;
      } else remaining -= bytes;
    }
  }
}
