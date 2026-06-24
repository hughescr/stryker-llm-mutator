/*
 * Package: @hughescr/stryker-llm-mutator
 *
 * Public entry point / barrel.
 *
 * This package widens Stryker's mutation coverage two ways: a set of formulaic,
 * network-free HEURISTIC mutators (the P1–P4 catalog), and an optional
 * DYNAMIC-LLM pre-pass (default model `claude-haiku-4-5`) that proposes localized,
 * behavior-changing edits a fixed operator table cannot express.
 *
 * ARCHITECTURE — MONKEYPATCH-INJECTION (functional-architecture §3). Stryker v9
 * has no public "Mutator" plugin kind: the operator set is hardcoded in the
 * instrumenter as a mutable, non-frozen module-level array (`allMutators`). So we
 * RUNTIME-RESOLVE that array (see `src/instrumenter-registry.ts`) and `push()` our
 * own `NodeMutator`s into it — the heuristic mutators and the single per-run
 * synchronous `LLMMutator` whose replacements the async pre-pass precomputed.
 *
 * TWO INTEGRATION PATHS share that injection:
 *   • PRIMARY (M6): `withLlmMutators(config)` — a config-wrapper the consumer drops
 *     into their `stryker.conf.mjs` so STOCK `stryker run` picks up our mutators.
 *     It injects during config evaluation (same process, before instrumentation),
 *     then returns the Stryker config with `llmMutator` stripped. No separate CLI.
 *   • ALTERNATIVE: the `stryker-llm` bin (`dist/cli.js`) drives in-process
 *     `new Stryker(...).runMutationTest()` itself.
 * Either way Stryker instruments with our mutators and drives its entire pipeline
 * (sandbox, perTest coverage, concurrency, checkers, reporters) over them for free.
 *
 * The `strykerPlugins` array exports a real `PluginKind.Reporter` plugin
 * (`llm-mutator`) that renders OUR survivor view + LLM cost on the stock
 * `stryker run` path (where the consumer cannot call our reporter directly); the
 * MUTATOR injection itself is still by monkeypatch (Stryker has no Mutator plugin
 * kind), NOT through a plugin descriptor.
 *
 * This module re-exports the stable surface of the components — the LLM provider
 * abstraction (§4.1), the heuristic mutators + the `injectMutators()` seam (§3.1),
 * the dynamic-LLM pre-pass (targeting → batched propose → filters → precomputed
 * map → injected `LLMMutator`, §4), the M4 reporter (§6), the driver's pure
 * decision surface (§2 / §6), and the `llmMutator` config schema (§6) — so
 * downstream consumers import from the package root. The out-of-band CONTINGENCY
 * seam (§3.5) is INTERNAL-only and deliberately NOT on this public surface (its
 * worker is not emitted into `dist`); it is reached directly via `./seam`.
 */

import { llmMutatorReporterPlugin } from './report/reporter-plugin';

/** Package version marker. */
export const VERSION = '0.1.0';

/**
 * The Stryker plugin declaration array. Stryker's plugin-loader reads a plugin
 * module's `strykerPlugins` export when the consumer lists this package in
 * `plugins:[...]`. It holds the real `llm-mutator` `PluginKind.Reporter` plugin,
 * which renders OUR survivor view + LLM cost on the stock `stryker run` path. The
 * MUTATOR injection is NOT a plugin (Stryker v9 has no public Mutator plugin kind)
 * — it happens by monkeypatch-injection via `withLlmMutators(...)` during config
 * evaluation (functional-architecture §3.1).
 */
export const strykerPlugins: readonly unknown[] = [llmMutatorReporterPlugin];

