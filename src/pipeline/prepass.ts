/*
 * Gate-3 batched-propose orchestration + Gate-4 filtering + STOPPING
 * (functional-architecture §4 Gates 3–4 / STOPPING). The async PRE-PASS the
 * driver runs BEFORE any injection; its output (the filtered survivors) becomes
 * the precomputed `LLMMutator` map. OFFLINE-testable end-to-end with a
 * MockProvider — no Stryker, no live network.
 *
 * It walks the EV-ranked {@link ProposeTarget}s top-down, calling `propose()`
 * once per ENCLOSING FUNCTION (Gate 3 batches by function, not span), threading
 * the AbortSignal, and halting on ANY of:
 *   (1) COST CEILING / (2) CALL CAP — surfaced as {@link BudgetExceededError}
 *       from the budgeted provider (or checked between targets), CAUGHT so the
 *       partial survivor set is kept;
 *   (3) EV QUEUE EXHAUSTED — no targets left;
 *   (4) DIMINISHING RETURNS — a rolling window of per-call NEW-candidate/diversity
 *       yield falls below `minYieldPerCall`.
 *
 * Survivor (killed/survived) counts are NOT known pre-Stryker, so the
 * diminishing-returns proxy is the per-call count of NEW unique {range,replacement}
 * survivors (post `applyFilters` + near-equivalence) PLUS new distinct
 * `mutatorTag`s — exactly the candidate/diversity yield the doc specifies. Actual
 * survivor counts come back in Stryker's `MutantResult[]` and feed the NEXT run's
 * targeting.
 */

import { applyFilters, dedupKey } from './filters';
import { type DropLogger, filterNearEquivalent } from './near-equivalence';
import { type DroppedReplacement } from './llm-map';
import { propose, type ProposeResult, type ProposeTarget } from './propose';
import { BudgetExceededError } from './budgeted-provider';
import type { CostAccumulator, CostSnapshot, LLMProvider } from '../llm/index';
import type { LlmMutatorConfig } from '../config';
import type { Replacement } from '../seam/types';

/** A logger sink for pre-pass notes. Defaults to a no-op. */
export type PrePassLogger = (line: string) => void;

/** Injected dependencies for {@link runPrePass}. */
export interface RunPrePassDeps {
    /** The shared per-run cost accumulator (the budgeted provider records into it). */
    cost: CostAccumulator;
    /** Note logger for stop reasons + dropped near-equivalents. */
    log?: PrePassLogger;
    /** Cooperative cancellation signal forwarded to each propose() call. */
    signal?: AbortSignal;
}

/** Why the pre-pass stopped, for logging + the next run's posture. */
export type PrePassStopReason =
    | 'queue-exhausted'
    | 'cost-ceiling'
    | 'call-cap'
    | 'diminishing-returns';

/** The result of {@link runPrePass}. */
export interface RunPrePassResult {
    /** The filtered survivor replacements (post applyFilters + near-equivalence). */
    survivors: Replacement[];
    /** The cost snapshot at the end of the pre-pass. */
    cost: CostSnapshot;
    /** Near-equivalent + statement-shaped drops, for the run's drop log. */
    dropped: DroppedReplacement[];
    /** Why the pre-pass halted. */
    stopReason: PrePassStopReason;
    /** How many propose() calls were issued. */
    callsIssued: number;
}

/**
 * A tiny rolling-window yield tracker for the diminishing-returns stop. Pushes a
 * per-call yield number; once the buffer is FULL (`window` samples) it reports
 * whether the window mean has dropped below the floor. Pure, bun-testable in
 * isolation.
 */
export class RollingYield {
    readonly #window: number;
    readonly #buffer: number[] = [];

    constructor(window: number) {
        this.#window = window;
    }

    /** Record one call's yield, evicting the oldest sample past the window. */
    push(value: number): void {
        this.#buffer.push(value);
        if (this.#buffer.length > this.#window) {
            this.#buffer.shift();
        }
    }

    /** True once a full window of samples has accumulated. */
    isFull(): boolean {
        return this.#buffer.length >= this.#window;
    }

    /** The mean yield over the current window (0 for an empty buffer). */
    mean(): number {
        if (this.#buffer.length === 0) {
            return 0;
        }
        return this.#buffer.reduce((a, b) => a + b, 0) / this.#buffer.length;
    }
}

