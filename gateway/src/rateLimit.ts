// Límite de tasa en memoria con ventana fija por cliente y cuota.

import type { RateTier } from "./routes.ts";

export type RateLimits = Record<RateTier, number>;

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

const WINDOW_MS = 60_000;

export class RateLimiter {
  readonly #limits: RateLimits;
  readonly #now: () => number;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(limits: RateLimits, now: () => number = Date.now) {
    this.#limits = limits;
    this.#now = now;
  }

  check(tier: RateTier, clientKey: string): RateDecision {
    const limit = this.#limits[tier];
    const now = this.#now();
    const key = `${tier}:${clientKey}`;
    let window = this.#windows.get(key);
    if (!window || now - window.start >= WINDOW_MS) {
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
      if (this.#windows.size > 10_000) this.#evict(now);
    }
    window.count++;
    return {
      allowed: limit <= 0 || window.count <= limit,
      limit,
      remaining: Math.max(0, limit - window.count),
      resetSeconds: Math.ceil((window.start + WINDOW_MS - now) / 1000),
    };
  }

  #evict(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= WINDOW_MS) this.#windows.delete(key);
    }
  }
}
