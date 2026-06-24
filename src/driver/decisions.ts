/*
 * The driver's PURE decision surface (functional-architecture §2 / §6) — every
 * driver export EXCEPT the Node-only orchestration entry `runLlmMutation`.
 *
 * This barrel exists so the package root (`src/index.ts`) and `bun test` can pull
 * the full decision API — mutator selection, config reading, switch gating, CLI
 * parsing, run-plan assembly — WITHOUT transitively importing
 * `@stryker-mutator/core` (which only `src/driver/run.ts` imports, and which
 * throws under Bun). The Node-only orchestration entry `runLlmMutation` is reached
 * separately from `./run` (or via the `dist/cli.js` bin).
 */

// ── Mutator selection (PURE) ─────────────────────────────────────────────────
export {
    type HeuristicsConfig,
    type HeuristicSelection,
    selectHeuristicMutators,
} from './select-mutators';

// ── Target config reader (PURE-ish I/O — no Stryker) ─────────────────────────
export {
    readTargetConfig,
    type ReadTargetConfigResult,
    resolveConfigFilePath,
    SUPPORTED_CONFIG_FILE_NAMES,
} from './config-reader';

// ── Switch gating + credentials + Phase-A LLM stub (PURE) ────────────────────
export {
    assertLlmCredentials,
    buildLlmMutator,
    gateSwitches,
    type GatePlan,
    MissingCredentialsError,
    NotImplementedError,
} from './gate';

// ── CLI argument parsing (PURE) ──────────────────────────────────────────────
export {
    type InjectionMode,
    parseArgs,
    type ParseResult,
    type RunOptions,
    USAGE,
} from './cli-args';

// ── Run-plan assembly (PURE) ─────────────────────────────────────────────────
export { buildRunPlan, type PartialStrykerOptions, type RunPlan } from './plan';
