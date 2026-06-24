/*
 * OFFLINE end-to-end integration test (development-plan §5 phase 2, exercised
 * with the mock provider per the §5 network note).
 *
 * This proves the WHOLE vertical slice wires together without touching the
 * network: a canned LLM candidate flows through every real component in order —
 *
 *   propose(MockProvider, target)   // stage-2, no network
 *     -> applyFilters(...)          // cheap deterministic winnowing (§4.3)
 *     -> instrument(files, edits)   // Stryker's own instrumenter, out-of-band
 *     -> runMutants(...)            // score by activating each mutant
 *
 * The only substitution vs. a live run is the provider: a {@link MockProvider}
 * stands in for the Anthropic Agent SDK and returns a schema-shaped candidate.
 * Everything downstream (filters, seam, runner) is the exact production code.
 *
 * Fixture: `add(a, b) => a + b` with a test pinning `add(2, 3) === 5`. The mock
 * proposes `a + b` -> `a * b`, which flips the pinning test to failing, so the
 * mutant must be reported `killed`. We also assert a survivor case (an identity
 * rewrite that filters drop, and a behaviour-preserving edit that survives) to
 * show both verdicts come through the same wiring.
 *
 * Runtime: needs `node` (instrumenter child process) and `bun` (runner) on PATH.
 */

import { describe, expect, it } from 'bun:test';

import { MockProvider } from '../../src/llm/index';
import { applyFilters, propose, type ProposeTarget } from '../../src/pipeline/index';
import { instrument, runMutants, type SourceFile } from '../../src/seam/index';

const FIXTURE_NAME = 'add.ts';
const FIXTURE_SOURCE = `export function add(a: number, b: number): number {\n    return a + b;\n}\n`;
const FIXTURE_TEST = `import { test, expect } from 'bun:test';\nimport { add } from './add.ts';\ntest('add pins behaviour', () => {\n    expect(add(2, 3)).toBe(5);\n});\n`;

const SPAN_TEXT = 'a + b';
// `a + b` on line index 1 (Stryker zero-based), columns [11, 16).
const TARGET: ProposeTarget = {
    fileName: FIXTURE_NAME,
    range: { start: { line: 1, column: 11 }, end: { line: 1, column: 16 } },
    spanText: SPAN_TEXT,
    context: FIXTURE_SOURCE,
};

const SOURCE_FILES: SourceFile[] = [{ name: FIXTURE_NAME, content: FIXTURE_SOURCE }];
const EXTRA_FILES: SourceFile[] = [{ name: 'add.test.ts', content: FIXTURE_TEST }];

/** Build a mock provider that returns the given candidate list for any prompt. */
function mockReturning(candidates: unknown[]): MockProvider {
    return new MockProvider({ responder: () => ({ candidates }), costUsd: 0 });
}

describe('end-to-end offline slice (mock provider)', () => {
    it('drives a canned mutation from propose through to a KILLED verdict', async () => {
        const provider = mockReturning([
            {
                original: SPAN_TEXT,
                replacement: 'a * b',
                mutatorTag: 'arithmetic-swap',
                rationale: 'Multiplication differs from addition for most inputs.',
            },
        ]);

        const proposed = await propose(provider, TARGET);
        expect(proposed).toHaveLength(1);
        // propose() tags LLM mutants distinctly from built-ins (§4.4).
        expect(proposed[0]!.mutatorName).toBe('llm/arithmetic-swap');

        const edits = applyFilters(proposed);
        expect(edits).toHaveLength(1);

        const { files, mutants } = await instrument(SOURCE_FILES, edits);
        // Both coupled artifacts produced for exactly one mutant (§3.1).
        expect(mutants).toHaveLength(1);
        expect(files[0]!.content).toContain(`stryMutAct_9fa48("${mutants[0]!.id}")`);

        const results = await runMutants(mutants, { files, extraFiles: EXTRA_FILES });
        expect(results).toHaveLength(1);
        expect(results[0]!.id).toBe(mutants[0]!.id);
        expect(results[0]!.status).toBe('killed');
    });

    it('scores EVERY candidate when the model proposes multiple for one span', async () => {
        // Regression for the multi-candidate seam bug: propose() returns TWO
        // distinct candidates for the SAME target span (`a + b`). Both must
        // survive filtering, both must be instrumented as their own switch +
        // manifest record, and both must be scored — none silently dropped.
        const provider = mockReturning([
            {
                original: SPAN_TEXT,
                replacement: 'a * b',
                mutatorTag: 'arithmetic-swap',
                rationale: 'Multiplication differs from addition for most inputs.',
            },
            {
                original: SPAN_TEXT,
                replacement: 'a - b',
                mutatorTag: 'arithmetic-swap',
                rationale: 'Subtraction differs from addition for most inputs.',
            },
        ]);

        const proposed = await propose(provider, TARGET);
        expect(proposed).toHaveLength(2);
        const edits = applyFilters(proposed);
        expect(edits).toHaveLength(2);

        const { files, mutants } = await instrument(SOURCE_FILES, edits);
        // Both coupled artifacts produced for BOTH mutants (§3.1).
        expect(mutants).toHaveLength(2);
        for (const mutant of mutants) {
            expect(files[0]!.content).toContain(`stryMutAct_9fa48("${mutant.id}")`);
        }

        const results = await runMutants(mutants, { files, extraFiles: EXTRA_FILES });
        // Every mutant scored, in input order; both are killed by add(2,3)===5.
        expect(results).toHaveLength(2);
        expect(results.map(r => r.id)).toEqual(mutants.map(m => m.id));
        expect(results.every(r => r.status === 'killed')).toBe(true);
    });

    it('reports a behaviour-preserving mutation as SURVIVED through the same wiring', async () => {
        // `b + a` is commutative with `a + b`, so add(2, 3) still === 5 and the
        // pinning test still passes -> the mutant survives. This proves the
        // survived path flows through the same propose->filter->seam->runner chain.
        const provider = mockReturning([
            {
                original: SPAN_TEXT,
                replacement: 'b + a',
                mutatorTag: 'operand-swap',
                rationale: 'Swapping operands of a commutative op is behaviour-preserving here.',
            },
        ]);

        const proposed = await propose(provider, TARGET);
        const edits = applyFilters(proposed);
        expect(edits).toHaveLength(1);

        const { files, mutants } = await instrument(SOURCE_FILES, edits);
        expect(mutants).toHaveLength(1);

        const results = await runMutants(mutants, { files, extraFiles: EXTRA_FILES });
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe('survived');
    });

    it('filters drop an identity rewrite before it reaches the seam', async () => {
        // The model echoes the span unchanged; filterIdentical removes it, so
        // nothing is instrumented or run (no LLM, no seam spend wasted — §4.3).
        const provider = mockReturning([
            {
                original: SPAN_TEXT,
                replacement: SPAN_TEXT,
                mutatorTag: 'noop',
                rationale: 'No change.',
            },
        ]);

        const proposed = await propose(provider, TARGET);
        expect(proposed).toHaveLength(1);
        const edits = applyFilters(proposed);
        expect(edits).toHaveLength(0);
    });
});
