/*
 * Package: @hughescr/stryker-llm-mutator
 *
 * Public entry point / barrel.
 *
 * This package uses a lightweight LLM (default model `claude-haiku-4-5`) to
 * identify mutation locations and rewrite them, producing a wider variety of
 * mutants than Stryker's built-in formulaic mutators (see
 * `docs/development-plan.md`). Stryker v9 has no public "Mutator" plugin kind —
 * the mutators are hardcoded in the instrumenter — so the integration drives
 * Stryker's own `instrument()` machinery out-of-band rather than registering a
 * new mutator plugin (§3.3). The `strykerPlugins` array is intentionally empty
 * for now: the runtime is wired through the seam, not a plugin descriptor.
 *
 * This module re-exports the stable surface of the four components — the LLM
 * provider abstraction (§4.1), the out-of-band seam (§4.2), the stage-2 propose
 * pipeline + deterministic filters (§4.3), and the `llmMutator` config schema
 * (§4.4) — so downstream consumers import from the package root.
 */

/** Package version marker. */
export const VERSION = '0.1.0';

/**
 * The Stryker plugin declaration array. Stryker loads a plugin module's
 * `strykerPlugins` export; it is intentionally empty because this package
 * integrates through the out-of-band seam (development-plan §3.3), not a
 * registered plugin descriptor.
 */
export const strykerPlugins: readonly unknown[] = [];

// ── Config (§4.4) ───────────────────────────────────────────────────────────
export {
    DEFAULT_MODEL,
    llmMutatorConfigSchema,
    ProviderName,
    Stage3Mode,
    type LlmMutatorConfig,
    type LlmMutatorConfigInput,
} from './config';

// ── LLM provider abstraction (§4.1 / §6) ────────────────────────────────────
//
// NOTE: `extractResult` is intentionally NOT re-exported at the PACKAGE root
// (it remains available from the `src/llm` layer barrel for the provider's own
// offline tests). It is a pure test-seam helper whose signature references the
// Agent SDK's `SDKResultMessage`; keeping it off the consumer-facing surface
// avoids leaking an internal SDK type into the package's public API. Consumers
// use the `AnthropicAgentProvider` class, not this helper.
export {
    AgentProviderError,
    AnthropicAgentProvider,
    type AnthropicAgentProviderOptions,
    type CacheEntry,
    type CacheKeyParts,
    computeCacheKey,
    CostAccumulator,
    type CostSnapshot,
    type JsonSchema,
    type LLMProvider,
    MockProvider,
    type MockProviderOptions,
    type MockResponder,
    type ProviderRequest,
    type ProviderResult,
    type ProviderUsage,
    resolveAuthEnv,
    ResponseCache,
} from './llm/index';

// ── Out-of-band Stryker seam (§4.2) ─────────────────────────────────────────
export {
    computeMutantId,
    instrument,
    type InstrumentResult,
    type MutantRunResult,
    type MutantRunStatus,
    type Position,
    type Replacement,
    runMutants,
    type RunMutantsOptions,
    type SeamMutant,
    type SourceFile,
    type SourceRange,
} from './seam/index';

// ── Stage-2 pipeline: propose + deterministic filters (§4.3) ────────────────
export {
    applyFilters,
    dedupKey,
    dedupReplacements,
    filterIdentical,
    filterUnparseable,
    isParseable,
    propose,
    PROPOSE_MUTATOR_PREFIX,
    type ProposeOptions,
    type ProposeTarget,
} from './pipeline/index';

// ── Heuristic mutators + monkeypatch injection seam (§3.1.3 / §3.3) ──────────
//
// The heuristic NodeMutators (the first being `NumberLiteralValue`) and the
// `injectMutators()` seam that registers them into Stryker's hardcoded
// `allMutators` registry. Re-exported so the M0 driver and downstream consumers
// can both reach them from the package root.
export { heuristicMutators, type NodeMutator, numberLiteralValueMutator } from './mutators/index';
export { injectMutators, type InjectMutatorsOptions, type InjectMutatorsResult } from './injection';
