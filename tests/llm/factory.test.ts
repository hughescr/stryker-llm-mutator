/*
 * Offline unit tests for the provider factory.
 *
 * Constructs each provider branch WITHOUT making a network call: the
 * AnthropicAgentProvider constructor is side-effect-free (auth is resolved lazily
 * in generate()), so we only assert the constructed provider's identity. The mock
 * branch is fully offline; the not-implemented branches assert the thrown error.
 * No live query() is ever invoked here (that is the human-run live smoke test).
 */

import { describe, expect, it } from 'bun:test';

import { llmMutatorConfigSchema, type LlmMutatorConfig } from '../../src/config';
import { createProvider } from '../../src/llm/factory';
import { NotImplementedError } from '../../src/driver/gate';

function cfg(provider: LlmMutatorConfig['provider']): LlmMutatorConfig {
    return llmMutatorConfigSchema.parse({ provider });
}

describe('createProvider', () => {
    it('constructs the AnthropicAgentProvider for anthropic-agent-sdk (no network)', () => {
        const provider = createProvider(cfg('anthropic-agent-sdk'));
        expect(provider.name).toBe('anthropic-agent-sdk');
    });

    it('constructs a MockProvider for mock', () => {
        const provider = createProvider(cfg('mock'));
        expect(provider.name).toBe('mock');
    });

    it('throws NotImplementedError for anthropic-api', () => {
        expect(() => createProvider(cfg('anthropic-api'))).toThrow(NotImplementedError);
    });

    it('throws NotImplementedError for openai', () => {
        expect(() => createProvider(cfg('openai'))).toThrow(NotImplementedError);
    });

    it('throws NotImplementedError for openai-compatible', () => {
        expect(() => createProvider(cfg('openai-compatible'))).toThrow(/not implemented yet/);
    });
});
