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
 * The {@link OpenAiCompatibleProvider} it ALSO imports is, by contrast, pure
 * native-`fetch` with NO node-only dependency (the live network call hides behind
 * an injectable `fetchImpl`), so the `mock`, `openai`, and `openai-compatible`
 * branches are all offline-testable; only the agent-sdk branch needs the
 * human-run live smoke test.
 *
 * SHIPS: `anthropic-agent-sdk` (the dev subscription path), `mock` (so a config
 * can drive the whole pre-pass offline/dry), and the OpenAI-compatible Chat
 * Completions path under BOTH `openai` (real OpenAI — keyed, optionally metered)
 * and `openai-compatible` (any local LM Studio / vLLM / llama.cpp server, key-less
 * by default) — ONE {@link OpenAiCompatibleProvider} class with two constructor
 * presets. Only `anthropic-api` (the raw Anthropic API-key path) still throws a
 * clear {@link NotImplementedError} (it arrives in M5).
 */

import { AnthropicAgentProvider } from './anthropic-agent-provider';
import { MockProvider } from './mock-provider';
import { OpenAiCompatibleProvider } from './openai-compatible-provider';
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
 *   • `openai`             → {@link OpenAiCompatibleProvider} keyed with
 *                            `OPENAI_API_KEY` and optionally metered via
 *                            `openAiPricing` (`providerLabel: 'openai'`).
 *   • `openai-compatible`  → {@link OpenAiCompatibleProvider} against
 *                            `openAiBaseUrl`, key-less unless `OPENAI_API_KEY`
 *                            happens to be set (`providerLabel: 'openai-compatible'`).
 *   • `anthropic-api`      → {@link NotImplementedError} (raw API-key path, M5).
 *
 * @param config The parsed `llmMutator` config (reads `provider` + `model` plus
 *   the `openAi*` knobs for the OpenAI-compatible path).
 * @returns The constructed provider.
 * @throws NotImplementedError for `anthropic-api` (not yet implemented).
 */
export function createProvider(config: LlmMutatorConfig): LLMProvider {
    switch (config.provider) {
        case 'anthropic-agent-sdk':
            // Production keeps the SDK's schema-native emit/validate loop so the
            // result is SDK-validated against the caller's exact schema. Extended
            // thinking remains disabled to avoid unnecessary reasoning latency for
            // the mechanical propose task. Isolation + connector-disable are already
            // the provider's defaults (true), so we don't pass them here.
            return new AnthropicAgentProvider({
                model: config.model,
                thinking: { type: 'disabled' },
                outputMode: 'json_schema',
            });
        case 'mock':
            return new MockProvider();
        case 'openai':
            // Real OpenAI: REQUIRES OPENAI_API_KEY (the gate enforces it before we
            // reach the factory) and may be metered via the optional `openAiPricing`
            // config. Native `json_schema` structured output on by default.
            return new OpenAiCompatibleProvider({
                baseUrl: config.openAiBaseUrl,
                model: config.model,
                jsonMode: config.openAiJsonMode,
                apiKey: process.env.OPENAI_API_KEY,
                pricing: config.openAiPricing,
                providerLabel: 'openai',
            });
        case 'openai-compatible':
            // Any local OpenAI-compatible server (LM Studio / vLLM / llama.cpp):
            // KEY-LESS by default, but forward `OPENAI_API_KEY` if one happens to be
            // set. `openAiPricing` is honored when supplied (else every call is $0).
            return new OpenAiCompatibleProvider({
                baseUrl: config.openAiBaseUrl,
                model: config.model,
                jsonMode: config.openAiJsonMode,
                apiKey: process.env.OPENAI_API_KEY ?? undefined,
                pricing: config.openAiPricing,
                providerLabel: 'openai-compatible',
            });
        case 'anthropic-api':
            throw new NotImplementedError(
                `provider "${config.provider}" is not implemented yet ` +
                    '(use anthropic-agent-sdk for the subscription path; the raw ' +
                    'Anthropic API-key path arrives in M5).',
            );
    }
}
