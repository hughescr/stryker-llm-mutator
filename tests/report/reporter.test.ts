/*
 * Offline unit tests for the M4 reporter.
 *
 * Hands synthetic `MutantResult[]` (mixed statuses + mutatorNames: built-ins,
 * heuristics, llm) + a synthetic CostSnapshot + an enrichment side-map and
 * asserts the rendered SURVIVORS section, the not-comparable note, the cost line,
 * the 1-based location verbatim (no re-subtract), the precise `llm/<tag>` from
 * enrichment, and the filtered our-mutants-only artifact. No Stryker, no network.
 */

import { describe, expect, it } from 'bun:test';
import type { MutantResult } from '@stryker-mutator/api/core';

import { formatReport, isOurMutant, type MutantEnrichment } from '../../src/report/reporter';
import type { CostSnapshot } from '../../src/llm/index';
import { heuristicMutators } from '../../src/mutators/index';

/** Build a synthetic MutantResult with sensible defaults. */
function mutant(over: Partial<MutantResult> & Pick<MutantResult, 'id'>): MutantResult {
    return {
        fileName: '/abs/a.ts',
        mutatorName: 'llm',
        status: 'Survived',
        location: { start: { line: 10, column: 4 }, end: { line: 10, column: 9 } },
        replacement: 'a - 1',
        ...over,
    } as MutantResult;
}

const COST: CostSnapshot = { totalUsd: 3.456, calls: 42 };

describe('isOurMutant', () => {
    it('recognizes llm, llm/<tag>, heuristic/<op>, and bare heuristic names', () => {
        expect(isOurMutant('llm')).toBe(true);
        expect(isOurMutant('llm/off-by-one')).toBe(true);
        expect(isOurMutant('heuristic/NumberLiteralValue')).toBe(true);
        expect(isOurMutant('NumberLiteralValue')).toBe(true);
        expect(isOurMutant('BoundaryOffByOne')).toBe(true);
    });

    it('rejects built-in mutator names', () => {
        expect(isOurMutant('ArithmeticOperator')).toBe(false);
        expect(isOurMutant('BooleanLiteral')).toBe(false);
    });

    it('tags EVERY registered heuristic mutator name (no catalog drift)', () => {
        // The anti-drift guard: HEURISTIC_NAMES is derived from the heuristicMutators
        // barrel, so isOurMutant must tag exactly the names the tool actually injects.
        // A future operator added to the catalog is covered automatically.
        for (const m of heuristicMutators) {
            expect(isOurMutant(m.name)).toBe(true);
        }
        expect(heuristicMutators).toHaveLength(14);
    });
});

describe('formatReport — survivors', () => {
    it('lists only OUR survived mutants, sorted by file/line/col', () => {
        const results = [
            mutant({ id: '1', mutatorName: 'llm', fileName: '/abs/b.ts', location: loc(5, 2) }),
            mutant({
                id: '2',
                mutatorName: 'NumberLiteralValue',
                fileName: '/abs/a.ts',
                location: loc(20, 0),
            }),
            mutant({
                id: '3',
                mutatorName: 'ArithmeticOperator',
                fileName: '/abs/a.ts',
                location: loc(1, 0),
            }), // built-in → excluded
            mutant({ id: '4', mutatorName: 'llm', fileName: '/abs/a.ts', status: 'Killed' }), // killed → not a survivor
        ];
        const out = formatReport(results, COST);
        const lines = out.survivorsText.split('\n');
        expect(lines[0]).toContain('SURVIVORS');
        // /abs/a.ts:20 before /abs/b.ts:5 (file then line).
        expect(lines[1]).toContain('/abs/a.ts:20:0');
        expect(lines[1]).toContain('NumberLiteralValue');
        expect(lines[2]).toContain('/abs/b.ts:5:2');
    });

    it('sorts same-file survivors by line then column', () => {
        const results = [
            mutant({ id: '1', fileName: '/abs/a.ts', location: loc(10, 8) }),
            mutant({ id: '2', fileName: '/abs/a.ts', location: loc(10, 2) }), // same line, lower col
            mutant({ id: '3', fileName: '/abs/a.ts', location: loc(3, 0) }), // earlier line
        ];
        const out = formatReport(results, COST);
        const lines = out.survivorsText.split('\n');
        expect(lines[1]).toContain(':3:0');
        expect(lines[2]).toContain(':10:2');
        expect(lines[3]).toContain(':10:8');
    });

    it('renders the "none" line when no injected mutant survived', () => {
        const out = formatReport([mutant({ id: '1', status: 'Killed' })], COST);
        expect(out.survivorsText).toContain('none');
    });

    it('uses the 1-based Stryker location VERBATIM (does not re-subtract)', () => {
        const out = formatReport([mutant({ id: '1', location: loc(7, 3) })], COST);
        expect(out.survivorsText).toContain(':7:3');
    });

    it('shows original -> replacement and the rationale from enrichment', () => {
        const enrichment = new Map<string, MutantEnrichment>([
            ['1', { original: 'x + 1', tag: 'off-by-one', rationale: 'classic boundary bug' }],
        ]);
        const out = formatReport([mutant({ id: '1', replacement: 'x - 1' })], COST, {
            enrichment,
        });
        expect(out.survivorsText).toContain('x + 1 -> x - 1');
        expect(out.survivorsText).toContain('llm/off-by-one');
        expect(out.survivorsText).toContain('(classic boundary bug)');
    });

    it('shows just the replacement when there is no enrichment original', () => {
        const out = formatReport([mutant({ id: '1', replacement: 'a - 1' })], COST);
        const line = out.survivorsText.split('\n')[1]!;
        expect(line).toContain('  a - 1');
        expect(line).not.toContain(' -> ');
    });

    it('handles a survived mutant with no replacement text', () => {
        const out = formatReport([mutant({ id: '1', replacement: undefined })], COST);
        expect(out.survivorsText).toContain('SURVIVORS');
    });
});

