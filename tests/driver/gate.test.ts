/*
 * Offline unit tests for the switch-gating + credential fail-fast + Phase-A LLM
 * throw-stub (functional-architecture §6 switch interplay / §3.5 stub). All pure
 * (env injected, no network, no Stryker): both-off warn, both-on additive,
 * heuristics-only, dynamicLLM-on credential fail-fast (per provider) and
 * credentials-present pass-through, and the NotImplementedError stub.
 */

import { describe, expect, it } from 'bun:test';

import { llmMutatorConfigSchema, type LlmMutatorConfig } from '../../src/config';
import {
    assertLlmCredentials,
    buildLlmMutator,
    gateSwitches,
    MissingCredentialsError,
} from '../../src/driver/gate';
import { CostAccumulator, MockProvider, ResponseCache } from '../../src/llm/index';
import { createBudgetedProvider } from '../../src/pipeline/budgeted-provider';
import { LLM_MUTATOR_NAME } from '../../src/mutators/llm-mutator';
import { proposeCacheIdentity } from '../../src/pipeline/propose';
import { buildProposeTargets, type SourceFileInput } from '../../src/pipeline/targeting';

/** Parse a partial llmMutator block into the fully-defaulted config. */
function config(partial: Record<string, unknown>): LlmMutatorConfig {
    return llmMutatorConfigSchema.parse(partial);
}

describe('gateSwitches', () => {
    it('heuristics-only (the default): runHeuristics true, runDynamicLLM false, no warning', () => {
        const plan = gateSwitches(config({}));
        expect(plan.runHeuristics).toBe(true);
        expect(plan.runDynamicLLM).toBe(false);
        expect(plan.bothOff).toBe(false);
        expect(plan.warning).toBeUndefined();
    });

    it('both off: bothOff true and a mandatory warning', () => {
        const plan = gateSwitches(
            config({ heuristics: { enabled: false }, dynamicLLM: { enabled: false } }),
        );
        expect(plan.runHeuristics).toBe(false);
        expect(plan.runDynamicLLM).toBe(false);
        expect(plan.bothOff).toBe(true);
        expect(plan.warning).toBeDefined();
        expect(plan.warning).toContain('STOCK Stryker');
    });

    it('both on: additive — both run, no warning', () => {
        const plan = gateSwitches(
            config({
                heuristics: { enabled: true },
                dynamicLLM: { enabled: true },
            }),
        );
        expect(plan.runHeuristics).toBe(true);
        expect(plan.runDynamicLLM).toBe(true);
        expect(plan.bothOff).toBe(false);
        expect(plan.warning).toBeUndefined();
    });

    it('dynamicLLM-only: runDynamicLLM true, runHeuristics false, no both-off warning', () => {
        const plan = gateSwitches(
            config({ heuristics: { enabled: false }, dynamicLLM: { enabled: true } }),
        );
        expect(plan.runHeuristics).toBe(false);
        expect(plan.runDynamicLLM).toBe(true);
        expect(plan.bothOff).toBe(false);
        expect(plan.warning).toBeUndefined();
    });
});

