/*
 * OFFLINE structural tests for the Anthropic Agent SDK provider.
 *
 * These tests NEVER call `query()` — the live network path is human-run in the
 * main thread (development-plan §5). They cover the security-critical
 * auth-env-shadowing guard, terminal-result extraction across the SDK result
 * subtypes, and that the provider constructs and rejects an already-aborted
 * request without touching the network.
 */

import { describe, expect, it } from 'bun:test';

import {
    AgentProviderError,
    AnthropicAgentProvider,
    extractResult,
    pickServedModel,
    resolveAuthEnv,
} from '../../src/llm/anthropic-agent-provider';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

// Minimal terminal-result builders. Cast through unknown because we only
// populate the fields extractResult reads; the SDK type is far larger.
function successResult(
    structuredOutput: unknown,
    overrides: Partial<Record<string, unknown>> = {},
): SDKResultMessage {
    return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'raw model text',
        total_cost_usd: 0.0042,
        modelUsage: { 'claude-haiku-4-5': {} },
        usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
        },
        structured_output: structuredOutput,
        ...overrides,
    } as unknown as SDKResultMessage;
}

function errorResult(
    subtype: string,
    overrides: Partial<Record<string, unknown>> = {},
): SDKResultMessage {
    return {
        type: 'result',
        subtype,
        is_error: true,
        total_cost_usd: 0.009,
        errors: ['boom'],
        ...overrides,
    } as unknown as SDKResultMessage;
}

describe('resolveAuthEnv', () => {
    it('sets CLAUDE_CODE_OAUTH_TOKEN from the ambient env', () => {
        const env = resolveAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-123', PATH: '/usr/bin' });
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-123');
        expect(env.PATH).toBe('/usr/bin');
    });

    it('prefers an explicit oauth token over the ambient one', () => {
        const env = resolveAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'ambient' }, 'explicit');
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('explicit');
    });

    it('STRIPS ANTHROPIC_API_KEY so it cannot shadow the OAuth token', () => {
        const env = resolveAuthEnv({
            CLAUDE_CODE_OAUTH_TOKEN: 'tok',
            ANTHROPIC_API_KEY: 'sk-should-not-leak',
        });
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
        expect('ANTHROPIC_API_KEY' in env).toBe(false);
    });

    it('strips the api key even when only the explicit token is given', () => {
        const env = resolveAuthEnv({ ANTHROPIC_API_KEY: 'sk-x' }, 'explicit-tok');
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('explicit-tok');
        expect('ANTHROPIC_API_KEY' in env).toBe(false);
    });

    it('throws when neither an explicit nor an ambient OAuth token exists', () => {
        expect(() => resolveAuthEnv({ PATH: '/usr/bin' })).toThrow(AgentProviderError);
        expect(() => resolveAuthEnv({ PATH: '/usr/bin' })).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    });

    it('omits undefined ambient values from the forwarded env', () => {
        const env = resolveAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', MAYBE: undefined });
        expect('MAYBE' in env).toBe(false);
    });
});

describe('extractResult', () => {
    it('returns the validated structured_output on success', () => {
        const result = extractResult<{ x: number }>(successResult({ x: 7 }), 'fallback');
        expect(result.value).toEqual({ x: 7 });
        expect(result.costUsd).toBe(0.0042);
        expect(result.rawText).toBe('raw model text');
        expect(result.cached).toBe(false);
    });

    it('maps usage tokens onto ProviderUsage', () => {
        const result = extractResult(successResult({ x: 1 }), 'fallback');
        expect(result.usage).toEqual({
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 5,
            cacheWriteTokens: 3,
        });
    });

    it('reads the model from modelUsage, falling back when absent', () => {
        expect(extractResult(successResult({ x: 1 }), 'fallback').model).toBe('claude-haiku-4-5');
        const noModelUsage = successResult({ x: 1 }, { modelUsage: {} });
        expect(extractResult(noModelUsage, 'fallback-model').model).toBe('fallback-model');
    });

    it('throws on success WITHOUT structured_output', () => {
        const noStructured = successResult(undefined, { structured_output: undefined });
        expect(() => extractResult(noStructured, 'm')).toThrow(/no structured_output/);
    });

    it('throws AgentProviderError on error_max_structured_output_retries, preserving subtype and cost', () => {
        try {
            extractResult(errorResult('error_max_structured_output_retries'), 'm');
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(AgentProviderError);
            const e = err as AgentProviderError;
            expect(e.subtype).toBe('error_max_structured_output_retries');
            expect(e.costUsd).toBe(0.009);
        }
    });

    it('throws on every other error subtype', () => {
        for (const subtype of [
            'error_during_execution',
            'error_max_turns',
            'error_max_budget_usd',
        ]) {
            expect(() => extractResult(errorResult(subtype), 'm')).toThrow(AgentProviderError);
        }
    });
});

describe('pickServedModel', () => {
    it('falls back when modelUsage is empty or missing', () => {
        expect(pickServedModel({}, 'fb')).toBe('fb');
        expect(pickServedModel(undefined, 'fb')).toBe('fb');
    });

    it('returns the single served model on the one-model path', () => {
        expect(
            pickServedModel(
                { 'claude-haiku-4-5': {} } as unknown as SDKResultMessage['modelUsage'],
                'fb',
            ),
        ).toBe('claude-haiku-4-5');
    });

    it('picks the model with the largest total token usage, not an arbitrary key', () => {
        const modelUsage = {
            'claude-haiku-4-5': { inputTokens: 10, outputTokens: 5 },
            'claude-opus-4-5': { inputTokens: 900, outputTokens: 100 },
        } as unknown as SDKResultMessage['modelUsage'];
        expect(pickServedModel(modelUsage, 'fb')).toBe('claude-opus-4-5');
    });
});

describe('AnthropicAgentProvider', () => {
    it('exposes the stable provider name', () => {
        expect(new AnthropicAgentProvider({ oauthToken: 'tok' }).name).toBe('anthropic-agent-sdk');
    });

    it('constructs with an injected env/token without touching the network', () => {
        const provider = new AnthropicAgentProvider({
            env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
            model: 'claude-haiku-4-5',
        });
        expect(provider).toBeInstanceOf(AnthropicAgentProvider);
    });

    it('rejects an already-aborted request before any network call', async () => {
        const provider = new AnthropicAgentProvider({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } });
        const controller = new AbortController();
        controller.abort();
        await expect(
            provider.generate({ prompt: 'p', schema: {}, signal: controller.signal }),
        ).rejects.toThrow(/aborted/);
    });
});

describe('AgentProviderError', () => {
    it('carries subtype and costUsd', () => {
        const err = new AgentProviderError('msg', 'some_subtype', 1.23);
        expect(err.name).toBe('AgentProviderError');
        expect(err.subtype).toBe('some_subtype');
        expect(err.costUsd).toBe(1.23);
        expect(err).toBeInstanceOf(Error);
    });
});
