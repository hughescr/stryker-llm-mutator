/*
 * Offline unit tests for the Gate-3/4 pre-pass orchestration + RollingYield.
 *
 * Drives `runPrePass` with a MockProvider returning canned ProposeResponse
 * candidates, a real CostAccumulator, and a temp-dir ResponseCache wrapped by the
 * budgeted provider. Asserts: per-function batching, filter+near-equiv applied,
 * cost-ceiling / call-cap / diminishing-returns / queue-exhausted stops, partial
 * survivors kept on a budget abort, and cache warm-run free re-runs. No network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { llmMutatorConfigSchema, type LlmMutatorConfig } from '../../src/config';
import { CostAccumulator, MockProvider, ResponseCache } from '../../src/llm/index';
import { createBudgetedProvider } from '../../src/pipeline/budgeted-provider';
import { RollingYield, runPrePass } from '../../src/pipeline/prepass';
import type { ProposeTarget } from '../../src/pipeline/propose';
import type { ProviderRequest } from '../../src/llm/types';
import type { SourceRange } from '../../src/seam/types';

function range(line: number): SourceRange {
    return { start: { line, column: 0 }, end: { line, column: 10 } };
}

function target(fileName: string, line: number, spanText: string): ProposeTarget {
    return { fileName, range: range(line), spanText, context: spanText };
}

/** A canned candidate envelope the propose schema expects. */
function candidate(replacement: string, tag: string, original: string) {
    return { original, replacement, mutatorTag: tag, rationale: `because ${tag}` };
}

/** Parse a dynamicLLM-enabled config with overrides. */
function cfg(over: Record<string, unknown> = {}): LlmMutatorConfig {
    return llmMutatorConfigSchema.parse({ dynamicLLM: { enabled: true, ...over } });
}

describe('RollingYield', () => {
    it('is not full until window samples accumulate, then reports the window mean', () => {
        const r = new RollingYield(3);
        expect(r.isFull()).toBe(false);
        expect(r.mean()).toBe(0);
        r.push(3);
        r.push(0);
        expect(r.isFull()).toBe(false);
        r.push(0);
        expect(r.isFull()).toBe(true);
        expect(r.mean()).toBeCloseTo(1, 5);
    });

    it('evicts the oldest sample past the window', () => {
        const r = new RollingYield(2);
        r.push(10);
        r.push(0);
        r.push(0); // evicts the 10
        expect(r.mean()).toBe(0);
    });
});

