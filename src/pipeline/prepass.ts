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

import { basename } from 'node:path';

import { applyFilters, dedupKey } from './filters';
import { filterNearEquivalent } from './near-equivalence';
import { type DroppedReplacement } from './llm-map';
import { propose, type ProposeResult, type ProposeTarget } from './propose';
import type { AlignDropReason } from './range-align';
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
 *
 * The near-equivalence pass is run WITHOUT a stdout `DropLogger`: its
 * per-candidate lines were a console flood source. The drops are still collected
 * here as {@link DroppedReplacement}s (so the JSON report carries them) and their
 * COUNT is rolled into the caller's per-function drop summary.
 */
function filterCall(raw: readonly Replacement[]): {
    survivors: Replacement[];
    dropped: DroppedReplacement[];
} {
    const dropped: DroppedReplacement[] = [];
    const afterCheap = applyFilters(raw);
    const survivors = filterNearEquivalent(afterCheap);
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
 * Emit the per-call progress heartbeat (a no-op when no `log` sink is wired). A
 * compact one-liner — `[n/total] file:line — +N cand, T total, $cost` — prefixed
 * `stryker-llm:` to read consistently with the wrapper's other summary lines.
 * Extracted so `runPrePass` stays under the lint complexity cap; PURELY additive.
 */
function logHeartbeat(
    log: PrePassLogger | undefined,
    info: {
        callsIssued: number;
        total: number;
        target: ProposeTarget;
        newThisCall: number;
        survivors: number;
        cost: CostAccumulator;
    },
): void {
    if (log === undefined) {
        return;
    }
    const { totalUsd } = info.cost.snapshot();
    log(
        `stryker-llm: pre-pass [${String(info.callsIssued)}/${String(info.total)}] ` +
            `${basename(info.target.fileName)}:${String(info.target.range.start.line + 1)} — ` +
            `+${String(info.newThisCall)} cand, ${String(info.survivors)} total, ` +
            `$${totalUsd.toFixed(2)}`,
    );
}

/**
 * Emit the per-function DROP SUMMARY: ONE rolled-up line replacing the old
 * per-candidate `node-alignment drop` / `near-equivalent drop` stdout spam. The
 * full per-drop detail still lives in the JSON report (`state.dropped`); this is
 * just the console roll-up. No-op when no `log` sink is wired OR when this call
 * dropped nothing.
 *
 * Format: `stryker-llm: file:line — dropped M/T (buckets)` where `M` is this
 * call's total drops (node-alignment + near-equivalent), `T` is every candidate
 * the model returned for this call, and `buckets` lists ONLY the non-zero
 * categories in this fixed order: unaligned, statement, ambiguous, not-found,
 * equivalent.
 *
 * `replacements` is the count of node-ALIGNED candidates (`proposed.replacements`)
 * — near-equivalent drops are a SUBSET of those, so `T = replacements + alignDrops`
 * (NOT `+ equivalent`, which would double-count the near-equivalent candidates).
 */
function logDropSummary(
    log: PrePassLogger | undefined,
    info: {
        target: ProposeTarget;
        replacements: number;
        dropCounts: Partial<Record<AlignDropReason, number>>;
        equivalent: number;
    },
): void {
    if (log === undefined) {
        return;
    }
    const { dropCounts, equivalent } = info;
    const alignDrops =
        (dropCounts['non-node-aligned'] ?? 0) +
        (dropCounts['not-an-expression'] ?? 0) +
        (dropCounts.ambiguous ?? 0) +
        (dropCounts['not-found'] ?? 0);
    const dropped = alignDrops + equivalent;
    if (dropped === 0) {
        return;
    }
    // Near-equivalent drops are already inside `info.replacements`, so the model's
    // candidate count for this call is `replacements + alignDrops` (no +equivalent).
    const total = info.replacements + alignDrops;

    // Fixed bucket order; only non-zero categories are listed.
    const buckets: string[] = [];
    const add = (count: number, label: string): void => {
        if (count > 0) {
            buckets.push(`${String(count)} ${label}`);
        }
    };
    add(dropCounts['non-node-aligned'] ?? 0, 'unaligned');
    add(dropCounts['not-an-expression'] ?? 0, 'statement');
    add(dropCounts.ambiguous ?? 0, 'ambiguous');
    add(dropCounts['not-found'] ?? 0, 'not-found');
    add(equivalent, 'equivalent');

    log(
        `stryker-llm: ${basename(info.target.fileName)}:` +
            `${String(info.target.range.start.line + 1)} — ` +
            `dropped ${String(dropped)}/${String(total)} (${buckets.join(', ')})`,
    );
}

/**
 * The mutable accumulators threaded through {@link processProposeResult} for one
 * wave's worth of settled results. `runPrePass` owns these for the whole run;
 * the helper reads + mutates them in place so the per-result logic is identical
 * whether the wave was sequential (`parallelBatches === 1`) or concurrent.
 */
interface PrePassState {
    survivors: Replacement[];
    dropped: DroppedReplacement[];
    seenIdentities: Set<string>;
    seenTags: Set<string>;
    rolling: RollingYield;
    /** Bumped once per processed SUCCESSFUL result, mirroring the old per-call counter. */
    callsIssued: number;
}

/**
 * Process ONE successful `propose()` result in array order, applying the EXACT
 * per-call logic the sequential loop used: record node-alignment drops, filter +
 * near-equiv, dedup new survivors + tag-novelty into the shared accumulators,
 * push the per-call yield, emit the heartbeat, then evaluate the
 * diminishing-returns floor. Mutates {@link PrePassState} in place and returns
 * the diminishing-returns stop reason if the floor tripped (else `undefined`).
 * Extracted so `runPrePass` stays under the lint complexity cap; the behavior is
 * byte-for-byte the original inner loop body.
 */
function processProposeResult(
    proposed: ProposeResult,
    target: ProposeTarget,
    state: PrePassState,
    ctx: {
        total: number;
        cost: CostAccumulator;
        log: PrePassLogger | undefined;
        diminishingReturns: LlmMutatorConfig['dynamicLLM']['diminishingReturns'];
    },
): PrePassStopReason | undefined {
    const { log, diminishingReturns } = ctx;
    state.callsIssued += 1;

    // Node-alignment drops (not-found / ambiguous / non-node-aligned /
    // not-an-expression) join the run's drop log for the JSON report. Their
    // per-candidate detail stays OFF stdout — the one-line per-function summary
    // below rolls them up by typed category instead of flooding the console.
    state.dropped.push(...proposed.dropped);

    // Near-equivalence detail also stays OFF stdout (no `log` DropLogger): its
    // per-candidate lines were a second flood source. We keep the drops in
    // `state.dropped` (so the report carries them) and fold their count into the
    // same per-function summary as the `equivalent` bucket.
    const filtered = filterCall(proposed.replacements);
    state.dropped.push(...filtered.dropped);

    let newThisCall = 0;
    for (const r of filtered.survivors) {
        const identity = dedupKey(r);
        if (!state.seenIdentities.has(identity)) {
            state.seenIdentities.add(identity);
            state.survivors.push(r);
            newThisCall += 1;
        }
        if (!state.seenTags.has(r.mutatorName)) {
            state.seenTags.add(r.mutatorName);
            newThisCall += 1;
        }
    }

    state.rolling.push(newThisCall);

    // Per-call PROGRESS HEARTBEAT: one compact line so a long cold-cache
    // run shows liveness + running cost instead of sitting silent between
    // the Gate1/2 line and the final summary. Purely additive — no control
    // flow depends on it. `cost.snapshot()` just reads two fields (cheap).
    logHeartbeat(log, {
        callsIssued: state.callsIssued,
        total: ctx.total,
        target,
        newThisCall,
        survivors: state.survivors.length,
        cost: ctx.cost,
    });

    // Per-function DROP SUMMARY: ONE rolled-up line (right after the heartbeat)
    // replacing the old per-candidate spam. Emitted only when this call dropped
    // at least one candidate; buckets by typed category, non-zero only.
    logDropSummary(log, {
        target,
        replacements: proposed.replacements.length,
        dropCounts: proposed.dropCounts,
        equivalent: filtered.dropped.length,
    });

    if (state.rolling.isFull() && state.rolling.mean() < diminishingReturns.minYieldPerCall) {
        log?.(
            `Pre-pass STOP: diminishing returns (window mean ` +
                `${state.rolling.mean().toFixed(3)} < ${String(diminishingReturns.minYieldPerCall)})`,
        );
        return 'diminishing-returns';
    }
    return undefined;
}

/**
 * Run the dynamic-LLM pre-pass over the EV-ranked targets. Returns the filtered
 * survivors plus the cost snapshot, drop log, stop reason, and call count.
 *
 * The targets are processed in consecutive WAVES of `dynamicLLM.parallelBatches`
 * (default 1). Within a wave all `propose()` calls are issued CONCURRENTLY via
 * `Promise.allSettled`; the settled results are then processed strictly IN ARRAY
 * ORDER so the survivor set + heartbeat sequence stay deterministic. Waves
 * themselves are sequential: the budgeted provider only checks the ceiling
 * BETWEEN calls and diminishing-returns is evaluated PER WAVE, so a cost/call
 * ceiling may overshoot — and the diminishing-returns stop may run — by up to
 * `parallelBatches - 1` calls. With `parallelBatches === 1` each wave is a single
 * target, making the behavior identical to the original sequential loop.
 *
 * @param provider The BUDGETED provider (cache + cost + ceiling enforcement).
 * @param targets EV-ranked enclosing-function targets from Gate 1/2.
 * @param config The parsed config (reads `dynamicLLM.budget` + `diminishingReturns` + `parallelBatches`).
 * @param deps Cost accumulator, logger, abort signal.
 */
export async function runPrePass(
    provider: LLMProvider,
    targets: readonly ProposeTarget[],
    config: LlmMutatorConfig,
    deps: RunPrePassDeps,
): Promise<RunPrePassResult> {
    const { cost, log, signal } = deps;
    const { budget, diminishingReturns, parallelBatches } = config.dynamicLLM;

    const state: PrePassState = {
        survivors: [],
        dropped: [],
        seenIdentities: new Set<string>(),
        seenTags: new Set<string>(),
        rolling: new RollingYield(diminishingReturns.window),
        callsIssued: 0,
    };
    const ctx = { total: targets.length, cost, log, diminishingReturns };

    let stopReason: PrePassStopReason = 'queue-exhausted';
    let stop = false;

    for (let i = 0; i < targets.length && !stop; i += parallelBatches) {
        const wave = targets.slice(i, i + parallelBatches);
        // oxlint-disable-next-line no-await-in-loop -- waves are sequential by design: ceiling + diminishing-returns are evaluated per wave.
        const settled = await Promise.allSettled(
            wave.map(t =>
                propose(provider, t, {
                    maxCandidates: budget.maxCandidatesPerFile,
                    model: config.model,
                    ...(signal === undefined ? {} : { signal }),
                }),
            ),
        );
        // Re-pair each settled outcome with its target so processing stays in
        // ARRAY ORDER without an out-of-band index (settled is index-aligned to
        // wave by construction). Deterministic regardless of completion order.
        const results = wave.map((t, j) => ({ target: t, outcome: settled[j] }));

        // Process the wave's results IN ARRAY ORDER (deterministic). A rejection
        // sets the stop flag but we STILL finish the already-completed siblings —
        // they are paid for (and cached). A non-budget rejection propagates.
        for (const { target, outcome } of results) {
            if (outcome === undefined) {
                continue;
            }
            if (outcome.status === 'fulfilled') {
                const reason = processProposeResult(outcome.value, target, state, ctx);
                if (reason !== undefined) {
                    stopReason = reason;
                    stop = true;
                }
                continue;
            }
            const error = outcome.reason as unknown;
            if (error instanceof BudgetExceededError) {
                stopReason = error.reason === 'maxCostUsd' ? 'cost-ceiling' : 'call-cap';
                log?.(`Pre-pass STOP: ${error.message}`);
                stop = true;
                continue;
            }
            throw error;
        }
    }

    return {
        survivors: state.survivors,
        cost: cost.snapshot(),
        dropped: state.dropped,
        stopReason,
        callsIssued: state.callsIssued,
    };
}
