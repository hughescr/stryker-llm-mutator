/*
 * `withLlmMutators(config)` — the PRIMARY M6 integration path: a config-wrapper a
 * consumer drops into their `stryker.conf.mjs` so STOCK `stryker run` (NOT our
 * `stryker-llm` bin) picks up our mutators.
 *
 *   import { withLlmMutators } from '@hughescr/stryker-llm-mutator';
 *   export default await withLlmMutators({ ...strykerConfig, llmMutator: { ... } });
 *
 * HOW IT WORKS (the lifecycle seam — verified against Stryker config-reader.js):
 *   Stryker loads the config file with `await import(pathToFileURL(configFile))` in
 *   its MAIN process, at the very START of the run, BEFORE instrumentation. ESM
 *   guarantees that import does not resolve until every top-level await in the
 *   module graph has settled — including (a) this package's
 *   `instrumenter-registry` TLA that resolves the live `allMutators`, and (b) the
 *   consumer's own `export default await withLlmMutators(...)`. So by the time
 *   Stryker reads the config's `.default`, our mutators are ALREADY pushed onto the
 *   live `allMutators` the in-process instrumenter reads. No Stryker plugin hook for
 *   mutators is needed — we inject during config evaluation, in the same process,
 *   before the first `transformBabel` call.
 *
 * SYNC vs ASYNC:
 *   • Heuristics-only (`dynamicLLM.enabled` false): the injection is SYNCHRONOUS.
 *     `allMutators` is already a settled binding (the registry's TLA finished as
 *     part of THIS module's static-import graph, before `withLlmMutators` is
 *     called), so the heuristics branch pushes with no await. `export default
 *     withLlmMutators(cfg)` works without the caller awaiting — but we still return
 *     a Promise (uniform type) and DOCUMENT `await` in both examples for safety,
 *     since Stryker reads `.default` only after the whole module import settles.
 *   • dynamicLLM on: the async pre-pass (provider + cache + cost → buildLlmMutator
 *     → inject) MUST complete before instrumentation, so the consumer MUST `await`
 *     — `export default await withLlmMutators(cfg)` — which forces it via the
 *     config module's own top-level await.
 *
 * RETURNS A CLEAN CONFIG: the `llmMutator` key is OUR extension, not a Stryker
 * option. We strip it before returning so Stryker sees no unknown key (it would
 * otherwise warn). The returned object is the user's Stryker config minus
 * `llmMutator`, stamped with an idempotency marker.
 *
 * NODE-ONLY IMPORT DISCIPLINE: this module must NOT import `@stryker-mutator/core`
 * (it runs inside the consumer's Node `stryker run` process and core's instrumenter
 * throws under Bun — but more importantly we deliberately avoid pulling core into a
 * config wrapper). It imports only: the instrumenter-registry (resolved
 * allMutators), the PURE decision modules, and the Node-only LLM bits
 * (createProvider/createBudgetedProvider/ResponseCache/CostAccumulator) which are
 * fine under Node. The dynamicLLM branch is therefore coverage-exempt (it pulls the
 * Anthropic SDK via createProvider); the heuristics branch + clean-config +
 * idempotency logic ARE bun-tested.
 */

import process from 'node:process';
import { resolve } from 'node:path';

import { injectMutators } from './injection';
import { createProvider } from './llm/factory';
import { CostAccumulator, ResponseCache } from './llm/index';
import { createBudgetedProvider } from './pipeline/budgeted-provider';
import { llmMutatorConfigSchema, type LlmMutatorConfigInput } from './config';
import { selectHeuristicMutators } from './driver/select-mutators';
import { assertLlmCredentials, buildLlmMutator, gateSwitches } from './driver/gate';
import { readMutateSources } from './driver/read-sources';
import type { PartialStrykerOptions } from './driver/plan';
import { setRunCost, setRunMap } from './runtime-state';

/** A line emitter for the wrapper's notes. Defaults to `console.warn` (Stryker's stderr). */
export type WithLlmMutatorsLog = (line: string) => void;

/** The Stryker config shape `withLlmMutators` accepts: any partial options + our `llmMutator` block. */
export type WithLlmMutatorsConfig = PartialStrykerOptions & {
    /** OUR extension block (heuristics + dynamicLLM switches). Stripped from the returned config. */
    llmMutator?: LlmMutatorConfigInput;
    /** Other Stryker options pass through untouched. */
    [key: string]: unknown;
};

/** Options for {@link withLlmMutators} (injectable log + a non-default project dir). */
export interface WithLlmMutatorsOptions {
    /** Note sink for the wrapper's own lines (defaults to `console.warn`). */
    log?: WithLlmMutatorsLog;
    /**
     * The project root the dynamic-LLM pre-pass resolves `mutate` globs + the cache
     * dir against. Defaults to `process.cwd()` — correct under `stryker run`, which
     * runs in the project root. Injectable for tests.
     */
    projectDir?: string;
}

/**
 * The idempotency marker stamped (non-enumerable) on a returned config. A re-call
 * with the SAME object — or a config that already carries the marker — skips
 * re-injection, because `injectMutators` does NOT de-dup and a double augment would
 * register the heuristics twice. Module-level Symbol so the identity is stable
 * within one process / package instance.
 */
const PROCESSED = Symbol.for('@hughescr/stryker-llm-mutator/processed');

/** Default note sink: Stryker surfaces stderr, so `console.warn` is visible in a run. */
const defaultLog: WithLlmMutatorsLog = line => {
    // eslint-disable-next-line no-console -- the wrapper has no Stryker logger; stderr is the visible channel during config eval.
    console.warn(line);
};

