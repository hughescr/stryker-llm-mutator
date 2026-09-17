/*
 * Offline tests for `scripts/migrate-cache-fingerprint.ts`: a fabricated
 * project + a fabricated LEGACY (verbatim-prompt-keyed, 1.2.1-shaped) cache
 * entry in a temp dir, then the migration copies it under the fingerprint key
 * with `meta` added — dry-run touches nothing, a re-run reports it as present,
 * and a function with no legacy entry is reported missing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { llmMutatorConfigSchema } from '../../src/config';
import { computeCacheKey, ResponseCache } from '../../src/llm/index';
import { proposeCacheIdentity } from '../../src/pipeline/propose';
import { buildProposeTargets } from '../../src/pipeline/targeting';
import {
    LEGACY_PROPOSE_SYSTEM,
    legacyProposePrompt,
    legacyProposeSchema,
    loadMigrationConfig,
    migrateCacheFingerprint,
} from '../../scripts/migrate-cache-fingerprint';

const RICH_FN = `export function classify(items: number[], threshold: number) {
    let count = 0;
    for (let i = 0; i < items.length - 1; i++) {
        if (items[i] > threshold && items[i + 1] <= threshold) {
            count = count + 1;
        }
    }
    return { count: count, ok: count >= 2 };
}
`;

const LEGACY_VALUE = {
    candidates: [
        {
            original: 'count >= 2',
            replacement: 'count > 2',
            mutatorTag: 'off-by-one',
            rationale: 'boundary',
        },
    ],
};

describe('legacy (1.2.1) prompt builder — frozen copy', () => {
    it('renders the verbatim function inside the FUNCTION fence, no CONTEXT block when equal', () => {
        const fn = 'function f(a) {\n    return a + 1; // c\n}';
        const prompt = legacyProposePrompt({ spanText: fn, context: fn }, 20);
        expect(prompt).toBe(
            [
                'Propose up to 20 distinct, behavior-changing mutations, each on a small sub-expression WITHIN the FUNCTION below.',
                '',
                'FUNCTION (mutate sub-expressions inside this; "original" must be a verbatim substring of it):',
                '```',
                fn,
                '```',
            ].join('\n'),
        );
    });

    it('adds the CONTEXT block when the context differs', () => {
        const prompt = legacyProposePrompt({ spanText: 'f', context: 'ctx' }, 3);
        expect(prompt).toContain(
            'CONTEXT (for understanding only; do NOT mutate outside the FUNCTION):',
        );
        expect(prompt).toContain('```\nctx\n```');
    });

    it('freezes the system prompt and the schema shape', () => {
        expect(LEGACY_PROPOSE_SYSTEM.startsWith('You are a mutation-testing assistant')).toBe(true);
        const schema = legacyProposeSchema(7) as {
            properties: { candidates: { maxItems: number } };
        };
        expect(schema.properties.candidates.maxItems).toBe(7);
    });
});

describe('migrateCacheFingerprint', () => {
    let projectDir: string;
    let cacheDir: string;
    const cfg = llmMutatorConfigSchema.parse({ model: 'haiku', dynamicLLM: { enabled: true } });

    /** The single target the fabricated project yields (whole-function text, offsets…). */
    function theTarget() {
        const { targets } = buildProposeTargets(
            [{ fileName: join(projectDir, 'src', 'calc.ts'), content: RICH_FN }],
            cfg,
        );
        expect(targets).toHaveLength(1);
        return targets[0]!;
    }

    function legacyKey(): string {
        const target = theTarget();
        const max = cfg.dynamicLLM.budget.maxCandidatesPerFile;
        return computeCacheKey({
            model: cfg.model,
            prompt: legacyProposePrompt(target, max),
            system: LEGACY_PROPOSE_SYSTEM,
            schema: legacyProposeSchema(max),
        });
    }

    function newKey(): string {
        return proposeCacheIdentity(
            theTarget(),
            cfg.model,
            cfg.dynamicLLM.budget.maxCandidatesPerFile,
        ).cacheKey;
    }

    beforeEach(async () => {
        projectDir = await mkdtemp(join(tmpdir(), 'stryker-llm-migrate-fp-'));
        cacheDir = join(projectDir, '.stryker-llm-cache');
        await mkdir(join(projectDir, 'src'), { recursive: true });
        await writeFile(join(projectDir, 'src', 'calc.ts'), RICH_FN, 'utf8');
        await mkdir(cacheDir, { recursive: true });
        // A 1.2.1-shaped legacy entry: value + cost + model, NO meta, keyed by the verbatim prompt.
        await writeFile(
            join(cacheDir, `${legacyKey()}.json`),
            JSON.stringify({ value: LEGACY_VALUE, costUsd: 0.02, model: 'haiku' }),
            'utf8',
        );
    });

    afterEach(async () => {
        await rm(projectDir, { recursive: true, force: true });
    });

    it('copies the legacy entry under the fingerprint key, adding meta, and reports counts', async () => {
        const lines: string[] = [];
        const stats = await migrateCacheFingerprint(cfg, {
            projectDir,
            dryRun: false,
            log: l => lines.push(l),
        });
        expect(stats).toEqual({ scanned: 1, migrated: 1, alreadyPresent: 0, missing: 0 });

        const migrated = await new ResponseCache(cacheDir).get(newKey());
        expect(migrated?.value).toEqual(LEGACY_VALUE);
        expect(migrated?.costUsd).toBe(0.02);
        expect(migrated?.model).toBe('haiku');
        expect(migrated?.meta).toEqual({
            fingerprint: proposeCacheIdentity(theTarget(), 'haiku', 20).meta.fingerprint,
            fileName: join(projectDir, 'src', 'calc.ts'),
            functionName: 'classify',
        });
        // The legacy file is left in place (harmless; nothing reads it any more).
        expect((await readdir(cacheDir)).sort()).toEqual(
            [`${legacyKey()}.json`, `${newKey()}.json`].sort(),
        );
        expect(lines.some(l => l.includes('1 migrated'))).toBe(true);
    });

    it('dry-run reports what it WOULD migrate and writes nothing', async () => {
        const stats = await migrateCacheFingerprint(cfg, { projectDir, dryRun: true });
        expect(stats).toEqual({ scanned: 1, migrated: 1, alreadyPresent: 0, missing: 0 });
        expect(await readdir(cacheDir)).toEqual([`${legacyKey()}.json`]);
    });

    it('a second run finds the new entry already present', async () => {
        await migrateCacheFingerprint(cfg, { projectDir, dryRun: false });
        const stats = await migrateCacheFingerprint(cfg, { projectDir, dryRun: false });
        expect(stats).toEqual({ scanned: 1, migrated: 0, alreadyPresent: 1, missing: 0 });
    });

    it('reports a function with no legacy entry as missing (nothing to copy)', async () => {
        await rm(join(cacheDir, `${legacyKey()}.json`));
        const stats = await migrateCacheFingerprint(cfg, { projectDir, dryRun: false });
        expect(stats).toEqual({ scanned: 1, migrated: 0, alreadyPresent: 0, missing: 1 });
        expect(await readdir(cacheDir)).toEqual([]);
    });

    it('scans EVERY eligible function regardless of the per-file / per-run caps', async () => {
        // 12 rich functions in one file; default topSpansPerFile is 10 and we set
        // maxLlmCallsPerRun to 3 — the migration still scans all 12.
        const many = Array.from({ length: 12 }, (_, i) =>
            RICH_FN.replace('function classify(', `function fn${String(i)}(`),
        ).join('\n');
        await writeFile(join(projectDir, 'src', 'many.ts'), many, 'utf8');
        const capped = llmMutatorConfigSchema.parse({
            model: 'haiku',
            dynamicLLM: { enabled: true, budget: { maxLlmCallsPerRun: 3 } },
        });
        const stats = await migrateCacheFingerprint(capped, { projectDir, dryRun: true });
        expect(stats.scanned).toBe(13);
    });
});

