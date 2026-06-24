/*
 * Switch GATING + credential fail-fast + the Phase-A dynamic-LLM throw-stub
 * (functional-architecture §6 switch interplay / §3.5 dynamicLLM stub).
 *
 * ALL PURE — no Stryker import, no network — so the driver's decision logic is
 * unit-testable under `bun test` separately from the side-effecting
 * `new Stryker().runMutationTest()` call.
 *
 * `gateSwitches(cfg)` collapses the two switches (`heuristics.enabled`,
 * `dynamicLLM.enabled`) into a small PLAN the driver acts on, covering the four
 * §6 cases:
 *   • BOTH OFF        → warn (no custom mutators); the driver runs STOCK Stryker
 *                       (never clears built-ins to empty — that would mutate
 *                       nothing). `runHeuristics=false`, `runDynamicLLM=false`.
 *   • heuristics-only → inject the heuristic selection (the M1 DEFAULT path; no
 *                       credentials/network). `runHeuristics=true`.
 *   • dynamicLLM on   → ADDITIVE with heuristics; requires a credential check
 *                       BEFORE any Stryker work and (Phase A) the LLM generation
 *                       is a throw-stub. `runDynamicLLM=true`.
 *   • BOTH ON         → additive: both sets go in together, tagged distinctly.
 *
 * The credential check (`assertLlmCredentials`) is REAL and wired now; the LLM
 * GENERATION is stubbed-as-throw (`buildLlmMutator`) so enabling the switch in
 * Phase A fails loudly and predictably (a single named slot for M3 to fill)
 * rather than appearing to work.
 */

import { resolveAuthEnv } from '../llm/index';
import type { LlmMutatorConfig } from '../config';

/**
 * Error thrown when a feature is enabled in config but not yet implemented in the
 * current milestone. Distinct class so callers (and tests) can match it precisely
 * rather than scraping a message.
 */
export class NotImplementedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NotImplementedError';
    }
}

/**
 * Error thrown when dynamicLLM is enabled with a network provider but the required
 * credentials are absent. Carries the offending provider for a precise message.
 */
export class MissingCredentialsError extends Error {
    /** The provider whose credentials were not found. */
    readonly provider: string;
    constructor(message: string, provider: string) {
        super(message);
        this.name = 'MissingCredentialsError';
        this.provider = provider;
    }
}

/**
 * The gating plan {@link gateSwitches} returns — a pure description of what the
 * driver should do, independent of injection mode (`--ours-only`/`--augment`).
 */
export interface GatePlan {
    /** Inject the heuristic selection (true unless heuristics are disabled). */
    runHeuristics: boolean;
    /** Run the dynamic-LLM pre-pass + inject the `LLMMutator` (Phase A: throws). */
    runDynamicLLM: boolean;
    /**
     * Both switches are off: no custom mutators will be injected and the driver
     * should run STOCK Stryker unmodified. The driver MUST surface {@link warning}.
     */
    bothOff: boolean;
    /**
     * A user-facing warning to emit, or `undefined` when none applies. Set when
     * both switches are off (the user gets vanilla behaviour and must be told).
     */
    warning?: string;
}

/**
 * Collapse the two config switches into a {@link GatePlan}. PURE — it makes NO
 * credential check and NO injection; it only describes the decision. The driver
 * calls {@link assertLlmCredentials} and {@link buildLlmMutator} separately when
 * `runDynamicLLM` is true.
 */
export function gateSwitches(cfg: LlmMutatorConfig): GatePlan {
    const runHeuristics = cfg.heuristics.enabled;
    const runDynamicLLM = cfg.dynamicLLM.enabled;
    const bothOff = !runHeuristics && !runDynamicLLM;

    return {
        runHeuristics,
        runDynamicLLM,
        bothOff,
        ...(bothOff
            ? {
                  warning:
                      'Both heuristics and dynamicLLM are disabled: no custom mutators will be ' +
                      'injected; running STOCK Stryker (built-in mutators only).',
              }
            : {}),
    };
}

/**
 * The set of provider names that require network credentials. The offline `mock`
 * provider is intentionally absent — it needs nothing, so dynamicLLM with `mock`
 * skips the credential check entirely.
 */
const NETWORK_PROVIDERS = new Set<LlmMutatorConfig['provider']>([
    'anthropic-agent-sdk',
    'anthropic-api',
    'openai',
    'openai-compatible',
]);

/**
 * Fail FAST if dynamicLLM is enabled with a network provider whose credentials
 * are missing (functional-architecture §6 switch interplay). PURE except that it
 * reads the ambient environment (injectable for tests). Does NOT silently degrade
 * to heuristics-only — it throws {@link MissingCredentialsError} so the CLI can
 * print a clear error and exit non-zero.
 *
 *   • `anthropic-agent-sdk` → reuse {@link resolveAuthEnv}, which throws when
 *     `CLAUDE_CODE_OAUTH_TOKEN` is absent. We translate its
 *     `AgentProviderError('missing_oauth_token')` into a uniform
 *     {@link MissingCredentialsError}.
 *   • `anthropic-api` → require `ANTHROPIC_API_KEY`.
 *   • `openai` / `openai-compatible` → require `OPENAI_API_KEY`.
 *   • `mock` (or dynamicLLM disabled) → no-op.
 *
 * @param cfg The parsed config.
 * @param env The ambient environment (defaults to `process.env`); injectable.
 */
export function assertLlmCredentials(
    cfg: LlmMutatorConfig,
    env: Record<string, string | undefined> = process.env,
): void {
    if (!cfg.dynamicLLM.enabled) {
        return;
    }
    const { provider } = cfg;
    if (!NETWORK_PROVIDERS.has(provider)) {
        return; // mock — no credentials needed.
    }

    if (provider === 'anthropic-agent-sdk') {
        try {
            // Throws AgentProviderError('missing_oauth_token') when the token is absent.
            resolveAuthEnv(env);
        } catch {
            throw new MissingCredentialsError(
                'dynamicLLM provider "anthropic-agent-sdk" requires CLAUDE_CODE_OAUTH_TOKEN, ' +
                    'but none was found in the environment.',
                provider,
            );
        }
        return;
    }

    if (provider === 'anthropic-api') {
        if (!env.ANTHROPIC_API_KEY) {
            throw new MissingCredentialsError(
                'dynamicLLM provider "anthropic-api" requires ANTHROPIC_API_KEY, but none was ' +
                    'found in the environment.',
                provider,
            );
        }
        return;
    }

    // openai / openai-compatible
    if (!env.OPENAI_API_KEY) {
        throw new MissingCredentialsError(
            `dynamicLLM provider "${provider}" requires OPENAI_API_KEY, but none was found in ` +
                'the environment.',
            provider,
        );
    }
}

/**
 * Phase-A dynamic-LLM generation seam. M3 will replace the throw with the real
 * pre-pass: target → batched propose → filters → build a `(fileName,loc)→Node[]`
 * map → return ONE injected `llm/<tag>` `LLMMutator` doing a sync map lookup. In
 * Phase A it ALWAYS throws {@link NotImplementedError} so the dynamicLLM switch is
 * HONEST today — it never silently produces zero mutants and never degrades.
 *
 * The driver calls {@link assertLlmCredentials} BEFORE this, so missing creds
 * surface as a credentials error; if creds are present, this throws the
 * not-implemented error.
 */
export function buildLlmMutator(_cfg: LlmMutatorConfig): never {
    throw new NotImplementedError(
        'dynamicLLM is enabled but the LLM pre-pass + LLMMutator are not implemented yet ' +
            '(arrives in M3). Run with dynamicLLM disabled for heuristics-only.',
    );
}
