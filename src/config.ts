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
