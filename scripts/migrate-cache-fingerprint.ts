/*
 * ════════════════════════════════════════════════════════════════════════════
 * CACHE FINGERPRINT MIGRATION — re-key a `.stryker-llm-cache` written by
 * ≤ 1.2.1 (verbatim-prompt keys) onto the fingerprint keys, WITHOUT any
 * network call.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS:
 *   Up to 1.2.1 a cache entry lived at `<sha256(model \0 prompt \0 system \0
 *   schema)>.json` where `prompt` embedded the function's VERBATIM source text.
 *   The pre-pass now keys each call by the function's STRUCTURAL fingerprint
 *   instead (`src/pipeline/propose.ts` `proposeCacheIdentity` →
 *   `src/pipeline/fingerprint.ts`), so every legacy entry silently misses and
 *   the first unfrozen run after upgrading would re-buy the whole pre-pass. The
 *   entry body stores no prompt, so it cannot be re-keyed from the file alone —
 *   but the legacy prompt IS deterministic from the project's sources, so we
 *   rebuild every legacy request and copy each hit to its new key.
 *
 * HOW IT WORKS:
 *   Reads the project's `llmMutator` block (model, cacheDir, candidate cap) and
 *   its mutate sources the way `withLlmMutators` does, builds EVERY eligible
 *   function target (no per-file / per-run caps, no coverage requirement), and
 *   for each computes (a) the LEGACY key from a FROZEN copy of the 1.2.1 prompt
 *   builder + system prompt + schema kept in this file (so a later prompt change
 *   cannot break the migration) and (b) the NEW fingerprint key via the live
 *   `proposeCacheIdentity`. When the legacy entry exists and the new one does
 *   not, the entry is copied under the new key with `meta` (fingerprint +
 *   provenance) added. Legacy files are left in place; nothing reads them.
 *
 * SAFETY: a JS/MJS config that evaluates `withLlmMutators(...)` at import time
 *   is NEVER imported here (importing it would run a live, billed pre-pass).
 *   Such a config is skipped with a note (schema defaults apply) — or, when
 *   named explicitly via `--config`, the script refuses. Pass a `.json` config
 *   or rely on the defaults (`model: haiku`, `cacheDir: .stryker-llm-cache`).
 *
 * HOW THE HUMAN RUNS THIS (offline, $0):
 *   bun scripts/migrate-cache-fingerprint.ts --project <dir> [--config <file>]
 *       [--mutate '<glob>']... [--dry-run]
 *   Defaults: --project = cwd; --config = the project's stryker config probed
 *   the way the CLI does (json preferred; a withLlmMutators config is skipped);
 *   --mutate = src/**\/*.ts (repeatable; what `withLlmMutators` scans).
 *
 * Imports from SRC (not dist): scripts are runnable drivers, not library code.
 * The core is exported (`migrateCacheFingerprint`, `loadMigrationConfig`) so
 * it is unit-tested; the CLI runs only when this file is the entry point.
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import { llmMutatorConfigSchema, type LlmMutatorConfig } from '../src/config';
import { readTargetConfig, resolveConfigFilePath } from '../src/driver/config-reader';
import { readMutateSources } from '../src/driver/read-sources';
import { computeCacheKey, ResponseCache, type CacheEntryMeta } from '../src/llm/index';
import type { JsonSchema } from '../src/llm/types';
import { proposeCacheIdentity, type ProposeTarget } from '../src/pipeline/propose';
import { buildProposeTargets } from '../src/pipeline/targeting';

// ── FROZEN 1.2.1 request builders — DO NOT "fix" these to match src ──────────

/** The 1.2.1 system prompt, byte-for-byte (`dist/index.js` PROPOSE_SYSTEM). */
export const LEGACY_PROPOSE_SYSTEM = [
    'You are a mutation-testing assistant for JavaScript/TypeScript.',
    'You are given the exact source text of ONE function and surrounding context.',
    'Propose localized, behavior-changing mutations, each targeting a SMALL, SELF-CONTAINED sub-expression WITHIN the function.',
    'For EACH mutation:',
    '- pick a single small sub-expression inside the function (e.g. "hour >= 12", "a ?? b", "len - 1", "items[i + 1]") — NOT the whole function, NOT a statement;',
    '- put that sub-expression\'s EXACT verbatim source (character-for-character, as it appears in the function) in "original" — it MUST appear verbatim in the function text;',
    '- put the edited sub-expression in "replacement", keeping it a syntactically valid expression that is valid IN PLACE where "original" sits;',
    '- ensure both "original" and "replacement" are syntactically valid in place, and that the change alters runtime behavior a good test should catch;',
    '- prefer plausible real bugs (off-by-one, flipped condition, wrong operator, swapped argument, dropped guard, wrong boundary literal, etc.).',
    'Do NOT add optional chaining (`?.`) when the supplied code proves the receiver non-nullish. Consider it only when the supplied code shows a concrete, reachable runtime-nullish receiver path whose behavior would change; if no such runtime possibility is shown, choose another mutation. A TypeScript annotation, cast, or non-null assertion alone proves neither condition.',
    'Do NOT propose semantically-equivalent rewrites. Do NOT change identifiers that are not part of the behavior. Do NOT echo the whole function.',
    'Return ONLY the structured object; no prose outside it.',
].join('\n');

