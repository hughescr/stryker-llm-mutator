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
import { functionFingerprint } from '../../src/pipeline/fingerprint';
import { proposeCacheIdentity, type ProposeTarget } from '../../src/pipeline/propose';
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
        expect(
            result.dropped.some(d => d.reason.includes('not found (verbatim or by AST shape)')),
        ).toBe(true);
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
        // ORDER (unaligned, statement, unplaceable, ambiguous, not-found) can be
        // asserted. The function has two `a`s so a bare `a` is ambiguous; its
        // name `pick` is a declaration id Stryker cannot expression-place.
        const fn = 'function pick(a) {\n    return a > a ? a : 0;\n}';
        const inner = new MockProvider({
            responder: () => ({
                candidates: [
                    candidate('a < a ? a : 0', 'ok', 'a > a ? a : 0'), // aligns → survives
                    candidate('a ? a', 'cross', 'a ? a'), // crosses nodes → non-node-aligned
                    candidate('return 0;', 'stmt', 'return a > a ? a : 0;'), // → not-an-expression
                    candidate('pick2', 'name', 'pick'), // declaration id → not-expression-placeable
                    candidate('b', 'amb', 'a'), // appears twice → ambiguous
                    candidate('z - 1', 'gone', 'z + 9'), // absent → not-found
                ],
            }),
            costUsd: 0,
        });
        const lines: string[] = [];
        const result = await runPrePass(budgeted(inner), [target('/abs/h.ts', 117, fn)], cfg(), {
            cost,
            log: l => lines.push(l),
        });
        expect(
            result.dropped.some(d => d.reason.includes('is not expression-placeable by Stryker')),
        ).toBe(true);
        const summary = lines.filter(l => l.includes('— dropped '));
        expect(summary).toHaveLength(1);
        // 5 drops of 6 candidates; buckets in the fixed order, each non-zero once.
        expect(summary[0]).toBe(
            'stryker-llm: h.ts:118 — dropped 5/6 (1 unaligned, 1 statement, 1 unplaceable, 1 ambiguous, 1 not-found)',
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

    it('reports a fingerprint text-hash fallback (unparseable function text) with the target location', async () => {
        const broken = 'function f(a) {\n    return a + 1;\n]';
        const inner = new MockProvider({
            responder: () => ({ candidates: [] }),
            costUsd: 0,
        });
        const lines: string[] = [];
        await runPrePass(budgeted(inner), [target('/abs/broken.ts', 6, broken)], cfg(), {
            cost,
            log: l => lines.push(l),
        });
        const fallback = lines.filter(l => l.includes('fingerprint fallback'));
        expect(fallback).toHaveLength(1);
        expect(fallback[0]).toContain('(/abs/broken.ts:7)');
    });

    it('logs the count of candidates RECOVERED by shape alongside the drop buckets', async () => {
        // `a + 1` is spelled `a+1` in the function and also echoed by a comment:
        // the verbatim search is raw-ambiguous, the shape replay recovers the one
        // real node. A second candidate stays unrecoverable (absent) → not-found.
        const fn = 'function f(a) {\n    // a + 1\n    return a+1;\n}';
        const inner = new MockProvider({
            responder: () => ({
                candidates: [
                    candidate('a - 1', 'dec', 'a + 1'), // recovered by shape
                    candidate('z - 1', 'gone', 'z + 9'), // absent → not-found
                ],
            }),
            costUsd: 0,
        });
        const lines: string[] = [];
        const result = await runPrePass(budgeted(inner), [target('/abs/r.ts', 4, fn)], cfg(), {
            cost,
            log: l => lines.push(l),
        });
        expect(result.survivors.map(r => r.original)).toEqual(['a+1']);
        const summary = lines.filter(l => l.includes('— dropped '));
        expect(summary).toHaveLength(1);
        expect(summary[0]).toBe(
            'stryker-llm: r.ts:5 — dropped 1/2 (1 not-found); recovered 1 by shape',
        );
        // A call that recovered but dropped nothing still gets the line (a
        // different function, so the first call's cache entry is not replayed).
        const fn2 = 'function g(b) {\n    // b + 1\n    return b+1;\n}';
        const onlyRecovered = new MockProvider({
            responder: () => ({ candidates: [candidate('b - 1', 'dec', 'b + 1')] }),
            costUsd: 0,
        });
        const lines2: string[] = [];
        await runPrePass(budgeted(onlyRecovered), [target('/abs/r.ts', 4, fn2)], cfg(), {
            cost,
            log: l => lines2.push(l),
        });
        expect(lines2.filter(l => l.includes('— dropped '))).toEqual([
            'stryker-llm: r.ts:5 — dropped 0/1; recovered 1 by shape',
        ]);
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
        // Four DISTINCT functions (distinct cache keys → four PAID calls) whose
        // same-length names put the unique `z + 1` at the same aligned range →
        // the same survivor identity every time → 0 new after the first.
        const fn = (name: string) => `function ${name}(z) {\n    return z + 1;\n}`;
        const targets = [
            target('/abs/a.ts', 0, fn('fa')),
            target('/abs/a.ts', 0, fn('fb')), // same range+replacement → 0 new
            target('/abs/a.ts', 0, fn('fc')),
            target('/abs/a.ts', 0, fn('fd')),
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

describe('runPrePass — fingerprint-keyed cache + paid-only accounting', () => {
    let dir: string;
    let cache: ResponseCache;
    let cost: CostAccumulator;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stryker-llm-prepass-fp-'));
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
            defaultModel: 'haiku',
            ...over,
        });
    }

    const FN = 'function fp(p) {\n    return p + 1;\n}';
    const FN_COMMENTED =
        'function fp(p) {\n    // Stryker disable next-line all\n    return p + 1; /* c */\n}';

    it('keys each call by the function FINGERPRINT and records meta on the entry', async () => {
        const inner = new MockProvider({
            responder: () => ({ candidates: [candidate('p - 1', 'dec', 'p + 1')] }),
            costUsd: 0.1,
        });
        const t = { ...target('/abs/fp.ts', 0, FN), functionName: 'fp' };
        await runPrePass(budgeted(inner), [t], cfg(), { cost });

        const { cacheKey } = proposeCacheIdentity(
            t,
            'haiku',
            cfg().dynamicLLM.budget.maxCandidatesPerFile,
        );
        const entry = await cache.get(cacheKey);
        expect(entry).toBeDefined();
        expect(entry?.meta).toEqual({
            fingerprint: functionFingerprint(FN),
            fileName: '/abs/fp.ts',
            functionName: 'fp',
        });
    });

    it('a comment-only edit to the function is a cache HIT (no second paid call)', async () => {
        const inner = new MockProvider({
            responder: () => ({ candidates: [candidate('p - 1', 'dec', 'p + 1')] }),
            costUsd: 0.1,
        });
        const first = await runPrePass(budgeted(inner), [target('/abs/fp.ts', 0, FN)], cfg(), {
            cost,
        });
        expect(first.callsIssued).toBe(1);

        const cost2 = new CostAccumulator();
        const second = await runPrePass(
            createBudgetedProvider(inner, {
                cache,
                cost: cost2,
                maxCostUsd: 5,
                maxLlmCallsPerRun: 500,
                defaultModel: 'haiku',
            }),
            [target('/abs/fp.ts', 0, FN_COMMENTED)],
            cfg(),
            { cost: cost2 },
        );
        expect(inner.calls).toHaveLength(1);
        expect(second.cost.totalUsd).toBe(0);
        // The cached proposal still node-aligns against the COMMENTED source.
        expect(second.survivors.map(r => r.replacement)).toEqual(['p - 1']);
        expect(second.survivors[0]?.range.start).toEqual({ line: 2, column: 11 });
    });

    it('callsIssued counts only PAID calls (a warm run issues 0) while the heartbeat still walks every target', async () => {
        const inner = new MockProvider({
            responder: () => ({ candidates: [candidate('p - 1', 'dec', 'p + 1')] }),
            costUsd: 0.1,
        });
        const targets = [
            target('/abs/a.ts', 0, 'function fa(p) {\n    return p + 1;\n}'),
            target('/abs/b.ts', 0, 'function fb(p) {\n    return p + 1;\n}'),
        ];
        await runPrePass(budgeted(inner), targets, cfg(), { cost });

        const cost2 = new CostAccumulator();
        const lines: string[] = [];
        const warm = await runPrePass(
            createBudgetedProvider(inner, {
                cache,
                cost: cost2,
                maxCostUsd: 5,
                maxLlmCallsPerRun: 500,
                defaultModel: 'haiku',
            }),
            targets,
            cfg(),
            { cost: cost2, log: l => lines.push(l) },
        );
        expect(warm.callsIssued).toBe(0);
        expect(warm.cost.calls).toBe(2); // hits are still recorded $0 calls
        const heartbeats = lines.filter(l => l.includes('pre-pass ['));
        expect(heartbeats).toHaveLength(2);
        expect(heartbeats[0]).toContain('[1/2]');
        expect(heartbeats[1]).toContain('[2/2]');
    });

    it('diminishing returns IGNORES free hits: zero-yield cached targets never trip the stop', async () => {
        // Pre-seed three zero-candidate entries under the exact keys the pre-pass
        // will compute, then append one PAID target. window=2 floor=0.1: had the
        // free hits counted, the window would fill with 0,0 and stop BEFORE the
        // paid target; they do not, so the paid target still runs.
        const maxCandidates = cfg().dynamicLLM.budget.maxCandidatesPerFile;
        const cachedTargets = ['ca', 'cb', 'cc'].map(name =>
            target('/abs/c.ts', 0, `function ${name}(q) {\n    return q + 1;\n}`),
        );
        for (const t of cachedTargets) {
            // oxlint-disable-next-line no-await-in-loop -- sequential seeding of three entries.
            await cache.set(proposeCacheIdentity(t, 'haiku', maxCandidates).cacheKey, {
                value: { candidates: [] },
                costUsd: 0,
                model: 'haiku',
            });
        }
        const inner = new MockProvider({
            responder: () => ({ candidates: [candidate('r - 1', 'dec', 'r + 1')] }),
            costUsd: 0.1,
        });
        const paid = target('/abs/p.ts', 0, 'function pd(r) {\n    return r + 1;\n}');
        const config = cfg({ diminishingReturns: { window: 2, minYieldPerCall: 0.1 } });

        const result = await runPrePass(budgeted(inner), [...cachedTargets, paid], config, {
            cost,
        });
        expect(result.stopReason).toBe('queue-exhausted');
        expect(result.callsIssued).toBe(1);
        expect(inner.calls).toHaveLength(1);
        expect(result.survivors.map(r => r.replacement)).toEqual(['r - 1']);
    });

    it('free hits never exhaust maxLlmCallsPerRun (cached targets beyond the cap, then a paid one)', async () => {
        const maxCandidates = cfg().dynamicLLM.budget.maxCandidatesPerFile;
        const cachedTargets = ['xa', 'xb', 'xc'].map(name =>
            target('/abs/x.ts', 0, `function ${name}(q) {\n    return q + 1;\n}`),
        );
        for (const t of cachedTargets) {
            // oxlint-disable-next-line no-await-in-loop -- sequential seeding of three entries.
            await cache.set(proposeCacheIdentity(t, 'haiku', maxCandidates).cacheKey, {
                value: { candidates: [] },
                costUsd: 0,
                model: 'haiku',
            });
        }
        const inner = new MockProvider({
            responder: () => ({ candidates: [candidate('r - 1', 'dec', 'r + 1')] }),
            costUsd: 0.1,
        });
        const paid = target('/abs/p.ts', 0, 'function pe(r) {\n    return r + 1;\n}');
        const result = await runPrePass(
            budgeted(inner, { maxLlmCallsPerRun: 1 }),
            [...cachedTargets, paid],
            cfg(),
            { cost },
        );
        expect(result.stopReason).toBe('queue-exhausted');
        expect(inner.calls).toHaveLength(1);
        expect(result.survivors.map(r => r.replacement)).toEqual(['r - 1']);
    });

    /*
     * A PAID stop (diminishing returns, cost ceiling, call cap) must end the paid
     * work only: every CACHED target is free and must still be replayed, even
     * when it sits AFTER the stop in EV order. The `isCached` probe (the same one
     * targeting uses) tells the pre-pass which targets are free.
     */
    describe('mixed cached / uncached queues: a paid stop never skips a cached target', () => {
        const maxCandidates = cfg().dynamicLLM.budget.maxCandidatesPerFile;
        const CACHED_FN = 'function ch(q) {\n    return q + 1;\n}';

        /** Seed the cache with one valid candidate for `CACHED_FN` and return its target. */
        async function seedCached(): Promise<ProposeTarget> {
            const t = target('/abs/c.ts', 0, CACHED_FN);
            await cache.set(proposeCacheIdentity(t, 'haiku', maxCandidates).cacheKey, {
                value: { candidates: [candidate('q - 1', 'dec', 'q + 1')] },
                costUsd: 0,
                model: 'haiku',
            });
            return t;
        }

        /** The `isCached` probe: a target is cached when its key is on disk. */
        async function probe(): Promise<(t: ProposeTarget) => boolean> {
            const keys = await cache.keys();
            return t => keys.has(proposeCacheIdentity(t, 'haiku', maxCandidates).cacheKey);
        }

        it('diminishing returns after a zero-yield paid call still replays the later cached target', async () => {
            const cached = await seedCached();
            const inner = new MockProvider({ responder: () => ({ candidates: [] }), costUsd: 0.1 });
            const uncached = target('/abs/u.ts', 0, 'function un(r) {\n    return r * 2;\n}');
            const config = cfg({ diminishingReturns: { window: 1, minYieldPerCall: 1 } });

            const result = await runPrePass(budgeted(inner), [uncached, cached], config, {
                cost,
                isCached: await probe(),
            });
            expect(result.stopReason).toBe('diminishing-returns');
            expect(result.callsIssued).toBe(1);
            expect(inner.calls).toHaveLength(1);
            expect(result.survivors.map(r => r.replacement)).toEqual(['q - 1']);
        });

        it('a call cap hit by the first paid target still replays the cached targets after it (no network)', async () => {
            const cached = await seedCached();
            const inner = new MockProvider({
                responder: () => ({ candidates: [candidate('r / 2', 'div', 'r * 2')] }),
                costUsd: 0.1,
            });
            const paidA = target('/abs/ua.ts', 0, 'function ua(r) {\n    return r * 2;\n}');
            const paidB = target('/abs/ub.ts', 0, 'function ub(r) {\n    return r * 2;\n}');

            const result = await runPrePass(
                budgeted(inner, { maxLlmCallsPerRun: 1 }),
                [paidA, paidB, cached],
                cfg(),
                { cost, isCached: await probe() },
            );
            expect(result.stopReason).toBe('call-cap');
            expect(inner.calls).toHaveLength(1);
            expect(result.callsIssued).toBe(1);
            expect(result.survivors.map(r => r.replacement).sort()).toEqual(['q - 1', 'r / 2']);
        });

        it('a cost ceiling already crossed still replays every cached target', async () => {
            const cached = await seedCached();
            const inner = new MockProvider({ responder: () => ({ candidates: [] }), costUsd: 0.1 });
            const paid = target('/abs/u.ts', 0, 'function un(r) {\n    return r * 2;\n}');
            cost.add(10); // over the $5 ceiling before the first paid call

            const result = await runPrePass(budgeted(inner), [paid, cached], cfg(), {
                cost,
                isCached: await probe(),
            });
            expect(result.stopReason).toBe('cost-ceiling');
            expect(inner.calls).toHaveLength(0);
            expect(result.survivors.map(r => r.replacement)).toEqual(['q - 1']);
        });

        it('without an isCached probe the legacy single-queue behaviour stands', async () => {
            const cached = await seedCached();
            const inner = new MockProvider({ responder: () => ({ candidates: [] }), costUsd: 0.1 });
            const uncached = target('/abs/u.ts', 0, 'function un(r) {\n    return r * 2;\n}');
            const config = cfg({ diminishingReturns: { window: 1, minYieldPerCall: 1 } });

            const result = await runPrePass(budgeted(inner), [uncached, cached], config, { cost });
            expect(result.stopReason).toBe('diminishing-returns');
            expect(result.survivors).toEqual([]);
        });
    });
});
