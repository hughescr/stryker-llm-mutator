/*
 * Shared contract: the `llmMutator` config block.
 *
 * A `zod`-validated options block that lives under `llmMutator` in
 * `stryker.conf.*` (see `docs/development-plan.md` §4.4). It declares the
 * provider + model, the budget caps that bound LLM spend at every stage, the
 * stage-3 confirmer posture (`off` by default — §4.3), and where the
 * content-addressed cache lives (§7). Every field has a sane default so an
 * empty `llmMutator: {}` parses to a complete, usable config.
 *
 * This module exports the schema and the inferred parsed type. It imports no
 * sibling implementation module.
 */

import { z } from 'zod';

/**
 * The default model for all LLM calls. The first provider is the Anthropic
 * subscription path via the Agent SDK driving this model (development-plan §4.1 / §6).
 */
export const DEFAULT_MODEL = 'claude-haiku-4-5';

/**
 * Identifiers for the LLM provider backing the pipeline. All sit behind the
 * single {@link LLMProvider} abstraction; this only selects which implementation
 * to construct (development-plan §6). `mock` is the offline, network-free
 * provider used by unit tests and `--dry-run`-style local checks.
 */
export const ProviderName = z.enum([
    /** Anthropic subscription via the Agent SDK, authed with CLAUDE_CODE_OAUTH_TOKEN (FIRST / dev). */
    'anthropic-agent-sdk',
    /** Raw Anthropic API key, one-shot completion — the sanctioned shippable default. */
    'anthropic-api',
    /** OpenAI, one-shot completion. */
    'openai',
    /** Any OpenAI-compatible endpoint with a configurable base URL. */
    'openai-compatible',
    /** Offline, deterministic, network-free provider for tests. */
    'mock',
]);

/** The stage-3 confirm-wrongness posture. `off` by default (development-plan §4.3). */
export const Stage3Mode = z.enum(['off', 'confirm']);

/**
 * The heuristic operator catalog (functional-architecture §5). Each name is the
 * `name` field of a heuristic `NodeMutator` and the allow-list token used by
 * `heuristics.operators`. The names span the prioritized P1–P4 catalog; only the
 * P1 trio (`NumberLiteralValue`, `BoundaryOffByOne`, `FallbackOperandSubstitution`)
 * is implemented today, but the enum carries the full catalog so a target config
 * can name a not-yet-shipped operator without a schema error (it is simply absent
 * from the live registry until its milestone lands — see the driver's
 * `selectHeuristicMutators`). The enum is intentionally a CLOSED allow-list, so an
 * unknown/typo'd operator name is a config error rather than a silent no-op.
 */
export const HeuristicOperator = z.enum([
    // P1 — shipped (M1)
    'NumberLiteralValue',
    'BoundaryOffByOne',
    'FallbackOperandSubstitution',
    // P2
    'ComparisonBoundaryShift',
    'CallArgumentTweak',
    'AwaitDrop',
    // P3
    'EarlyReturnInjection',
    'SpreadOperandDrop',
    'ArrayMethodSwap',
    'PromiseCombinatorSwap',
    // P4
    'DefaultParamValueTweak',
    'OptionalChainForce',
    'StringMethodArgSwap',
    'TernaryBranchSwap',
]);

/** A single heuristic operator name from the {@link HeuristicOperator} catalog. */
export type HeuristicOperatorName = z.infer<typeof HeuristicOperator>;

/**
 * The `llmMutator` options schema. Defaults are applied field-by-field so a
 * caller may supply any subset; an omitted field falls back to its documented
 * default. See {@link LlmMutatorConfig} for the inferred type.
 */