describe('loadMigrationConfig', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stryker-llm-migrate-cfg-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('reads the llmMutator block from a JSON config', async () => {
        await writeFile(
            join(dir, 'stryker.config.json'),
            JSON.stringify({ llmMutator: { model: 'sonnet', cacheDir: 'llm-cache' } }),
            'utf8',
        );
        const { config, source } = await loadMigrationConfig(dir, undefined);
        expect(config.model).toBe('sonnet');
        expect(config.cacheDir).toBe('llm-cache');
        expect(source).toBe(join(dir, 'stryker.config.json'));
    });

    it('falls back to schema defaults when no config file exists', async () => {
        const { config, source } = await loadMigrationConfig(dir, undefined);
        expect(config.model).toBe('haiku');
        expect(source).toBeUndefined();
    });

    it('REFUSES to evaluate a JS config that calls withLlmMutators (it would run a live pre-pass)', async () => {
        await writeFile(
            join(dir, 'stryker.conf.mjs'),
            "import { withLlmMutators } from '@hughescr/stryker-llm-mutator';\nexport default await withLlmMutators({ llmMutator: {} });\n",
            'utf8',
        );
        // Probed (no --config): skipped with defaults + a note, never imported.
        const lines: string[] = [];
        const probed = await loadMigrationConfig(dir, undefined, l => lines.push(l));
        expect(probed.source).toBeUndefined();
        expect(probed.config.model).toBe('haiku');
        expect(lines.some(l => l.includes('withLlmMutators'))).toBe(true);
        // Explicit --config: a hard error (the caller asked for THAT file).
        await expect(loadMigrationConfig(dir, 'stryker.conf.mjs')).rejects.toThrow(
            /withLlmMutators/,
        );
    });
});
