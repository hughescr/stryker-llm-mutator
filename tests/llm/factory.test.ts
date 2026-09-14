/*
 * Offline unit tests for the provider factory.
 *
 * Constructs each provider branch WITHOUT making a network call: the
 * AnthropicAgentProvider and OpenAiCompatibleProvider constructors are both
 * side-effect-free (auth/transport are resolved lazily in generate()), so we only
 * assert the constructed provider's identity. The mock branch is fully offline;
 * the `openai` / `openai-compatible` branches construct the dependency-free
 * OpenAI-compatible provider with the expected `name`; the one remaining
 * not-implemented branch (`anthropic-api`) asserts the thrown error. No live
 * query() / fetch() is ever invoked here (that is the human-run live smoke test).
 */

import { describe, expect, it } from 'bun:test';

import { llmMutatorConfigSchema, type LlmMutatorConfig } from '../../src/config';
import { createProvider } from '../../src/llm/factory';
import { OpenAiCompatibleProvider } from '../../src/llm/openai-compatible-provider';
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

    it('constructs an OpenAiCompatibleProvider labelled `openai` for openai', () => {
        const config = cfg('openai');
        const provider = createProvider(config);
        expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
        expect(provider.name).toBe(`openai(${config.model})`);
    });

    it('constructs an OpenAiCompatibleProvider labelled `openai-compatible` for openai-compatible', () => {
        const config = cfg('openai-compatible');
        const provider = createProvider(config);
        expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
        expect(provider.name).toBe(`openai-compatible(${config.model})`);
    });
});
