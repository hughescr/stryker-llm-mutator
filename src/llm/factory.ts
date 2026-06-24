/*
 * Provider factory (functional-architecture §6 / pre-pass design providerFactory).
 *
 * The ONE place that maps a config `provider` name → a concrete
 * {@link LLMProvider} implementation. Every pipeline stage (propose, prepass,
 * budgeted-provider, targeting, reporter) codes against the `LLMProvider`
 * abstraction and takes a provider as a PARAMETER, so they stay bun-testable with
 * a MockProvider passed directly — never via this factory.
 *
 * NODE-ONLY: this module imports the concrete {@link AnthropicAgentProvider},
 * which pulls the Anthropic Agent SDK (Node-only). It is therefore constructed
 * ONLY in `src/driver/run.ts` (coverage-exempt, the same Node wall as Stryker).
 * The `mock` and not-implemented branches ARE offline-testable; the agent-sdk
 * branch is exercised by the human-run live smoke test.
 *
 * M3 SHIPS: `anthropic-agent-sdk` (the dev subscription path) + `mock` (so a
 * config can drive the whole pre-pass offline/dry). The raw-API-key /
 * OpenAI(-compatible) providers throw a clear {@link NotImplementedError}
 * (`anthropic-api` arrives in M5; OpenAI is deferred — §7).
 */

import { AnthropicAgentProvider } from './anthropic-agent-provider';
import { MockProvider } from './mock-provider';
import { NotImplementedError } from '../driver/gate';
import type { LLMProvider } from './types';
import type { LlmMutatorConfig } from '../config';

/**
 * Construct the {@link LLMProvider} the config selects.
 *
 *   • `anthropic-agent-sdk` → {@link AnthropicAgentProvider} (subscription, Node).
 *   • `mock`               → {@link MockProvider} with NO canned responses; a
 *                            caller that actually drives it must pass one in (the
 *                            factory's mock is for a dry, network-free wiring
 *                            check — any real prompt rejects rather than guessing).
 *   • `anthropic-api` / `openai` / `openai-compatible` → {@link NotImplementedError}.
 *
 * @param config The parsed `llmMutator` config (reads `provider` + `model`).
 * @returns The constructed provider.
 * @throws NotImplementedError for a provider not yet implemented in M3.
 */
export function createProvider(config: LlmMutatorConfig): LLMProvider {
    switch (config.provider) {
        case 'anthropic-agent-sdk':
            return new AnthropicAgentProvider({ model: config.model });
        case 'mock':
            return new MockProvider();
        case 'anthropic-api':
        case 'openai':
        case 'openai-compatible':
            throw new NotImplementedError(
                `provider "${config.provider}" is not implemented yet ` +
                    '(M3 ships anthropic-agent-sdk + mock; raw-API-key arrives in M5).',
            );
    }
}
