/*
 * Offline unit tests for the instrumenter-registry resolver (M6 module-resolution
 * fix). Asserts that `resolveMutatePath` resolves the HOISTED instrumenter's
 * internal `mutate.js` via real Node resolution, and that the exported
 * `allMutators` is the live, mutable, non-frozen built-in array — the SAME instance
 * any importer (injection.ts, the canary) reaches.
 *
 * No Stryker invocation, no network. (The reference-identity-with-the-deep-import
 * guarantee is asserted end-to-end through the REAL instrumenter by the canary's
 * resolution-parity invariant; here we assert the resolver's shape/contract.)
 */

import { describe, expect, it } from 'bun:test';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { allMutators, resolveMutatePath } from '../src/instrumenter-registry';

describe('instrumenter-registry', () => {
    it('resolveMutatePath points at an existing mutate.js under the instrumenter dist', async () => {
        const resolved = resolveMutatePath();
        expect(path.isAbsolute(resolved)).toBe(true);
        expect(resolved.endsWith(path.join('dist', 'src', 'mutators', 'mutate.js'))).toBe(true);
        expect(resolved).toContain(path.join('@stryker-mutator', 'instrumenter'));
        const stats = await stat(resolved);
        expect(stats.isFile()).toBe(true);
    });

    it('exports the live, mutable, non-frozen built-in mutator array', () => {
        expect(Array.isArray(allMutators)).toBe(true);
        expect(Object.isFrozen(allMutators)).toBe(false);
        // The stock Stryker v9 built-in count (asserted at 16 by the canary too).
        expect(allMutators.length).toBe(16);
        for (const m of allMutators) {
            expect(typeof m.name).toBe('string');
            expect(typeof m.mutate).toBe('function');
        }
    });

    it('re-importing the registry yields the SAME array instance (ESM singleton)', async () => {
        const again = await import('../src/instrumenter-registry');
        expect(again.allMutators).toBe(allMutators);
    });
});
