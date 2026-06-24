/*
 * Offline unit tests for the shared `mutate`-glob source reader (used by both the
 * `stryker-llm` CLI driver and the `withLlmMutators` config wrapper).
 *
 * Writes a tiny fixture tree to a temp dir, then asserts:
 *   • a glob reads the matching files as absolute fileName + content;
 *   • multiple patterns de-duplicate overlapping matches;
 *   • an empty/undefined `patterns` falls back to DEFAULT_MUTATE_PATTERNS (src/**).
 * Uses the real filesystem (no Stryker, no network), bun-runnable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_MUTATE_PATTERNS, readMutateSources } from '../../src/driver/read-sources';

let dir = '';

beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'read-sources-'));
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(path.join(dir, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');
    await writeFile(path.join(dir, 'other.ts'), 'export const c = 3;\n', 'utf8');
});

afterAll(async () => {
    if (dir) {
        await rm(dir, { recursive: true, force: true });
    }
});

describe('readMutateSources', () => {
    it('reads matching files as absolute fileName + content', async () => {
        const files = await readMutateSources(dir, ['src/**/*.ts']);
        const byName = new Map(files.map(f => [path.basename(f.fileName), f]));
        expect(byName.size).toBe(2);
        expect(path.isAbsolute(byName.get('a.ts')!.fileName)).toBe(true);
        expect(byName.get('a.ts')!.content).toBe('export const a = 1;\n');
        expect(byName.get('b.ts')!.content).toBe('export const b = 2;\n');
        // `other.ts` is outside `src/**`, so it is not read.
        expect(byName.has('other.ts')).toBe(false);
    });

    it('de-duplicates overlapping patterns', async () => {
        const files = await readMutateSources(dir, ['src/**/*.ts', 'src/a.ts']);
        const names = files.map(f => path.basename(f.fileName)).sort();
        expect(names).toEqual(['a.ts', 'b.ts']);
    });

    it('falls back to DEFAULT_MUTATE_PATTERNS when patterns is empty or undefined', async () => {
        expect(DEFAULT_MUTATE_PATTERNS).toEqual(['src/**/*.ts']);
        const fromUndefined = await readMutateSources(dir, undefined);
        const fromEmpty = await readMutateSources(dir, []);
        expect(fromUndefined.map(f => path.basename(f.fileName)).sort()).toEqual(['a.ts', 'b.ts']);
        expect(fromEmpty.map(f => path.basename(f.fileName)).sort()).toEqual(['a.ts', 'b.ts']);
    });
});
