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

import { withLlmMutators } from '../src/with-llm-mutators';
import { allMutators } from '../src/instrumenter-registry';

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
        // The full P1–P4 catalog (14 operators) plus the 16 built-ins.
        expect(allMutators.length).toBe(16 + 14);
        expect(countByName('NumberLiteralValue')).toBe(1);
        expect(countByName('TernaryBranchSwap')).toBe(1);
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
});