describe('runPrePass', () => {
    let dir: string;
    let cache: ResponseCache;
    let cost: CostAccumulator;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stryker-llm-prepass-'));
        cache = new ResponseCache(dir);
        cost = new CostAccumulator();
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    function budgeted(inner: MockProvider, over: Record<string, unknown> = {}) {
        return createBudgetedProvider(inner, {
            cache,
            cost,
            maxCostUsd: 5,
            maxLlmCallsPerRun: 500,
            defaultModel: 'claude-haiku-4-5',
            ...over,
        });
    }

    it('batches one propose() per function and collects filtered survivors', async () => {
        const inner = new MockProvider({
            responder: (request: ProviderRequest) => ({
                candidates: request.prompt.includes('alpha')
                    ? [candidate('a - 1', 'dec', 'a + 1'), candidate('a + 2', 'inc2', 'a + 1')]
                    : [candidate('b * 2', 'double', 'b + 1')],
            }),
            costUsd: 0.01,
        });
        const targets = [
            target('/abs/a.ts', 0, 'function alpha(a) { return a + 1; }'),
            target('/abs/b.ts', 1, 'function beta(b) { return b + 1; }'),
        ];

        const result = await runPrePass(budgeted(inner), targets, cfg(), { cost });
        expect(result.callsIssued).toBe(2);
        expect(result.survivors.map(r => r.replacement).sort()).toEqual([
            'a + 2',
            'a - 1',
            'b * 2',
        ]);
        expect(result.stopReason).toBe('queue-exhausted');
        expect(result.cost.calls).toBe(2);
    });

    it('drops identical (no-op) candidates via applyFilters', async () => {
        // The propose stage sets Replacement.original = the target spanText, so a
        // candidate whose replacement equals the span text is the no-op to drop.
        const inner = new MockProvider({
            responder: () => ({
                candidates: [
                    candidate('a + 1', 'noop', 'a + 1'), // == spanText → identical → dropped
                    candidate('a - 1', 'real', 'a + 1'),
                ],
            }),
            costUsd: 0,
        });
        const result = await runPrePass(budgeted(inner), [target('/abs/a.ts', 0, 'a + 1')], cfg(), {
            cost,
        });
        expect(result.survivors.map(r => r.replacement)).toEqual(['a - 1']);
    });

    it('drops near-equivalent candidates and records them in the drop log', async () => {
        // spanText 'a + 1' becomes Replacement.original; '(a + 1)' is near-equiv.
        const inner = new MockProvider({
            responder: () => ({
                candidates: [
                    candidate('(a + 1)', 'parens', 'a + 1'), // near-equiv to span → dropped
                    candidate('a - 1', 'real', 'a + 1'),
                ],
            }),
            costUsd: 0,
        });
        const result = await runPrePass(budgeted(inner), [target('/abs/a.ts', 0, 'a + 1')], cfg(), {
            cost,
        });
        expect(result.survivors.map(r => r.replacement)).toEqual(['a - 1']);
        expect(result.dropped.some(d => d.replacement === '(a + 1)')).toBe(true);
    });

    it('STOPS on the cost ceiling and KEEPS the partial survivors', async () => {
        const inner = new MockProvider({
            responder: (request: ProviderRequest) => ({
                candidates: [candidate(`x_${request.prompt.length} - 1`, 'dec', 'x + 1')],
            }),
            costUsd: 3,
        });
        const targets = [
            target('/abs/a.ts', 0, 'aaa'),
            target('/abs/b.ts', 1, 'bbbb'),
            target('/abs/c.ts', 2, 'ccccc'),
            target('/abs/d.ts', 3, 'dddddd'),
        ];
        const result = await runPrePass(budgeted(inner, { maxCostUsd: 5 }), targets, cfg(), {
            cost,
        });
        // Call 1 (total 3) ok; call 2 (total 6) ok; call 3 blocked (6 ≥ 5).
        expect(result.stopReason).toBe('cost-ceiling');
        expect(result.callsIssued).toBe(2);
        expect(result.survivors.length).toBe(2);
    });

    it('STOPS on the call cap', async () => {
        const inner = new MockProvider({
            responder: (request: ProviderRequest) => ({
                candidates: [candidate(`y_${request.prompt.length} - 1`, 'dec', 'y + 1')],
            }),
            costUsd: 0,
        });
        const targets = [target('/abs/a.ts', 0, 'aa'), target('/abs/b.ts', 1, 'bbb')];
        const result = await runPrePass(budgeted(inner, { maxLlmCallsPerRun: 1 }), targets, cfg(), {
            cost,
        });
        expect(result.stopReason).toBe('call-cap');
        expect(result.callsIssued).toBe(1);
    });

    it('STOPS on diminishing returns once a full window yields below the floor', async () => {
        // Every call returns the SAME (already-seen) candidate → 0 new yield after
        // the first. window=2, floor=0.1 → after 2 zero-yield calls, stop.
        const inner = new MockProvider({
            responder: () => ({ candidates: [candidate('z - 1', 'dec', 'z + 1')] }),
            costUsd: 0,
        });
        const config = cfg({ diminishingReturns: { window: 2, minYieldPerCall: 0.1 } });
        const targets = [
            target('/abs/a.ts', 0, 'fn'),
            target('/abs/a.ts', 0, 'fn'), // same span+replacement → 0 new
            target('/abs/a.ts', 0, 'fn'),
            target('/abs/a.ts', 0, 'fn'),
        ];
        const result = await runPrePass(budgeted(inner), targets, config, { cost });
        expect(result.stopReason).toBe('diminishing-returns');
        // First call yields (2: new survivor + new tag); next calls yield 0.
        expect(result.callsIssued).toBeLessThan(4);
    });

    it('warm re-run is FREE: a second pre-pass over the same targets adds no cost', async () => {
        const inner = new MockProvider({
            responder: () => ({ candidates: [candidate('w - 1', 'dec', 'w + 1')] }),
            costUsd: 0.25,
        });
        const provider = budgeted(inner);
        const targets = [target('/abs/a.ts', 0, 'fn')];

        const first = await runPrePass(provider, targets, cfg(), { cost });
        expect(first.cost.totalUsd).toBe(0.25);

        const cost2 = new CostAccumulator();
        const provider2 = createBudgetedProvider(inner, {
            cache,
            cost: cost2,
            maxCostUsd: 5,
            maxLlmCallsPerRun: 500,
            defaultModel: 'claude-haiku-4-5',
        });
        const second = await runPrePass(provider2, targets, cfg(), { cost: cost2 });
        expect(second.cost.totalUsd).toBe(0); // served from cache.
        expect(second.survivors.map(r => r.replacement)).toEqual(['w - 1']);
        // The inner provider was called only once across both runs.
        expect(inner.calls).toHaveLength(1);
    });

    it('forwards a log sink and notes the stop reason', async () => {
        const inner = new MockProvider({
            responder: () => ({ candidates: [candidate('q - 1', 'dec', 'q + 1')] }),
            costUsd: 0,
        });
        const lines: string[] = [];
        await runPrePass(
            budgeted(inner, { maxLlmCallsPerRun: 1 }),
            [target('/abs/a.ts', 0, 'fn'), target('/abs/b.ts', 1, 'fn2')],
            cfg(),
            { cost, log: l => lines.push(l) },
        );
        expect(lines.some(l => l.includes('Pre-pass STOP'))).toBe(true);
    });

    it('re-throws a non-budget error from the provider', async () => {
        const inner = new MockProvider({
            responder: () => {
                throw new Error('boom');
            },
        });
        let thrown: unknown;
        try {
            await runPrePass(budgeted(inner), [target('/abs/a.ts', 0, 'fn')], cfg(), { cost });
        } catch (error) {
            thrown = error;
        }
        expect((thrown as Error).message).toBe('boom');
    });
});