export const llmMutatorConfigSchema = z
    .object({
        /** Which provider implementation to construct. Default: the dev subscription path. */
        provider: ProviderName.default('anthropic-agent-sdk'),
        /** Model id passed to the provider. Default `claude-haiku-4-5`. */
        model: z.string().min(1).default(DEFAULT_MODEL),
        /**
         * Budget caps bounding LLM spend. Stage-1 risk targeting keeps only the
         * top-N spans per file, and stage-2 proposes at most `maxCandidatesPerFile`
         * mutants per file (development-plan §4.3 / §7 cost shape).
         */
        budget: z
            .object({
                /** Stage-1: keep at most this many highest-risk spans per file. */
                topSpansPerFile: z.number().int().positive().default(10),
                /** Stage-2: propose at most this many candidate mutants per file. */
                maxCandidatesPerFile: z.number().int().positive().default(20),
            })
            .prefault({}),
        /**
         * Stage-3 confirm-wrongness configuration. `off` by default; when
         * `confirm`, it is scoped to pure standalone-importable functions,
         * confirm-only, and every drop is logged (development-plan §4.3 / §7).
         */
        stage3: z
            .object({
                /** `off` (default) disables stage-3 entirely; `confirm` enables the non-equivalence confirmer. */
                mode: Stage3Mode.default('off'),
                /**
                 * Number of distinguishing-input attempts before a surviving
                 * candidate is dropped-and-logged. Only consulted when `mode` is
                 * `confirm`.
                 */
                retries: z.number().int().positive().default(3),
            })
            .prefault({}),
        /**
         * Directory for the content-addressed cache (key =
         * SHA(model + prompt + file content + span)) that makes warm runs stable
         * (development-plan §7 reproducibility). Relative paths resolve against
         * the Stryker working directory.
         */
        cacheDir: z.string().min(1).default('.stryker-llm-cache'),
        /**
         * The HEURISTICS switch block (functional-architecture §6). The
         * deterministic, network-free heuristic mutators (default ON). With an
         * empty `operators` allow-list every registered heuristic runs; otherwise
         * only the named operators run. `skipUncovered` deprioritizes zero-coverage
         * spans where a coverage signal is available. `.prefault({})` (NOT
         * `.default({})`) is the zod-v4 idiom for a nested object whose own fields
         * each carry defaults — so an absent `heuristics` block still fills the
         * inner defaults.
         */
        heuristics: z
            .object({
                /** THE switch — heuristics on by default (no credentials/network). */
                enabled: z.boolean().default(true),
                /** `[]` = all registered heuristics; else an allow-list of operator names. */
                operators: z.array(HeuristicOperator).default([]),
                /** Deprioritize zero-coverage spans where a coverage signal exists. */
                skipUncovered: z.boolean().default(true),
            })
            .prefault({}),
        /**
         * The DYNAMIC-LLM switch block (functional-architecture §6). The targeted
         * LLM pre-pass + injected `LLMMutator` (default OFF — it costs money and
         * needs credentials). The `targeting` / `budget` / `diminishingReturns`
         * sub-blocks bound which spans are sent to the model and how much may be
         * spent. These are consumed only when `enabled` is true (the M3 path); in
         * M1/M2 the whole block is dormant. Each sub-block uses `.prefault({})` so
         * an absent block fills its inner defaults.
         */
        dynamicLLM: z
            .object({
                /** THE switch — dynamic LLM off by default. */
                enabled: z.boolean().default(false),
                /** Stage-1 risk/EV targeting bounds (functional-architecture §4 Gate 1). */
                targeting: z
                    .object({
                        /** Keep at most this many highest-EV spans per file. */
                        topSpansPerFile: z.number().int().positive().default(10),
                        /** Eligibility floor: only spans with `risk >= minRiskScore`. */
                        minRiskScore: z.number().min(0).default(1),
                        /** Require a coverage signal (`coveredBy >= 1`) for eligibility. */
                        requireCoverage: z.boolean().default(true),
                    })
                    .prefault({}),
                /** LLM-call budget caps (functional-architecture §4 Gate 3 / §6). */
                budget: z
                    .object({
                        /** Propose at most this many diverse candidates per file. */
                        maxCandidatesPerFile: z.number().int().positive().default(20),
                        /** Hard cap on total `provider.generate()` calls per run. */
                        maxLlmCallsPerRun: z.number().int().positive().default(500),
                        /** HARD dollar abort, consulted BETWEEN calls (§4 mid-run ceiling). */
                        maxCostUsd: z.number().positive().default(5),
                    })
                    .prefault({}),
                /** Diminishing-returns stop (functional-architecture §4 STOPPING). */
                diminishingReturns: z
                    .object({
                        /** Rolling window of the last `window` calls. */
                        window: z.number().int().positive().default(20),
                        /** Floor on candidate/diversity yield-per-call before halting. */
                        minYieldPerCall: z.number().min(0).default(0.1),
                    })
                    .prefault({}),
            })
            .prefault({}),
    })
    .strict();

/**
 * The parsed, fully-defaulted `llmMutator` config. Produced by
 * `llmMutatorConfigSchema.parse(...)`; every field is present (no optionals)
 * because the schema fills defaults. This is the type the pipeline, seam, and
 * provider factory all consume.
 */
export type LlmMutatorConfig = z.infer<typeof llmMutatorConfigSchema>;

/** The raw, pre-parse input shape (all fields optional) accepted from `stryker.conf.*`. */
export type LlmMutatorConfigInput = z.input<typeof llmMutatorConfigSchema>;
