/*
 * Anthropic Agent SDK provider — the FIRST provider (development-plan §4.1, §6).
 *
 * Drives `claude-haiku-4-5` through `@anthropic-ai/claude-agent-sdk`'s `query()`
 * on the Anthropic SUBSCRIPTION path, authenticated with
 * `CLAUDE_CODE_OAUTH_TOKEN`. The Agent SDK is AGENTIC — it may take several
 * internal turns to satisfy the requested JSON schema — so this provider asks
 * for structured output via the SDK's `outputFormat: { type: 'json_schema' }`
 * mode and reads the validated object back from the terminal result's
 * `structured_output`. It re-prompts internally on schema mismatch and surfaces
 * a terminal error if it cannot comply; we translate that into a rejected
 * promise per the {@link LLMProvider} contract.
 *
 * THIS IS THE ONLY FILE THAT MAKES A LIVE NETWORK CALL. It is kept deliberately
 * THIN: the single SDK round-trip is isolated in `#runQuery`, while the
 * auth-env resolution and result extraction are pulled out into pure exported
 * functions ({@link resolveAuthEnv}, {@link extractResult}) so they are
 * unit-testable OFFLINE without ever calling `query()`. The live end-to-end
 * smoke test is run by a human in the main thread (development-plan §5 network
 * note) — background/headless agents cannot clear the network sandbox prompt.
 *
 * AUTH PRECEDENCE (development-plan §7): the SDK reads both `ANTHROPIC_API_KEY`
 * and `CLAUDE_CODE_OAUTH_TOKEN`, and the API key OUTRANKS the OAuth token. For
 * the subscription path we therefore (a) require `CLAUDE_CODE_OAUTH_TOKEN`, and
 * (b) ensure `ANTHROPIC_API_KEY` does NOT shadow it for this call by NOT
 * forwarding it in the per-call `options.env`. The default model and a tool
 * lockdown keep this a pure single-shot generation with no file/tool side
 * effects.
 */