describe('assertLlmCredentials', () => {
    it('is a no-op when dynamicLLM is disabled (default), regardless of env', () => {
        expect(() => assertLlmCredentials(config({}), {})).not.toThrow();
    });

    it('is a no-op for the mock provider even with dynamicLLM enabled and empty env', () => {
        const cfg = config({ provider: 'mock', dynamicLLM: { enabled: true } });
        expect(() => assertLlmCredentials(cfg, {})).not.toThrow();
    });

    it('throws MissingCredentialsError for anthropic-agent-sdk without CLAUDE_CODE_OAUTH_TOKEN', () => {
        const cfg = config({ provider: 'anthropic-agent-sdk', dynamicLLM: { enabled: true } });
        expect(() => assertLlmCredentials(cfg, {})).toThrow(MissingCredentialsError);
        try {
            assertLlmCredentials(cfg, {});
        } catch (error) {
            expect(error).toBeInstanceOf(MissingCredentialsError);
            expect((error as MissingCredentialsError).provider).toBe('anthropic-agent-sdk');
        }
    });

    it('passes for anthropic-agent-sdk WITH CLAUDE_CODE_OAUTH_TOKEN present', () => {
        const cfg = config({ provider: 'anthropic-agent-sdk', dynamicLLM: { enabled: true } });
        expect(() =>
            assertLlmCredentials(cfg, { CLAUDE_CODE_OAUTH_TOKEN: 'tok-123' }),
        ).not.toThrow();
    });

    it('throws for anthropic-api without ANTHROPIC_API_KEY, passes with it', () => {
        const cfg = config({ provider: 'anthropic-api', dynamicLLM: { enabled: true } });
        expect(() => assertLlmCredentials(cfg, {})).toThrow(MissingCredentialsError);
        expect(() => assertLlmCredentials(cfg, { ANTHROPIC_API_KEY: 'sk-ant-1' })).not.toThrow();
    });

    it('throws for openai without OPENAI_API_KEY, passes with it', () => {
        const cfg = config({ provider: 'openai', dynamicLLM: { enabled: true } });
        expect(() => assertLlmCredentials(cfg, {})).toThrow(MissingCredentialsError);
        expect(() => assertLlmCredentials(cfg, { OPENAI_API_KEY: 'sk-1' })).not.toThrow();
    });

    it('carries the offending provider on the openai MissingCredentialsError', () => {
        const cfg = config({ provider: 'openai', dynamicLLM: { enabled: true } });
        try {
            assertLlmCredentials(cfg, {});
        } catch (error) {
            expect(error).toBeInstanceOf(MissingCredentialsError);
            expect((error as MissingCredentialsError).provider).toBe('openai');
        }
    });

    it('does NOT throw for openai-compatible without OPENAI_API_KEY (key-less local servers)', () => {
        const cfg = config({ provider: 'openai-compatible', dynamicLLM: { enabled: true } });
        expect(() => assertLlmCredentials(cfg, {})).not.toThrow();
    });

    it('also passes for openai-compatible WHEN a key happens to be present', () => {
        const cfg = config({ provider: 'openai-compatible', dynamicLLM: { enabled: true } });
        expect(() => assertLlmCredentials(cfg, { OPENAI_API_KEY: 'sk-local' })).not.toThrow();
    });
});

