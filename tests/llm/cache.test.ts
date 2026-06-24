import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeCacheKey, ResponseCache, type CacheKeyParts } from '../../src/llm/cache';

const PARTS: CacheKeyParts = {
    model: 'claude-haiku-4-5',
    prompt: 'mutate this function',
    schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'string' } } },
};

describe('computeCacheKey', () => {
    it('is a 64-char hex SHA-256 digest', () => {
        const key = computeCacheKey(PARTS);
        expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for identical inputs', () => {
        expect(computeCacheKey(PARTS)).toBe(computeCacheKey({ ...PARTS }));
    });

    it('changes when the model changes', () => {
        expect(computeCacheKey({ ...PARTS, model: 'other' })).not.toBe(computeCacheKey(PARTS));
    });

    it('changes when the prompt changes', () => {
        expect(computeCacheKey({ ...PARTS, prompt: 'different' })).not.toBe(computeCacheKey(PARTS));
    });

    it('changes when the schema changes', () => {
        expect(computeCacheKey({ ...PARTS, schema: { type: 'array' } })).not.toBe(
            computeCacheKey(PARTS),
        );
    });

    it('is insensitive to schema key ordering (stable serialization)', () => {
        const reordered: CacheKeyParts = {
            ...PARTS,
            schema: {
                properties: { b: { type: 'string' }, a: { type: 'number' } },
                type: 'object',
            },
        };
        expect(computeCacheKey(reordered)).toBe(computeCacheKey(PARTS));
    });
});

describe('ResponseCache', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stryker-llm-cache-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('misses on an unknown key', async () => {
        const cache = new ResponseCache(dir);
        expect(await cache.get('deadbeef')).toBeUndefined();
    });

    it('round-trips an entry set then get', async () => {
        const cache = new ResponseCache(dir);
        const entry = { value: { ok: true }, costUsd: 0.01, model: 'claude-haiku-4-5' };
        await cache.set('k1', entry);
        expect(await cache.get('k1')).toEqual(entry);
    });

    it('round-trips by content parts', async () => {
        const cache = new ResponseCache(dir);
        const entry = { value: [1, 2, 3], costUsd: 0.02, model: 'm', rawText: 'raw' };
        await cache.setByParts(PARTS, entry);
        expect(await cache.getByParts(PARTS)).toEqual(entry);
    });

    it('creates the cache directory lazily on first set', async () => {
        const nested = join(dir, 'a', 'b', 'c');
        const cache = new ResponseCache(nested);
        await cache.set('k', { value: 1, costUsd: 0, model: 'm' });
        expect(await cache.get('k')).toEqual({ value: 1, costUsd: 0, model: 'm' });
    });

    it('treats a corrupt entry file as a miss', async () => {
        const cache = new ResponseCache(dir);
        await Bun.write(join(dir, 'corrupt.json'), '{ not valid json');
        expect(await cache.get('corrupt')).toBeUndefined();
    });

    it('keeps distinct keys in distinct files', async () => {
        const cache = new ResponseCache(dir);
        await cache.set('k1', { value: 'one', costUsd: 0, model: 'm' });
        await cache.set('k2', { value: 'two', costUsd: 0, model: 'm' });
        expect((await cache.get<string>('k1'))?.value).toBe('one');
        expect((await cache.get<string>('k2'))?.value).toBe('two');
    });
});
