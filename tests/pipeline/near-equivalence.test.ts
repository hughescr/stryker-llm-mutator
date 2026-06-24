/*
 * Offline unit tests for the conservative near-equivalence filter.
 *
 * Two halves: (1) it DOES drop whitespace-only / redundant-paren / no-op-TS-cast
 * differences; (2) it MUST NOT drop literal-format changes, operator swaps, or
 * argument reorders. Plus: it logs every drop, keeps on un-parseable input, and
 * keeps when the two sides parse at different syntactic levels. Pure, offline.
 */

import { describe, expect, it } from 'bun:test';

import { filterNearEquivalent, isNearEquivalent } from '../../src/pipeline/near-equivalence';
import type { Replacement, SourceRange } from '../../src/seam/types';

function range(line = 0): SourceRange {
    return { start: { line, column: 0 }, end: { line, column: 1 } };
}

function repl(original: string, replacement: string, line = 0): Replacement {
    return {
        fileName: '/abs/foo.ts',
        range: range(line),
        original,
        replacement,
        mutatorName: 'llm/x',
    };
}

describe('isNearEquivalent — DROPS (conservative true)', () => {
    it('whitespace-only difference', () => {
        expect(isNearEquivalent('a+b', 'a + b')).toBe(true);
    });

    it('redundant wrapping parens', () => {
        expect(isNearEquivalent('a + b', '(a + b)')).toBe(true);
    });

    it('a no-op TS "as" cast unwraps to its operand', () => {
        expect(isNearEquivalent('x', 'x as number')).toBe(true);
    });

    it('a no-op TS "satisfies" expression unwraps to its operand', () => {
        expect(isNearEquivalent('x', 'x satisfies number')).toBe(true);
    });
});

describe('isNearEquivalent — KEEPS (must not false-drop)', () => {
    it('a hex-vs-decimal literal-format change is KEPT (0x10 vs 16)', () => {
        expect(isNearEquivalent('0x10', '16')).toBe(false);
    });

    it('an exponential-vs-plain literal change is KEPT (1e3 vs 1000)', () => {
        expect(isNearEquivalent('1e3', '1000')).toBe(false);
    });

    it('a string-quote change is KEPT (\'a\' vs "a")', () => {
        expect(isNearEquivalent("'a'", '"a"')).toBe(false);
    });

    it('an operator swap is KEPT (a + b vs a - b)', () => {
        expect(isNearEquivalent('a + b', 'a - b')).toBe(false);
    });

    it('an argument reorder is KEPT (f(a, b) vs f(b, a))', () => {
        expect(isNearEquivalent('f(a, b)', 'f(b, a)')).toBe(false);
    });

    it('keeps when a side does not parse', () => {
        expect(isNearEquivalent('a +', 'a + b')).toBe(false);
    });

    it('keeps when the two sides parse at different levels', () => {
        // 'a + b' is an expression (level 0); 'return a + b;' parses only inside a
        // function body (level 2) → different levels → KEEP.
        expect(isNearEquivalent('a + b', 'return a + b;')).toBe(false);
    });
});

describe('filterNearEquivalent', () => {
    it('drops near-equivalents, keeps real changes, preserving survivor order', () => {
        const input = [
            repl('a + b', '(a + b)', 1), // drop (parens)
            repl('a + b', 'a - b', 2), // keep (operator)
            repl('x', 'x as T', 3), // drop (cast)
            repl('f(a, b)', 'f(b, a)', 4), // keep (reorder)
        ];
        const survivors = filterNearEquivalent(input);
        expect(survivors.map(r => r.replacement)).toEqual(['a - b', 'f(b, a)']);
    });

    it('logs every drop with file:line and the reason', () => {
        const lines: string[] = [];
        filterNearEquivalent([repl('a + b', '(a + b)', 7)], { log: l => lines.push(l) });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('/abs/foo.ts:7');
        expect(lines[0]).toContain('a + b -> (a + b)');
        expect(lines[0]).toMatch(/identity-cast/);
    });

    it('does not mutate its input', () => {
        const input = [repl('a + b', '(a + b)')];
        const copy = [...input];
        filterNearEquivalent(input);
        expect(input).toEqual(copy);
    });

    it('is a no-op (no log) when nothing is near-equivalent', () => {
        const lines: string[] = [];
        const survivors = filterNearEquivalent([repl('a + b', 'a - b')], {
            log: l => lines.push(l),
        });
        expect(survivors).toHaveLength(1);
        expect(lines).toHaveLength(0);
    });
});
