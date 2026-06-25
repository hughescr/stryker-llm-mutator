import { describe, expect, it } from 'bun:test';

import type { LLMProvider, ProviderRequest, ProviderResult } from '../../src/llm/types';
import type { SourceRange } from '../../src/seam/types';

import { PROPOSE_MUTATOR_PREFIX, propose, type ProposeTarget } from '../../src/pipeline';

/**
 * A canned, offline {@link LLMProvider} for tests. It never touches the network:
 * it returns a pre-supplied `candidates` payload (the structured object the real
 * provider would have validated against the schema) and records the last request
 * so assertions can inspect the prompt/schema the propose stage built.
 *
 * This is a plain object, not a `jest.spyOn` / `mock.module`, so no global mock
 * cleanup is required (test-hygiene rules apply to those, not to hand-built
 * fakes).
 */
function makeMockProvider(
    payload: unknown,
    options: { costUsd?: number; model?: string; onRequest?: (r: ProviderRequest) => void } = {},
): LLMProvider {
    return {
        name: 'mock',
        generate<T>(request: ProviderRequest): Promise<ProviderResult<T>> {
            options.onRequest?.(request);
            return Promise.resolve({
                value: payload as T,
                costUsd: options.costUsd ?? 0,
                model: options.model ?? request.model ?? 'claude-haiku-4-5',
            });
        },
    };
}

// The enclosing function the model reads. Under the node-aligned contract, the
// candidate's `original` is a SUB-EXPRESSION (e.g. `a > b ? a : b`) located + node
// aligned inside this function; the resulting Replacement.range is that
// sub-expression's node range (NOT the whole function).
const FUNCTION_SOURCE = 'function max(a: number, b: number) {\n    return a > b ? a : b;\n}';

/** A target carrying the function source + its absolute offsets for alignment. */
const TARGET: ProposeTarget = {
    fileName: 'src/calc.ts',
    // The whole-function range is the fallback only; per-edit ranges are aligned.
    range: { start: { line: 0, column: 0 }, end: { line: 2, column: 1 } },
    spanText: FUNCTION_SOURCE,
    context: FUNCTION_SOURCE,
    fileContent: FUNCTION_SOURCE,
    spanStartOffset: 0,
    spanEndOffset: FUNCTION_SOURCE.length,
};

// `a > b ? a : b` is the ConditionalExpression on file line index 1 (0-based);
// it starts at column 11 (`    return ` is 11 chars) and ends at column 24.
const TERNARY_RANGE: SourceRange = {
    start: { line: 1, column: 11 },
    end: { line: 1, column: 24 },
};

