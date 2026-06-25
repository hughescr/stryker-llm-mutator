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
import { dedupKey } from '../../src/pipeline/filters';
import { RollingYield, runPrePass } from '../../src/pipeline/prepass';
import type { ProposeTarget } from '../../src/pipeline/propose';
import type { LLMProvider, ProviderRequest, ProviderResult } from '../../src/llm/types';
import type { SourceRange } from '../../src/seam/types';

function range(line: number): SourceRange {
    return { start: { line, column: 0 }, end: { line, column: 10 } };
}

/**
 * Build a target whose `spanText` is an enclosing FUNCTION containing the
 * sub-expression `a + 1` (the candidates below mutate that). Under the
 * node-aligned contract the target carries the file content + the function's
 * absolute offsets so propose can locate + node-align each candidate's `original`
 * inside it. `fnSource` defaults to a function wrapping a unique `a + 1`.
 */
function target(
    fileName: string,
    line: number,
    fnSource = 'function f(a) {\n    return a + 1;\n}',
): ProposeTarget {
    return {
        fileName,
        range: range(line),
        spanText: fnSource,
        context: fnSource,
        fileContent: fnSource,
        spanStartOffset: 0,
        spanEndOffset: fnSource.length,
    };
}

/**
 * A canned candidate envelope the propose schema expects. `original` is the
 * verbatim SUB-EXPRESSION (located inside the target function); `replacement` is
 * the edited sub-expression. Both must be locatable/alignable inside `spanText`.
 */
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

    function budgeted(inner: LLMProvider, over: Record<string, unknown> = {}) {
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
            target('/abs/a.ts', 0, 'function alpha(a) {\n    return a + 1;\n}'),
            target('/abs/b.ts', 1, 'function beta(b) {\n    return b + 1;\n}'),
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
        // After node-alignment Replacement.original = the located sub-expression
        // `a + 1`, so a candidate whose replacement equals it is the no-op to drop.
        const inner = new MockProvider({
            responder: () => ({
                candidates: [
                    candidate('a + 1', 'noop', 'a + 1'), // == original → identical → dropped
                    candidate('a - 1', 'real', 'a + 1'),
                ],
            }),
            costUsd: 0,
        });
        const result = await runPrePass(budgeted(inner), [target('/abs/a.ts', 0)], cfg(), {
            cost,
        });
        expect(result.survivors.map(r => r.replacement)).toEqual(['a - 1']);
    });

    it('drops near-equivalent candidates and records them in the drop log', async () => {
        // The aligned sub-expression `a + 1` becomes Replacement.original; the
        // replacement '(a + 1)' is near-equivalent to it (parens only).
        const inner = new MockProvider({
            responder: () => ({
                candidates: [
                    candidate('(a + 1)', 'parens', 'a + 1'), // near-equiv → dropped
                    candidate('a - 1', 'real', 'a + 1'),
                ],
            }),
            costUsd: 0,
        });
        const result = await runPrePass(budgeted(inner), [target('/abs/a.ts', 0)], cfg(), {
            cost,
        });
        expect(result.survivors.map(r => r.replacement)).toEqual(['a - 1']);
        expect(result.dropped.some(d => d.replacement === '(a + 1)')).toBe(true);
    });

    it('records node-alignment drops (not-found / not-an-expression) in the drop log + rolls them up', async () => {
        // One candidate aligns cleanly; one references an `original` absent from the
        // function (not-found); one aligns to the ReturnStatement (not-an-expression).
        const inner = new MockProvider({
            responder: () => ({
                candidates: [
                    candidate('a - 1', 'real', 'a + 1'), // aligns → survives
                    candidate('z - 1', 'gone', 'z + 9'), // not in function → not-found
                    candidate('return 0;', 'stmt', 'return a + 1;'), // statement → not-an-expression
                ],
            }),
            costUsd: 0,
        });
        const lines: string[] = [];
        const result = await runPrePass(budgeted(inner), [target('/abs/a.ts', 0)], cfg(), {
            cost,
            log: l => lines.push(l),
        });
        expect(result.survivors.map(r => r.replacement)).toEqual(['a - 1']);
        // Both alignment drops are accounted in the run drop log (the JSON report),
        // with the ACTUAL sub-expression interpolated (not the literal "original").
        expect(result.dropped.some(d => d.reason.includes('not found verbatim'))).toBe(true);
        expect(result.dropped.some(d => d.reason.includes('z + 9'))).toBe(true);
        expect(
            result.dropped.some(d => d.reason.includes('aligns to a statement, not an expression')),
        ).toBe(true);
        // The per-candidate spam is GONE: no `node-alignment drop` line on stdout.
        expect(lines.some(l => l.includes('node-alignment drop'))).toBe(false);
        // Instead, ONE rolled-up per-function summary: 2 drops of 3 candidates.
        const summary = lines.filter(l => l.includes('— dropped '));
        expect(summary).toHaveLength(1);
        expect(summary[0]).toContain('a.ts:1 — dropped 2/3');
        expect(summary[0]).toContain('1 statement');
        expect(summary[0]).toContain('1 not-found');
    });

    it('emits ONE per-function drop summary with M/T + non-zero buckets in fixed order', async () => {
        // 1 survivor + drops across every node-alignment category so the bucket
        // ORDER (unaligned, statement, ambiguous, not-found) can be asserted. The
        // function has two `a`s so a bare `a` is ambiguous.
        const fn = 'function f(a) {\n    return a > a ? a : 0;\n}';
        const inner = new MockProvider({
            responder: () => ({
                candidates: [
                    candidate('a < a ? a : 0', 'ok', 'a > a ? a : 0'), // aligns → survives
                    candidate('a ? a', 'cross', 'a ? a'), // crosses nodes → non-node-aligned
                    candidate('return 0;', 'stmt', 'return a > a ? a : 0;'), // → not-an-expression
                    candidate('b', 'amb', 'a'), // appears twice → ambiguous
                    candidate('z - 1', 'gone', 'z + 9'), // absent → not-found
                ],
            }),
            costUsd: 0,
        });
        const lines: string[] = [];
        await runPrePass(budgeted(inner), [target('/abs/h.ts', 117, fn)], cfg(), {
            cost,
            log: l => lines.push(l),
        });
        const summary = lines.filter(l => l.includes('— dropped '));
        expect(summary).toHaveLength(1);
        // 4 drops of 5 candidates; buckets in the fixed order, each non-zero once.
        expect(summary[0]).toBe(
            'stryker-llm: h.ts:118 — dropped 4/5 (1 unaligned, 1 statement, 1 ambiguous, 1 not-found)',
        );
    });

    it('folds near-equivalent drops into the summary as an `equivalent` bucket (no per-drop spam)', async () => {
        // One real survivor + one near-equivalent (parens-only) drop. The
        // near-equivalent detail must NOT spam stdout; it folds into the summary.
        const inner = new MockProvider({
            responder: () => ({
                candidates: [
                    candidate('a - 1', 'real', 'a + 1'), // survives
                    candidate('(a + 1)', 'parens', 'a + 1'), // near-equivalent → dropped
                ],
            }),
            costUsd: 0,
        });
        const lines: string[] = [];
        const result = await runPrePass(budgeted(inner), [target('/abs/a.ts', 0)], cfg(), {
            cost,
            log: l => lines.push(l),
        });
        expect(result.survivors.map(r => r.replacement)).toEqual(['a - 1']);
        // Detail still in the report.
        expect(result.dropped.some(d => d.replacement === '(a + 1)')).toBe(true);
        // No per-candidate near-equivalent line on stdout.
        expect(lines.some(l => l.includes('near-equivalent drop'))).toBe(false);
        // Folded into the single summary line.
        const summary = lines.filter(l => l.includes('— dropped '));
        expect(summary).toHaveLength(1);
        // 2 candidates returned, both aligned; 1 of them dropped near-equivalent.
        expect(summary[0]).toContain('a.ts:1 — dropped 1/2 (1 equivalent)');
    });

    it('emits NO drop summary line for a call with zero drops', async () => {
        const inner = new MockProvider({
            responder: () => ({ candidates: [candidate('a - 1', 'real', 'a + 1')] }),
            costUsd: 0,
        });
        const lines: string[] = [];
        await runPrePass(budgeted(inner), [target('/abs/a.ts', 0)], cfg(), {
            cost,
            log: l => lines.push(l),
        });
        expect(lines.some(l => l.includes('— dropped '))).toBe(false);
        // The heartbeat still fires (so we know the call ran).
        expect(lines.some(l => l.includes('pre-pass ['))).toBe(true);
    });

    it('STOPS on the cost ceiling and KEEPS the partial survivors', async () => {
        // Each candidate mutates the located sub-expression `x + 1`; a distinct
        // replacement per prompt length keeps each survivor unique.
        const inner = new MockProvider({
            responder: (request: ProviderRequest) => ({
                candidates: [candidate(`x_${request.prompt.length} - 1`, 'dec', 'x + 1')],
            }),
            costUsd: 3,
        });
        // Distinct function names (so prompts differ) all wrapping `x + 1`.
        const targets = [
            target('/abs/a.ts', 0, 'function fa(x) {\n    return x + 1;\n}'),
            target('/abs/b.ts', 1, 'function fbb(x) {\n    return x + 1;\n}'),
            target('/abs/c.ts', 2, 'function fccc(x) {\n    return x + 1;\n}'),
            target('/abs/d.ts', 3, 'function fdddd(x) {\n    return x + 1;\n}'),
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
        const targets = [
            target('/abs/a.ts', 0, 'function fa(y) {\n    return y + 1;\n}'),
            target('/abs/b.ts', 1, 'function fbb(y) {\n    return y + 1;\n}'),
        ];
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
        // Same function (with a unique `z + 1`) repeated → same survivor → 0 new.
        const fn = 'function fz(z) {\n    return z + 1;\n}';
        const targets = [
            target('/abs/a.ts', 0, fn),
            target('/abs/a.ts', 0, fn), // same span+replacement → 0 new
            target('/abs/a.ts', 0, fn),
            target('/abs/a.ts', 0, fn),
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
        const targets = [target('/abs/a.ts', 0, 'function fw(w) {\n    return w + 1;\n}')];

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
            [
                target('/abs/a.ts', 0, 'function fq(q) {\n    return q + 1;\n}'),
                target('/abs/b.ts', 1, 'function fqq(q) {\n    return q + 1;\n}'),
            ],
            cfg(),
            { cost, log: l => lines.push(l) },
        );
        expect(lines.some(l => l.includes('Pre-pass STOP'))).toBe(true);
    });

    it('emits one progress heartbeat per successful propose call when a log is given', async () => {
        const inner = new MockProvider({
            responder: (request: ProviderRequest) => ({
                candidates: [candidate(`h_${request.prompt.length} - 1`, 'dec', 'h + 1')],
            }),
            costUsd: 0,
        });
        const lines: string[] = [];
        const targets = [
            target('/abs/a.ts', 0, 'function ha(h) {\n    return h + 1;\n}'),
            target('/abs/b.ts', 1, 'function hbb(h) {\n    return h + 1;\n}'),
            target('/abs/c.ts', 2, 'function hccc(h) {\n    return h + 1;\n}'),
        ];
        const result = await runPrePass(budgeted(inner), targets, cfg(), {
            cost,
            log: l => lines.push(l),
        });
        const heartbeats = lines.filter(l => l.includes('pre-pass ['));
        // One heartbeat per propose() call, all stryker-llm:-prefixed, carrying the
        // [n/total] counter, the file basename, and the running cost.
        expect(heartbeats).toHaveLength(result.callsIssued);
        expect(heartbeats).toHaveLength(3);
        expect(heartbeats.every(l => l.startsWith('stryker-llm: pre-pass ['))).toBe(true);
        expect(heartbeats[0]).toContain('[1/3]');
        expect(heartbeats[2]).toContain('[3/3]');
        expect(heartbeats[0]).toContain('a.ts');
        expect(heartbeats.every(l => l.includes('$0.00'))).toBe(true);
    });

    it('re-throws a non-budget error from the provider', async () => {
        const inner = new MockProvider({
            responder: () => {
                throw new Error('boom');
            },
        });
        let thrown: unknown;
        try {
            await runPrePass(budgeted(inner), [target('/abs/a.ts', 0)], cfg(), { cost });
        } catch (error) {
            thrown = error;
        }
        expect((thrown as Error).message).toBe('boom');
    });

    /**
     * A concurrency-tracking provider: each `generate` increments an in-flight
     * counter, yields the event loop (so overlapping calls actually coexist),
     * records the running maximum, then decrements. `maxInFlight` proves how many
     * `propose()` calls were truly simultaneous. Unique replacement per prompt so
     * every survivor is distinct.
     */
    function concurrencyProvider(): LLMProvider & { maxInFlight: number } {
        let inFlight = 0;
        const tracker: LLMProvider & { maxInFlight: number } = {
            name: 'concurrency-tracker',
            maxInFlight: 0,
            async generate<T>(request: ProviderRequest): Promise<ProviderResult<T>> {
                inFlight += 1;
                tracker.maxInFlight = Math.max(tracker.maxInFlight, inFlight);
                // Hold the call open on a real timer so every sibling in the wave
                // reaches this point (past the async cache read) and truly overlaps
                // before any resolves — a microtask yield is too short to observe it.
                await new Promise<void>(resolve => {
                    setTimeout(resolve, 10);
                });
                inFlight -= 1;
                return {
                    value: {
                        candidates: [candidate(`p_${request.prompt.length} - 1`, 'dec', 'p + 1')],
                    } as T,
                    costUsd: 0,
                    model: 'claude-haiku-4-5',
                    cached: false,
                };
            },
        };
        return tracker;
    }

    function pTargets(n: number): ProposeTarget[] {
        // Distinct function names → distinct prompts → distinct cache keys, each
        // wrapping a unique `p + 1` the candidate mutates.
        return Array.from({ length: n }, (_unused, k) =>
            target('/abs/p.ts', k, `function f${'x'.repeat(k + 1)}(p) {\n    return p + 1;\n}`),
        );
    }

    it('issues propose() calls CONCURRENTLY per wave (max-in-flight reaches parallelBatches)', async () => {
        const inner = concurrencyProvider();
        await runPrePass(budgeted(inner), pTargets(6), cfg({ parallelBatches: 3 }), { cost });
        // Three calls truly overlap each wave.
        expect(inner.maxInFlight).toBe(3);
    });

    it('runs strictly SEQUENTIAL with parallelBatches: 1 (max-in-flight never exceeds 1)', async () => {
        const inner = concurrencyProvider();
        await runPrePass(budgeted(inner), pTargets(6), cfg({ parallelBatches: 1 }), { cost });
        expect(inner.maxInFlight).toBe(1);
    });

    it('yields the SAME survivor set for parallelBatches 1 and 4 (order-insensitive)', async () => {
        const responder = (request: ProviderRequest) => ({
            candidates: [
                candidate(`e_${request.prompt.length} - 1`, 'dec', 'e + 1'),
                candidate(`e_${request.prompt.length} * 2`, 'mul', 'e + 1'),
            ],
        });
        const targets = pTargets(7).map(t => ({
            ...t,
            spanText: t.spanText.replace(/\bp\b/g, 'e'),
            context: t.context?.replace(/\bp\b/g, 'e'),
            fileContent: t.fileContent?.replace(/\bp\b/g, 'e'),
        }));

        const seq = await runPrePass(
            budgeted(new MockProvider({ responder, costUsd: 0 })),
            targets,
            cfg({ parallelBatches: 1 }),
            { cost },
        );
        // Fresh cost + cache-independent comparison: a second run over the same
        // (now warm) cache returns the identical survivors regardless of waves.
        const par = await runPrePass(
            budgeted(new MockProvider({ responder, costUsd: 0 })),
            targets,
            cfg({ parallelBatches: 4 }),
            { cost: new CostAccumulator() },
        );

        const keys = (r: typeof seq) => r.survivors.map(dedupKey).sort();
        expect(keys(par)).toEqual(keys(seq));
        expect(seq.survivors.length).toBeGreaterThan(0);
    });

    it('emits one heartbeat per processed call under parallel waves', async () => {
        const inner = new MockProvider({
            responder: (request: ProviderRequest) => ({
                candidates: [candidate(`g_${request.prompt.length} - 1`, 'dec', 'g + 1')],
            }),
            costUsd: 0,
        });
        const lines: string[] = [];
        const targets = pTargets(5).map(t => ({
            ...t,
            spanText: t.spanText.replace(/\bp\b/g, 'g'),
            context: t.context?.replace(/\bp\b/g, 'g'),
            fileContent: t.fileContent?.replace(/\bp\b/g, 'g'),
        }));
        const result = await runPrePass(budgeted(inner), targets, cfg({ parallelBatches: 2 }), {
            cost,
            log: l => lines.push(l),
        });
        const heartbeats = lines.filter(l => l.includes('pre-pass ['));
        expect(heartbeats).toHaveLength(result.callsIssued);
        expect(heartbeats).toHaveLength(5);
        expect(heartbeats[0]).toContain('[1/5]');
        expect(heartbeats[4]).toContain('[5/5]');
    });
});
