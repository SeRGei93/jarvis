import { createHash } from "node:crypto";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "loop-guard" });

/** Max times the same skill+query may run before it's blocked (Go subagent.go maxLoopCount). */
export const MAX_LOOP_COUNT = 2;
/** How long a loop key is remembered (Go subagent.go loopTTL). */
export const LOOP_TTL_MS = 5 * 60_000;

interface Entry {
  count: number;
  expiresAt: number;
}

/** Raised when a skill is invoked too many times for the same query within the TTL window. */
export class LoopGuardError extends Error {
  constructor(skill: string) {
    super(`loop guard: skill '${skill}' already ran ${MAX_LOOP_COUNT} times for this query`);
    this.name = "LoopGuardError";
  }
}

/**
 * In-memory guard against runaway sub-agent loops (parity with Go tools/subagent.go).
 * Keyed by `skill:md5(query)`; the 3rd invocation of the same key inside the TTL is
 * rejected. Node is single-threaded, so no mutex is needed. `now` is injectable for tests.
 */
export class LoopGuard {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(skill: string, query: string): string {
    return `${skill}:${createHash("md5").update(query).digest("hex")}`;
  }

  private evictExpired(now: number): void {
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= now) this.entries.delete(k);
    }
  }

  /** Record an attempt; throws LoopGuardError once the cap is hit. */
  check(skill: string, query: string): void {
    const now = this.now();
    this.evictExpired(now);

    const key = this.key(skill, query);
    const existing = this.entries.get(key);
    if (existing && existing.count >= MAX_LOOP_COUNT) {
      log.warn({ skill, count: existing.count }, "loop guard blocked");
      throw new LoopGuardError(skill);
    }

    const count = (existing?.count ?? 0) + 1;
    this.entries.set(key, { count, expiresAt: now + LOOP_TTL_MS });
    log.debug({ skill, count }, "loop guard increment");
  }
}
