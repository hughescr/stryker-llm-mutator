/*
 * Offline behavioral tests for `withLlmMutators` — the heuristics + clean-config +
 * idempotency + gating paths (the dynamicLLM branch is exercised offline via the
 * buildLlmMutator/run tests with a MockProvider, and live by the human-run proof;
 * the whole file is coverage-exempt, so these are CORRECTNESS assertions).
 *
 * The heuristics path injects into the live `allMutators` (the registry's resolved
 * array), so each test snapshots + restores it via splice to avoid leaking to other
 * importers/tests. No Stryker run, no network — `dynamicLLM` stays off throughout.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withLlmMutators } from '../src/with-llm-mutators';
import { allMutators } from '../src/instrumenter-registry';
import { LLM_MUTATOR_NAMES } from '../src/mutators/llm-mutator';
import { LLM_CATEGORIES } from '../src/pipeline/classify';

let pristine: typeof allMutators = [];

beforeEach(() => {
    pristine = [...allMutators];
});

afterEach(() => {
    // Restore the live registry IN PLACE (keep the same instance).
    allMutators.splice(0, allMutators.length, ...pristine);
});

/** Count entries in the live registry whose name matches. */
function countByName(name: string): number {
    return allMutators.filter(m => m.name === name).length;
}

describe('withLlmMutators — heuristics path', () => {
    it('injects the named heuristic operators and strips llmMutator from the config', async () => {
        const clean = await withLlmMutators(
            {
                mutate: ['src/**/*.ts'],
                concurrency: 4,
                llmMutator: { heuristics: { operators: ['NumberLiteralValue'] } },
            },
            { log: () => {} },
        );

        // Clean config: llmMutator removed, other Stryker options preserved.
        expect('llmMutator' in clean).toBe(false);
        expect(clean.mutate).toEqual(['src/**/*.ts']);
        expect(clean.concurrency).toBe(4);
        // The named operator was augment-injected into the live registry.
        expect(countByName('NumberLiteralValue')).toBe(1);
        // Built-ins are preserved (augment, not replace).
        expect(allMutators.length).toBeGreaterThan(16);
    });

    it('injects ALL heuristics when llmMutator is absent (default posture)', async () => {
        const clean = await withLlmMutators({ mutate: ['src/**/*.ts'] }, { log: () => {} });
        expect('llmMutator' in clean).toBe(false);
        // The current P1–P4 catalog (7 operators) plus the 16 built-ins.
        expect(allMutators.length).toBe(16 + 7);
        expect(countByName('NumberLiteralValue')).toBe(1);
        expect(countByName('StringMethodArgSwap')).toBe(1);
        expect(countByName('OptionalChainForce')).toBe(0);
        expect(countByName('EarlyReturnInjection')).toBe(0);
        expect(countByName('TernaryBranchSwap')).toBe(0);
        expect(countByName('BoundaryOffByOne')).toBe(0);
        expect(countByName('ComparisonBoundaryShift')).toBe(0);
        expect(countByName('DefaultParamValueTweak')).toBe(0);
        expect(countByName('FallbackOperandSubstitution')).toBe(0);
    });

    it('is idempotent: re-calling with the returned (stamped) config does NOT double-register', async () => {
        const clean = await withLlmMutators(
            {
                mutate: ['x'],
                llmMutator: { heuristics: { operators: ['NumberLiteralValue'] } },
            },
            { log: () => {} },
        );
        expect(countByName('NumberLiteralValue')).toBe(1);
        // A second call with the previously-returned config must be a no-op.
        const clean2 = await withLlmMutators(clean, { log: () => {} });
        expect(countByName('NumberLiteralValue')).toBe(1);
        expect('llmMutator' in clean2).toBe(false);
    });

    it('both switches off: injects nothing, warns, returns clean config', async () => {
        const warnings: string[] = [];
        const clean = await withLlmMutators(
            { mutate: ['x'], llmMutator: { heuristics: { enabled: false } } },
            { log: line => warnings.push(line) },
        );
        // Nothing injected (registry unchanged from pristine).
        expect(allMutators.length).toBe(pristine.length);
        expect('llmMutator' in clean).toBe(false);
        // A both-off warning was surfaced.
        expect(warnings.some(w => w.includes('Both heuristics and dynamicLLM are disabled'))).toBe(
            true,
        );
    });

    it('rejects an operator name outside the closed catalog (zod parse error)', async () => {
        // `heuristics.operators` is a closed enum allow-list, so a typo'd/unknown
        // operator is a config ERROR (parse throws), not a silent unimplemented skip.
        await expect(
            withLlmMutators(
                {
                    mutate: ['x'],
                    llmMutator: { heuristics: { operators: ['NotARealOperator' as never] } },
                },
                { log: () => {} },
            ),
        ).rejects.toThrow();
        // Nothing was injected (the parse threw before any injection).
        expect(allMutators.length).toBe(pristine.length);
    });

    it('returns a Promise even on the synchronous heuristics path (uniform type)', async () => {
        const result = withLlmMutators({ mutate: ['x'] }, { log: () => {} });
        expect(result).toBeInstanceOf(Promise);
        const clean = await result;
        expect('llmMutator' in clean).toBe(false);
    });

    it('registers NO Llm* name and leaves excludedMutations untouched (heuristics-only is byte-identical)', async () => {
        const excluded = ['llm', 'StringLiteral'];
        const clean = await withLlmMutators(
            { mutate: ['x'], excludedMutations: excluded },
            { log: () => {} },
        );
        for (const name of LLM_MUTATOR_NAMES) {
            expect(countByName(name)).toBe(0);
        }
        expect(clean.excludedMutations).toBe(excluded);
        expect(clean.excludedMutations).toEqual(['llm', 'StringLiteral']);
    });
});

