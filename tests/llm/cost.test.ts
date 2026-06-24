import { describe, expect, it } from 'bun:test';

import { CostAccumulator } from '../../src/llm/cost';

describe('CostAccumulator', () => {
    it('starts empty', () => {
        const acc = new CostAccumulator();
        expect(acc.totalUsd).toBe(0);
        expect(acc.calls).toBe(0);
        expect(acc.snapshot()).toEqual({ totalUsd: 0, calls: 0 });
    });

    it('sums costs across calls and counts them', () => {
        const acc = new CostAccumulator();
        acc.add(0.01);
        acc.add(0.02);
        acc.add(0.03);
        expect(acc.totalUsd).toBeCloseTo(0.06, 10);
        expect(acc.calls).toBe(3);
    });

    it('counts zero-cost cache hits as calls', () => {
        const acc = new CostAccumulator();
        acc.add(0);
        acc.add(0);
        expect(acc.totalUsd).toBe(0);
        expect(acc.calls).toBe(2);
    });

    it('produces a read-only snapshot of the running total', () => {
        const acc = new CostAccumulator();
        acc.add(1.5);
        expect(acc.snapshot()).toEqual({ totalUsd: 1.5, calls: 1 });
    });

    it('resets to the initial empty state', () => {
        const acc = new CostAccumulator();
        acc.add(2);
        acc.reset();
        expect(acc.snapshot()).toEqual({ totalUsd: 0, calls: 0 });
    });

    it('rejects a negative cost', () => {
        const acc = new CostAccumulator();
        expect(() => acc.add(-0.01)).toThrow(/invalid costUsd/);
    });

    it('rejects a non-finite cost', () => {
        const acc = new CostAccumulator();
        expect(() => acc.add(Number.NaN)).toThrow(/invalid costUsd/);
        expect(() => acc.add(Number.POSITIVE_INFINITY)).toThrow(/invalid costUsd/);
    });
});
