/*
 * ════════════════════════════════════════════════════════════════════════════
 * CACHE MODEL MIGRATION — re-key a `.stryker-llm-cache` from one model id to
 * another WITHOUT any network call.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS:
 *   A cache entry lives at `<sha256(model \0 prompt \0 system \0 schema)>.json`
 *   (`src/llm/cache.ts` computeCacheKey) and its body stores only the validated
 *   value + call metadata — NOT the prompt. So when the configured model id
 *   changes (e.g. the default moved from `claude-haiku-4-5` to the `haiku`
 *   alias), every existing entry silently misses and the next run re-bills the
 *   whole pre-pass, even though the alias serves the same model. The entry
 *   cannot be re-keyed from the file alone (no prompt inside), but the prompt IS
 *   deterministic from the project's sources — so we rebuild every request the
 *   real pre-pass would issue and copy each hit to its new key.
 *
 * HOW IT WORKS:
 *   Runs the REAL targeting + pre-pass (`readMutateSources` → `buildProposeTargets`
 *   → `runPrePass`) over the project with a MIGRATING provider in place of the
 *   budgeted/network one. For each request the pre-pass issues, the provider
 *   computes the key under `--from` and under `--to`; when the old file exists
 *   and the new one does not, it copies the entry (updating the informational
 *   `model` field). It never calls a model, never spends, and returns an empty
 *   candidate list so the pre-pass simply walks every target (the diminishing-
 *   returns stop is disabled for the walk). Only targets whose source is
 *   unchanged since the entry was written can match — exactly the set that would
 *   hit on the next run anyway.
 *
 * HOW THE HUMAN RUNS THIS (offline, $0):
 *   bun scripts/migrate-cache-model.ts --project <dir> --from claude-haiku-4-5 --to haiku \
 *       [--cache .stryker-llm-cache] [--mutate 'src/**\/*.ts']... [--dry-run]
 *   Defaults: --project = cwd, --cache = .stryker-llm-cache (relative to the
 *   project), --mutate = src/**\/*.ts (repeatable; negated globs are not
 *   supported — extra files only add targets that never hit).
 *
 * Imports from SRC (not dist): scripts are runnable drivers, not library code.
 */

import { parseArgs } from 'node:util';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { llmMutatorConfigSchema } from '../src/config';
import { readMutateSources } from '../src/driver/read-sources';
import { computeCacheKey, CostAccumulator } from '../src/llm/index';
import type { LLMProvider, ProviderRequest, ProviderResult } from '../src/llm/types';
import { runPrePass } from '../src/pipeline/prepass';
import { buildProposeTargets } from '../src/pipeline/targeting';

const { values } = parseArgs({
    options: {
        project: { type: 'string', default: process.cwd() },
        cache: { type: 'string', default: '.stryker-llm-cache' },
        from: { type: 'string' },
        to: { type: 'string' },
        mutate: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean', default: false },
    },
});

if (values.from === undefined || values.to === undefined) {
    // eslint-disable-next-line no-console -- CLI usage text.
    console.error(
        'usage: bun scripts/migrate-cache-model.ts --from <model> --to <model> [--project <dir>] [--cache <dir>] [--mutate <glob>]... [--dry-run]',
    );
    process.exit(2);
}
const fromModel = values.from;
const toModel = values.to;
const projectDir = resolve(values.project);
const cacheDir = resolve(projectDir, values.cache);
const dryRun = values['dry-run'];

/** Tally of what the walk found, printed at the end. */
const stats = { requests: 0, migrated: 0, alreadyPresent: 0, noOldEntry: 0 };

/**
 * The migrating provider: re-keys one request from `fromModel` to `toModel` if
 * the old entry exists, then answers with zero candidates at zero cost so the
 * pre-pass moves on to the next target without touching the network.
 */
const migrator: LLMProvider = {
    name: `cache-migrator(${fromModel}→${toModel})`,
    async generate<T>(request: ProviderRequest): Promise<ProviderResult<T>> {
        stats.requests += 1;
        const parts = { prompt: request.prompt, system: request.system, schema: request.schema };
        const oldPath = join(cacheDir, `${computeCacheKey({ model: fromModel, ...parts })}.json`);
        const newPath = join(cacheDir, `${computeCacheKey({ model: toModel, ...parts })}.json`);

        let raw: string | undefined;
        try {
            raw = await readFile(oldPath, 'utf8');
        } catch {
            stats.noOldEntry += 1;
        }
        if (raw !== undefined) {
            let newExists = true;
            try {
                await readFile(newPath, 'utf8');
            } catch {
                newExists = false;
            }
            if (newExists) {
                stats.alreadyPresent += 1;
            } else {
                stats.migrated += 1;
                if (!dryRun) {
                    // Keep the body byte-identical except the informational `model`
                    // field, which records the id the entry is now filed under.
                    const entry = JSON.parse(raw) as Record<string, unknown>;
                    if (entry.model === fromModel) {
                        entry.model = toModel;
                        await writeFile(newPath, JSON.stringify(entry), 'utf8');
                    } else {
                        await copyFile(oldPath, newPath);
                    }
                }
            }
        }
        return { value: { candidates: [] } as T, costUsd: 0, model: toModel };
    },
};

// The default config reproduces the prompts a default-configured consumer
// issues (targeting bounds + maxCandidatesPerFile shape the prompt + schema).
// The diminishing-returns stop is disabled so the walk visits every target.
const cfg = llmMutatorConfigSchema.parse({
    dynamicLLM: { enabled: true, diminishingReturns: { minYieldPerCall: 0 } },
});

const files = await readMutateSources(projectDir, values.mutate);
const { targets } = buildProposeTargets(files, cfg);
await runPrePass(migrator, targets, cfg, { cost: new CostAccumulator() });

// eslint-disable-next-line no-console -- CLI summary.
console.log(
    `${dryRun ? '[dry-run] ' : ''}cache ${cacheDir}: ${String(files.length)} file(s), ` +
        `${String(targets.length)} target(s), ${String(stats.requests)} request(s) — ` +
        `${String(stats.migrated)} migrated ${fromModel} → ${toModel}, ` +
        `${String(stats.alreadyPresent)} already present, ${String(stats.noOldEntry)} without an old entry`,
);
