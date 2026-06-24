/*
 * Edge-case coverage for the seam's instrument() and runMutants() (development-
 * plan §3.3 / §4.2). Complements the end-to-end Phase-0 proof with the survived
 * outcome, the no-match (un-placed replacement) case, and worker error
 * propagation. Fully offline.
 */

import { describe, expect, it } from 'bun:test';

import {
    computeMutantId,
    instrument,
    type Replacement,
    runMutants,
    type SourceFile,
} from '../../src/seam/index';

const FIXTURE_NAME = 'calc.ts';
const FIXTURE_SOURCE = `export function add(a: number, b: number): number {\n    return a + b;\n}\n`;
const SOURCE_FILES: SourceFile[] = [{ name: FIXTURE_NAME, content: FIXTURE_SOURCE }];

// `a + b` -> `a * b`, on line 1, columns [11, 16) (Stryker 0-based convention).
const SWAP: Replacement = {
    fileName: FIXTURE_NAME,
    range: { start: { line: 1, column: 11 }, end: { line: 1, column: 16 } },
    original: 'a + b',
    replacement: 'a * b',
    mutatorName: 'LLMArithmeticSwap',
};

describe('seam instrument() + runMutants() edge cases', () => {
    it('reports `survived` when the test suite cannot distinguish the mutant', async () => {
        const result = await instrument(SOURCE_FILES, [SWAP]);
        // add(2, 2) === 4 under BOTH `a + b` and `a * b`, so the mutant survives.
        const indistinguishableTest = `import { test, expect } from 'bun:test';\nimport { add } from './calc.ts';\ntest('weak test', () => {\n    expect(add(2, 2)).toBe(4);\n});\n`;
        const runResults = await runMutants(result.mutants, {
            files: result.files,
            extraFiles: [{ name: 'calc.test.ts', content: indistinguishableTest }],
            timeoutMs: 30_000,
        });
        expect(runResults).toHaveLength(1);
        expect(runResults[0]!.status).toBe('survived');
        expect(runResults[0]!.detail).toBeUndefined();
    });

    it('collects no mutant when a replacement span matches no node', async () => {
        const noMatch: Replacement = {
            ...SWAP,
            // A span that does not coincide with any babel node boundary.
            range: { start: { line: 0, column: 0 }, end: { line: 0, column: 3 } },
        };
        const result = await instrument(SOURCE_FILES, [noMatch]);
        expect(result.mutants).toHaveLength(0);
        // The emitted source for a file with no placed mutants has no header.
        expect(result.files[0]!.content).not.toContain('stryMutAct_9fa48');
    });

    it('rejects when the worker cannot instrument (unparseable replacement)', async () => {
        const broken: Replacement = { ...SWAP, replacement: 'a +' };
        await expect(instrument(SOURCE_FILES, [broken])).rejects.toThrow(
            /Instrumentation worker failed/,
        );
    });

    it('assigns each replacement its deterministic id in the manifest', async () => {
        const result = await instrument(SOURCE_FILES, [SWAP]);
        expect(result.mutants[0]!.id).toBe(computeMutantId(SWAP));
    });

    it('places EVERY distinct replacement over one span as its own switch AND manifest record', async () => {
        // Regression: two distinct candidates target the SAME span `a + b`
        // (identical fileName+range, different replacement text). Both must be
        // collected — neither may be silently overwritten in the worker's span
        // map (the §3.1 multi-candidate failure). propose() routinely yields
        // several candidates per target span, so this is the common case.
        const swapMul: Replacement = {
            ...SWAP,
            replacement: 'a * b',
            mutatorName: 'LLMArithmeticSwap',
        };
        const swapSub: Replacement = {
            ...SWAP,
            replacement: 'a - b',
            mutatorName: 'LLMArithmeticSwap',
        };
        const result = await instrument(SOURCE_FILES, [swapMul, swapSub]);

        // Both mutants collected with their own deterministic ids.
        expect(result.mutants).toHaveLength(2);
        const idMul = computeMutantId(swapMul);
        const idSub = computeMutantId(swapSub);
        const ids = new Set(result.mutants.map(m => m.id));
        expect(ids.has(idMul)).toBe(true);
        expect(ids.has(idSub)).toBe(true);

        // Both replacements appear as switches in the emitted source, each gated
        // on its OWN id.
        const emitted = result.files[0]!.content;
        expect(emitted).toContain(`stryMutAct_9fa48("${idMul}")`);
        expect(emitted).toContain(`stryMutAct_9fa48("${idSub}")`);
        expect(emitted).toContain('a * b');
        expect(emitted).toContain('a - b');
    });

    it('reports `timeout` when a test run exceeds the timeout', async () => {
        const result = await instrument(SOURCE_FILES, [SWAP]);
        // A test that hangs forever; the runner must kill it and report timeout.
        const hangingTest = `import { test } from 'bun:test';\nimport './calc.ts';\ntest('hangs', async () => {\n    await new Promise(() => {});\n});\n`;
        const runResults = await runMutants(result.mutants, {
            files: result.files,
            extraFiles: [{ name: 'calc.test.ts', content: hangingTest }],
            timeoutMs: 1_000,
        });
        expect(runResults[0]!.status).toBe('timeout');
    });

    it('reports `error` when the bun binary cannot be spawned', async () => {
        const result = await instrument(SOURCE_FILES, [SWAP]);
        const runResults = await runMutants(result.mutants, {
            files: result.files,
            extraFiles: [
                {
                    name: 'calc.test.ts',
                    content: `import { test } from 'bun:test';\ntest('noop', () => {});\n`,
                },
            ],
            timeoutMs: 5_000,
            bunPath: '/nonexistent/bun-binary-that-does-not-exist',
        });
        // The binary never ran, so this is a harness error, not a kill.
        expect(runResults[0]!.status).toBe('error');
        expect(runResults[0]!.detail).toContain('ENOENT');
    });
});