// ── Config (§4.4 / §6) ──────────────────────────────────────────────────────
export {
    DEFAULT_MODEL,
    HeuristicOperator,
    type HeuristicOperatorName,
    llmMutatorConfigSchema,
    type LlmMutatorConfig,
    type LlmMutatorConfigInput,
    ProviderName,
    Stage3Mode,
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

// ── Out-of-band CONTINGENCY seam (§3.5 fallback — NOT the live path) ─────────
//
// The seam (drive the instrumenter ourselves + a thin runner) is the DOCUMENTED
// CONTINGENCY for if a future Stryker freezes/moves `allMutators` (§3.5). It is
// deliberately NOT re-exported from this public barrel: its worker
// (`src/seam/instrument-worker.mjs`) is not emitted into `dist` and resolves the
// instrumenter via a hardcoded `node_modules/...` path, so the seam only works
// INTERNALLY (exercised by its own tests, which import from `./seam/index`
// directly). Its `parseReplacementFragment` helper is REUSED by the live LLM
// pre-pass and is re-exported below with the pipeline.

// ── Stage-2 pipeline: propose + deterministic filters (§4.3) ────────────────
// ── + M3 dynamic-LLM pre-pass: targeting, near-equivalence, map-builder,
//      pre-pass orchestration, budget wrapper (§4 Gates 1–4) ─────────────────
export {
    applyFilters,
    type BabelLoc,
    type BudgetedProviderOptions,
    BudgetExceededError,
    type BudgetLogger,
    type BuildLlmMutatorMapResult,
    buildLlmMutatorMap,
    type BuildProposeTargetsOptions,
    type BuildProposeTargetsResult,
    buildProposeTargets,
    type CoverageLookup,
    createBudgetedProvider,
    dedupKey,
    dedupReplacements,
    type DropLogger,
    type DroppedReplacement,
    filterIdentical,
    filterNearEquivalent,
    type FilterNearEquivalentOptions,
    filterUnparseable,
    isLlmWorthy,
    isNearEquivalent,
    isParseable,
    type LlmMutatorMap,
    locKeyFromBabelLoc,
    locKeyFromRange,
    type ParsedEntry,
    parseReplacementFragment,
    type PrePassLogger,
    type PrePassStopReason,
    propose,
    PROPOSE_MUTATOR_PREFIX,
    type ProposeOptions,
    type ProposeTarget,
    RICHNESS_BOOST,
    RICHNESS_THRESHOLD,
    RISK_WEIGHTS,
    RollingYield,
    runPrePass,
    type RunPrePassDeps,
    type RunPrePassResult,
    type SourceFileInput,
    type TargetLogger,
    type TargetMeta,
} from './pipeline/index';

// ── M4 reporter: survivor view + cost summary + filtered artifact (§6) ───────
export {
    type FilteredMutant,
    type FilteredReport,
    type FormatReportOptions,
    formatReport,
    isOurMutant,
    LLM_PREFIX,
    type MutantEnrichment,
    type ReportOutput,
} from './report/index';

// ── id→enrichment correlator (shared by run.ts CLI + the Reporter plugin) ─────
export { correlateEnrichment } from './report/correlate';

// ── The real Stryker Reporter plugin (M6 stock-`stryker run` path) ───────────
//
// `strykerPlugins` (above) holds `llmMutatorReporterPlugin`; the name + plugin are
// re-exported so consumers/tests can reference them. The user activates the
// reporter via `reporters: ['llm-mutator', ...]` after listing this package in
// `plugins: ['@hughescr/stryker-llm-mutator']`.
export { LLM_MUTATOR_REPORTER_NAME, llmMutatorReporterPlugin } from './report/reporter-plugin';

// ── Runtime-state singleton: the wrapper→reporter cost/map hand-off (§6) ──────
export {
    getRuntimeState,
    resetRuntimeState,
    type RuntimeState,
    setRunCost,
    setRunMap,
} from './runtime-state';

// ── PRIMARY M6 integration path: the stock-`stryker run` config wrapper ──────
//
// `withLlmMutators(config)` is what a consumer drops into their `stryker.conf.mjs`
// default export so STOCK `stryker run` picks up our mutators (it injects during
// config evaluation, returns the config with `llmMutator` stripped). The heuristics
// path is synchronous; the dynamicLLM path must be awaited (`export default await
// withLlmMutators(cfg)`).
export {
    withLlmMutators,
    type WithLlmMutatorsConfig,
    type WithLlmMutatorsLog,
    type WithLlmMutatorsOptions,
} from './with-llm-mutators';

// ── Heuristic mutators + monkeypatch injection seam (§3.1.3 / §3.3) ──────────
//
// The heuristic NodeMutators (the first being `NumberLiteralValue`) and the
// `injectMutators()` seam that registers them into Stryker's hardcoded
// `allMutators` registry. Re-exported so the M0 driver and downstream consumers
// can both reach them from the package root.
export {
    arrayMethodSwapMutator,
    awaitDropMutator,
    boundaryOffByOneMutator,
    callArgumentTweakMutator,
    comparisonBoundaryShiftMutator,
    createLlmMutator,
    defaultParamValueTweakMutator,
    earlyReturnInjectionMutator,
    fallbackOperandSubstitutionMutator,
    heuristicMutators,
    LLM_MUTATOR_NAME,
    type NodeMutator,
    type NodePath,
    numberLiteralValueMutator,
    optionalChainForceMutator,
    promiseCombinatorSwapMutator,
    spreadOperandDropMutator,
    stringMethodArgSwapMutator,
    ternaryBranchSwapMutator,
} from './mutators/index';
export { injectMutators, type InjectMutatorsOptions, type InjectMutatorsResult } from './injection';

// ── Driver: switches → mutator selection → in-process Stryker (§2 / §6) ──────
//
// The driver's PURE decision surface is re-exported here so consumers can read
// the target config, select heuristics, gate the switches, parse CLI args, and
// build a run plan WITHOUT loading Stryker. We DELIBERATELY do NOT re-export the
// Node-only `runLlmMutation` runtime function from this root barrel: it imports
// `@stryker-mutator/core`, whose instrumenter throws `generator is not a function`
// under Bun, and `tests/index.test.ts` imports this barrel under `bun test`. The
// orchestration entry is reached instead via the `dist/cli.js` bin or a direct
// import of `./driver/run` (Node-only callers). Its result/log TYPES are
// re-exported here (types are erased at runtime, so they pull in nothing).
export {
    assertLlmCredentials,
    buildLlmMutator,
    type BuildLlmMutatorDeps,
    type BuildLlmMutatorResult,
    buildRunPlan,
    type GatePlan,
    gateSwitches,
    type HeuristicSelection,
    type HeuristicsConfig,
    type InjectionMode,
    MissingCredentialsError,
    NotImplementedError,
    parseArgs,
    type ParseResult,
    type PartialStrykerOptions,
    readTargetConfig,
    type ReadTargetConfigResult,
    resolveConfigFilePath,
    type RunOptions,
    type RunPlan,
    selectHeuristicMutators,
    SUPPORTED_CONFIG_FILE_NAMES,
    USAGE,
} from './driver/decisions';
export type { LogFn, RunLlmMutationResult } from './driver/run';