/** Strip `llmMutator` from the config and stamp the idempotency marker; return the clean object. */
function cleanConfig<T extends WithLlmMutatorsConfig>(config: T): Omit<T, 'llmMutator'> {
    const { llmMutator: _omit, ...clean } = config;
    Object.defineProperty(clean, PROCESSED, {
        value: true,
        enumerable: false,
        configurable: true,
        writable: false,
    });
    return clean;
}

/**
 * Inject this package's mutators into Stryker's live `allMutators` registry by
 * evaluating the `llmMutator` switches, then return the user's Stryker config with
 * `llmMutator` removed (so stock `stryker run` instruments with our mutators and
 * sees a clean config). See the module header for the lifecycle/sync-async story.
 *
 * Always returns a Promise for a uniform type. The heuristics-only injection is
 * synchronous (completes before the first await point); the dynamicLLM pre-pass is
 * async and MUST be awaited by the consumer (`export default await ...`).
 *
 * @param config The user's Stryker config plus an optional `llmMutator` block.
 * @param options Injectable note sink + project dir (defaults to `process.cwd()`).
 * @returns The Stryker config with `llmMutator` stripped (ready to default-export).
 */
export async function withLlmMutators<T extends WithLlmMutatorsConfig>(
    config: T,
    options: WithLlmMutatorsOptions = {},
): Promise<Omit<T, 'llmMutator'>> {
    const log = options.log ?? defaultLog;

    // Idempotency: if this exact config was already processed, skip re-injection
    // (a second augment would double-register the heuristics) and just return it
    // cleaned. We check the marker on the INPUT — a caller that passes back a
    // previously-returned config (which carries the marker) is a re-call.
    if (Object.hasOwn(config, PROCESSED)) {
        return cleanConfig(config);
    }

    // Parse: fills all defaults; an absent `llmMutator` block => heuristics-on /
    // dynamicLLM-off (the default posture).
    const cfg = llmMutatorConfigSchema.parse(config.llmMutator ?? {});
    const gate = gateSwitches(cfg);
    if (gate.warning !== undefined) {
        log(`stryker-llm: ${gate.warning}`);
    }

    // Heuristics (SYNCHRONOUS): select + augment-inject. `allMutators` is already
    // resolved (the registry's TLA settled during this module's static-import
    // graph), so this touches a ready array with no await.
    if (gate.runHeuristics) {
        const { mutators, unimplemented } = selectHeuristicMutators(cfg.heuristics);
        if (unimplemented.length > 0) {
            log(
                `stryker-llm: requested operators not yet implemented (ignored): ${unimplemented.join(', ')}`,
            );
        }
        if (mutators.length > 0) {
            const injected = injectMutators(mutators, { mode: 'augment' });
            log(
                `stryker-llm: injected ${String(injected.injectedNames.length)} heuristic mutator(s): ${injected.injectedNames.join(', ')}`,
            );
        }
    }

    // dynamicLLM (ASYNC pre-pass) — reuses the run.ts pre-pass WITHOUT `new Stryker()`.
    if (gate.runDynamicLLM) {
        await runDynamicLlmPrePass(cfg, options.projectDir ?? process.cwd(), log);
    }

    // Return a CLEAN config: Stryker sees no unknown `llmMutator` key, and the
    // returned object is stamped so a re-call is a no-op.
    return cleanConfig(config);
}

/**
 * Run the dynamic-LLM pre-pass (credential check → budgeted provider → read mutate
 * sources → buildLlmMutator → augment-inject the single `llm` mutator) and stash
 * the cost + map into the runtime-state singleton for the Reporter plugin. This is
 * the `run.ts` step (3)+(4) MINUS `new Stryker()` — the wrapper never constructs
 * Stryker; stock `stryker run` does, after config load.
 *
 * Node-only (pulls the Anthropic SDK via createProvider) — coverage-exempt; the
 * underlying buildLlmMutator/pre-pass logic is covered offline with a MockProvider.
 */
async function runDynamicLlmPrePass(
    cfg: ReturnType<typeof llmMutatorConfigSchema.parse>,
    projectDir: string,
    log: WithLlmMutatorsLog,
): Promise<void> {
    // Credential fail-fast BEFORE constructing any provider.
    assertLlmCredentials(cfg);

    const cost = new CostAccumulator();
    const cache = new ResponseCache(resolve(projectDir, cfg.cacheDir));
    const frozen = cfg.dynamicLLM.frozen;
    const provider = createBudgetedProvider(createProvider(cfg), {
        cache,
        cost,
        maxCostUsd: cfg.dynamicLLM.budget.maxCostUsd,
        maxLlmCallsPerRun: cfg.dynamicLLM.budget.maxLlmCallsPerRun,
        defaultModel: cfg.model,
        log,
        ...(frozen ? { cacheOnly: true } : {}),
    });
    if (frozen) {
        log(
            'stryker-llm: frozen-set mode (cache-only): re-scoring only already-cached ' +
                'LLM proposals; cache misses yield no mutant — deterministic re-score.',
        );
    }

    const files = await readMutateSources(projectDir, undefined);
    const built = await buildLlmMutator(cfg, {
        provider,
        costAccumulator: cost,
        files,
        cwd: resolve(projectDir),
        log,
    });
    injectMutators([built.mutator], { mode: 'augment' });

    // Stash for the Reporter plugin (same process, read at report time).
    setRunCost(built.costSnapshot);
    setRunMap(built.map);
    log(
        `stryker-llm: LLM pre-pass cost $${built.costSnapshot.totalUsd.toFixed(2)} / ` +
            `${String(built.costSnapshot.calls)} calls`,
    );
}
