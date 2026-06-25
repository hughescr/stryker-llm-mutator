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
    type EffortLevel,
    query,
    type Options,
    type SDKMessage,
    type SDKResultMessage,
    type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';

import { DEFAULT_MODEL } from '../config';
import type {
    JsonSchema,
    LLMProvider,
    ProviderRequest,
    ProviderResult,
    ProviderUsage,
} from './types';

/** Provider name as exposed on {@link LLMProvider.name}. */
const PROVIDER_NAME = 'anthropic-agent-sdk';

/**
 * The two output modes {@link AnthropicAgentProvider} can drive `query()` in.
 *
 * - `'json_schema'` (the DEFAULT) uses the SDK's structured-output mode: it sets
 *   `outputFormat: { type: 'json_schema', schema }`, the SDK asks the model to
 *   emit an object, re-prompts on schema mismatch over several internal turns
 *   (`maxTurns: 6`), and the validated object is read back from the terminal
 *   result's `structured_output`. SDK-validated, multi-turn, robust — but the
 *   generate → emit → validate loop is the latency cost the benchmark probes.
 * - `'prompt'` OMITS `outputFormat` entirely: it appends a directive to the user
 *   prompt asking the model to emit raw JSON conforming to the schema, runs a
 *   SMALL turn budget (one generation turn + headroom), then parses the terminal
 *   `result` TEXT and validates it LOCALLY (see {@link extractJsonObject} and
 *   {@link validateAgainstSchema}). Single-turn, faster, on the SAME subscription
 *   path — at the cost of doing the parse/validate ourselves and retrying once.
 */
export type AnthropicAgentOutputMode = 'json_schema' | 'prompt';

/** Turn budget for the `'json_schema'` path (generation + SDK emit/validate). */
const JSON_SCHEMA_MAX_TURNS = 6;

/**
 * Turn budget for the `'prompt'` path: one generation turn plus a little
 * headroom. There is NO SDK emit/validate loop in this mode (we parse + validate
 * locally), so this is intentionally far below {@link JSON_SCHEMA_MAX_TURNS}.
 */
const PROMPT_MODE_MAX_TURNS = 2;

/**
 * Error thrown when the Agent SDK terminates without producing a schema-valid
 * object (any `SDKResultError` subtype, most importantly
 * `error_max_structured_output_retries`, or a `success` result that carries no
 * `structured_output`). Carries the terminal `subtype` and the accrued
 * `total_cost_usd` so a caller can still account for spend on a failed call.
 *
 * In the `'prompt'` output mode the `subtype` is the synthetic marker
 * `prompt_parse_failed` when, after one retry, the model's raw text still could
 * not be parsed + validated into a schema-conforming object.
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
    /**
     * Suppress claude.ai cloud connectors. DEFAULT TRUE — part of the hermetic fix.
     *
     * claude.ai cloud connectors (the user's Notion / Strava / Safari / etc.
     * connectors) are auto-fetched and connected by the spawned `claude-code`
     * subprocess by DEFAULT, and they are NOT covered by the isolation keys above:
     * `strictMcpConfig` + `mcpServers: {}` only gate explicitly-configured MCP
     * servers, and `settingSources: []` actually makes this WORSE — the SDK reads
     * the gating flag (`Settings.disableClaudeAiConnectors`) FROM settings sources,
     * so emptying them defaults connectors back ON. Each connector is an external
     * handshake the provider never needs for a pure schema-constrained generation,
     * and a suspected source of variable per-call latency.
     *
     * When `true` (and isolation is on) we pass
     * `managedSettings: { disableClaudeAiConnectors: true }` — the SDK option that
     * forces the gating flag regardless of settings sources — so the subprocess
     * never auto-fetches or connects them. When `false` the `managedSettings` key
     * is omitted and the SDK's default (connectors auto-fetch) stands; this escape
     * hatch exists ONLY for the connector benchmark (`scripts/bench-connectors.ts`),
     * production never sets it. Has no effect when `isolate` is `false` (all
     * settings load anyway, so a forced managed override is meaningless).
     */
    disableClaudeAiConnectors?: boolean;
    /**
     * How the provider asks for + reads back the structured object. DEFAULT
     * `'json_schema'` so existing behavior is UNCHANGED.
     *
     * - `'json_schema'` — the SDK's structured-output mode: `outputFormat` is set,
     *   the SDK runs its multi-turn generate → emit → validate loop, and the
     *   SDK-validated object is read from `result.structured_output`. Robust but
     *   pays the multi-turn latency the benchmark targets.
     * - `'prompt'` — OMIT `outputFormat`, append a "emit raw JSON conforming to
     *   this schema" directive to the prompt, run a small turn budget, then PARSE
     *   the terminal text and VALIDATE it locally in a single turn — faster and
     *   fewer turns, on the same subscription path. See
     *   {@link AnthropicAgentOutputMode}.
     *
     * This is a provider-internal toggle the benchmark exercises; the factory
     * still constructs the provider in the `'json_schema'` default for now.
     */
    outputMode?: AnthropicAgentOutputMode;
    /**
     * Reasoning EFFORT level forwarded to the SDK's `query()` as `effort`. Tunes
     * how much thinking/reasoning the model applies: `'low'` is minimal thinking /
     * fastest, up through `'high'` (the SDK default) / `'xhigh'` / `'max'`. Lowering
     * it trades reasoning depth for latency — appropriate for the MECHANICAL propose
     * task, which does not need deep reasoning.
     *
     * UNSET (the default) does NOT forward `effort` at all, so the SDK's own default
     * (`'high'` — "Deep reasoning") stands and production behavior is unchanged. This
     * is a pass-through knob the benchmark exercises; the factory leaves it unset.
     */
    effort?: EffortLevel;
    /**
     * Extended-THINKING configuration forwarded to the SDK's `query()` as `thinking`.
     * `{ type: 'disabled' }` turns off extended thinking entirely; `{ type: 'adaptive' }`
     * lets the model decide (the SDK default), and `{ type: 'enabled', budgetTokens }`
     * pins a budget. Disabling it trades reasoning for latency — appropriate for the
     * MECHANICAL propose task.
     *
     * UNSET (the default) does NOT forward `thinking` at all, so the SDK's own default
     * (adaptive thinking) stands and production behavior is unchanged. This is a
     * pass-through knob the benchmark exercises; the factory leaves it unset.
     */
    thinking?: ThinkingConfig;
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
 * The directive appended to the user prompt in `'prompt'` output mode, ahead of
 * the stringified schema. Tells the model to emit ONLY a single raw JSON object
 * (no prose, no markdown fences) so {@link extractJsonObject} can parse it.
 */