/** The 1.2.1 response schema, byte-for-byte (`dist/index.js` buildProposeSchema). */
export function legacyProposeSchema(maxCandidates: number): JsonSchema {
    return {
        type: 'object',
        additionalProperties: false,
        required: ['candidates'],
        properties: {
            candidates: {
                type: 'array',
                minItems: 0,
                maxItems: maxCandidates,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['original', 'replacement', 'mutatorTag', 'rationale'],
                    properties: {
                        original: {
                            type: 'string',
                            description:
                                'The EXACT verbatim source of a SMALL, self-contained sub-expression you chose to mutate. It MUST appear verbatim (character-for-character) somewhere inside the FUNCTION block, and must be a single complete expression (e.g. "hour >= 12", "a ?? b", "items[i + 1]") — NOT the whole function and NOT a statement.',
                        },
                        replacement: {
                            type: 'string',
                            description:
                                'The edited sub-expression that replaces "original" in place. Must be a syntactically valid expression, differ from original, and be valid where "original" sits.',
                        },
                        mutatorTag: {
                            type: 'string',
                            description:
                                'Short kebab-case label for the kind of mutation, e.g. "negate-condition" or "off-by-one".',
                        },
                        rationale: {
                            type: 'string',
                            description:
                                'One sentence on why this is a plausible, behavior-changing, real-bug-like mutation.',
                        },
                    },
                },
            },
        },
    };
}

/** The 1.2.1 user prompt, byte-for-byte (`dist/index.js` buildProposePrompt): VERBATIM function text. */
export function legacyProposePrompt(
    target: Pick<ProposeTarget, 'spanText' | 'context'>,
    maxCandidates: number,
): string {
    const parts = [
        `Propose up to ${String(maxCandidates)} distinct, behavior-changing mutations, each on a small sub-expression WITHIN the FUNCTION below.`,
        '',
        'FUNCTION (mutate sub-expressions inside this; "original" must be a verbatim substring of it):',
        '```',
        target.spanText,
        '```',
    ];
    if (
        target.context !== undefined &&
        target.context.length > 0 &&
        target.context !== target.spanText
    ) {
        parts.push(
            '',
            'CONTEXT (for understanding only; do NOT mutate outside the FUNCTION):',
            '```',
            target.context,
            '```',
        );
    }
    return parts.join('\n');
}

// ── Config loading (never evaluates a withLlmMutators config) ────────────────

/** A note sink for the script's progress lines. */
export type MigrationLog = (line: string) => void;

/** The outcome of {@link loadMigrationConfig}: the parsed block + where it came from. */
export interface MigrationConfig {
    /** The fully-defaulted `llmMutator` block. */
    config: LlmMutatorConfig;
    /** The config file read, or `undefined` when schema defaults were used. */
    source?: string;
}

/**
 * Read the project's `llmMutator` block the way the CLI does (`readTargetConfig`),
 * EXCEPT that a JS config whose source mentions `withLlmMutators` is never
 * imported — evaluating it would run the live pre-pass. When such a file was
 * merely probed it is skipped (defaults apply, a note is logged); when it was
 * named explicitly via `--config`, this throws so the caller knows their
 * overrides were not read.
 */
export async function loadMigrationConfig(
    projectDir: string,
    configFile: string | undefined,
    log?: MigrationLog,
): Promise<MigrationConfig> {
    const path = await resolveConfigFilePath(projectDir, configFile);
    if (path === undefined) {
        return { config: llmMutatorConfigSchema.parse({}) };
    }
    if (extname(path).toLowerCase() !== '.json') {
        const text = await readFile(path, 'utf8');
        if (text.includes('withLlmMutators')) {
            const why =
                `${path} evaluates withLlmMutators() at import time, which would run a live ` +
                'LLM pre-pass; it is not imported.';
            if (configFile !== undefined) {
                throw new Error(
                    `${why} Pass a .json config (or omit --config to use the schema defaults).`,
                );
            }
            log?.(`note: ${why} Using schema defaults (model haiku, cacheDir .stryker-llm-cache).`);
            return { config: llmMutatorConfigSchema.parse({}) };
        }
    }
    const { config } = await readTargetConfig(projectDir, path);
    return { config, source: path };
}

// ── The migration ────────────────────────────────────────────────────────────

/** Tally of what the walk found. */
export interface MigrationStats {
    /** Eligible function targets examined. */
    scanned: number;
    /** Legacy entries copied (or, in dry-run, that WOULD be copied) to their new key. */
    migrated: number;
    /** Targets whose fingerprint-keyed entry already exists (nothing to do). */
    alreadyPresent: number;
    /** Targets with neither a legacy nor a new entry (never proposed, or source changed). */
    missing: number;
}