describe('propose — node-aligned sub-expression contract', () => {
    it('aligns each candidate to its sub-expression node range (not the function)', async () => {
        const provider = makeMockProvider({
            candidates: [
                {
                    original: 'a > b ? a : b',
                    replacement: 'a < b ? a : b',
                    mutatorTag: 'flip-condition',
                    rationale: 'Flipping > to < returns the minimum instead of the maximum.',
                },
                {
                    original: 'a > b ? a : b',
                    replacement: 'a >= b ? a : b',
                    mutatorTag: 'boundary',
                    rationale: 'Changing > to >= alters the tie-break branch.',
                },
            ],
        });

        const { replacements, dropped } = await propose(provider, TARGET);

        expect(dropped).toHaveLength(0);
        expect(replacements).toHaveLength(2);
        expect(replacements[0]).toEqual({
            fileName: 'src/calc.ts',
            range: TERNARY_RANGE,
            original: 'a > b ? a : b',
            replacement: 'a < b ? a : b',
            mutatorName: `${PROPOSE_MUTATOR_PREFIX}/flip-condition`,
            rationale: 'Flipping > to < returns the minimum instead of the maximum.',
        });
        expect(replacements[1]?.mutatorName).toBe(`${PROPOSE_MUTATOR_PREFIX}/boundary`);
        // The aligned range is the ternary node, NOT the whole-function fallback.
        expect(replacements[1]?.range).toEqual(TERNARY_RANGE);
    });

    it('aligns a SMALLER nested sub-expression to its own node range', async () => {
        // `a > b` is a BinaryExpression nested inside the ternary; it must align to
        // its own (tighter) node span, proving exact-node alignment, not the parent.
        const provider = makeMockProvider({
            candidates: [
                {
                    original: 'a > b',
                    replacement: 'a < b',
                    mutatorTag: 'flip',
                    rationale: 'Flip the comparison.',
                },
            ],
        });

        const { replacements } = await propose(provider, TARGET);
        expect(replacements).toHaveLength(1);
        // `a > b` starts at column 11 and ends at column 16.
        expect(replacements[0]?.range).toEqual({
            start: { line: 1, column: 11 },
            end: { line: 1, column: 16 },
        });
        expect(replacements[0]?.original).toBe('a > b');
    });

    it('falls back to the bare prefix when the model omits a mutatorTag', async () => {
        const provider = makeMockProvider({
            candidates: [
                {
                    original: 'a > b ? a : b',
                    replacement: 'b > a ? a : b',
                    mutatorTag: '   ',
                    rationale: 'Swaps operands.',
                },
            ],
        });

        const { replacements } = await propose(provider, TARGET);

        expect(replacements[0]?.mutatorName).toBe(PROPOSE_MUTATOR_PREFIX);
    });

    it('truncates to maxCandidates even when the model over-produces', async () => {
        // Five distinct, alignable sub-expressions; only the first two are kept.
        const provider = makeMockProvider({
            candidates: [
                {
                    original: 'a > b ? a : b',
                    replacement: 'a < b ? a : b',
                    mutatorTag: 't0',
                    rationale: 'n',
                },
                { original: 'a > b', replacement: 'a < b', mutatorTag: 't1', rationale: 'n' },
                { original: 'a', replacement: 'b', mutatorTag: 't2', rationale: 'n' },
                { original: 'b', replacement: 'a', mutatorTag: 't3', rationale: 'n' },
                { original: 'a : b', replacement: 'b : a', mutatorTag: 't4', rationale: 'n' },
            ],
        });

        const { replacements } = await propose(provider, TARGET, { maxCandidates: 2 });

        expect(replacements).toHaveLength(2);
        expect(replacements[1]?.replacement).toBe('a < b');
    });

    it('returns empty replacements + drops when the model proposes nothing', async () => {
        const provider = makeMockProvider({ candidates: [] });

        const { replacements, dropped } = await propose(provider, TARGET);

        expect(replacements).toEqual([]);
        expect(dropped).toEqual([]);
    });

    it('builds a function prompt + schema and forwards system/model/cacheKey', async () => {
        let seen: ProviderRequest | undefined;
        const provider = makeMockProvider(
            { candidates: [] },
            {
                onRequest: r => {
                    seen = r;
                },
            },
        );

        await propose(provider, TARGET, {
            maxCandidates: 3,
            model: 'claude-opus-4-1',
            cacheKey: 'span-abc',
        });

        expect(seen?.prompt).toContain('a > b ? a : b');
        expect(seen?.prompt).toContain('FUNCTION');
        expect(seen?.prompt).toContain('up to 3');
        expect(seen?.system).toContain('mutation-testing');
        expect(seen?.system).toContain('sub-expression');
        expect(seen?.model).toBe('claude-opus-4-1');
        expect(seen?.cacheKey).toBe('span-abc');

        const schema = seen?.schema as {
            properties: { candidates: { maxItems: number } };
        };
        expect(schema.properties.candidates.maxItems).toBe(3);
    });

    it('omits the CONTEXT block when context equals the function source', async () => {
        let seen: ProviderRequest | undefined;
        const provider = makeMockProvider(
            { candidates: [] },
            {
                onRequest: r => {
                    seen = r;
                },
            },
        );

        // context === spanText (the common targeting output) → no separate CONTEXT.
        await propose(provider, TARGET);

        expect(seen?.prompt).toContain('a > b ? a : b');
        expect(seen?.prompt).not.toContain('CONTEXT');
    });

    it('includes a CONTEXT block when context differs from the function source', async () => {
        let seen: ProviderRequest | undefined;
        const provider = makeMockProvider(
            { candidates: [] },
            {
                onRequest: r => {
                    seen = r;
                },
            },
        );

        await propose(provider, { ...TARGET, context: '// surrounding module context' });

        expect(seen?.prompt).toContain('CONTEXT');
        expect(seen?.prompt).toContain('surrounding module context');
    });

    it('omits the CONTEXT block when context is undefined', async () => {
        let seen: ProviderRequest | undefined;
        const provider = makeMockProvider(
            { candidates: [] },
            {
                onRequest: r => {
                    seen = r;
                },
            },
        );

        const { context: _ignored, ...noContext } = TARGET;
        await propose(provider, noContext);

        expect(seen?.prompt).not.toContain('CONTEXT');
    });

    it('propagates a provider rejection (transport/auth/schema failure)', async () => {
        const provider: LLMProvider = {
            name: 'mock',
            generate<T>(_request: ProviderRequest): Promise<ProviderResult<T>> {
                return Promise.reject(new Error('terminal schema failure'));
            },
        };

        await expect(propose(provider, TARGET)).rejects.toThrow('terminal schema failure');
    });
});

