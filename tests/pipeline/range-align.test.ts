/*
 * Offline unit tests for the Gate-4 node-aligned range derivation
 * (`range-align.ts`). Pure Babel traversal — no LLM, no Stryker, no network.
 *
 * Covers the locate → exact-node → is-expression → 0-based-range happy path and
 * each of the four drop reasons:
 *   • not-found         — `original` absent from the function source;
 *   • ambiguous         — `original` appears more than once in the function;
 *   • non-node-aligned  — substring crosses node boundaries / matches no node;
 *   • not-an-expression — exactly-aligned node is a statement, not an expression.
 */

import { describe, expect, it } from 'bun:test';

import { type AlignResult, alignCandidateRange } from '../../src/pipeline/range-align';

/** A small function fixture: `hour >= 12` BinaryExpression inside a return. */
const IS_AFTERNOON = 'function isAfternoon(hour) {\n    return hour >= 12;\n}';

/** Narrow an AlignResult to its success branch (throws if dropped). */
function expectSuccess(result: AlignResult): Extract<AlignResult, { range: unknown }> {
    if ('dropped' in result) {
        throw new Error(`expected success, got drop: ${result.reason}`);
    }
    return result;
}

describe('alignCandidateRange — success (found → exact node → expression → range)', () => {
    it('aligns a clean sub-expression to its node range (0-based, line−1)', () => {
        // `hour >= 12` is on babel line 2 → Stryker line 1; `    return ` is 11
        // chars so it starts at column 11 and ends at column 21.
        const result = alignCandidateRange(IS_AFTERNOON, 0, IS_AFTERNOON.length, 'hour >= 12');
        const ok = expectSuccess(result);
        expect(ok.original).toBe('hour >= 12');
        expect(ok.range).toEqual({
            start: { line: 1, column: 11 },
            end: { line: 1, column: 21 },
        });
    });

    it('aligns a nested nullish-coalescing sub-expression', () => {
        const fn = 'function pick(a, b) {\n    return a ?? b;\n}';
        const result = alignCandidateRange(fn, 0, fn.length, 'a ?? b');
        const ok = expectSuccess(result);
        // `a ?? b` on babel line 2 → Stryker line 1, columns [11, 17).
        expect(ok.range).toEqual({
            start: { line: 1, column: 11 },
            end: { line: 1, column: 17 },
        });
    });

    it('scopes the search to the function offsets so an identical span ELSEWHERE in the file is not mis-located', () => {
        // The file has `hour >= 12` twice: once outside the target function and
        // once inside it. Scoping to the function's offsets locates the in-function
        // occurrence, NOT the earlier one, and is unambiguous within the scope.
        const file =
            'const early = hour >= 12;\n' +
            'function isAfternoon(hour) {\n    return hour >= 12;\n}';
        const fnStart = file.indexOf('function');
        const result = alignCandidateRange(file, fnStart, file.length, 'hour >= 12');
        const ok = expectSuccess(result);
        // The in-function occurrence is on file line index 2 (0-based) → babel line
        // 3 → Stryker line 2, columns [11, 21).
        expect(ok.range).toEqual({
            start: { line: 2, column: 11 },
            end: { line: 2, column: 21 },
        });
    });
});

describe('alignCandidateRange — drop reasons', () => {
    it('drops not-found when original is absent from the function', () => {
        const result = alignCandidateRange(IS_AFTERNOON, 0, IS_AFTERNOON.length, 'minute >= 30');
        expect(result).toEqual({ dropped: true, reason: 'not-found' });
    });

    it('drops ambiguous when original appears more than once in the function', () => {
        const fn = 'function f(a) {\n    return a + a;\n}';
        const result = alignCandidateRange(fn, 0, fn.length, 'a'); // `a` appears 3×
        expect(result).toEqual({ dropped: true, reason: 'ambiguous' });
    });

    it('drops non-node-aligned when the substring crosses node boundaries', () => {
        // `>= 12;\n}` etc. would not parse; use a contiguous substring of a valid
        // expression that spans across sibling nodes: `12;\n    return` is unique
        // but matches no single AST node.
        const fn = 'function g(hour) {\n    const x = 12;\n    return hour >= 12;\n}';
        // `12;\n    return hour` is contiguous but crosses statement boundaries.
        const needle = '12;\n    return hour';
        const result = alignCandidateRange(fn, 0, fn.length, needle);
        expect(result).toEqual({ dropped: true, reason: 'non-node-aligned' });
    });

    it('drops not-an-expression when the aligned node is a statement', () => {
        // `return hour >= 12;` aligns EXACTLY to the ReturnStatement node, which is
        // not an expression — the expression placer would reject it.
        const result = alignCandidateRange(
            IS_AFTERNOON,
            0,
            IS_AFTERNOON.length,
            'return hour >= 12;',
        );
        expect(result).toEqual({ dropped: true, reason: 'not-an-expression' });
    });

    it('drops non-node-aligned for a partial-token substring (no exact node span)', () => {
        // `hour >= 1` is a substring of `hour >= 12` but its end falls mid-literal,
        // aligning to no node's exact span.
        const result = alignCandidateRange(IS_AFTERNOON, 0, IS_AFTERNOON.length, 'hour >= 1');
        expect(result).toEqual({ dropped: true, reason: 'non-node-aligned' });
    });
});

describe('alignCandidateRange — robustness', () => {
    it('handles a parenthesized expression by aligning to the inner node when exact', () => {
        // `(a + b)` — the parens are not a separate node in babel default parse;
        // the unique substring `a * c` aligns to its BinaryExpression cleanly.
        const fn = 'function h(a, b, c) {\n    return (a + b) + a * c;\n}';
        const result = alignCandidateRange(fn, 0, fn.length, 'a * c');
        const ok = expectSuccess(result);
        expect(ok.original).toBe('a * c');
    });
});
