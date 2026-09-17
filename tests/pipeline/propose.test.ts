import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostAccumulator, MockProvider, ResponseCache } from '../../src/llm/index';
import type { LLMProvider, ProviderRequest, ProviderResult } from '../../src/llm/types';
import type { SourceRange } from '../../src/seam/types';

import {
    createBudgetedProvider,
    PROPOSE_MUTATOR_PREFIX,
    propose,
    proposeCacheIdentity,
    type ProposeTarget,
} from '../../src/pipeline';

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
        expect(seen?.system).toContain('Do NOT add optional chaining');
        expect(seen?.system).toContain('concrete, reachable runtime-nullish receiver path');
        expect(seen?.system).toContain('TypeScript annotation, cast, or non-null assertion');
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

        await propose(provider, {
            ...TARGET,
            context: 'const LIMIT = 3; // surrounding module context',
        });

        expect(seen?.prompt).toContain('CONTEXT');
        expect(seen?.prompt).toContain('const LIMIT = 3;');
        // The context is comment-stripped like the function text.
        expect(seen?.prompt).not.toContain('surrounding module context');
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
        expect(dropped[0]?.reason).toContain('not found (verbatim or by AST shape)');
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

    it('DROPS a candidate whose node Stryker cannot expression-place (not-expression-placeable)', async () => {
        // The function NAME `max` is an Identifier — an Expression by node type —
        // but it is the FunctionDeclaration's id, not a referenced expression, so
        // Stryker would fall to the statement placer (the isambard `export class`
        // crash shape). It must be dropped with the typed reason.
        const provider = makeMockProvider({
            candidates: [
                { original: 'max', replacement: 'max_alt', mutatorTag: 'typo', rationale: 'n' },
            ],
        });

        const { replacements, dropped, dropCounts } = await propose(provider, TARGET);

        expect(replacements).toHaveLength(0);
        expect(dropped).toHaveLength(1);
        expect(dropped[0]?.reason).toContain('is not expression-placeable by Stryker');
        expect(dropped[0]?.reason).toContain('`max`');
        expect(dropCounts).toEqual({ 'not-expression-placeable': 1 });
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
        expect(dropped[0]?.reason).toContain('not found (verbatim or by AST shape)');
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

describe('propose — comment-stripped prompt + cache identity', () => {
    const COMMENTED = [
        'function max(a: number, b: number) {',
        '    // Stryker disable next-line all',
        '    return a > b ? a : b; /* pick the larger */',
        '}',
    ].join('\n');
    const COMMENTED_TARGET: ProposeTarget = {
        fileName: '/abs/calc.ts',
        range: { start: { line: 0, column: 0 }, end: { line: 3, column: 1 } },
        spanText: COMMENTED,
        context: COMMENTED,
        fileContent: COMMENTED,
        spanStartOffset: 0,
        spanEndOffset: COMMENTED.length,
        functionName: 'max',
    };

    it('sends the model the COMMENT-STRIPPED function (and context) text', async () => {
        let seen: ProviderRequest | undefined;
        const provider = makeMockProvider(
            { candidates: [] },
            {
                onRequest: r => {
                    seen = r;
                },
            },
        );
        await propose(provider, COMMENTED_TARGET);
        expect(seen?.prompt).not.toContain('Stryker disable');
        expect(seen?.prompt).not.toContain('pick the larger');
        expect(seen?.prompt).toContain('return a > b ? a : b;');
        // Stripped context === stripped function → no CONTEXT block.
        expect(seen?.prompt).not.toContain('CONTEXT');
    });

    it('still node-aligns a candidate against the REAL (commented) source', async () => {
        const provider = makeMockProvider({
            candidates: [
                { original: 'a > b', replacement: 'a < b', mutatorTag: 'flip', rationale: 'n' },
            ],
        });
        const { replacements, dropped } = await propose(provider, COMMENTED_TARGET);
        expect(dropped).toEqual([]);
        expect(replacements).toHaveLength(1);
        // Line 2 (0-based) of the commented source: `    return a > b ? a : b; …`.
        expect(replacements[0]?.range.start).toEqual({ line: 2, column: 11 });
    });

    it('forwards cacheMeta alongside cacheKey and reports whether the result was cached', async () => {
        let seen: ProviderRequest | undefined;
        const provider: LLMProvider = {
            name: 'mock',
            generate<T>(request: ProviderRequest): Promise<ProviderResult<T>> {
                seen = request;
                return Promise.resolve({
                    value: { candidates: [] } as T,
                    costUsd: 0,
                    model: 'm',
                    cached: true,
                });
            },
        };
        const meta = { fingerprint: 'f'.repeat(64), fileName: '/abs/calc.ts', functionName: 'max' };
        const result = await propose(provider, COMMENTED_TARGET, {
            cacheKey: 'k',
            cacheMeta: meta,
        });
        expect(seen?.cacheKey).toBe('k');
        expect(seen?.cacheMeta).toEqual(meta);
        expect(result.cached).toBe(true);
    });

    it('reports cached: false when the provider does not flag the result', async () => {
        const result = await propose(makeMockProvider({ candidates: [] }), COMMENTED_TARGET);
        expect(result.cached).toBe(false);
    });

    it('proposeCacheIdentity: same key for comment/whitespace variants, distinct per model/cap/function', () => {
        const plain = proposeCacheIdentity(TARGET, 'haiku', 20);
        const commented = proposeCacheIdentity(COMMENTED_TARGET, 'haiku', 20);
        expect(plain.cacheKey).toMatch(/^[0-9a-f]{64}$/);
        expect(commented.cacheKey).toBe(plain.cacheKey);
        expect(commented.meta.fingerprint).toBe(plain.meta.fingerprint);

        expect(proposeCacheIdentity(TARGET, 'sonnet', 20).cacheKey).not.toBe(plain.cacheKey);
        expect(proposeCacheIdentity(TARGET, 'haiku', 8).cacheKey).not.toBe(plain.cacheKey);
        const other: ProposeTarget = {
            ...TARGET,
            spanText: 'function min(a, b) { return a < b ? a : b; }',
        };
        expect(proposeCacheIdentity(other, 'haiku', 20).cacheKey).not.toBe(plain.cacheKey);
    });

    it('proposeCacheIdentity: meta carries the fingerprint + provenance (functionName only when known)', () => {
        const withName = proposeCacheIdentity(COMMENTED_TARGET, 'haiku', 20);
        expect(withName.meta).toEqual({
            fingerprint: withName.meta.fingerprint,
            fileName: '/abs/calc.ts',
            functionName: 'max',
        });
        const anonymous = proposeCacheIdentity(TARGET, 'haiku', 20);
        expect(anonymous.meta).toEqual({
            fingerprint: anonymous.meta.fingerprint,
            fileName: 'src/calc.ts',
        });
    });
});

/*
 * END-TO-END REPLAY. A fingerprint-keyed cache HIT must preserve the mutant set
 * it promises: the cached candidate's `original` was spelled against the OLD
 * function text, so after a whitespace / quote / paren / comment edit the
 * verbatim substring is gone and the candidate must be re-found STRUCTURALLY
 * (range-align's shape fallback), yielding the CURRENT text + range. Real
 * `ResponseCache` + budgeted provider + `propose()` — no network.
 */
describe('propose — cached candidates replay across formatting-only edits', () => {
    let dir: string;
    let cache: ResponseCache;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stryker-llm-propose-replay-'));
        cache = new ResponseCache(dir);
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    /** A single-function target whose file IS the function. */
    function fnTarget(source: string): ProposeTarget {
        return {
            fileName: '/abs/replay.ts',
            range: { start: { line: 0, column: 0 }, end: { line: 2, column: 1 } },
            spanText: source,
            fileContent: source,
            spanStartOffset: 0,
            spanEndOffset: source.length,
        };
    }

    /** Buy the proposals for `source` once (paid), returning the inner provider. */
    async function buy(source: string, candidates: unknown[]): Promise<MockProvider> {
        const inner = new MockProvider({ responder: () => ({ candidates }), costUsd: 0.1 });
        const provider = createBudgetedProvider(inner, {
            cache,
            cost: new CostAccumulator(),
            maxCostUsd: 5,
            maxLlmCallsPerRun: 5,
            defaultModel: 'haiku',
        });
        const target = fnTarget(source);
        const identity = proposeCacheIdentity(target, 'haiku', 8);
        const bought = await propose(provider, target, {
            model: 'haiku',
            cacheKey: identity.cacheKey,
            cacheMeta: identity.meta,
        });
        expect(bought.cached).toBe(false);
        expect(bought.replacements).toHaveLength(candidates.length);
        return inner;
    }

    /** Replay `source` against the cache (must be a HIT), returning the result. */
    async function replay(inner: MockProvider, source: string) {
        const provider = createBudgetedProvider(inner, {
            cache,
            cost: new CostAccumulator(),
            maxCostUsd: 5,
            maxLlmCallsPerRun: 5,
            defaultModel: 'haiku',
        });
        const target = fnTarget(source);
        const identity = proposeCacheIdentity(target, 'haiku', 8);
        const result = await propose(provider, target, {
            model: 'haiku',
            cacheKey: identity.cacheKey,
            cacheMeta: identity.meta,
        });
        expect(result.cached).toBe(true);
        expect(inner.calls).toHaveLength(1);
        return result;
    }

    const ORIGINAL = 'function f(a) { return a + 1; }';
    const INC = { original: 'a + 1', replacement: 'a - 1', mutatorTag: 'dec', rationale: 'r' };

    it('a whitespace-only edit keeps the purchased mutant (current text + range)', async () => {
        const inner = await buy(ORIGINAL, [INC]);
        const result = await replay(inner, 'function f(a) {\n    return a+1;\n}');
        expect(result.dropped).toEqual([]);
        expect(result.replacements).toHaveLength(1);
        expect(result.replacements[0]?.original).toBe('a+1');
        expect(result.replacements[0]?.replacement).toBe('a - 1');
        expect(result.replacements[0]?.range).toEqual({
            start: { line: 1, column: 11 },
            end: { line: 1, column: 14 },
        });
    });

    it('a verbatim replay counts no recovery', async () => {
        const inner = await buy(ORIGINAL, [INC]);
        const result = await replay(inner, ORIGINAL);
        expect(result.recovered).toBe(0);
        expect(result.replacements.map(r => r.original)).toEqual(['a + 1']);
    });

    it('(a) a re-indentation of a multi-line sub-expression keeps the purchased mutant (recovered by shape)', async () => {
        const src = 'function f(a, b) {\n  return g(\n    a,\n    b,\n  );\n}';
        const inner = await buy(src, [
            {
                original: 'g(\n    a,\n    b,\n  )',
                replacement: 'g(b, a)',
                mutatorTag: 'swap',
                rationale: 'r',
            },
        ]);
        const result = await replay(
            inner,
            'function f(a, b) {\n    return g(\n        a,\n        b,\n    );\n}',
        );
        expect(result.dropCounts).toEqual({});
        expect(result.recovered).toBe(1);
        expect(result.replacements.map(r => r.original)).toEqual([
            'g(\n        a,\n        b,\n    )',
        ]);
        expect(result.replacements[0]?.range).toEqual({
            start: { line: 1, column: 11 },
            end: { line: 4, column: 5 },
        });
    });

    it('(b) a comment added inside the function but OUTSIDE the span keeps the purchased mutant', async () => {
        const inner = await buy(ORIGINAL, [INC]);
        // A comment that does not repeat the text: the verbatim match still wins.
        const plain = await replay(inner, 'function f(a) {\n    // bump\n    return a + 1;\n}');
        expect(plain.dropCounts).toEqual({});
        expect(plain.recovered).toBe(0);
        expect(plain.replacements.map(r => r.original)).toEqual(['a + 1']);
        // A comment that DOES repeat the text made the raw substring ambiguous;
        // the single real node is recovered by shape.
        const echo = await replay(
            inner,
            'function f(a) {\n    // a + 1 is the offset\n    return a + 1;\n}',
        );
        expect(echo.dropCounts).toEqual({});
        expect(echo.recovered).toBe(1);
        expect(echo.replacements.map(r => r.original)).toEqual(['a + 1']);
        expect(echo.replacements[0]?.range).toEqual({
            start: { line: 2, column: 11 },
            end: { line: 2, column: 16 },
        });
    });

    it('(c) a comment inserted INSIDE the span keeps the purchased mutant, re-spelled with the comment', async () => {
        // Documented outcome: RECOVERED by shape. The emitted `original` is the
        // CURRENT text of the node, comment included, and the range spans it.
        const inner = await buy(ORIGINAL, [INC]);
        const result = await replay(inner, 'function f(a) { return a + /* inc */ 1; }');
        expect(result.dropCounts).toEqual({});
        expect(result.recovered).toBe(1);
        expect(result.replacements.map(r => r.original)).toEqual(['a + /* inc */ 1']);
        expect(result.replacements[0]?.range).toEqual({
            start: { line: 0, column: 23 },
            end: { line: 0, column: 38 },
        });
    });

    it('a quote-style edit keeps the purchased mutant', async () => {
        const src = "function g(s) { return s === 'x'; }";
        const inner = await buy(src, [
            { original: "s === 'x'", replacement: "s !== 'x'", mutatorTag: 'neg', rationale: 'r' },
        ]);
        const result = await replay(inner, 'function g(s) { return s === "x"; }');
        expect(result.replacements.map(r => r.original)).toEqual(['s === "x"']);
    });

    it('a parenthesis edit keeps the purchased mutant', async () => {
        const src = 'function h(a, b) { return a + b * 2; }';
        const inner = await buy(src, [
            { original: 'b * 2', replacement: 'b / 2', mutatorTag: 'op', rationale: 'r' },
        ]);
        const result = await replay(inner, 'function h(a, b) { return a + (b * 2); }');
        expect(result.replacements.map(r => r.original)).toEqual(['b * 2']);
        const result2 = await replay(inner, 'function h(a, b) { return (a + ((b) * 2)); }');
        expect(result2.replacements.map(r => r.original)).toEqual(['(b) * 2']);
    });

    it('a replayed candidate whose expression now occurs twice is still dropped as ambiguous', async () => {
        const inner = await buy(ORIGINAL, [INC]);
        // A function with two `a+1` nodes has a different fingerprint, so seed
        // its entry directly with the same cached candidate.
        const twice = 'function f(a) { return (a+1) * (a+1); }';
        const target = fnTarget(twice);
        const identity = proposeCacheIdentity(target, 'haiku', 8);
        await cache.set(identity.cacheKey, {
            value: { candidates: [INC] },
            costUsd: 0.1,
            model: 'haiku',
        });
        const result = await replay(inner, twice);
        expect(result.replacements).toEqual([]);
        expect(result.dropCounts).toEqual({ ambiguous: 1 });
    });
});
