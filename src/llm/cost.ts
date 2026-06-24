/*
 * Per-run LLM cost accumulator.
 *
 * Reporting surfaces `total_cost_usd` per run (see `docs/development-plan.md`
 * §4.4): the sum of every provider call's cost across all three pipeline
 * stages. This module is a tiny, OFFLINE accumulator — callers feed it each
 * {@link import('./types').ProviderResult.costUsd} as calls complete and ask it
 * for the running total. It performs no I/O and no network access, so it is
 * trivially unit-testable.
 */

/**
 * A read-only snapshot of accumulated spend. Returned by
 * {@link CostAccumulator.snapshot} so a report can render the total without
 * holding a mutable reference to the accumulator.
 */
export interface CostSnapshot {
    /** Total cost in US dollars summed across every recorded call. */
    totalUsd: number;
    /** Number of provider calls recorded (including zero-cost cache hits). */
    calls: number;
}

/**
 * Accumulates the per-call `costUsd` of provider results into a single per-run
 * total. Cache hits (cost `0`) are still counted as calls so the call count
 * reflects how many generations the pipeline requested, not how many hit the
 * network.
 */
export class CostAccumulator {
    #totalUsd = 0;
    #calls = 0;

    /**
     * Record one provider call's cost. Negative costs are rejected (no provider
     * reports a negative charge; a negative value signals a bug upstream and
     * must not silently understate the run total). Resolves nothing; mutates the
     * running total in place.
     */
    add(costUsd: number): void {
        if (!Number.isFinite(costUsd) || costUsd < 0) {
            throw new Error(`CostAccumulator.add: invalid costUsd ${String(costUsd)}`);
        }
        this.#totalUsd += costUsd;
        this.#calls += 1;
    }

    /** Total accumulated cost in US dollars across all recorded calls. */
    get totalUsd(): number {
        return this.#totalUsd;
    }

    /** Number of provider calls recorded so far. */
    get calls(): number {
        return this.#calls;
    }

    /** A plain read-only snapshot suitable for handing to a reporter. */
    snapshot(): CostSnapshot {
        return { totalUsd: this.#totalUsd, calls: this.#calls };
    }

    /** Reset the accumulator to its initial empty state (for reuse across runs). */
    reset(): void {
        this.#totalUsd = 0;
        this.#calls = 0;
    }
}