describe('propose — node-alignment drop conditions', () => {
    it('DROPS a candidate whose original is not found in the function (not-found)', async () => {
        const provider = makeMockProvider({
            candidates: [
                {
                    original: 'x + y', // never appears in `max`
                    replacement: 'x - y',
                    mutatorTag: 'nope',
                    rationale: 'n',
                },
            ],
        });

        const { replacements, dropped } = await propose(provider, TARGET);

        expect(replacements).toHaveLength(0);
        expect(dropped).toHaveLength(1);
        expect(dropped[0]?.reason).toContain('not found verbatim');
        // The reason interpolates the ACTUAL sub-expression, not the word "original".
        expect(dropped[0]?.reason).toContain('x + y');
        expect(dropped[0]?.fileName).toBe('src/calc.ts');
    });

    it('DROPS a candidate whose original appears more than once (ambiguous)', async () => {
        // `n` appears twice in the parameter list / nowhere uniquely — use a fn
        // where `a` appears multiple times so a bare `a` is ambiguous.
        const fn = 'function f(a) {\n    return a + a;\n}';
        const target: ProposeTarget = {
            fileName: 'src/f.ts',
            range: { start: { line: 0, column: 0 }, end: { line: 2, column: 1 } },
            spanText: fn,
            fileContent: fn,
            spanStartOffset: 0,
            spanEndOffset: fn.length,
        };
        const provider = makeMockProvider({
            candidates: [{ original: 'a', replacement: 'b', mutatorTag: 'amb', rationale: 'n' }],
        });

        const { replacements, dropped } = await propose(provider, target);

        expect(replacements).toHaveLength(0);
        expect(dropped).toHaveLength(1);
        expect(dropped[0]?.reason).toContain('ambiguous');
        // The reason interpolates the ACTUAL sub-expression, not the word "original".
        expect(dropped[0]?.reason).toContain('`a`');
    });

    it('DROPS a candidate that does not align to any single node (non-node-aligned)', async () => {
        // `b ? a` is a contiguous substring of `a > b ? a : b` but crosses node
        // boundaries — no single AST node spans exactly those characters.
        const provider = makeMockProvider({
            candidates: [
                { original: 'b ? a', replacement: 'b ? b', mutatorTag: 'cross', rationale: 'n' },
            ],
        });

        const { replacements, dropped } = await propose(provider, TARGET);

        expect(replacements).toHaveLength(0);
        expect(dropped).toHaveLength(1);
        expect(dropped[0]?.reason).toContain('crosses node boundaries');
        // The reason interpolates the ACTUAL sub-expression, not the word "original".
        expect(dropped[0]?.reason).toContain('b ? a');
    });

    it('DROPS a candidate that aligns to a statement-shaped node (not-an-expression)', async () => {
        // `return a > b ? a : b;` is a ReturnStatement — aligned exactly but NOT an
        // expression, so the expression placer would reject it.
        const provider = makeMockProvider({
            candidates: [
                {
                    original: 'return a > b ? a : b;',
                    replacement: 'return b;',
                    mutatorTag: 'stmt',
                    rationale: 'n',
                },
            ],
        });

        const { replacements, dropped } = await propose(provider, TARGET);

        expect(replacements).toHaveLength(0);
        expect(dropped).toHaveLength(1);
        expect(dropped[0]?.reason).toContain('aligns to a statement, not an expression');
    });

    it('keeps the alignable candidates and drops only the failing ones', async () => {
        const provider = makeMockProvider({
            candidates: [
                { original: 'a > b', replacement: 'a < b', mutatorTag: 'ok', rationale: 'n' },
                { original: 'q + r', replacement: 'q - r', mutatorTag: 'bad', rationale: 'n' },
            ],
        });

        const { replacements, dropped } = await propose(provider, TARGET);

        expect(replacements).toHaveLength(1);
        expect(replacements[0]?.mutatorName).toBe(`${PROPOSE_MUTATOR_PREFIX}/ok`);
        expect(dropped).toHaveLength(1);
        expect(dropped[0]?.reason).toContain('not found verbatim');
    });

    it('tallies dropCounts by TYPED reason and never echoes the literal word "original"', async () => {
        // Two not-found + one not-an-expression → typed buckets, no static "original".
        const provider = makeMockProvider({
            candidates: [
                { original: 'x + y', replacement: 'x - y', mutatorTag: 'a', rationale: 'n' },
                { original: 'p * q', replacement: 'p / q', mutatorTag: 'b', rationale: 'n' },
                {
                    original: 'return a > b ? a : b;',
                    replacement: 'return b;',
                    mutatorTag: 'c',
                    rationale: 'n',
                },
            ],
        });

        const { dropped, dropCounts } = await propose(provider, TARGET);

        expect(dropCounts).toEqual({ 'not-found': 2, 'not-an-expression': 1 });
        // Every reason interpolates the REAL sub-expression — the defective static
        // table hardcoded `"original"`, which must no longer appear.
        expect(dropped.every(d => !d.reason.includes('"original"'))).toBe(true);
        expect(dropped.some(d => d.reason.includes('x + y'))).toBe(true);
        expect(dropped.some(d => d.reason.includes('p * q'))).toBe(true);
    });

    it('truncates a pathological (long) sub-expression in the drop reason', async () => {
        // A not-found `original` longer than the 60-char cap is clipped + ellipsised
        // so one bad candidate cannot blow up a report line.
        const longExpr = `someVeryLongIdentifierName + ${'x'.repeat(80)}`;
        const provider = makeMockProvider({
            candidates: [
                { original: longExpr, replacement: 'y', mutatorTag: 'big', rationale: 'n' },
            ],
        });

        const { dropped } = await propose(provider, TARGET);

        expect(dropped).toHaveLength(1);
        expect(dropped[0]?.reason).toContain('…');
        // Clipped to the prefix; the full 80-x tail is NOT present.
        expect(dropped[0]?.reason).toContain('someVeryLongIdentifierName');
        expect(dropped[0]?.reason).not.toContain('x'.repeat(80));
    });

    it('falls back to spanText as the file source when offsets are omitted', async () => {
        // Backward-compat: a hand-built target with no fileContent/offsets aligns
        // against spanText starting at offset 0.
        const target: ProposeTarget = {
            fileName: 'src/inline.ts',
            range: { start: { line: 0, column: 0 }, end: { line: 0, column: 5 } },
            spanText: 'a > b',
        };
        const provider = makeMockProvider({
            candidates: [
                { original: 'a > b', replacement: 'a < b', mutatorTag: 'flip', rationale: 'n' },
            ],
        });

        const { replacements } = await propose(provider, target);
        expect(replacements).toHaveLength(1);
        expect(replacements[0]?.range).toEqual({
            start: { line: 0, column: 0 },
            end: { line: 0, column: 5 },
        });
    });
});
