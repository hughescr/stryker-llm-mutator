/*
 * Public surface of the LLM provider layer.
 *
 * Re-exports the stable contract (`types`) plus the three offline building
 * blocks (mock provider, content-addressed cache, cost accumulator) and the
 * first real provider (Anthropic Agent SDK / subscription). Pipeline stages and
 * the integrator import from here rather than reaching into individual modules.
 * See `docs/development-plan.md` §4.1 / §6.
 */

export type {
    JsonSchema,
    LLMProvider,
    ProviderRequest,
    ProviderResult,
    ProviderUsage,
} from './types';

// NOTE: `extractResult` is intentionally NOT re-exported from this barrel. It is
// a pure, offline test-seam helper (its signature references the Agent SDK's
// `SDKResultMessage`); the provider's own unit tests import it DIRECTLY from
// `./anthropic-agent-provider`, so a barrel re-export would just be dead code.
export {
    AgentProviderError,
    AnthropicAgentProvider,
    resolveAuthEnv,
    type AnthropicAgentProviderOptions,
} from './anthropic-agent-provider';

export { MockProvider, type MockProviderOptions, type MockResponder } from './mock-provider';

export { computeCacheKey, ResponseCache, type CacheEntry, type CacheKeyParts } from './cache';

export { CostAccumulator, type CostSnapshot } from './cost';