describe('buildLlmMutator (M3 orchestrator, offline)', () => {
    const RICH_FN = `
function classify(items, threshold) {
    let count = 0;
    for (let i = 0; i < items.length - 1; i++) {
        if (items[i] > threshold && items[i + 1] <= threshold) {
            count = count + 1;
        }
    }
    return { count: count, ok: count >= 2 };
}
`;

    function files(): SourceFileInput[] {
        return [{ fileName: '/abs/classify.ts', content: RICH_FN }];
    }

    async function withTempCache<T>(fn: (cache: ResponseCache) => Promise<T>): Promise<T> {
        const { mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const dir = await mkdtemp(join(tmpdir(), 'stryker-llm-gate-'));
        try {
            return await fn(new ResponseCache(dir));
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }

    it('runs the pre-pass with a MockProvider and returns a sync "llm" NodeMutator + cost + map', async () => {
        await withTempCache(async cache => {
            const cfg = config({ provider: 'mock', dynamicLLM: { enabled: true } });
            const cost = new CostAccumulator();
            const inner = new MockProvider({
                responder: () => ({
                    candidates: [
                        {
                            // A SUB-EXPRESSION inside classify (node-aligned), NOT
                            // the whole function — this is the contract the fix
                            // enforces so an expression edit replaces an expression
                            // node and the map is non-empty.
                            original: 'count >= 2',
                            replacement: 'count > 2',
                            mutatorTag: 'off-by-one',
                            rationale: 'boundary',
                        },
                    ],
                }),
                costUsd: 0.02,
            });
            const provider = createBudgetedProvider(inner, {
                cache,
                cost,
                maxCostUsd: 5,
                maxLlmCallsPerRun: 500,
                defaultModel: 'claude-haiku-4-5',
            });

            const result = await buildLlmMutator(cfg, {
                provider,
                costAccumulator: cost,
                files: files(),
                cwd: '/abs',
            });

            expect(result.mutator.name).toBe(LLM_MUTATOR_NAME);
            expect(result.costSnapshot.calls).toBeGreaterThanOrEqual(1);
            expect(result.costSnapshot.totalUsd).toBeGreaterThan(0);
            // The map holds at least the one survivor candidate.
            expect(result.map.size).toBeGreaterThanOrEqual(1);
        });
    });

    it('forwards a log sink and reports the pre-pass summary', async () => {
        await withTempCache(async cache => {
            const cfg = config({ provider: 'mock', dynamicLLM: { enabled: true } });
            const cost = new CostAccumulator();
            const inner = new MockProvider({
                responder: () => ({ candidates: [] }),
                costUsd: 0,
            });
            const provider = createBudgetedProvider(inner, {
                cache,
                cost,
                maxCostUsd: 5,
                maxLlmCallsPerRun: 500,
                defaultModel: 'claude-haiku-4-5',
            });
            const lines: string[] = [];

            await buildLlmMutator(cfg, {
                provider,
                costAccumulator: cost,
                files: files(),
                cwd: '/abs',
                log: l => lines.push(l),
            });

            expect(lines.some(l => l.includes('LLM pre-pass:'))).toBe(true);
        });
    });

    describe('cache-aware (monotone) targeting', () => {
        /** A second rich function so there are two targets competing for one paid slot. */
        const RICH_FN_B = RICH_FN.replace('function classify(', 'function classifyB(').replace(
            'count >= 2',
            'count >= 3',
        );
        const twoFiles = (): SourceFileInput[] => [
            { fileName: '/abs/classify.ts', content: RICH_FN },
            { fileName: '/abs/classify-b.ts', content: RICH_FN_B },
        ];
        const oneNewCall = () =>
            config({
                provider: 'mock',
                model: 'haiku',
                dynamicLLM: { enabled: true, budget: { maxLlmCallsPerRun: 1 } },
            });
        const responder = () => ({
            candidates: [
                {
                    original: 'count = count + 1',
                    replacement: 'count = count - 1',
                    mutatorTag: 'dec',
                    rationale: 'r',
                },
            ],
        });

        /** Pre-seed the cache with the EXACT entry the pre-pass would write for `classify`. */
        async function seedClassify(cache: ResponseCache, cfg: LlmMutatorConfig): Promise<void> {
            const { targets } = buildProposeTargets(twoFiles(), cfg);
            const a = targets.find(t => t.fileName === '/abs/classify.ts')!;
            const { cacheKey, meta } = proposeCacheIdentity(
                a,
                cfg.model,
                cfg.dynamicLLM.budget.maxCandidatesPerFile,
            );
            await cache.set(cacheKey, { value: responder(), costUsd: 0.02, model: 'haiku', meta });
        }

        it('with a `cache` dep, cached functions ride free ABOVE the call cap and new ones fill it', async () => {
            await withTempCache(async cache => {
                const cfg = oneNewCall();
                await seedClassify(cache, cfg);
                const cost = new CostAccumulator();
                const inner = new MockProvider({ responder, costUsd: 0.02 });
                const provider = createBudgetedProvider(inner, {
                    cache,
                    cost,
                    maxCostUsd: 5,
                    maxLlmCallsPerRun: 1,
                    defaultModel: 'haiku',
                });
                const lines: string[] = [];

                const result = await buildLlmMutator(cfg, {
                    provider,
                    costAccumulator: cost,
                    files: twoFiles(),
                    cwd: '/abs',
                    cache,
                    log: l => lines.push(l),
                });

                expect(lines).toContain(
                    'Gate1/2: 1 cached target(s) (free) + 1 new target(s) selected (cap 1)',
                );
                // ONE paid call (classifyB); classify came from the cache — and BOTH
                // files land in the map.
                expect(inner.calls).toHaveLength(1);
                expect(result.map.size).toBe(2);
            });
        });

        it('without a `cache` dep every function is "new" and the cap bites (legacy)', async () => {
            await withTempCache(async cache => {
                const cfg = oneNewCall();
                await seedClassify(cache, cfg);
                const cost = new CostAccumulator();
                const inner = new MockProvider({ responder, costUsd: 0.02 });
                const provider = createBudgetedProvider(inner, {
                    cache,
                    cost,
                    maxCostUsd: 5,
                    maxLlmCallsPerRun: 1,
                    defaultModel: 'haiku',
                });
                const lines: string[] = [];

                const result = await buildLlmMutator(cfg, {
                    provider,
                    costAccumulator: cost,
                    files: twoFiles(),
                    cwd: '/abs',
                    log: l => lines.push(l),
                });

                expect(lines).toContain(
                    'Gate1/2: 0 cached target(s) (free) + 1 new target(s) selected (cap 1)',
                );
                expect(result.map.size).toBe(1);
            });
        });

        it('frozen: only the cached function is targeted; the uncached one is skipped and logged', async () => {
            await withTempCache(async cache => {
                const cfg = oneNewCall();
                await seedClassify(cache, cfg);
                const cost = new CostAccumulator();
                const inner = new MockProvider({ responder, costUsd: 0.02 });
                const provider = createBudgetedProvider(inner, {
                    cache,
                    cost,
                    maxCostUsd: 5,
                    maxLlmCallsPerRun: 1,
                    defaultModel: 'haiku',
                    cacheOnly: true,
                });
                const lines: string[] = [];

                const result = await buildLlmMutator(cfg, {
                    provider,
                    costAccumulator: cost,
                    files: twoFiles(),
                    cwd: '/abs',
                    cache,
                    frozen: true,
                    log: l => lines.push(l),
                });

                expect(lines).toContain(
                    'Gate1/2: 1 cached target(s) (free) + 0 new target(s) selected (frozen: 1 uncached skipped)',
                );
                expect(inner.calls).toHaveLength(0);
                expect(result.map.size).toBe(1);
                expect(result.costSnapshot.totalUsd).toBe(0);
            });
        });

        it('a paid stop on a higher-EV new function never skips the cached one ranked below it', async () => {
            // `classifyC` out-ranks `classify` by EV. Its paid call yields nothing
            // and window=1 / floor=1 trips diminishing returns at once; the cached
            // `classify` (lower EV) must still be replayed — free replay is not
            // subject to paid stopping rules.
            const RICHER_FN = `
function classifyC(items, threshold, limit) {
    let count = 0;
    for (let i = 0; i < items.length - 1; i++) {
        if (items[i] > threshold && items[i + 1] <= threshold) {
            count = count + 1;
        }
        if (count > limit || items[i] % 2 === 0) {
            count = Math.max(count - 1, 0);
        }
    }
    return { count: count, ok: count >= 2 && count <= limit * 2 };
}
`;
            await withTempCache(async cache => {
                const cfg = config({
                    provider: 'mock',
                    model: 'haiku',
                    dynamicLLM: {
                        enabled: true,
                        diminishingReturns: { window: 1, minYieldPerCall: 1 },
                    },
                });
                await seedClassify(cache, cfg);
                const cost = new CostAccumulator();
                const inner = new MockProvider({
                    responder: () => ({ candidates: [] }),
                    costUsd: 0.02,
                });
                const provider = createBudgetedProvider(inner, {
                    cache,
                    cost,
                    maxCostUsd: 5,
                    maxLlmCallsPerRun: 5,
                    defaultModel: 'haiku',
                });
                const lines: string[] = [];

                const result = await buildLlmMutator(cfg, {
                    provider,
                    costAccumulator: cost,
                    files: [
                        { fileName: '/abs/classify.ts', content: RICH_FN },
                        { fileName: '/abs/classify-c.ts', content: RICHER_FN },
                    ],
                    cwd: '/abs',
                    cache,
                    log: l => lines.push(l),
                });

                expect(lines.some(l => l.includes('stop=diminishing-returns'))).toBe(true);
                expect(inner.calls).toHaveLength(1);
                expect([...result.map.keys()]).toEqual(['/abs/classify.ts']);
            });
        });
    });
});