describe('formatReport — summary + cost', () => {
    it('counts killed/survived/no-coverage/timeout among OUR mutants and prints the note + cost', () => {
        const results = [
            mutant({ id: '1', status: 'Survived' }),
            mutant({ id: '2', status: 'Killed' }),
            mutant({ id: '3', status: 'NoCoverage' }),
            mutant({ id: '4', status: 'Timeout' }),
            mutant({ id: '5', status: 'Survived', mutatorName: 'ArithmeticOperator' }), // built-in → not counted
        ];
        const out = formatReport(results, COST);
        expect(out.summaryText).toContain('Injected mutants: 4');
        expect(out.summaryText).toContain('killed 1');
        expect(out.summaryText).toContain('survived 1');
        expect(out.summaryText).toContain('no-coverage 1');
        expect(out.summaryText).toContain('timeout 1');
        expect(out.summaryText).toContain('NOT comparable');
        expect(out.summaryText).toContain('Total LLM cost: $3.46 across 42 calls');
    });

    it('formats a zero-cost heuristics-only run', () => {
        const out = formatReport([mutant({ id: '1', mutatorName: 'NumberLiteralValue' })], {
            totalUsd: 0,
            calls: 0,
        });
        expect(out.summaryText).toContain('Total LLM cost: $0.00 across 0 calls');
    });
});

describe('formatReport — filtered artifact', () => {
    it('contains ONLY our mutants, across all statuses, with enriched names + fields', () => {
        const enrichment = new Map<string, MutantEnrichment>([
            ['1', { original: 'x + 1', tag: 'flip', rationale: 'r' }],
        ]);
        const results = [
            mutant({ id: '1', mutatorName: 'llm', status: 'Survived', replacement: 'x - 1' }),
            mutant({ id: '2', mutatorName: 'NumberLiteralValue', status: 'Killed' }),
            mutant({ id: '3', mutatorName: 'ArithmeticOperator', status: 'Survived' }), // built-in → excluded
        ];
        const out = formatReport(results, COST, { enrichment });
        expect(out.filtered.mutants).toHaveLength(2);

        const m1 = out.filtered.mutants.find(m => m.id === '1')!;
        expect(m1.mutatorName).toBe('llm/flip');
        expect(m1.original).toBe('x + 1');
        expect(m1.rationale).toBe('r');
        expect(m1.line).toBe(10);
        expect(m1.column).toBe(4);
        expect(m1.status).toBe('Survived');

        const m2 = out.filtered.mutants.find(m => m.id === '2')!;
        expect(m2.mutatorName).toBe('NumberLiteralValue');
        expect(m2.original).toBeUndefined();
        expect(m2.rationale).toBeUndefined();
    });

    it('omits replacement in the artifact when Stryker carried none', () => {
        const out = formatReport([mutant({ id: '1', replacement: undefined })], COST);
        expect(out.filtered.mutants[0]!.replacement).toBeUndefined();
    });
});

/** A 1-based Stryker location helper. */
function loc(line: number, column: number): MutantResult['location'] {
    return { start: { line, column }, end: { line, column: column + 3 } };
}
