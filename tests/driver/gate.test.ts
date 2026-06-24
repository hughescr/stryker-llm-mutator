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
    NotImplementedError,
} from '../../src/driver/gate';

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

    it('throws for openai-compatible without OPENAI_API_KEY', () => {
        const cfg = config({ provider: 'openai-compatible', dynamicLLM: { enabled: true } });
        expect(() => assertLlmCredentials(cfg, {})).toThrow(MissingCredentialsError);
    });
});

describe('buildLlmMutator (Phase-A stub)', () => {
    it('always throws NotImplementedError with the M3 guidance message', () => {
        const cfg = config({ dynamicLLM: { enabled: true } });
        expect(() => buildLlmMutator(cfg)).toThrow(NotImplementedError);
        try {
            buildLlmMutator(cfg);
        } catch (error) {
            expect(error).toBeInstanceOf(NotImplementedError);
            expect((error as NotImplementedError).message).toContain('M3');
        }
    });
});
