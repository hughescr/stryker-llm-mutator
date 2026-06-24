/*
 * PHASE-0 SEAM PROOF (development-plan §5, phase 0 / §3.1, §3.3).
 *
 * This is the load-bearing proof of the whole runtime half: it shows that we can
 * take a hardcoded LLM-style edit, drive Stryker's OWN instrumenter out-of-band
 * to emit BOTH coupled artifacts (the activation switch in source AND a matching
 * manifest record), and then KILL that mutant by running a behaviour-pinning
 * test with the mutant active. It is fully offline — no network, no live LLM.
 *
 * Fixture: a trivial `add(a, b)` that returns `a + b`, with a test pinning
 * `add(2, 3) === 5`. We inject ONE replacement turning `a + b` into `a * b`. The
 * mutant must (a) appear as both a switch and a manifest record (the two-coupled
 * -artifacts invariant) and (b) flip the pinning test to failing when active.
 */

import { describe, expect, it } from 'bun:test';

import {
    computeMutantId,
    instrument,
    type Replacement,
    runMutants,
    type SourceFile,
} from '../../src/seam/index';

// The fixture source under mutation. `a + b` sits on line index 1 (0-based,
// Stryker convention): `    return a + b;`. `a` is at column 11, and the
// expression `a + b` spans columns [11, 16). These positions are Stryker's
// zero-based line / zero-based column convention (see src/seam/types.ts).
const FIXTURE_NAME = 'add.ts';
const FIXTURE_SOURCE = `export function add(a: number, b: number): number {\n    return a + b;\n}\n`;

// A behaviour-pinning test that imports the (to-be-instrumented) module by its
// fixture basename. add(2, 3) === 5 under `a + b`; under the `a * b` mutant it
// becomes 6, so this assertion flips to failing -> the mutant is killed.
const FIXTURE_TEST = `import { test, expect } from 'bun:test';\nimport { add } from './add.ts';\ntest('add pins behaviour', () => {\n    expect(add(2, 3)).toBe(5);\n});\n`;

// The single hardcoded edit: replace `a + b` with `a * b`.
const REPLACEMENT: Replacement = {
    fileName: FIXTURE_NAME,
    range: {
        start: { line: 1, column: 11 },
        end: { line: 1, column: 16 },
    },
    original: 'a + b',
    replacement: 'a * b',
    mutatorName: 'LLMArithmeticSwap',
    rationale: 'Swap addition for multiplication to probe the arithmetic boundary.',
};

const SOURCE_FILES: SourceFile[] = [{ name: FIXTURE_NAME, content: FIXTURE_SOURCE }];

describe('Phase-0 seam proof', () => {
    it('emits BOTH coupled artifacts: the activation switch in source AND a matching manifest record', async () => {
        const result = await instrument(SOURCE_FILES, [REPLACEMENT]);
        const expectedId = computeMutantId(REPLACEMENT);

        // (a) manifest record exists for our deterministic id.
        expect(result.mutants).toHaveLength(1);
        const mutant = result.mutants[0]!;
        expect(mutant.id).toBe(expectedId);
        expect(mutant.mutatorName).toBe('LLMArithmeticSwap');
        expect(mutant.replacement).toBe('a * b');

        // (b) emitted source carries the activation switch for that SAME id,
        // gated on Stryker's `stryMutAct_9fa48` helper, with both branches.
        expect(result.files).toHaveLength(1);
        const emitted = result.files[0]!.content;
        expect(emitted).toContain(`stryMutAct_9fa48("${expectedId}")`);
        expect(emitted).toContain('a * b'); // mutated branch
        expect(emitted).toContain('a + b'); // original branch (in the coverage/else side)
        // The Stryker syntax-helper header that wires up the env-var activation.
        expect(emitted).toContain('__STRYKER_ACTIVE_MUTANT__');
    });

    it('produces a deterministic id stable across two instrument() runs', async () => {
        const first = await instrument(SOURCE_FILES, [REPLACEMENT]);
        const second = await instrument(SOURCE_FILES, [REPLACEMENT]);
        expect(first.mutants[0]!.id).toBe(second.mutants[0]!.id);
        expect(first.mutants[0]!.id).toBe(computeMutantId(REPLACEMENT));
    });

    it('kills the mutant: the pinning test passes baseline but fails with the mutant active', async () => {
        const result = await instrument(SOURCE_FILES, [REPLACEMENT]);
        const runResults = await runMutants(result.mutants, {
            files: result.files,
            extraFiles: [{ name: 'add.test.ts', content: FIXTURE_TEST }],
            timeoutMs: 30_000,
        });

        expect(runResults).toHaveLength(1);
        const runResult = runResults[0]!;
        expect(runResult.id).toBe(computeMutantId(REPLACEMENT));
        expect(runResult.status).toBe('killed');
    });
});
