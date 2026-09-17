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

/*
 * STRUCTURAL FALLBACK. The response cache is keyed by the function's structural
 * fingerprint, so a whitespace / quote / paren / comment edit still HITS — but
 * the cached candidate's `original` was spelled against the OLD text. When the
 * verbatim substring is absent, the sub-expression is re-found by AST SHAPE
 * (`fingerprint.ts` `expressionShape` / `nodeShape`) inside the function, and
 * the CURRENT source text + range are emitted. Ambiguity (two nodes of that
 * shape) still drops, and a verbatim hit still wins.
 */
describe('alignCandidateRange — structural fallback (respelled source)', () => {
    it('re-finds a sub-expression after a whitespace-only edit and emits the CURRENT text', () => {
        const fn = 'function f(a) {\n    return a+1;\n}';
        const ok = expectSuccess(alignCandidateRange(fn, 0, fn.length, 'a + 1'));
        expect(ok.original).toBe('a+1');
        expect(ok.range).toEqual({ start: { line: 1, column: 11 }, end: { line: 1, column: 14 } });
    });

    it('re-finds a sub-expression whose source now carries an inline comment', () => {
        const fn = 'function f(a) {\n    return a + /* one */ 1;\n}';
        const ok = expectSuccess(alignCandidateRange(fn, 0, fn.length, 'a + 1'));
        expect(ok.original).toBe('a + /* one */ 1');
    });

    it('re-finds a string literal after a quote-style edit', () => {
        const fn = "function f(s) {\n    return s === 'hi';\n}";
        const ok = expectSuccess(alignCandidateRange(fn, 0, fn.length, 's === "hi"'));
        expect(ok.original).toBe("s === 'hi'");
    });

    it('re-finds an expression after redundant parentheses were added or removed', () => {
        const added = 'function f(a, b) {\n    return (a + b) * 2;\n}';
        expect(expectSuccess(alignCandidateRange(added, 0, added.length, 'a + b')).original).toBe(
            'a + b',
        );
        const removed = 'function f(a, b) {\n    return a * 2;\n}';
        expect(
            expectSuccess(alignCandidateRange(removed, 0, removed.length, '(a * 2)')).original,
        ).toBe('a * 2');
    });

    it('re-finds a sub-expression that reads a private field of its class', () => {
        const priv = 'class C {\n    #n = 1;\n    f() {\n        return this.#n+1;\n    }\n}';
        const start = priv.indexOf('f()');
        const end = priv.lastIndexOf('}');
        expect(expectSuccess(alignCandidateRange(priv, start, end, 'this.#n + 1')).original).toBe(
            'this.#n+1',
        );
    });

    it('still drops ambiguous when the shape occurs twice (even if spelled differently)', () => {
        const fn = 'function f(a) {\n    return a+1 + (a + 1);\n}';
        // Verbatim `a + 1` is found ONCE (inside the parens) — the verbatim path
        // wins and aligns there; a needle absent verbatim but present twice by
        // shape is ambiguous.
        expect(expectSuccess(alignCandidateRange(fn, 0, fn.length, 'a + 1')).range.start).toEqual({
            line: 1,
            column: 18,
        });
        expect(alignCandidateRange(fn, 0, fn.length, 'a  +  1')).toEqual({
            dropped: true,
            reason: 'ambiguous',
        });
    });

    it('keeps the verbatim occurrence over a differently-spelled structural twin', () => {
        const fn = 'function f(a) {\n    const x = a+1;\n    return a + 1;\n}';
        const ok = expectSuccess(alignCandidateRange(fn, 0, fn.length, 'a + 1'));
        expect(ok.range.start).toEqual({ line: 2, column: 11 });
    });

    it('drops not-found when the needle is not an expression or has no structural twin', () => {
        expect(alignCandidateRange(IS_AFTERNOON, 0, IS_AFTERNOON.length, 'hour  >  13')).toEqual({
            dropped: true,
            reason: 'not-found',
        });
        expect(alignCandidateRange(IS_AFTERNOON, 0, IS_AFTERNOON.length, 'hour >= ;')).toEqual({
            dropped: true,
            reason: 'not-found',
        });
    });

    it('scopes the structural search to the function offsets', () => {
        const file =
            'const early = hour>=12;\nfunction isAfternoon(hour) {\n    return hour>=12;\n}';
        const fnStart = file.indexOf('function');
        const ok = expectSuccess(alignCandidateRange(file, fnStart, file.length, 'hour >= 12'));
        expect(ok.range.start).toEqual({ line: 2, column: 11 });
    });

    it('re-finds by shape when the verbatim text ALSO appears inside a comment (raw ambiguity)', () => {
        // A comment added inside the function but outside the span repeats the
        // candidate's text: two raw occurrences, ONE real node. The raw ambiguity
        // must not block the shape replay.
        const fn = 'function f(a) {\n    // a + 1 is the offset\n    return a + 1;\n}';
        const ok = expectSuccess(alignCandidateRange(fn, 0, fn.length, 'a + 1'));
        expect(ok.original).toBe('a + 1');
        expect(ok.range).toEqual({ start: { line: 2, column: 11 }, end: { line: 2, column: 16 } });
        expect(ok.recovered).toBe(true);
    });

    it('re-finds by shape when the ONLY verbatim occurrence lies inside a comment (non-node-aligned)', () => {
        const fn = 'function f(a) {\n    // was a + 1\n    return a+1;\n}';
        const ok = expectSuccess(alignCandidateRange(fn, 0, fn.length, 'a + 1'));
        expect(ok.original).toBe('a+1');
        expect(ok.range).toEqual({ start: { line: 2, column: 11 }, end: { line: 2, column: 14 } });
        expect(ok.recovered).toBe(true);
    });

    it('reports recovered=false on a verbatim match and true on a structural one', () => {
        expect(
            expectSuccess(alignCandidateRange(IS_AFTERNOON, 0, IS_AFTERNOON.length, 'hour >= 12'))
                .recovered,
        ).toBe(false);
        expect(
            expectSuccess(alignCandidateRange(IS_AFTERNOON, 0, IS_AFTERNOON.length, 'hour>=12'))
                .recovered,
        ).toBe(true);
    });

    it('keeps the verbatim drop reason when the shape replay finds nothing either', () => {
        // Raw-ambiguous (two comments) but not an expression → ambiguous stands.
        const twoComments = 'function f(a) {\n    // a ? a\n    // a ? a\n    return a;\n}';
        expect(alignCandidateRange(twoComments, 0, twoComments.length, 'a ? a')).toEqual({
            dropped: true,
            reason: 'ambiguous',
        });
        // A single non-node-aligned occurrence with no equal-shape node → non-node-aligned stands.
        const partial = 'function f(a) {\n    // a + 2\n    return a + 1;\n}';
        expect(alignCandidateRange(partial, 0, partial.length, 'a + 2')).toEqual({
            dropped: true,
            reason: 'non-node-aligned',
        });
    });

    it('still drops ambiguous when a raw-ambiguous needle has two equal-shape nodes', () => {
        const fn = 'function f(a) {\n    // a + 1\n    return (a + 1) * (a+1);\n}';
        expect(alignCandidateRange(fn, 0, fn.length, 'a + 1')).toEqual({
            dropped: true,
            reason: 'ambiguous',
        });
    });

    it('still applies the placement gates to a structurally re-found node', () => {
        // A method key re-found by shape is still not expression-placeable.
        const file = 'export class R {\n    dispatch(a) { return a; }\n}';
        const start = file.indexOf('dispatch');
        const end = file.lastIndexOf('}') - 1;
        expect(alignCandidateRange(file, start, end, '(dispatch)')).toEqual({
            dropped: true,
            reason: 'not-expression-placeable',
        });
    });
});

