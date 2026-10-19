import type { Limits } from "./protocol.js";

export interface DayCount {
  /** UTC date, `YYYY-MM-DD`. */
  day: string;
  bytes: number;
}

export const DAY_COUNT_KEY = "dayCount";
const MINUTE_MS = 60_000;

/** The minute window lives in memory and restarts after hibernation; the day count is saved every `dayFlushBytes`. */
export class ByteBudget {
  private minuteStart = Number.NEGATIVE_INFINITY;
  private minuteBytes = 0;
  private count: DayCount;
  private saved: number;

  constructor(
    private readonly limits: Limits,
    stored: DayCount | undefined,
    private readonly save: (count: DayCount) => void,
  ) {
    this.count = stored ?? { day: "", bytes: 0 };
    this.saved = this.count.bytes;
  }

  exhausted(now: number): boolean {
    this.roll(now);
    return this.count.bytes >= this.limits.dayBytes;
  }

  /** Counts `bytes` and returns true, or returns false when they exceed the minute or day budget. */
  take(bytes: number, now: number): boolean {
    this.roll(now);
    if (this.count.bytes + bytes > this.limits.dayBytes) {
      this.flush();
      return false;
    }
    if (this.minuteBytes + bytes > this.limits.minuteBytes) return false;
    this.minuteBytes += bytes;
    this.count.bytes += bytes;
    if (this.count.bytes - this.saved >= this.limits.dayFlushBytes) this.flush();
    return true;
  }

  flush(): void {
    if (this.count.bytes === this.saved) return;
    this.saved = this.count.bytes;
    this.save({ ...this.count });
  }

  private roll(now: number): void {
    if (now - this.minuteStart >= MINUTE_MS) {
      this.minuteStart = now;
      this.minuteBytes = 0;
    }
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.count.day) {
      this.count = { day, bytes: 0 };
      this.saved = 0;
    }
  }
}
