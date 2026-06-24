/*
 * Shared contract: the LLM provider abstraction.
 *
 * This module defines the ONE high-level operation every pipeline stage codes
 * against — "given a prompt and a JSON schema, return a validated object that
 * conforms to that schema, plus call metadata." It deliberately says nothing
 * about transport, auth, or whether the backend is agentic (the Anthropic Agent
 * SDK, which runs an internal multi-turn tool loop) or a straight one-shot
 * completion (a raw API key, OpenAI, an OpenAI-compatible endpoint). Callers
 * MUST NOT be able to tell which kind of provider they hold — see
 * `docs/development-plan.md` §4.1 and §6.
 *
 * Nothing here imports a sibling implementation module: these are the stable
 * interfaces, not the provider itself. Offline unit tests inject a mock
 * provider that returns canned, schema-valid objects and never touches the
 * network (development-plan §5 network note).
 */

/**
 * A JSON Schema document describing the shape of the structured object a caller
 * wants back. Kept as an opaque, transport-agnostic record so it can be handed
 * verbatim to the Anthropic Agent SDK's JSON-schema output mode, to a raw
 * provider's structured-output param, or to a local validator. The provider is
 * responsible for asking the model to satisfy this schema and for surfacing a
 * terminal error if it cannot.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Token-usage accounting for a single provider call. Mirrors the common
 * input/output token split most providers report; fields are optional because
 * not every backend (or mock) exposes every counter. Cost in USD is reported
 * separately on {@link ProviderResult.costUsd} because it is the figure surfaced
 * in reporting (development-plan §4.4) and an agentic backend's cost is not a
 * simple function of a single request's tokens.
 */
export interface ProviderUsage {
    /** Tokens consumed by the prompt / input context, summed across internal turns if agentic. */
    inputTokens?: number;
    /** Tokens produced by the model as output, summed across internal turns if agentic. */
    outputTokens?: number;
    /** Tokens served from / written to a prompt cache, when the backend reports it. */
    cacheReadTokens?: number;
    /** Tokens written to a prompt cache, when the backend reports it. */
    cacheWriteTokens?: number;
}

/**
 * A single high-level generation request: a prompt plus the JSON schema the
 * response must satisfy. This is the entire caller-facing surface — there is no
 * field that leaks whether the backend is agentic or one-shot.
 */
export interface ProviderRequest {
    /**
     * The fully-rendered prompt to send to the model. Stages build this from
     * function source + targeted span + instructions; the provider treats it as
     * an opaque string.
     */
    prompt: string;
    /**
     * JSON Schema the returned object MUST conform to. The provider guarantees
     * that {@link ProviderResult.value} validates against this schema or it
     * rejects with a terminal error.
     */
    schema: JsonSchema;
    /**
     * Optional per-call system prompt / instructions, separate from the user
     * prompt. Providers that have no notion of a system prompt fold it into the
     * prompt. Optional so the common case stays a bare prompt+schema.
     */
    system?: string;
    /**
     * Optional model override for this single call. When omitted, the provider
     * uses the model it was constructed with (default `claude-haiku-4-5`).
     * Present so a stage can opt a specific call onto a different model without
     * a second provider instance.
     */
    model?: string;
    /**
     * Optional content-addressed cache key hint. When supplied, a caching
     * provider MAY use it as the cache identity instead of hashing the request
     * itself; when omitted the provider derives its own key. Lets the pipeline
     * align the cache with its deterministic span/mutant identity
     * (development-plan §7 reproducibility).
     */
    cacheKey?: string;
    /**
     * Optional cooperative cancellation signal. Providers SHOULD abort in-flight
     * work when this fires. Optional so callers that do not need cancellation
     * pass nothing.
     */
    signal?: AbortSignal;
}

/**
 * The validated result of a {@link ProviderRequest}, carrying the typed object
 * alongside the minimal call metadata reporting needs: cost in USD and the
 * model that actually served the call. `T` is the caller-supplied result type;
 * the provider has already validated `value` against the request schema, so
 * callers receive a ready-to-use, typed object.
 *
 * This is the canonical metadata envelope referenced throughout the codebase as
 * `ProviderResult<T>` (development-plan §4.1 / §4.4).
 */
export interface ProviderResult<T> {
    /** The schema-validated object the caller asked for, typed as `T`. */
    value: T;
    /**
     * Total cost of producing this result in US dollars, summed across all
     * internal turns for an agentic backend (the Agent SDK's `total_cost_usd`).
     * Surfaced per-run in reporting. `0` is a legitimate value for a mock or a
     * cache hit.
     */
    costUsd: number;
    /** The model id that actually served the call (e.g. `claude-haiku-4-5`). */
    model: string;
    /**
     * The raw text the model returned before schema parsing, when the backend
     * exposes it. Useful for logging / debugging a validation failure; optional
     * because some backends only surface the already-structured object.
     */
    rawText?: string;
    /** Token-usage accounting for the call, when the backend reports it. */
    usage?: ProviderUsage;
    /** True when this result was served from cache rather than a fresh model call. */
    cached?: boolean;
}

/**
 * The single abstraction every pipeline stage codes against. One core method:
 * prompt + schema in, validated typed object + metadata out. Implementations may
 * be agentic/multi-turn (Anthropic Agent SDK) or one-shot (API key / OpenAI /
 * OpenAI-compatible) — callers never branch on which.
 */
export interface LLMProvider {
    /**
     * A short, stable identifier for this provider implementation (e.g.
     * `anthropic-agent-sdk`, `anthropic-api`, `mock`). Used in logs and to
     * distinguish providers; NOT the model id (that is {@link ProviderResult.model}).
     */
    readonly name: string;
    /**
     * Generate a structured object that conforms to `request.schema`.
     *
     * Resolves with a {@link ProviderResult} whose `value` has ALREADY been
     * validated against the schema (typed as `T`). Rejects with an `Error` if
     * the backend cannot produce a schema-valid object (the agentic backend
     * re-prompts internally first and only then surfaces a terminal error), if
     * the call is aborted, or on transport/auth failure. Implementations MUST
     * NOT resolve with an unvalidated `value`.
     *
     * `T` is supplied by the caller and is not checked against `request.schema`
     * at compile time — keep them in sync (the schema is the runtime authority).
     */
    generate<T>(request: ProviderRequest): Promise<ProviderResult<T>>;
}