describe('withLlmMutators — dynamicLLM path (offline: mock provider, empty project)', () => {
    let projectDir = '';

    beforeEach(async () => {
        projectDir = await mkdtemp(join(tmpdir(), 'stryker-llm-wrapper-'));
    });

    afterEach(async () => {
        await rm(projectDir, { recursive: true, force: true });
    });

    /** A dynamicLLM-on config over the mock provider (no network, no credentials). */
    const dynamic = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        mutate: ['src/**/*.ts'],
        llmMutator: {
            provider: 'mock',
            heuristics: { enabled: false },
            dynamicLLM: { enabled: true },
            cacheDir: '.cache',
        },
        ...extra,
    });

    it('registers the 17 LLM mutator names (llm wildcard + 16 categories) before instrumentation', async () => {
        const lines: string[] = [];
        await withLlmMutators(dynamic(), { log: line => lines.push(line), projectDir });
        for (const name of LLM_MUTATOR_NAMES) {
            expect(countByName(name)).toBe(1);
        }
        expect(allMutators.length).toBe(pristine.length + LLM_MUTATOR_NAMES.length);
        expect(
            lines.some(l =>
                l.includes('injected 17 LLM mutator name(s): llm (wildcard), LlmComparison'),
            ),
        ).toBe(true);
        // The directive alias installed without a warning.
        expect(lines.some(l => l.includes('WARNING'))).toBe(false);
    });

    it("expands excludedMutations: ['llm'] on the returned clean config", async () => {
        const clean = await withLlmMutators(
            dynamic({ excludedMutations: ['llm', 'StringLiteral'] }),
            { log: () => {}, projectDir },
        );
        expect(clean.excludedMutations).toEqual(['llm', 'StringLiteral', ...LLM_CATEGORIES]);
        expect('llmMutator' in clean).toBe(false);
    });

    it("leaves an excludedMutations list without 'llm' as-is, and no list absent", async () => {
        const clean = await withLlmMutators(dynamic({ excludedMutations: ['StringLiteral'] }), {
            log: () => {},
            projectDir,
        });
        expect(clean.excludedMutations).toEqual(['StringLiteral']);
        const none = await withLlmMutators(dynamic(), { log: () => {}, projectDir });
        expect('excludedMutations' in none).toBe(false);
    });
});
