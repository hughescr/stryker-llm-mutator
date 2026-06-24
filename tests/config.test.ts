/*
 * Offline unit tests for the `llmMutator` config schema (functional-architecture
 * §6). These pin the two switch blocks added for M1/M2 — `heuristics` (default
 * ON) and `dynamicLLM` (default OFF) — plus the defaulting behaviour that makes
 * an empty `llmMutator: {}` parse to a complete, usable, heuristics-only config.
 * Pure zod parsing; no network, no Stryker.
 */

import { describe, expect, it } from 'bun:test';

import {
    DEFAULT_MODEL,
    HeuristicOperator,
    llmMutatorConfigSchema,
    type LlmMutatorConfig,
} from '../src/config';

describe('llmMutatorConfigSchema — empty block defaults', () => {
    it('parses an empty {} to heuristics-on / dynamicLLM-off with all defaults', () => {
        const cfg: LlmMutatorConfig = llmMutatorConfigSchema.parse({});

        // Top-level (unchanged) defaults still apply.
        expect(cfg.provider).toBe('anthropic-agent-sdk');
        expect(cfg.model).toBe(DEFAULT_MODEL);
        expect(cfg.cacheDir).toBe('.stryker-llm-cache');

        // Heuristics: ON by default, empty allow-list (= all), skipUncovered on.
        expect(cfg.heuristics.enabled).toBe(true);
        expect(cfg.heuristics.operators).toEqual([]);
        expect(cfg.heuristics.skipUncovered).toBe(true);

        // DynamicLLM: OFF by default, with all nested sub-block defaults filled.
        expect(cfg.dynamicLLM.enabled).toBe(false);
        expect(cfg.dynamicLLM.targeting.topSpansPerFile).toBe(10);
        expect(cfg.dynamicLLM.targeting.minRiskScore).toBe(1);
        expect(cfg.dynamicLLM.targeting.requireCoverage).toBe(true);
        expect(cfg.dynamicLLM.budget.maxCandidatesPerFile).toBe(20);
        expect(cfg.dynamicLLM.budget.maxLlmCallsPerRun).toBe(500);
        expect(cfg.dynamicLLM.budget.maxCostUsd).toBe(5);
        expect(cfg.dynamicLLM.diminishingReturns.window).toBe(20);
        expect(cfg.dynamicLLM.diminishingReturns.minYieldPerCall).toBe(0.1);
    });

    it('fills the inner heuristics/dynamicLLM defaults when the blocks are absent entirely', () => {
        // Same outcome whether the blocks are `{}` or simply omitted — `.prefault({})`.
        const cfg = llmMutatorConfigSchema.parse({ provider: 'mock' });
        expect(cfg.heuristics.enabled).toBe(true);
        expect(cfg.dynamicLLM.enabled).toBe(false);
    });
});

describe('llmMutatorConfigSchema — heuristics block', () => {
    it('accepts a populated operators allow-list of valid catalog names', () => {
        const cfg = llmMutatorConfigSchema.parse({
            heuristics: { operators: ['NumberLiteralValue', 'BoundaryOffByOne'] },
        });
        expect(cfg.heuristics.operators).toEqual(['NumberLiteralValue', 'BoundaryOffByOne']);
        // Other fields still defaulted.
        expect(cfg.heuristics.enabled).toBe(true);
        expect(cfg.heuristics.skipUncovered).toBe(true);
    });

    it('honors an explicit heuristics.enabled = false', () => {
        const cfg = llmMutatorConfigSchema.parse({ heuristics: { enabled: false } });
        expect(cfg.heuristics.enabled).toBe(false);
    });

    it('rejects an unknown operator name (closed allow-list)', () => {
        expect(() =>
            llmMutatorConfigSchema.parse({ heuristics: { operators: ['NotARealOperator'] } }),
        ).toThrow();
    });
});

describe('llmMutatorConfigSchema — dynamicLLM block', () => {
    it('accepts enabling dynamicLLM with overridden budget caps', () => {
        const cfg = llmMutatorConfigSchema.parse({
            dynamicLLM: { enabled: true, budget: { maxCostUsd: 2 } },
        });
        expect(cfg.dynamicLLM.enabled).toBe(true);
        expect(cfg.dynamicLLM.budget.maxCostUsd).toBe(2);
        // Other budget fields still defaulted.
        expect(cfg.dynamicLLM.budget.maxLlmCallsPerRun).toBe(500);
    });

    it('rejects a non-positive maxCostUsd', () => {
        expect(() =>
            llmMutatorConfigSchema.parse({ dynamicLLM: { budget: { maxCostUsd: 0 } } }),
        ).toThrow();
    });
});

describe('llmMutatorConfigSchema — strictness', () => {
    it('rejects unknown top-level keys (.strict())', () => {
        expect(() => llmMutatorConfigSchema.parse({ nope: true })).toThrow();
    });
});

describe('HeuristicOperator enum', () => {
    it('contains the shipped P1 trio', () => {
        const options = HeuristicOperator.options;
        expect(options).toContain('NumberLiteralValue');
        expect(options).toContain('BoundaryOffByOne');
        expect(options).toContain('FallbackOperandSubstitution');
    });
});
