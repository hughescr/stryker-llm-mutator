/*
 * Offline unit tests for the Gate-4 precomputed-map builder.
 *
 * Covers: the `+1` Stryker-0→Babel-1 keying (build half), absolute-path
 * normalization, the multi-candidate LIST per span, the read-key contract round-
 * trip, and the drop-and-log of statement-shaped (non-expression) replacements.
 * Pure, offline — no Stryker, no network.
 */

import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

import {
    buildLlmMutatorMap,
    countEntriesByCategory,
    locKeyFromBabelLoc,
    locKeyFromRange,
} from '../../src/pipeline/llm-map';
import type { Replacement, SourceRange } from '../../src/seam/types';

function range(l0: number, c0: number, l1: number, c1: number): SourceRange {
    return { start: { line: l0, column: c0 }, end: { line: l1, column: c1 } };
}

function repl(over: Partial<Replacement> = {}): Replacement {
    return {
        fileName: '/abs/foo.ts',
        range: range(0, 4, 0, 9),
        original: 'x + 1',
        replacement: 'x - 1',
        mutatorName: 'llm/off-by-one',
        ...over,
    };
}

describe('locKeyFromRange / locKeyFromBabelLoc (the +1 contract)', () => {
    it('build half adds +1 to both lines, leaves columns unchanged', () => {
        expect(locKeyFromRange(range(0, 4, 1, 9))).toBe('1:4-2:9');
    });

    it('read half uses the babel loc with NO offset, and the two halves align', () => {
        const buildKey = locKeyFromRange(range(2, 0, 2, 7));
        const readKey = locKeyFromBabelLoc({
            start: { line: 3, column: 0 },
            end: { line: 3, column: 7 },
        });
        expect(buildKey).toBe(readKey); // 0-based line 2 ↔ babel line 3.
    });
});

describe('buildLlmMutatorMap', () => {
    it('keys by absolute fileName + the +1 locKey, value is a list', () => {
        const { map, dropped } = buildLlmMutatorMap([repl()]);
        expect(dropped).toHaveLength(0);

        const byLoc = map.get('/abs/foo.ts');
        expect(byLoc).toBeDefined();
        const entries = byLoc!.get('1:4-1:9'); // Stryker line 0 → babel line 1.
        expect(entries).toHaveLength(1);
        expect(entries![0]!.mutatorName).toBe('llm/off-by-one');
        expect(entries![0]!.replacement).toBe('x - 1');
        expect(entries![0]!.original).toBe('x + 1');
    });

    it('normalizes a relative fileName to absolute via the supplied cwd', () => {
        const { map } = buildLlmMutatorMap([repl({ fileName: 'src/foo.ts' })], '/proj');
        expect(map.has(resolve('/proj', 'src/foo.ts'))).toBe(true);
        expect(map.has('src/foo.ts')).toBe(false);
    });

    it('collects multiple diverse candidates at one span into one list', () => {
        const a = repl({ replacement: 'x - 1', mutatorName: 'llm/dec' });
        const b = repl({ replacement: 'x + 2', mutatorName: 'llm/inc2' });
        const { map } = buildLlmMutatorMap([a, b]);
        const entries = map.get('/abs/foo.ts')!.get('1:4-1:9')!;
        expect(entries.map(e => e.mutatorName)).toEqual(['llm/dec', 'llm/inc2']);
    });

    it('carries the optional rationale onto the entry when present', () => {
        const { map } = buildLlmMutatorMap([repl({ rationale: 'off-by-one boundary' })]);
        const entry = map.get('/abs/foo.ts')!.get('1:4-1:9')![0]!;
        expect(entry.rationale).toBe('off-by-one boundary');
    });

    it('omits rationale on the entry when the replacement has none', () => {
        const { map } = buildLlmMutatorMap([repl()]);
        const entry = map.get('/abs/foo.ts')!.get('1:4-1:9')![0]!;
        expect(entry.rationale).toBeUndefined();
    });

    it('drops-and-logs a statement-shaped replacement rather than throwing', () => {
        const { map, dropped } = buildLlmMutatorMap([repl({ replacement: 'return x;' })]);
        expect(map.size).toBe(0);
        expect(dropped).toHaveLength(1);
        expect(dropped[0]!.fileName).toBe('/abs/foo.ts');
        expect(dropped[0]!.replacement).toBe('return x;');
        expect(dropped[0]!.reason).toMatch(/expression/);
    });

    it('keeps the valid survivors and drops only the unparseable ones', () => {
        const { map, dropped } = buildLlmMutatorMap([
            repl({ replacement: 'x - 1' }),
            repl({ replacement: 'return x;', range: range(5, 0, 5, 3) }),
        ]);
        expect(dropped).toHaveLength(1);
        expect(map.get('/abs/foo.ts')!.get('1:4-1:9')).toHaveLength(1);
    });

    it('stamps a deterministic Llm<Category> on each entry from (original, replacement)', () => {
        const { map } = buildLlmMutatorMap([
            repl({ original: 'x + 1', replacement: 'x - 1', mutatorName: 'llm/a' }),
            repl({ original: 'x + 1', replacement: 'x + 1 > 0', mutatorName: 'llm/b' }),
            repl({ original: 'x + 1', replacement: '!(x + 1)', mutatorName: 'llm/c' }),
            repl({ original: 'x + 1', replacement: 'x + 1 ?? y', mutatorName: 'llm/d' }),
        ]);
        const entries = map.get('/abs/foo.ts')!.get('1:4-1:9')!;
        expect(entries.map(e => e.category)).toEqual([
            'LlmArithmetic',
            'LlmComparison',
            'LlmNegate',
            'LlmNullish',
        ]);
        // The reporter tag is still carried alongside the category.
        expect(entries.map(e => e.mutatorName)).toEqual(['llm/a', 'llm/b', 'llm/c', 'llm/d']);
    });

    it('falls back to LlmOther when the original does not parse as an expression', () => {
        const { map, dropped } = buildLlmMutatorMap([
            repl({ original: 'x +', replacement: 'x - 1' }),
        ]);
        expect(dropped).toHaveLength(0);
        expect(map.get('/abs/foo.ts')!.get('1:4-1:9')![0]!.category).toBe('LlmOther');
    });
});

describe('countEntriesByCategory', () => {
    it('totals entries per category across files and spans (zero-count names omitted)', () => {
        const { map } = buildLlmMutatorMap([
            repl({ original: 'x + 1', replacement: 'x - 1' }),
            repl({ original: 'x + 1', replacement: 'x * 1', range: range(3, 0, 3, 5) }),
            repl({ original: 'x + 1', replacement: 'x + 2', fileName: '/abs/bar.ts' }),
        ]);
        const counts = countEntriesByCategory(map);
        expect(counts.get('LlmArithmetic')).toBe(2);
        expect(counts.get('LlmNumber')).toBe(1);
        expect(counts.has('LlmOther')).toBe(false);
        expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(3);
    });
});