import {
    query,
    type Options,
    type SDKMessage,
    type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { DEFAULT_MODEL } from '../config';
import type { LLMProvider, ProviderRequest, ProviderResult, ProviderUsage } from './types';

/** Provider name as exposed on {@link LLMProvider.name}. */
const PROVIDER_NAME = 'anthropic-agent-sdk';

/**
 * Error thrown when the Agent SDK terminates without producing a schema-valid
 * object (any `SDKResultError` subtype, most importantly
 * `error_max_structured_output_retries`, or a `success` result that carries no
 * `structured_output`). Carries the terminal `subtype` and the accrued
 * `total_cost_usd` so a caller can still account for spend on a failed call.
 */
export class AgentProviderError extends Error {
    /** The terminal SDK result subtype, or a synthetic marker when none applies. */
    readonly subtype: string;
    /** Cost in USD accrued before the terminal failure, for cost accounting. */
    readonly costUsd: number;

    constructor(message: string, subtype: string, costUsd: number) {
        super(message);
        this.name = 'AgentProviderError';
        this.subtype = subtype;
        this.costUsd = costUsd;
    }
}

/** Construction options for {@link AnthropicAgentProvider}. */
export interface AnthropicAgentProviderOptions {
    /**
     * Default model id for calls that do not override it. Defaults to
     * {@link DEFAULT_MODEL} (`claude-haiku-4-5`).
     */
    model?: string;
    /**
     * Subscription OAuth token. When omitted, falls back to
     * `process.env.CLAUDE_CODE_OAUTH_TOKEN`. Injected explicitly here mostly so
     * tests can exercise {@link resolveAuthEnv} without a real environment.
     */
    oauthToken?: string;
    /**
     * The ambient environment to derive auth from. Defaults to
     * `process.env`. Injectable so {@link resolveAuthEnv} is testable with a
     * synthetic env that has/lacks `ANTHROPIC_API_KEY`.
     */
    env?: Record<string, string | undefined>;
    /**
     * Run the Agent SDK HERMETICALLY. DEFAULT TRUE — this is the permanent fix.
     *
     * Each `query()` call spawns a `claude-code` subprocess, and by the SDK's
     * defaults that subprocess loads ALL filesystem settings + every project /
     * user `CLAUDE.md` and connects to every configured MCP server BEFORE it
     * generates — pure per-call startup overhead this provider never needs (it
     * does one pure schema-constrained generation with the side-effecting tools
     * already banned). When `true` we pass `settingSources: []`, `mcpServers:
     * {}`, and `strictMcpConfig: true` so NO settings, NO `CLAUDE.md`, and NO MCP
     * servers load — eliminating that config/MCP startup cost. The
     * structured-output (`outputFormat: json_schema`) path is UNAFFECTED.
     *
     * When `false`, those keys are omitted and the SDK's defaults load all
     * settings + MCP again (the original, slow behavior). This escape hatch
     * exists ONLY for the benchmark/comparison driver (`scripts/bench-isolation.ts`);
     * production never sets it, so isolation is simply on.
     */
    isolate?: boolean;
}

/**
 * Build the per-call `options.env` for the subscription path from an ambient
 * environment and an optional explicit OAuth token.
 *
 * PURE and OFFLINE — the api-key-shadowing guard that this function encodes is
 * the security-critical bit, so it lives here, unit-tested, separate from the
 * network call:
 * - The resolved `CLAUDE_CODE_OAUTH_TOKEN` is whatever the explicit token is,
 *   else the ambient `CLAUDE_CODE_OAUTH_TOKEN`. Missing both is a hard error —
 *   the subscription path cannot authenticate.
 * - `ANTHROPIC_API_KEY` is deliberately OMITTED from the returned env even when
 *   present ambiently, because it OUTRANKS the OAuth token and would silently
 *   divert the call onto the metered API-key path (development-plan §7). The
 *   returned record is the ENTIRE env handed to the SDK for the call, so an
 *   omitted key cannot leak in.
 */
export function resolveAuthEnv(
    env: Record<string, string | undefined> = process.env,
    oauthToken?: string,
): Record<string, string> {
    const token = oauthToken ?? env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) {
        throw new AgentProviderError(
            'AnthropicAgentProvider: subscription path requires CLAUDE_CODE_OAUTH_TOKEN (none found in options or environment).',
            'missing_oauth_token',
            0,
        );
    }

    const result: Record<string, string> = {};
    // Forward the ambient env MINUS any ANTHROPIC_API_KEY, so the API key can
    // never shadow the OAuth token for this call.
    for (const [key, value] of Object.entries(env)) {
        if (key === 'ANTHROPIC_API_KEY') {
            continue;
        }
        if (value !== undefined) {
            result[key] = value;
        }
    }
    result.CLAUDE_CODE_OAUTH_TOKEN = token;
    return result;
}

/**
 * Map an SDK `ModelUsage`-style aggregate (summed across the agentic turns) onto
 * the project's {@link ProviderUsage} shape. Tolerant of partial usage objects
 * so a backend that omits a counter still yields a well-formed (sparser) usage.
 */
function toProviderUsage(usage: SDKResultMessage['usage'] | undefined): ProviderUsage | undefined {
    if (!usage) {
        return undefined;
    }
    const u = usage as Record<string, unknown>;
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
    return {
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheWriteTokens: num(u.cache_creation_input_tokens),
    };
}

/**
 * Pick which served model to report on {@link ProviderResult.model} from the
 * SDK's per-model usage aggregate. An agentic run can report usage under more
 * than one model key (e.g. a sub-agent on a different model), so rather than
 * pick an arbitrary enumeration key we choose the model that did the most work —
 * the one with the largest total token usage (input + output). Ties and absent
 * counters fall back to enumeration order, and an empty/missing aggregate falls
 * back to `fallbackModel`. The single-model Haiku path is unaffected (one key).
 */
