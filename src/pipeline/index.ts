/*
 * Barrel for the stage-2 pipeline: the LLM `propose` stage and the cheap,
 * no-LLM deterministic `filters` that winnow its output. See
 * `docs/development-plan.md` §4.3 (stage 2) and phases 2–3.
 */

export {
    propose,
    PROPOSE_MUTATOR_PREFIX,
    type ProposeOptions,
    type ProposeTarget,
} from './propose';

export {
    applyFilters,
    dedupKey,
    dedupReplacements,
    filterIdentical,
    filterUnparseable,
    isParseable,
} from './filters';

// ── Shared replacement-fragment parser (Gate 4 / LLMMutator) ─────────────────
export { parseReplacementFragment } from './parse-fragment';

// ── Gate-4 precomputed-map builder + keying contract ─────────────────────────
export {
    type BabelLoc,
    type BuildLlmMutatorMapResult,
    buildLlmMutatorMap,
    type DroppedReplacement,
    type LlmMutatorMap,
    locKeyFromBabelLoc,
    locKeyFromRange,
    type ParsedEntry,
} from './llm-map';

// ── Gate-4 conservative near-equivalence filter ──────────────────────────────
export {
    type DropLogger,
    filterNearEquivalent,
    type FilterNearEquivalentOptions,
    isNearEquivalent,
} from './near-equivalence';

// ── Gate-1 risk/EV targeting + Gate-2 complementarity ────────────────────────
export {
    type BuildProposeTargetsOptions,
    type BuildProposeTargetsResult,
    buildProposeTargets,
    type CoverageLookup,
    isLlmWorthy,
    RICHNESS_BOOST,
    RICHNESS_THRESHOLD,
    RISK_WEIGHTS,
    type SourceFileInput,
    type TargetLogger,
    type TargetMeta,
} from './targeting';

// ── Gate-3/4 pre-pass orchestration + diminishing-returns stop ───────────────
export {
    type PrePassLogger,
    type PrePassStopReason,
    RollingYield,
    runPrePass,
    type RunPrePassDeps,
    type RunPrePassResult,
} from './prepass';

// ── Budget-enforcing, cache-backed provider wrapper ──────────────────────────
export {
    type BudgetedProviderOptions,
    BudgetExceededError,
    type BudgetLogger,
    createBudgetedProvider,
} from './budgeted-provider';