/*
 * THE isambard `export class` CRASH (review-handler.ts:21). `@babel/types`'
 * `isExpression()` is a NODE-TYPE check, so an Identifier always passes — but
 * Stryker's expression placer uses babel-traverse's virtual `path.isExpression()`,
 * which for an Identifier requires it to be REFERENCED. A method/property key or
 * a declaration id is NOT referenced, so no expression placer accepts it; Stryker
 * bubbles the mutant to the nearest Statement ancestor and the statement placer
 * wraps THAT in `if (…) {…} else {…}` — illegal as the `declaration` of an
 * Export*Declaration (`Property declaration of ExportNamedDeclaration expected
 * node to be of a type ["Declaration"] but instead got "IfStatement"`), and a
 * scope-breaking block wrap for any other declaration. These candidates MUST be
 * dropped at align time with the typed `not-expression-placeable` reason.
 */
describe('alignCandidateRange — not-expression-placeable (Stryker placement simulation)', () => {
    const NOT_PLACEABLE = { dropped: true, reason: 'not-expression-placeable' } as const;

    it('drops a ClassMethod key inside `export class` (the isambard review-handler crash)', () => {
        const file =
            'export class ReviewHandler {\n' +
            '    private async dispatchReviewAction(prefix: string): Promise<void> {\n' +
            '        return;\n' +
            '    }\n' +
            '}\n';
        const start = file.indexOf('private');
        const end = file.indexOf('    }\n') + 6;
        const result = alignCandidateRange(file, start, end, 'dispatchReviewAction');
        expect(result).toEqual(NOT_PLACEABLE);
    });

    it('drops a ClassMethod key inside `export default class`', () => {
        const file = 'export default class {\n    run(a) {\n        return a;\n    }\n}\n';
        const result = alignCandidateRange(file, 0, file.length, 'run');
        expect(result).toEqual(NOT_PLACEABLE);
    });

    it('drops a ClassProperty key inside an exported class', () => {
        const file = 'export class Box {\n    private readonly size: number = 1;\n}\n';
        const result = alignCandidateRange(file, 0, file.length, 'size');
        expect(result).toEqual(NOT_PLACEABLE);
    });

    it('drops the id of `export function` (the FunctionDeclaration is the export declaration)', () => {
        const file = 'export function isAfternoon(hour) {\n    return hour >= 12;\n}\n';
        const result = alignCandidateRange(file, 0, file.length, 'isAfternoon');
        expect(result).toEqual(NOT_PLACEABLE);
    });

    it('drops the id of `export const` (the VariableDeclaration is the export declaration)', () => {
        const file = 'export const limit = 12;\n';
        const result = alignCandidateRange(file, 0, file.length, 'limit');
        expect(result).toEqual(NOT_PLACEABLE);
    });

    it('drops a ClassMethod key in a NON-exported class too (an if-wrapped class is block-scoped)', () => {
        const file = 'class Box {\n    open() {\n        return 1;\n    }\n}\n';
        const result = alignCandidateRange(file, 0, file.length, 'open');
        expect(result).toEqual(NOT_PLACEABLE);
    });

    it('drops a function parameter binding (bubbles to the FunctionDeclaration statement)', () => {
        const file = 'function f(hour) {\n    return 1;\n}\n';
        const result = alignCandidateRange(file, 0, file.length, 'hour');
        expect(result).toEqual(NOT_PLACEABLE);
    });

    it('keeps a COMPUTED class-member key (a referenced expression, self-placeable)', () => {
        // A COMPUTED key IS a referenced expression → Stryker's expression placer
        // takes it at the key itself; it must NOT be dropped.
        const file = 'class Box {\n    [name]() {\n        return 1;\n    }\n}\n';
        const result = alignCandidateRange(file, 0, file.length, 'name');
        expect(expectSuccess(result).original).toBe('name');
    });

    it('keeps a chain member that bubbles to an EXPRESSION placement (Stryker places at the call)', () => {
        // `o.a` is the object of the callee member chain → not self-placeable, but
        // Stryker bubbles to the `o.a.b()` CallExpression, an expression placement.
        const file = 'function f(o) {\n    return o.a.b();\n}\n';
        const result = alignCandidateRange(file, 0, file.length, 'o.a');
        expect(expectSuccess(result).original).toBe('o.a');
    });

    it('keeps a non-computed member property name at a call site (bubbles to the CallExpression)', () => {
        // `moveMessage` is a NON-referenced Identifier, but its ancestors reach the
        // `this.client.moveMessage(uid)` CallExpression — an expression placement.
        const file = 'function f(uid) {\n    return this.client.moveMessage(uid);\n}\n';
        const result = alignCandidateRange(file, 0, file.length, 'moveMessage');
        expect(expectSuccess(result).original).toBe('moveMessage');
    });

    it('keeps a non-computed object-literal key (bubbles to the ObjectExpression)', () => {
        const file = 'function f() {\n    return { flags: 1 };\n}\n';
        const result = alignCandidateRange(file, 0, file.length, 'flags');
        expect(expectSuccess(result).original).toBe('flags');
    });

    it('keeps an assignment target member (bubbles to the AssignmentExpression)', () => {
        const file = 'function f(o) {\n    o.count = 1;\n}\n';
        const result = alignCandidateRange(file, 0, file.length, 'o.count');
        expect(expectSuccess(result).original).toBe('o.count');
    });

    it('keeps a `delete` operand and a tagged-template tag (bubble to the Unary/TaggedTemplate expression)', () => {
        const file = 'function f(o) {\n    delete o.k;\n    return html`x`;\n}\n';
        expect(expectSuccess(alignCandidateRange(file, 0, file.length, 'o.k')).original).toBe(
            'o.k',
        );
        expect(expectSuccess(alignCandidateRange(file, 0, file.length, 'html')).original).toBe(
            'html',
        );
    });

    it('keeps a non-null-asserted chain member (bubbles past the TSNonNullExpression)', () => {
        const file = 'function f(o) {\n    return o.a!.b;\n}\n';
        expect(expectSuccess(alignCandidateRange(file, 0, file.length, 'o.a')).original).toBe(
            'o.a',
        );
    });

    it('keeps a bare referenced identifier in a return (self-placeable)', () => {
        const file = 'function f() {\n    return hour;\n}\n';
        expect(expectSuccess(alignCandidateRange(file, 0, file.length, 'hour')).original).toBe(
            'hour',
        );
    });

    it('drops a class declared INSIDE an arrow body (the walk stops at the ClassDeclaration statement)', () => {
        // Without the statement stop the walk would run on to the enclosing
        // ArrowFunctionExpression (an expression placement) and wrongly keep it.
        const file =
            'const make = () => {\n' +
            '    class Box {\n        open() {\n            return 1;\n        }\n    }\n' +
            '    return Box;\n};\n';
        expect(alignCandidateRange(file, 0, file.length, 'open')).toEqual(NOT_PLACEABLE);
    });

    it('drops a destructured binding (ObjectProperty value under an ObjectPattern is not referenced)', () => {
        const file = 'function f(o) {\n    const { a: b } = o;\n    return 1;\n}\n';
        expect(alignCandidateRange(file, 0, file.length, 'b')).toEqual(NOT_PLACEABLE);
    });

    /*
     * The `isValidExpression` mirror. A computed key inside a DESTRUCTURING
     * pattern is the one expression position whose Stryker bubble ends at a
     * STATEMENT (the VariableDeclaration) rather than at an expression, so each
     * invalid-position rule is pinned by a candidate there: correct mirroring
     * bubbles-and-drops, while placing at the node itself would wrongly keep it.
     */
    it('drops a computed object-pattern key (object-property-key rule → bubbles to the declaration)', () => {
        const file = 'function f(o) {\n    const { [key]: value } = o;\n    return value;\n}\n';
        expect(alignCandidateRange(file, 0, file.length, 'key')).toEqual(NOT_PLACEABLE);
    });

    it('drops chain members under a computed pattern key (member / call / non-null chain rules)', () => {
        const member = 'function f(o, obj) {\n    const { [o.a.b]: v } = obj;\n    return v;\n}\n';
        expect(alignCandidateRange(member, 0, member.length, 'o.a')).toEqual(NOT_PLACEABLE);

        const call = 'function f(o, obj) {\n    const { [o.a().b]: v } = obj;\n    return v;\n}\n';
        expect(alignCandidateRange(call, 0, call.length, 'o.a()')).toEqual(NOT_PLACEABLE);

        const nonNull =
            'function f(o, obj) {\n    const { [o.a!.b]: v } = obj;\n    return v;\n}\n';
        expect(alignCandidateRange(nonNull, 0, nonNull.length, 'o.a!')).toEqual(NOT_PLACEABLE);
        expect(alignCandidateRange(nonNull, 0, nonNull.length, 'o.a')).toEqual(NOT_PLACEABLE);

        const callee = 'function f(o, obj) {\n    const { [o.a()]: v } = obj;\n    return v;\n}\n';
        expect(alignCandidateRange(callee, 0, callee.length, 'o.a')).toEqual(NOT_PLACEABLE);
    });

    it('drops OPTIONAL chain members under a computed pattern key', () => {
        const member = 'function f(o, obj) {\n    const { [o?.a.b]: v } = obj;\n    return v;\n}\n';
        expect(alignCandidateRange(member, 0, member.length, 'o?.a')).toEqual(NOT_PLACEABLE);

        const call =
            'function f(o, obj) {\n    const { [o.a?.().b]: v } = obj;\n    return v;\n}\n';
        expect(alignCandidateRange(call, 0, call.length, 'o.a?.()')).toEqual(NOT_PLACEABLE);

        const callee =
            'function f(o, obj) {\n    const { [o.a?.()]: v } = obj;\n    return v;\n}\n';
        expect(alignCandidateRange(callee, 0, callee.length, 'o.a')).toEqual(NOT_PLACEABLE);
    });

    it('keeps a COMPUTED member property even under a computed pattern key (the chain exception)', () => {
        // `x.y` is the computed property of `o[x.y]` — NOT part of the chain, so
        // Stryker places at `x.y` itself.
        const file =
            'function f(o, x, obj) {\n    const { [o[x.y]]: v } = obj;\n    return v;\n}\n';
        expect(expectSuccess(alignCandidateRange(file, 0, file.length, 'x.y')).original).toBe(
            'x.y',
        );
    });

    it('drops a tagged-template tag, a delete operand and an assignment target under a computed pattern key', () => {
        const tagged = 'function f(obj) {\n    const { [html`x`]: v } = obj;\n    return v;\n}\n';
        expect(alignCandidateRange(tagged, 0, tagged.length, 'html')).toEqual(NOT_PLACEABLE);

        const del =
            'function f(o, obj) {\n    const { [delete o.k]: v } = obj;\n    return v;\n}\n';
        expect(alignCandidateRange(del, 0, del.length, 'o.k')).toEqual(NOT_PLACEABLE);

        const assign =
            'function f(o, obj) {\n    const { [o.count = 1]: v } = obj;\n    return v;\n}\n';
        expect(alignCandidateRange(assign, 0, assign.length, 'o.count')).toEqual(NOT_PLACEABLE);
    });

    it('keeps a non-delete unary operand and an assignment SOURCE under a computed pattern key', () => {
        const neg = 'function f(o, obj) {\n    const { [-o.k]: v } = obj;\n    return v;\n}\n';
        expect(expectSuccess(alignCandidateRange(neg, 0, neg.length, 'o.k')).original).toBe('o.k');

        const assign =
            'function f(o, obj) {\n    const { [o.count = o.next]: v } = obj;\n    return v;\n}\n';
        expect(
            expectSuccess(alignCandidateRange(assign, 0, assign.length, 'o.next')).original,
        ).toBe('o.next');
    });
});