const PROMPT_MODE_DIRECTIVE =
    'Output ONLY a single raw JSON object conforming to this JSON Schema — no prose, no explanation, no markdown code fences:';

/**
 * Build the `'prompt'`-mode user prompt: the caller's `basePrompt`, then the
 * raw-JSON directive, then the stringified `schema`. PURE and OFFLINE so the
 * exact wording is unit-testable without `query()`. The system prompt is left
 * untouched (the caller's `request.system` still rides as `systemPrompt`).
 */
export function buildPromptModePrompt(basePrompt: string, schema: JsonSchema): string {
    return `${basePrompt}\n\n${PROMPT_MODE_DIRECTIVE}\n${JSON.stringify(schema)}`;
}

/** Opening/closing markdown code-fence pattern stripped before JSON extraction. */
const FENCE_OPEN = /^\s*```(?:json)?\s*\n?/i;
const FENCE_CLOSE = /\n?\s*```\s*$/i;

/**
 * Extract the first balanced top-level JSON OBJECT from arbitrary model text and
 * `JSON.parse` it. PURE and OFFLINE so the fenced / unfenced / prose-wrapped /
 * malformed cases are unit-testable without `query()`:
 * - strips a leading ```json / ``` fence and its trailing ``` when present;
 * - scans for the first `{`, then walks forward tracking brace depth (ignoring
 *   braces inside JSON strings, honoring `\`-escapes) to find the MATCHING `}`;
 * - `JSON.parse`s exactly that `{...}` slice.
 *
 * Throws {@link AgentProviderError} (`prompt_parse_failed`) when there is no
 * balanced object or the slice does not parse — the `'prompt'` path treats that
 * as a parse failure and retries / surfaces it.
 */
