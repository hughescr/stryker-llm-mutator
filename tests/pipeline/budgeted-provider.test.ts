/*
 * Offline unit tests for the budget-enforcing, cache-backed provider wrapper.
 *
 * Uses a real {@link CostAccumulator}, a real temp-dir {@link ResponseCache}, and
 * a {@link MockProvider} returning synthetic cost + canned values — no network.
 * Asserts: cache hit returns $0 + cached and never calls the inner provider;
 * cache miss delegates, records cost, and stores; the dollar ceiling and the
 * call cap each throw BudgetExceededError BETWEEN calls; the request cacheKey is
 * honored over the content-addressed default.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostAccumulator, MockProvider, ResponseCache } from '../../src/llm/index';
import { BudgetExceededError, createBudgetedProvider } from '../../src/pipeline/budgeted-provider';
import type { JsonSchema, ProviderRequest } from '../../src/llm/types';

const SCHEMA: JsonSchema = { type: 'object' };

function req(over: Partial<ProviderRequest> = {}): ProviderRequest {
    return { prompt: 'p', schema: SCHEMA, ...over };
}

describe('createBudgetedProvider', () => {
    let dir: string;
    let cache: ResponseCache;
    let cost: CostAccumulator;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stryker-llm-budget-'));
        cache = new ResponseCache(dir);
        cost = new CostAccumulator();
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    function wrap(
        inner: MockProvider,
        over: Partial<Parameters<typeof createBudgetedProvider>[1]> = {},
    ) {
        return createBudgetedProvider(inner, {
            cache,
            cost,
            maxCostUsd: 5,
            maxLlmCallsPerRun: 500,
            defaultModel: 'claude-haiku-4-5',
            ...over,
        });
    }

    it('exposes a budgeted name wrapping the inner provider', () => {
        const p = wrap(new MockProvider({ responder: () => ({ ok: true }) }));
        expect(p.name).toBe('budgeted(mock)');
    });

    it('MISS: delegates, records the real cost, and stores the entry', async () => {
        const inner = new MockProvider({ responder: () => ({ v: 1 }), costUsd: 0.5 });
        const p = wrap(inner);

        const result = await p.generate(req());
        expect(result.value).toEqual({ v: 1 });
        expect(result.costUsd).toBe(0.5);
        expect(cost.snapshot()).toEqual({ totalUsd: 0.5, calls: 1 });
        expect(inner.calls).toHaveLength(1);
    });

    it('HIT: a second call with the same content returns $0 cached and does NOT hit the inner provider', async () => {
        const inner = new MockProvider({ responder: () => ({ v: 2 }), costUsd: 0.5, model: 'm1' });
        const p = wrap(inner);

        await p.generate(req());
        const second = await p.generate(req());

        expect(second.cached).toBe(true);
        expect(second.costUsd).toBe(0);
        expect(second.value).toEqual({ v: 2 });
        expect(second.model).toBe('m1');
        // The inner provider was called exactly once (the first, MISS, call).
        expect(inner.calls).toHaveLength(1);
        // Both calls are counted; only the first cost money.
        expect(cost.snapshot()).toEqual({ totalUsd: 0.5, calls: 2 });
    });

    it('honors a request-supplied cacheKey over the content-addressed default', async () => {
        const inner = new MockProvider({ responder: () => ({ v: 3 }), costUsd: 0.1 });
        const p = wrap(inner);

        await p.generate(req({ cacheKey: 'fixed-key', prompt: 'first' }));
        // Different prompt but SAME explicit cacheKey → hit.
        const second = await p.generate(req({ cacheKey: 'fixed-key', prompt: 'second' }));
        expect(second.cached).toBe(true);
        expect(inner.calls).toHaveLength(1);
    });

    it('throws BudgetExceededError (maxCostUsd) BETWEEN calls once the ceiling is crossed', async () => {
        const inner = new MockProvider({ responder: () => ({ v: 4 }), costUsd: 3 });
        const p = wrap(inner, { maxCostUsd: 5 });

        await p.generate(req({ prompt: 'a' })); // total 3
        await p.generate(req({ prompt: 'b' })); // total 6 — now over

        let thrown: unknown;
        try {
            await p.generate(req({ prompt: 'c' })); // checked BEFORE spending → throws
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(BudgetExceededError);
        expect((thrown as BudgetExceededError).reason).toBe('maxCostUsd');
        expect((thrown as BudgetExceededError).snapshot.totalUsd).toBe(6);
        // The inner provider was only called twice (the third was blocked).
        expect(inner.calls).toHaveLength(2);
    });

    it('throws BudgetExceededError (maxLlmCallsPerRun) once the call cap is reached', async () => {
        const inner = new MockProvider({ responder: () => ({ v: 5 }), costUsd: 0 });
        const p = wrap(inner, { maxLlmCallsPerRun: 1 });

        await p.generate(req({ prompt: 'a' })); // calls → 1
        let thrown: unknown;
        try {
            await p.generate(req({ prompt: 'b' })); // calls already 1 ≥ cap → throws
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(BudgetExceededError);
        expect((thrown as BudgetExceededError).reason).toBe('maxLlmCallsPerRun');
    });

    it('reconstructs rawText from a cached entry when present', async () => {
        const inner = new MockProvider({ responder: () => ({ v: 6 }), costUsd: 0.1 });
        // Pre-seed a cache entry that carries rawText, keyed by the default content key.
        const p = wrap(inner);
        const request = req({ prompt: 'with-raw' });
        // First call stores WITHOUT rawText (mock omits it); seed one manually instead.
        await p.generate(request);
        // Manually overwrite the stored entry to include rawText, then re-read.
        const { computeCacheKey } = await import('../../src/llm/index');
        const key = computeCacheKey({
            model: 'claude-haiku-4-5',
            prompt: 'with-raw',
            schema: SCHEMA,
        });
        await cache.set(key, { value: { v: 6 }, costUsd: 0.1, model: 'm', rawText: 'RAW' });

        const hit = await p.generate(request);
        expect(hit.cached).toBe(true);
        expect(hit.rawText).toBe('RAW');
    });
});
