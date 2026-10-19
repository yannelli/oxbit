import { base64urlDecode, OFFER_TTL_MS, type Offer } from "@oxbit/sdk/tunnel";

export interface PairedDevice {
  id: string;
  name: string;
}
export type OfferOutcome = { paired: PairedDevice } | { expired: true };

interface Pending {
  psk: Uint8Array;
  expiresAt: number;
  claimed: boolean;
  lapsed: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** Pending pairing offers, kept in memory. Each one pairs one device and lapses after the TTL. */
export class OfferBook {
  private readonly pending = new Map<string, Pending>();
  private readonly outcomes = new Map<string, OfferOutcome>();
  private readonly waiters = new Map<string, Set<(outcome: OfferOutcome) => void>>();

  constructor(
    readonly ttlMs = OFFER_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  add(offer: Offer): { expiresAt: number } {
    const expiresAt = this.now() + this.ttlMs;
    const timer = setTimeout(() => this.lapse(offer.o), this.ttlMs);
    timer.unref();
    this.pending.set(offer.o, { psk: base64urlDecode(offer.k), expiresAt, claimed: false, lapsed: false, timer });
    return { expiresAt };
  }

  /** Reserves the offer for one handshake and returns its psk; undefined when missing, expired or already in use. */
  claim(id: string): Uint8Array | undefined {
    const entry = this.pending.get(id);
    if (!entry || entry.claimed || entry.lapsed || this.now() >= entry.expiresAt) return undefined;
    entry.claimed = true;
    return entry.psk;
  }

  /** Returns a claimed offer after its handshake failed. */
  release(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.claimed = false;
    if (entry.lapsed) this.finish(id, { expired: true });
  }

  complete(id: string, device: PairedDevice): void {
    if (this.pending.has(id)) this.finish(id, { paired: device });
  }

  /** Resolves when the offer pairs a device or expires. */
  wait(id: string): Promise<OfferOutcome> {
    const known = this.outcomes.get(id);
    if (known) return Promise.resolve(known);
    if (!this.pending.has(id)) return Promise.resolve({ expired: true });
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set.add(resolve));
    });
  }

  clear(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, { expired: true });
  }

  private lapse(id: string) {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.lapsed = true;
    if (!entry.claimed) this.finish(id, { expired: true });
  }

  private finish(id: string, outcome: OfferOutcome) {
    const entry = this.pending.get(id);
    if (entry) clearTimeout(entry.timer);
    this.pending.delete(id);
    this.outcomes.set(id, outcome);
    setTimeout(() => this.outcomes.delete(id), this.ttlMs).unref();
    for (const resolve of this.waiters.get(id) ?? []) resolve(outcome);
    this.waiters.delete(id);
  }
}