export function pickServedModel(
    modelUsage: SDKResultMessage['modelUsage'] | undefined,
    fallbackModel: string,
): string {
    let bestModel: string | undefined;
    let bestTokens = -1;
    for (const [model, usage] of Object.entries(modelUsage ?? {})) {
        const u = usage as Record<string, unknown>;
        const input = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
        const output = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
        const total = input + output;
        if (total > bestTokens) {
            bestTokens = total;
            bestModel = model;
        }
    }
    return bestModel ?? fallbackModel;
}

/**
 * Extract a validated {@link ProviderResult} from the Agent SDK's TERMINAL
 * result message, or throw {@link AgentProviderError}.
 *
 * PURE and OFFLINE so the success / error-subtype / missing-structured-output
 * branches are unit-testable with synthetic `SDKResultMessage` objects, no
 * `query()` required:
 * - `subtype: 'success'` WITH `structured_output` → resolve with that validated
 *   value (the SDK already enforced the schema), plus `total_cost_usd`, model,
 *   raw `result` text, and usage.
 * - `subtype: 'success'` WITHOUT `structured_output` → throw: a success that
 *   produced no structured object violates our contract.
 * - any error subtype (`error_max_structured_output_retries`,
 *   `error_during_execution`, `error_max_turns`, `error_max_budget_usd`) →
 *   throw, preserving the subtype and accrued cost.
 */
export function extractResult<T>(
    result: SDKResultMessage,
    fallbackModel: string,
): ProviderResult<T> {
    if (result.subtype !== 'success') {
        throw new AgentProviderError(
            `AnthropicAgentProvider: Agent SDK terminated with '${result.subtype}'${
                result.errors?.length ? `: ${result.errors.join('; ')}` : ''
            }`,
            result.subtype,
            result.total_cost_usd,
        );
    }

    if (result.structured_output === undefined) {
        throw new AgentProviderError(
            'AnthropicAgentProvider: Agent SDK returned success but no structured_output (schema mode produced no object).',
            'missing_structured_output',
            result.total_cost_usd,
        );
    }

    // The structured_output was produced and validated by the SDK's json_schema
    // output mode against request.schema; T is the caller-supplied view of it.
    const model = pickServedModel(result.modelUsage, fallbackModel);
    return {
        value: result.structured_output as T,
        costUsd: result.total_cost_usd,
        model,
        rawText: result.result,
        usage: toProviderUsage(result.usage),
        cached: false,
    };
}

/**
 * The Anthropic Agent SDK / subscription provider. Implements the single
 * {@link LLMProvider} operation by driving `query()` in JSON-schema output mode
 * and returning the SDK-validated `structured_output`.
 */
export class AnthropicAgentProvider implements LLMProvider {
    readonly name = PROVIDER_NAME;

    readonly #model: string;
    readonly #oauthToken?: string;
    readonly #env: Record<string, string | undefined>;
    readonly #isolate: boolean;

    constructor(options: AnthropicAgentProviderOptions = {}) {
        this.#model = options.model ?? DEFAULT_MODEL;
        this.#oauthToken = options.oauthToken;
        this.#env = options.env ?? process.env;
        this.#isolate = options.isolate ?? true;
    }

