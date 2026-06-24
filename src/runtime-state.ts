/*
 * The in-process RUNTIME-STATE singleton (M6 consumable path). When a consumer
 * runs stock `stryker run`, the dynamic-LLM pre-pass and the Reporter plugin live
 * in the SAME Node process but have NO direct call edge: `withLlmMutators(...)`
 * runs during config evaluation (BEFORE instrumentation), while the Reporter's
 * `onMutationTestReportReady` fires at the very END of the run. They communicate
 * through this module-level singleton — `withLlmMutators` STASHES the pre-pass cost
 * + precomputed map here; the Reporter READS them at report time to render the
 * survivor view + LLM cost via `formatReport`.
 *
 * This is the consumable-path analogue of the `stryker-llm` CLI's direct hand-off
 * in `run.ts` (where the pre-pass result is passed straight to `formatReport`);
 * there the values flow by argument, here they flow through this shared binding
 * because the two halves cannot see each other. A module-level singleton is the
 * right tool: ESM caches one instance per resolved path, so the wrapper and the
 * plugin — both importing THIS file from the one hoisted package install — share
 * the exact same mutable record.
 *
 * PURE — no Stryker import, no network, no I/O. Trivially bun-testable.
 */

import type { CostSnapshot } from './llm/index';
import type { LlmMutatorMap } from './pipeline/llm-map';

/**
 * The mutable per-run state the wrapper populates and the Reporter consumes.
 * Reset to its empty shape by {@link resetRuntimeState} so a second run in the
 * same process (e.g. a test, or a watch-mode re-run) does not leak the prior run's
 * cost or map.
 */
export interface RuntimeState {
    /** The dynamic-LLM pre-pass cost snapshot (zero on a heuristics-only run). */
    cost: CostSnapshot;
    /**
     * The precomputed `(absFileName, locKey) → ParsedEntry[]` map from the pre-pass,
     * or `undefined` when no dynamic-LLM pre-pass ran. Drives the Reporter's
     * id→`llm/<tag>` + original + rationale enrichment.
     */
    map?: LlmMutatorMap;
}

/** The empty initial state (no cost, no map). */
function emptyState(): RuntimeState {
    return { cost: { totalUsd: 0, calls: 0 } };
}

/**
 * The single shared runtime-state record. Mutated in place (not reassigned) so the
 * binding both halves imported stays the same object. Read via
 * {@link getRuntimeState}; written via {@link setRunCost} / {@link setRunMap}.
 */
const state: RuntimeState = emptyState();

/** Read the current runtime state (the live record — callers must not mutate it). */
export function getRuntimeState(): Readonly<RuntimeState> {
    return state;
}

/** Stash the dynamic-LLM pre-pass cost snapshot for the Reporter to render. */
export function setRunCost(cost: CostSnapshot): void {
    state.cost = cost;
}

/** Stash the precomputed LLM map for the Reporter's enrichment correlation. */
export function setRunMap(map: LlmMutatorMap): void {
    state.map = map;
}

/**
 * Reset the runtime state to empty (no cost, no map). Used between runs in one
 * process so a heuristics-only run does not inherit a prior run's LLM cost/map, and
 * for test isolation.
 */
export function resetRuntimeState(): void {
    state.cost = { totalUsd: 0, calls: 0 };
    delete state.map;
}
