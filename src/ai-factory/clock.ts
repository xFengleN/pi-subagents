/**
 * ai-factory/clock.ts — Injectable clock for the controller.
 *
 * The controller schedules wake-ups (backoff retries, WAITING_CAPACITY
 * re-attempts) through this seam so tests can advance a multi-hour wait
 * instantly instead of sleeping. No LLM call is involved in any wake path.
 */

export interface Clock {
  /** Current wall-clock time, ms since epoch. */
  now(): number;
  /** Schedule a callback after `ms`; returns a cancel function. */
  setTimeout(cb: () => void, ms: number): () => void;
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => {
    const t = setTimeout(cb, ms);
    return () => clearTimeout(t);
  },
};