/**
 * Filter one call's raw replacements through `applyFilters` + the conservative
 * near-equivalence pass, returning the survivors and the near-equivalent drops.
 */
function filterCall(
    raw: readonly Replacement[],
    dropLog: DropLogger | undefined,
): { survivors: Replacement[]; dropped: DroppedReplacement[] } {
    const dropped: DroppedReplacement[] = [];
    const afterCheap = applyFilters(raw);
    const survivors = filterNearEquivalent(
        afterCheap,
        dropLog === undefined ? {} : { log: dropLog },
    );
    // Record near-equivalent drops as DroppedReplacement entries for the run log.
    const survivorKeys = new Set(survivors.map(dedupKey));
    for (const r of afterCheap) {
        if (!survivorKeys.has(dedupKey(r))) {
            dropped.push({
                fileName: r.fileName,
                range: r.range,
                replacement: r.replacement,
                reason: 'near-equivalent to original (conservative AST normalization)',
            });
        }
    }
    return { survivors, dropped };
}

/**
 * Run the dynamic-LLM pre-pass over the EV-ranked targets. Returns the filtered
 * survivors plus the cost snapshot, drop log, stop reason, and call count.
 *
 * @param provider The BUDGETED provider (cache + cost + ceiling enforcement).
 * @param targets EV-ranked enclosing-function targets from Gate 1/2.
 * @param config The parsed config (reads `dynamicLLM.budget` + `diminishingReturns`).
 * @param deps Cost accumulator, logger, abort signal.
 */
export async function runPrePass(
    provider: LLMProvider,
    targets: readonly ProposeTarget[],
    config: LlmMutatorConfig,
    deps: RunPrePassDeps,
): Promise<RunPrePassResult> {
    const { cost, log, signal } = deps;
    const { budget, diminishingReturns } = config.dynamicLLM;

    const survivors: Replacement[] = [];
    const dropped: DroppedReplacement[] = [];
    const seenIdentities = new Set<string>();
    const seenTags = new Set<string>();
    const rolling = new RollingYield(diminishingReturns.window);

    let stopReason: PrePassStopReason = 'queue-exhausted';
    let callsIssued = 0;

    for (const target of targets) {
        try {
            // oxlint-disable-next-line no-await-in-loop -- sequential by design: the budgeted provider checks the ceiling BETWEEN calls, and diminishing-returns is evaluated per call.
            const proposed: ProposeResult = await propose(provider, target, {
                maxCandidates: budget.maxCandidatesPerFile,
                model: config.model,
                ...(signal === undefined ? {} : { signal }),
            });
            callsIssued += 1;

            // Node-alignment drops (not-found / ambiguous / non-node-aligned /
            // not-an-expression) join the run's drop log alongside near-equiv drops.
            dropped.push(...proposed.dropped);
            for (const drop of proposed.dropped) {
                log?.(`node-alignment drop ${drop.fileName}: ${drop.reason}`);
            }

            const filtered = filterCall(proposed.replacements, log);
            dropped.push(...filtered.dropped);

            let newThisCall = 0;
            for (const r of filtered.survivors) {
                const identity = dedupKey(r);
                if (!seenIdentities.has(identity)) {
                    seenIdentities.add(identity);
                    survivors.push(r);
                    newThisCall += 1;
                }
                if (!seenTags.has(r.mutatorName)) {
                    seenTags.add(r.mutatorName);
                    newThisCall += 1;
                }
            }

            rolling.push(newThisCall);
            if (rolling.isFull() && rolling.mean() < diminishingReturns.minYieldPerCall) {
                stopReason = 'diminishing-returns';
                log?.(
                    `Pre-pass STOP: diminishing returns (window mean ` +
                        `${rolling.mean().toFixed(3)} < ${String(diminishingReturns.minYieldPerCall)})`,
                );
                break;
            }
        } catch (error) {
            if (error instanceof BudgetExceededError) {
                stopReason = error.reason === 'maxCostUsd' ? 'cost-ceiling' : 'call-cap';
                log?.(`Pre-pass STOP: ${error.message}`);
                break;
            }
            throw error;
        }
    }

    return {
        survivors,
        cost: cost.snapshot(),
        dropped,
        stopReason,
        callsIssued,
    };
}
