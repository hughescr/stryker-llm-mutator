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

const RANGE: SourceRange = {
    start: { line: 4, column: 8 },
    end: { line: 4, column: 25 },
};

const TARGET: ProposeTarget = {
    fileName: 'src/calc.ts',
    range: RANGE,
    spanText: 'a > b ? a : b',
    context: 'function max(a: number, b: number) {\n    return a > b ? a : b;\n}',
};

describe('propose', () => {
    it('maps canned schema-valid candidates to seam-ready Replacements', async () => {
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

        const result = await propose(provider, TARGET);

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            fileName: 'src/calc.ts',
            range: RANGE,
            original: 'a > b ? a : b',
            replacement: 'a < b ? a : b',
            mutatorName: `${PROPOSE_MUTATOR_PREFIX}/flip-condition`,
            rationale: 'Flipping > to < returns the minimum instead of the maximum.',
        });
        expect(result[1]?.mutatorName).toBe(`${PROPOSE_MUTATOR_PREFIX}/boundary`);
    });

    it('uses the caller span text as original, ignoring a sloppy model echo', async () => {
        const provider = makeMockProvider({
            candidates: [
                {
                    original: 'WRONG ECHO',
                    replacement: 'a + b',
                    mutatorTag: 'wrong-op',
                    rationale: 'Replaces the conditional with an addition.',
                },
            ],
        });

        const result = await propose(provider, TARGET);

        expect(result[0]?.original).toBe('a > b ? a : b');
        expect(result[0]?.range).toEqual(RANGE);
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

        const result = await propose(provider, TARGET);

        expect(result[0]?.mutatorName).toBe(PROPOSE_MUTATOR_PREFIX);
    });

    it('truncates to maxCandidates even when the model over-produces', async () => {
        const provider = makeMockProvider({
            candidates: Array.from({ length: 5 }, (_, i) => ({
                original: 'a > b ? a : b',
                replacement: `a + ${i}`,
                mutatorTag: `tag-${i}`,
                rationale: 'n',
            })),
        });

        const result = await propose(provider, TARGET, { maxCandidates: 2 });

        expect(result).toHaveLength(2);
        expect(result[1]?.replacement).toBe('a + 1');
    });

    it('returns an empty array when the model proposes nothing', async () => {
        const provider = makeMockProvider({ candidates: [] });

        const result = await propose(provider, TARGET);

        expect(result).toEqual([]);
    });

    it('builds a prompt and schema and forwards system/model/cacheKey to the provider', async () => {
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
        expect(seen?.prompt).toContain('up to 3');
        expect(seen?.system).toContain('mutation-testing');
        expect(seen?.model).toBe('claude-opus-4-1');
        expect(seen?.cacheKey).toBe('span-abc');

        const schema = seen?.schema as {
            properties: { candidates: { maxItems: number } };
        };
        expect(schema.properties.candidates.maxItems).toBe(3);
    });

    it('omits the CONTEXT block from the prompt when no context is given', async () => {
        let seen: ProviderRequest | undefined;
        const provider = makeMockProvider(
            { candidates: [] },
            {
                onRequest: r => {
                    seen = r;
                },
            },
        );

        await propose(provider, { fileName: 'f.ts', range: RANGE, spanText: 'x + 1' });

        expect(seen?.prompt).toContain('x + 1');
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