    /**
     * Build the `Options` for a single pure-generation `query()` call: the
     * resolved subscription-auth env, the requested model, the caller's schema
     * as `outputFormat`, a small bounded turn budget, and a ban on the
     * side-effecting tools so the agent cannot touch the filesystem or run
     * commands — it can only generate.
     *
     * ISOLATION: when `this.#isolate` is true (the default), we additionally pass
     * `settingSources: []`, `mcpServers: {}`, and `strictMcpConfig: true` so the
     * spawned `claude-code` subprocess runs HERMETIC — it loads NO filesystem
     * settings, NO `CLAUDE.md`, and connects to NO MCP servers — eliminating the
     * per-call config/MCP startup overhead. When false those three keys are
     * omitted and the SDK's defaults load all settings + MCP (the original, slow
     * behavior, kept only for the benchmark). The `outputFormat: json_schema`
     * structured-output path is unaffected either way.
     *
     * Pure (no network) and exposed on the instance only via {@link generate};
     * kept as a method so the env/auth wiring is exercised by the same code path
     * the live call uses.
     */
    #buildOptions(request: ProviderRequest): Options {
        return {
            model: request.model ?? this.#model,
            // Hermetic isolation (default): suppress filesystem settings +
            // CLAUDE.md (settingSources: []) and all MCP servers (mcpServers: {}
            // + strictMcpConfig: true) so no per-call config/MCP startup runs.
            // Omitted entirely when isolation is off (the slow benchmark path).
            ...(this.#isolate ? { settingSources: [], mcpServers: {}, strictMcpConfig: true } : {}),
            // JSON-schema structured-output mode: the SDK asks the model to emit
            // an object matching this schema and re-prompts on mismatch.
            outputFormat: { type: 'json_schema', schema: request.schema },
            // Subscription auth, with ANTHROPIC_API_KEY stripped so it cannot
            // shadow the OAuth token (see resolveAuthEnv).
            env: resolveAuthEnv(this.#env, this.#oauthToken),
            // Pure generation with no file/command side effects: ban the
            // side-effecting tools BY NAME. A blanket ['*'] ban (or an empty
            // allowedTools) also disables the SDK's json_schema structured-output
            // emit path, so the model loops until error_max_turns and NO
            // structured output is ever produced — verified live. Naming the
            // concrete tools blocks side effects while leaving that path intact.
            disallowedTools: [
                'Bash',
                'Write',
                'Edit',
                'MultiEdit',
                'NotebookEdit',
                'WebFetch',
                'WebSearch',
                'Task',
            ],
            // json_schema output mode needs the model's generation turn PLUS the
            // SDK's structured-output emit/validation turn(s) (3 observed live),
            // so maxTurns must leave headroom above 1.
            maxTurns: 6,
            permissionMode: 'dontAsk',
            ...(request.system === undefined ? {} : { systemPrompt: request.system }),
            ...(request.signal === undefined
                ? {}
                : { abortController: toAbortController(request.signal) }),
        } satisfies Options;
    }

    /**
     * Drive the SDK once and return its TERMINAL result message. This is the
     * ONLY place a live network call happens; everything else in this file is
     * pure. Iterates the `Query` async-iterable and keeps the `type: 'result'`
     * message (there is exactly one, last).
     */
    async #runQuery(request: ProviderRequest): Promise<SDKResultMessage> {
        const options = this.#buildOptions(request);
        let terminal: SDKResultMessage | undefined;
        for await (const message of query({
            prompt: request.prompt,
            options,
        }) as AsyncIterable<SDKMessage>) {
            if (message.type === 'result') {
                terminal = message;
            }
        }
        if (!terminal) {
            throw new AgentProviderError(
                'AnthropicAgentProvider: Agent SDK stream ended without a terminal result message.',
                'no_terminal_result',
                0,
            );
        }
        return terminal;
    }

    /**
     * Generate a schema-validated object via the subscription Agent SDK path.
     * Resolves only with a value the SDK already validated against
     * `request.schema`; rejects with {@link AgentProviderError} on any terminal
     * SDK error (notably `error_max_structured_output_retries`), on a missing
     * structured output, on missing auth, or on abort.
     */
    async generate<T>(request: ProviderRequest): Promise<ProviderResult<T>> {
        if (request.signal?.aborted) {
            throw new AgentProviderError(
                'AnthropicAgentProvider.generate: request aborted.',
                'aborted',
                0,
            );
        }
        const terminal = await this.#runQuery(request);
        return extractResult<T>(terminal, request.model ?? this.#model);
    }
}

/**
 * Adapt an {@link AbortSignal} to an `AbortController` for the SDK, which takes
 * a controller rather than a bare signal. Aborting the returned controller's
 * signal mirrors the caller's signal. Pure; no network.
 */
function toAbortController(signal: AbortSignal): AbortController {
    const controller = new AbortController();
    if (signal.aborted) {
        controller.abort(signal.reason);
    } else {
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller;
}