/** Options for {@link migrateCacheFingerprint}. */
export interface MigrateOptions {
    /** The project root: `cacheDir` and the mutate globs resolve against it. */
    projectDir: string;
    /** The mutate globs; absent ⇒ the `withLlmMutators` default (`src/**\/*.ts`). */
    mutate?: readonly string[];
    /** Report only; write nothing. */
    dryRun: boolean;
    /** Progress + summary sink (defaults to silent). */
    log?: MigrationLog;
}

/** One planned copy: the legacy key to read, the new key + meta to write. */
interface PlannedCopy {
    legacyKey: string;
    cacheKey: string;
    meta: CacheEntryMeta;
}

/** The config with every selection cap lifted, so EVERY eligible function is a target. */
function uncapped(cfg: LlmMutatorConfig): LlmMutatorConfig {
    return {
        ...cfg,
        dynamicLLM: {
            ...cfg.dynamicLLM,
            targeting: {
                ...cfg.dynamicLLM.targeting,
                topSpansPerFile: Number.MAX_SAFE_INTEGER,
                requireCoverage: false,
            },
            budget: { ...cfg.dynamicLLM.budget, maxLlmCallsPerRun: Number.MAX_SAFE_INTEGER },
        },
    };
}

/**
 * Walk every eligible function of the project, and for each whose LEGACY
 * (verbatim-prompt) entry exists while its fingerprint-keyed entry does not,
 * copy the entry under the new key with `meta` added. Pure file I/O; $0.
 *
 * @param cfg The project's parsed `llmMutator` block (model, cacheDir, candidate cap).
 * @param options Project dir, mutate globs, dry-run switch, log sink.
 * @returns The scanned / migrated / already-present / missing tallies.
 */
export async function migrateCacheFingerprint(
    cfg: LlmMutatorConfig,
    options: MigrateOptions,
): Promise<MigrationStats> {
    const projectDir = resolve(options.projectDir);
    const cacheDir = resolve(projectDir, cfg.cacheDir);
    const cache = new ResponseCache(cacheDir);
    const maxCandidates = cfg.dynamicLLM.budget.maxCandidatesPerFile;
    const { log } = options;

    const files = await readMutateSources(projectDir, options.mutate);
    const { targets } = buildProposeTargets(files, uncapped(cfg));
    const keys = await cache.keys();
    log?.(
        `cache ${cacheDir}: ${String(keys.size)} entr${keys.size === 1 ? 'y' : 'ies'}; ` +
            `${String(files.length)} file(s), ${String(targets.length)} eligible function(s)`,
    );

    const stats: MigrationStats = { scanned: 0, migrated: 0, alreadyPresent: 0, missing: 0 };
    const planned: PlannedCopy[] = [];
    for (const target of targets) {
        stats.scanned += 1;
        const { cacheKey, meta } = proposeCacheIdentity(target, cfg.model, maxCandidates);
        if (keys.has(cacheKey)) {
            stats.alreadyPresent += 1;
            continue;
        }
        const legacyKey = computeCacheKey({
            model: cfg.model,
            prompt: legacyProposePrompt(target, maxCandidates),
            system: LEGACY_PROPOSE_SYSTEM,
            schema: legacyProposeSchema(maxCandidates),
        });
        if (!keys.has(legacyKey)) {
            stats.missing += 1;
            continue;
        }
        // Two identical functions share a new key: the first copy serves both.
        keys.add(cacheKey);
        planned.push({ legacyKey, cacheKey, meta });
    }

    // Batch the reads, then the writes — never one awaited round-trip per entry.
    const entries = await Promise.all(planned.map(copy => cache.get(copy.legacyKey)));
    const writes: Promise<void>[] = [];
    for (const [i, copy] of planned.entries()) {
        const entry = entries[i];
        if (entry === undefined) {
            stats.missing += 1; // unreadable/corrupt legacy file — nothing to copy.
            continue;
        }
        stats.migrated += 1;
        if (!options.dryRun) {
            writes.push(cache.set(copy.cacheKey, { ...entry, meta: copy.meta }));
        }
    }
    await Promise.all(writes);

    log?.(
        `${options.dryRun ? '[dry-run] ' : ''}${String(stats.scanned)} scanned — ` +
            `${String(stats.migrated)} migrated, ${String(stats.alreadyPresent)} already present, ` +
            `${String(stats.missing)} missing (no legacy entry)`,
    );
    return stats;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            project: { type: 'string', default: process.cwd() },
            config: { type: 'string' },
            mutate: { type: 'string', multiple: true },
            'dry-run': { type: 'boolean', default: false },
        },
    });
    const projectDir = resolve(values.project);
    // eslint-disable-next-line no-console -- CLI progress + summary.
    const log: MigrationLog = line => console.log(line);
    const { config, source } = await loadMigrationConfig(projectDir, values.config, log);
    log(`config: ${source ?? 'schema defaults (no config file read)'}`);
    await migrateCacheFingerprint(config, {
        projectDir,
        ...(values.mutate === undefined ? {} : { mutate: values.mutate }),
        dryRun: values['dry-run'],
        log,
    });
}