export function extractJsonObject(text: string): unknown {
    const unfenced = text.replace(FENCE_OPEN, '').replace(FENCE_CLOSE, '');
    const start = unfenced.indexOf('{');
    if (start === -1) {
        throw new AgentProviderError(
            'AnthropicAgentProvider: prompt-mode output contained no JSON object.',
            'prompt_parse_failed',
            0,
        );
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < unfenced.length; i++) {
        const ch = unfenced[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            if (inString) {
                escaped = true;
            }
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (ch === '{') {
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }

    if (end === -1) {
        throw new AgentProviderError(
            'AnthropicAgentProvider: prompt-mode output had no balanced top-level JSON object.',
            'prompt_parse_failed',
            0,
        );
    }

    const slice = unfenced.slice(start, end + 1);
    try {
        return JSON.parse(slice);
    } catch (error) {
        throw new AgentProviderError(
            `AnthropicAgentProvider: prompt-mode JSON did not parse: ${
                error instanceof Error ? error.message : String(error)
            }`,
            'prompt_parse_failed',
            0,
        );
    }
}

/** A schema fragment as our small validator reads it (object/array/string shapes). */
interface SchemaShape {
    type?: unknown;
    required?: unknown;
    properties?: Record<string, SchemaShape>;
    items?: SchemaShape;
}

/** True when `value` is a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when every name in `required` is a present key on the object `value`. */
function hasRequiredKeys(value: Record<string, unknown>, required: unknown): boolean {
    if (!Array.isArray(required)) {
        return true;
    }
    return required.every(key => typeof key === 'string' && key in value);
}

/**
 * Validate that one ARRAY ITEM conforms to its `items` sub-schema: it must be an
 * object that carries every `required` string key (and where that key's declared
 * type is `'string'`, the value must actually be a string). Deliberately shallow
 * — enough for our propose-style item shape, schema-driven rather than hardcoded.
 */
function itemConforms(item: unknown, itemSchema: SchemaShape | undefined): boolean {
    if (itemSchema === undefined || itemSchema.type !== 'object') {
        return true;
    }
    if (!isPlainObject(item)) {
        return false;
    }
    if (!hasRequiredKeys(item, itemSchema.required)) {
        return false;
    }
    const props = itemSchema.properties;
    if (props === undefined || !Array.isArray(itemSchema.required)) {
        return true;
    }
    for (const key of itemSchema.required) {
        if (typeof key !== 'string') {
            continue;
        }
        if (props[key]?.type === 'string' && typeof item[key] !== 'string') {
            return false;
        }
    }
    return true;
}

/**
 * Validate (and lightly REPAIR) a parsed prompt-mode value against `schema` with
 * a SMALL generic validator sufficient for our schema shape: a top-level object
 * with `required` keys + `properties`, where an array property's `items` is an
 * object with `required` (string) fields. PURE and OFFLINE so the valid /
 * missing-required-key / array-item-filtering cases are unit-testable.
 *
 * Behavior:
 * - the TOP-LEVEL value must be an object carrying every top-level `required`
 *   key; an array-typed required property must actually be an array. If either
 *   fails this is a hard FAILURE (returns `undefined`) — the `'prompt'` path
 *   treats it like a parse failure and retries / surfaces it.
 * - within a required ARRAY property, items that fail their `items` sub-schema
 *   are DROPPED (filtered out) rather than failing the whole value, mirroring the
 *   downstream tolerance for a few malformed candidates.
 *
 * @returns the validated (and item-filtered) value, or `undefined` if the
 *   top-level value is invalid.
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema): unknown {
    const shape = schema as SchemaShape;
    if (shape.type !== 'object') {
        // No object contract to enforce: accept any successfully-parsed value.
        return value;
    }
    if (!isPlainObject(value) || !hasRequiredKeys(value, shape.required)) {
        return undefined;
    }

    const props = shape.properties;
    if (props === undefined) {
        return value;
    }

    const out: Record<string, unknown> = { ...value };
    const required = Array.isArray(shape.required) ? shape.required : [];
    for (const [key, propSchema] of Object.entries(props)) {
        if (propSchema.type !== 'array') {
            continue;
        }
        if (Array.isArray(out[key])) {
            // Drop array items that fail their `items` sub-schema; keep the rest.
            out[key] = (out[key] as unknown[]).filter(item => itemConforms(item, propSchema.items));
        } else if (required.includes(key)) {
            // A required array property that is missing or not an array is a hard
            // failure (treated as a parse failure by the prompt path); a
            // non-required malformed array property is left untouched.
            return undefined;
        }
    }
    return out;
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
    readonly #disableClaudeAiConnectors: boolean;
    readonly #outputMode: AnthropicAgentOutputMode;
    readonly #effort?: EffortLevel;
    readonly #thinking?: ThinkingConfig;

    constructor(options: AnthropicAgentProviderOptions = {}) {
        this.#model = options.model ?? DEFAULT_MODEL;
        this.#oauthToken = options.oauthToken;
        this.#env = options.env ?? process.env;
        this.#isolate = options.isolate ?? true;
        this.#disableClaudeAiConnectors = options.disableClaudeAiConnectors ?? true;
        this.#outputMode = options.outputMode ?? 'json_schema';
        // No defaulting: keep these possibly-undefined so an unset option forwards
        // NOTHING and the SDK's own defaults (effort 'high' + adaptive thinking)
        // stand — production behavior is unchanged until a benchmark picks a winner.
        this.#effort = options.effort;
        this.#thinking = options.thinking;
    }

    /**
     * Build the keys COMMON to both output modes for a single pure-generation
     * `query()` call: the resolved subscription-auth env, the requested model,
     * the isolation keys, the ban on side-effecting tools, the permission mode,
     * and the optional system prompt + abort controller. The mode-specific keys
     * (`outputFormat` + `maxTurns`) are layered on by {@link #buildOptions}.
     *
     * ISOLATION: when `this.#isolate` is true (the default), we additionally pass
     * `settingSources: []`, `mcpServers: {}`, and `strictMcpConfig: true` so the
     * spawned `claude-code` subprocess runs HERMETIC — it loads NO filesystem
     * settings, NO `CLAUDE.md`, and connects to NO MCP servers — eliminating the
     * per-call config/MCP startup overhead. When `this.#disableClaudeAiConnectors`
     * is also true (the default) we add `managedSettings: { disableClaudeAiConnectors:
     * true }` to that same isolation block, so the subprocess also never auto-fetches
     * or connects the user's claude.ai cloud connectors — those are NOT covered by
     * `strictMcpConfig`/`settingSources: []` (emptying settings sources actually
     * defaults the gating flag back ON), and a forced `managedSettings` override is
     * the only way to suppress them. When isolation is false ALL these keys are
     * omitted and the SDK's defaults load every setting + MCP + connector (the
     * original, slow behavior, kept only for the benchmark). Output mode is
     * unaffected by it.
     *
     * Pure (no network).
     */
    #buildCommonOptions(request: ProviderRequest): Options {
        return {
            model: request.model ?? this.#model,
            // Hermetic isolation (default): suppress filesystem settings +
            // CLAUDE.md (settingSources: []) and all MCP servers (mcpServers: {}
            // + strictMcpConfig: true) so no per-call config/MCP startup runs, and
            // — when #disableClaudeAiConnectors is set (default) — force
            // managedSettings.disableClaudeAiConnectors so the subprocess skips the
            // claude.ai cloud connector auto-fetch that settingSources/strictMcpConfig
            // do NOT cover. The whole block is omitted when isolation is off (the
            // slow benchmark path); managedSettings is meaningless once all settings
            // load anyway, hence its nesting here rather than at the top level.
            ...(this.#isolate
                ? {
                      settingSources: [],
                      mcpServers: {},
                      strictMcpConfig: true,
                      ...(this.#disableClaudeAiConnectors
                          ? { managedSettings: { disableClaudeAiConnectors: true } }
                          : {}),
                  }
                : {}),
            // Reasoning-depth knobs (pass-through): forward `effort` / `thinking`
            // to the SDK ONLY when explicitly set, so an unset option leaves the
            // SDK's own defaults (effort 'high' + adaptive thinking) untouched and
            // production behavior is unchanged. Lowering effort / disabling thinking
            // trades reasoning for latency on the mechanical propose task.
            ...(this.#effort === undefined ? {} : { effort: this.#effort }),
            ...(this.#thinking === undefined ? {} : { thinking: this.#thinking }),
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
            permissionMode: 'dontAsk',
            ...(request.system === undefined ? {} : { systemPrompt: request.system }),
            ...(request.signal === undefined
                ? {}
                : { abortController: toAbortController(request.signal) }),
        } satisfies Options;
    }

    /**
     * Build the `Options` for the `'json_schema'` path: the common keys plus the
     * caller's schema as `outputFormat` and the multi-turn budget the SDK's
     * structured-output emit/validation loop needs.
     *
     * Exposed on the instance only via {@link generate}; kept as a method so the
     * env/auth wiring is exercised by the same code path the live call uses.
     */
    #buildOptions(request: ProviderRequest): Options {
        return {
            ...this.#buildCommonOptions(request),
            // JSON-schema structured-output mode: the SDK asks the model to emit
            // an object matching this schema and re-prompts on mismatch.
            outputFormat: { type: 'json_schema', schema: request.schema },
            // json_schema output mode needs the model's generation turn PLUS the
            // SDK's structured-output emit/validation turn(s) (3 observed live),
            // so maxTurns must leave headroom above 1.
            maxTurns: JSON_SCHEMA_MAX_TURNS,
        } satisfies Options;
    }

    /**
     * Build the `Options` for the `'prompt'` path: the common keys with NO
     * `outputFormat` (we ask for raw JSON in the prompt and parse it ourselves)
     * and a SMALL turn budget — one generation turn plus headroom, since there is
     * no SDK emit/validate loop to leave room for.
     *
     * Pure (no network).
     */
    #buildPromptOptions(request: ProviderRequest): Options {
        return {
            ...this.#buildCommonOptions(request),
            maxTurns: PROMPT_MODE_MAX_TURNS,
        } satisfies Options;
    }

    /**
     * Drive the SDK once for the given `prompt` + `options` and return its
     * TERMINAL result message. This is the ONLY place a live network call
     * happens; everything else in this file is pure. Iterates the `Query`
     * async-iterable and keeps the `type: 'result'` message (there is exactly
     * one, last). Shared by both output modes — only the prompt/options differ.
     */
    async #runQuery(prompt: string, options: Options): Promise<SDKResultMessage> {
        let terminal: SDKResultMessage | undefined;
        for await (const message of query({
            prompt,
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
     * Branches on the constructed `outputMode`:
     * - `'json_schema'` (default): drives the SDK's structured-output mode and
     *   returns the SDK-validated `structured_output` (multi-turn, robust).
     * - `'prompt'`: asks for raw JSON in the prompt, then parses + validates the
     *   terminal text locally in one turn (faster, fewer turns).
     *
     * Either way it resolves only with a value validated against `request.schema`
     * and rejects with {@link AgentProviderError} on a terminal SDK error, a
     * parse/validate failure (`prompt_parse_failed`, prompt mode), missing
     * structured output (json_schema mode), missing auth, or abort.
     */
    async generate<T>(request: ProviderRequest): Promise<ProviderResult<T>> {
        if (request.signal?.aborted) {
            throw new AgentProviderError(
                'AnthropicAgentProvider.generate: request aborted.',
                'aborted',
                0,
            );
        }
        if (this.#outputMode === 'prompt') {
            return this.#generatePromptMode<T>(request);
        }
        const terminal = await this.#runQuery(request.prompt, this.#buildOptions(request));
        return extractResult<T>(terminal, request.model ?? this.#model);
    }

    /**
     * The `'prompt'`-mode generation path: build the augmented raw-JSON prompt,
     * drive ONE `query()` (no `outputFormat`, small turn budget), then take the
     * terminal `result` TEXT and {@link extractJsonObject} +
     * {@link validateAgainstSchema} it locally. On an extract/validate failure it
     * RETRIES the whole query ONCE; on a second failure it throws
     * {@link AgentProviderError} (`prompt_parse_failed`) with the cost accrued
     * across BOTH attempts. Cost is summed across attempts either way.
     */
    async #generatePromptMode<T>(request: ProviderRequest): Promise<ProviderResult<T>> {
        const fallbackModel = request.model ?? this.#model;
        const prompt = buildPromptModePrompt(request.prompt, request.schema);
        const options = this.#buildPromptOptions(request);

        let accruedCost = 0;
        let lastError: AgentProviderError | undefined;
        // One initial attempt + one retry on parse/validate failure.
        for (let attempt = 0; attempt < 2; attempt++) {
            // eslint-disable-next-line no-await-in-loop -- sequential by design: the retry must wait for the first attempt's terminal result.
            const terminal = await this.#runQuery(prompt, options);
            if (terminal.subtype !== 'success') {
                // A terminal SDK error mirrors the json_schema path's contract.
                throw new AgentProviderError(
                    `AnthropicAgentProvider: Agent SDK terminated with '${terminal.subtype}'${
                        terminal.errors?.length ? `: ${terminal.errors.join('; ')}` : ''
                    }`,
                    terminal.subtype,
                    accruedCost + terminal.total_cost_usd,
                );
            }
            accruedCost += terminal.total_cost_usd;

            const text = terminal.result;
            try {
                const parsed = extractJsonObject(text);
                const validated = validateAgainstSchema(parsed, request.schema);
                if (validated === undefined) {
                    throw new AgentProviderError(
                        'AnthropicAgentProvider: prompt-mode output failed schema validation.',
                        'prompt_parse_failed',
                        accruedCost,
                    );
                }
                return {
                    value: validated as T,
                    costUsd: accruedCost,
                    model: pickServedModel(terminal.modelUsage, fallbackModel),
                    rawText: text,
                    usage: toProviderUsage(terminal.usage),
                    cached: false,
                };
            } catch (error) {
                if (!(error instanceof AgentProviderError)) {
                    throw error;
                }
                lastError = error;
                // Fall through to retry (attempt 0) or surface below (attempt 1).
            }
        }

        throw new AgentProviderError(
            `AnthropicAgentProvider: prompt-mode failed to produce a valid object after a retry${
                lastError ? `: ${lastError.message}` : ''
            }`,
            'prompt_parse_failed',
            accruedCost,
        );
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
