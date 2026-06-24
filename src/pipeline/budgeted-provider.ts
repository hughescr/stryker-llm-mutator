/*
 * Budget-enforcing provider wrapper (functional-architecture §4 mid-run ceiling /
 * Gate 4 caching). PURE wrapper over any {@link LLMProvider}; OFFLINE-testable
 * with a MockProvider + a real {@link CostAccumulator} + a temp-dir
 * {@link ResponseCache}.
 *
 * The dollar ceiling (`maxCostUsd`) and the call cap (`maxLlmCallsPerRun`) are
 * LOAD-BEARING only if consulted BETWEEN calls — otherwise they are decorative.
 * This wrapper owns that check: each `generate()` first consults the running
 * `cost.snapshot()` and, if a ceiling is already crossed, THROWS
 * {@link BudgetExceededError} BEFORE delegating to the inner provider. The
 * pre-pass loop catches that to stop the queue cleanly, keeping the survivors it
 * already collected (a partial map still drives a useful Stryker run).
 *
 * Content-addressing: every call is keyed by `req.cacheKey ?? computeCacheKey(
 * {model, prompt, schema})`. A cache HIT reconstructs a `ProviderResult` with
 * `costUsd: 0, cached: true`, records a zero-cost call (so the call COUNT still
 * advances), and never hits the network — so warm re-runs and overlapping spans
 * are free. A MISS delegates, then records the real cost and stores the entry.
 *
 * FROZEN-SET MODE (`cacheOnly: true`, functional-architecture §3.4 / §7 CI
 * gating). When set, the wrapper NEVER reaches the network: a HIT behaves exactly
 * as above, but a MISS records a zero-cost call and returns an EMPTY-candidates
 * result (`{ candidates: [] }`) WITHOUT calling `inner.generate` or `cache.set`.
 * The net effect is a deterministic, free re-score of ONLY the proposals already
 * resident in the cache (the "frozen mutant set") — cache misses contribute no
 * mutant. `propose()`/`runPrePass` already handle a zero-candidate response (it
 * just yields no survivors for that target), so this requires no pre-pass change.
 * The empty shape satisfies the propose schema (`candidates` has `minItems: 0`).
 */

import {
    type CacheEntry,
    computeCacheKey,
    type CostAccumulator,
    type CostSnapshot,
    type LLMProvider,
    type ProviderRequest,
    type ProviderResult,
    type ResponseCache,
} from '../llm/index';

/** A logger sink for budget/cache notes. Defaults to a no-op. */
export type BudgetLogger = (line: string) => void;

/**
 * Thrown when a hard budget ceiling is reached BETWEEN calls. Carries the
 * cost snapshot at the moment of the abort so the caller can report it.
 */
export class BudgetExceededError extends Error {
    /** The cost snapshot at the moment the ceiling was crossed. */
    readonly snapshot: CostSnapshot;
    /** Which ceiling tripped: the dollar cap or the call cap. */
    readonly reason: 'maxCostUsd' | 'maxLlmCallsPerRun';

    constructor(reason: 'maxCostUsd' | 'maxLlmCallsPerRun', snapshot: CostSnapshot) {
        super(
            `LLM budget ceiling reached (${reason}): ` +
                `$${snapshot.totalUsd.toFixed(4)} across ${String(snapshot.calls)} call(s).`,
        );
        this.name = 'BudgetExceededError';
        this.reason = reason;
        this.snapshot = snapshot;
    }
}

/** Construction options for {@link createBudgetedProvider}. */
export interface BudgetedProviderOptions {
    /** The content-addressed cache consulted before every call. */
    cache: ResponseCache;
    /** The shared per-run cost accumulator (the ceiling is read from its snapshot). */
    cost: CostAccumulator;
    /** Hard dollar ceiling, consulted BETWEEN calls. */
    maxCostUsd: number;
    /** Hard call-count ceiling, consulted BETWEEN calls. */
    maxLlmCallsPerRun: number;
    /** Default model used to compute a cache key when a request omits `cacheKey`. */
    defaultModel: string;
    /** Optional note logger (cache hits, aborts). */
    log?: BudgetLogger;
    /**
     * FROZEN-SET / CI-gating mode. When `true`, a cache MISS does NOT call the
     * inner provider or write the cache — it records a zero-cost call and returns
     * an empty-candidates result, so the run re-scores ONLY already-cached
     * proposals (deterministic + free). Default `false` (the live network path).
     */
    cacheOnly?: boolean;
}

/**
 * Wrap `inner` in a budget-enforcing, cache-backed {@link LLMProvider}. The
 * wrapper:
 *   1. computes the cache key (request-supplied or content-addressed);
 *   2. on a cache HIT → returns a zero-cost cached result (records the call);
 *   3. on a MISS → checks the dollar + call ceilings against the live snapshot
 *      and THROWS {@link BudgetExceededError} if already crossed, else delegates,
 *      records the real cost, and stores the entry.
 *
 * @param inner The real (or mock) provider to wrap.
 * @param options Cache, cost accumulator, ceilings, default model, logger.
 * @returns A budget-enforcing provider with the same {@link LLMProvider} surface.
 */
export function createBudgetedProvider(
    inner: LLMProvider,
    options: BudgetedProviderOptions,
): LLMProvider {
    const { cache, cost, maxCostUsd, maxLlmCallsPerRun, defaultModel, log } = options;
    const cacheOnly = options.cacheOnly ?? false;

    return {
        name: `${cacheOnly ? 'frozen' : 'budgeted'}(${inner.name})`,

        async generate<T>(request: ProviderRequest): Promise<ProviderResult<T>> {
            const key =
                request.cacheKey ??
                computeCacheKey({
                    model: request.model ?? defaultModel,
                    prompt: request.prompt,
                    schema: request.schema,
                });

            const hit = await cache.get<T>(key);
            if (hit !== undefined) {
                cost.add(0);
                log?.(`cache hit (${key.slice(0, 12)}…) — $0.00`);
                return {
                    value: hit.value,
                    costUsd: 0,
                    model: hit.model,
                    cached: true,
                    ...(hit.rawText === undefined ? {} : { rawText: hit.rawText }),
                };
            }

            // FROZEN-SET MODE: a MISS yields no mutant — record a $0 call and
            // return an empty-candidates result WITHOUT touching the network or
            // the cache. Deterministic + free re-score of the cached set only.
            if (cacheOnly) {
                cost.add(0);
                log?.(`frozen miss (${key.slice(0, 12)}…) — $0.00, no candidates`);
                return {
                    // The propose schema admits `{ candidates: [] }` (minItems 0);
                    // a target with no candidates simply yields no survivor.
                    value: { candidates: [] } as T,
                    costUsd: 0,
                    model: defaultModel,
                    cached: true,
                };
            }

            // Mid-run ceiling check — BETWEEN calls, before spending.
            const snapshot = cost.snapshot();
            if (snapshot.totalUsd >= maxCostUsd) {
                throw new BudgetExceededError('maxCostUsd', snapshot);
            }
            if (snapshot.calls >= maxLlmCallsPerRun) {
                throw new BudgetExceededError('maxLlmCallsPerRun', snapshot);
            }

            const result = await inner.generate<T>(request);
            cost.add(result.costUsd);

            const entry: CacheEntry<T> = {
                value: result.value,
                costUsd: result.costUsd,
                model: result.model,
                ...(result.rawText === undefined ? {} : { rawText: result.rawText }),
            };
            await cache.set<T>(key, entry);

            return result;
        },
    };
}
