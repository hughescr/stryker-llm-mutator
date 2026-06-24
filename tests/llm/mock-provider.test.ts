import { describe, expect, it } from 'bun:test';

import { MockProvider } from '../../src/llm/mock-provider';
import type { ProviderRequest } from '../../src/llm/types';

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };

function req(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
    return { prompt: 'hello', schema: SCHEMA, ...overrides };
}

describe('MockProvider', () => {
    it('exposes the stable provider name', () => {
        expect(new MockProvider().name).toBe('mock');
    });

    it('returns a canned response keyed by exact prompt', async () => {
        const provider = new MockProvider({ responses: { hello: { ok: true } } });
        const result = await provider.generate<{ ok: boolean }>(req());
        expect(result.value).toEqual({ ok: true });
        expect(result.cached).toBe(false);
    });

    it('reports the configured fixed cost and zero by default', async () => {
        const zero = new MockProvider({ responses: { hello: { ok: true } } });
        expect((await zero.generate(req())).costUsd).toBe(0);

        const priced = new MockProvider({ responses: { hello: { ok: true } }, costUsd: 0.0123 });
        expect((await priced.generate(req())).costUsd).toBe(0.0123);
    });

    it('falls back to a responder callback when no prompt entry matches', async () => {
        const provider = new MockProvider({
            responder: request => ({ echoed: request.prompt }),
        });
        const result = await provider.generate<{ echoed: string }>(req({ prompt: 'abc' }));
        expect(result.value).toEqual({ echoed: 'abc' });
    });

    it('prefers a prompt-map entry over the responder', async () => {
        const provider = new MockProvider({
            responses: { hello: { from: 'map' } },
            responder: () => ({ from: 'responder' }),
        });
        const result = await provider.generate<{ from: string }>(req());
        expect(result.value).toEqual({ from: 'map' });
    });

    it('rejects when no canned response matches', async () => {
        const provider = new MockProvider({ responses: { other: {} } });
        await expect(provider.generate(req())).rejects.toThrow(/no canned response/);
    });

    it('rejects when the abort signal is already fired', async () => {
        const controller = new AbortController();
        controller.abort();
        const provider = new MockProvider({ responses: { hello: {} } });
        await expect(provider.generate(req({ signal: controller.signal }))).rejects.toThrow(
            /aborted/,
        );
    });

    it('resolves the reported model from option, then request, then default', async () => {
        const fixed = new MockProvider({ responses: { hello: {} }, model: 'fixed-model' });
        expect((await fixed.generate(req())).model).toBe('fixed-model');

        const fromRequest = new MockProvider({ responses: { hello: {} } });
        expect((await fromRequest.generate(req({ model: 'req-model' }))).model).toBe('req-model');

        const fallback = new MockProvider({ responses: { hello: {} } });
        expect((await fallback.generate(req())).model).toBe('mock-model');
    });

    it('records every request it received for assertions', async () => {
        const provider = new MockProvider({ responder: () => ({}) });
        await provider.generate(req({ prompt: 'one' }));
        await provider.generate(req({ prompt: 'two' }));
        expect(provider.calls.map(c => c.prompt)).toEqual(['one', 'two']);
    });

    it('is deterministic: identical requests yield identical results', async () => {
        const provider = new MockProvider({ responses: { hello: { n: 1 } }, costUsd: 0.5 });
        const a = await provider.generate(req());
        const b = await provider.generate(req());
        expect(a).toEqual(b);
    });
});
