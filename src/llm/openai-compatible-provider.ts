/*
 * OpenAI-compatible Chat Completions provider — the ONE-SHOT, dependency-free
 * backend for real OpenAI plus every self-hosted OpenAI-compatible server
 * (LM Studio, vLLM, llama.cpp). Implements the single {@link LLMProvider}
 * operation against the `POST {baseURL}/v1/chat/completions` REST endpoint using
 * hand-rolled native `fetch` — NO `openai` SDK, NO new runtime dependency.
 *
 * ONE class serves BOTH config provider names (`openai` and `openai-compatible`)
 * with different constructor defaults: the real-OpenAI variant is given an API
 * key and (optionally) metered pricing; the local variant runs KEY-LESS but still
 * forwards `Authorization: Bearer <key>` if a key happens to be present. Which one
 * a caller holds is invisible at the {@link LLMProvider} surface — see
 * `src/llm/types.ts`.
 *
 * STRUCTURED OUTPUT is portable-first. By default (`jsonMode: true`) we send the
 * native `response_format: { type: 'json_schema', … , strict: true }` envelope,
 * but `strict` is an OpenAI-only guarantee that local servers do NOT honor, so in
 * BOTH modes we ALWAYS parse + validate the returned text LOCALLY via the shared
 * {@link extractJsonObject} / {@link validateAgainstSchema} helpers, re-request
 * ONCE on a parse/validate miss, and only then throw. The provider NEVER resolves
 * with an unvalidated value (the {@link LLMProvider} contract). When `jsonMode`
 * is `false` we instead embed the schema in the user prompt via
 * {@link buildPromptModePrompt} — the same prompt-mode directive the Anthropic
 * provider uses — for servers that reject the `response_format` envelope.
 *
 * THE SINGLE LIVE NETWORK CALL is isolated in the thin {@link OpenAiCompatibleProvider#post}
 * method (the only impure code here); everything else — URL normalization, request-body
 * assembly, response extraction, usage mapping, cost — is a PURE exported helper
 * that is unit-tested OFFLINE. `fetch` itself is INJECTED (`fetchImpl`), so the
 * tests pass a fake and never open a socket; the live end-to-end smoke check is a
 * human-run script in the main thread (`scripts/smoke-openai-compatible.ts`).
 *
 * This module imports ONLY the stable contract (`./types`) and the shared,
 * provider-agnostic structured-JSON core (`./structured-json`) — nothing
 * node-only, and emphatically NOT the Agent SDK — so it loads under `bun test`
 * and stays trivially offline-testable.
 */

import {
    AgentProviderError,
    buildPromptModePrompt,
    extractJsonObject,
    validateAgainstSchema,
} from './structured-json';
import type { LLMProvider, ProviderRequest, ProviderResult, ProviderUsage } from './types';

/** Default request timeout (ms) for a single Chat Completions round-trip. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Default number of transport retries (429 / 5xx / network error) before giving up. */
const DEFAULT_MAX_RETRIES = 2;
/** Default sampling temperature — `0` for the most reproducible output we can ask for. */
const DEFAULT_TEMPERATURE = 0;
/** Default provider label when none is supplied (the local, key-less variant). */
const DEFAULT_PROVIDER_LABEL = 'openai-compatible';
/** Linear-backoff base (ms): attempt N waits `RETRY_BACKOFF_MS * (N + 1)`. */
const RETRY_BACKOFF_MS = 50;

/**
 * Error thrown on a TERMINAL OpenAI-compatible call failure. Mirrors
 * {@link AgentProviderError}: it carries the failure `subtype` (e.g.
 * `openai_parse_failed`, `openai_bad_response`, `openai_http_500`,
 * `openai_network_error`, `aborted`) and the `costUsd` accrued before the
 * failure, so a caller can still account for spend on a failed call. A local,
 * key-less call simply carries `costUsd: 0`.
 */
export class OpenAiProviderError extends Error {
    /** A short, stable marker for the kind of terminal failure (see class doc). */
    readonly subtype: string;
    /** Cost in USD accrued before the terminal failure, for cost accounting. */
    readonly costUsd: number;

    constructor(message: string, subtype: string, costUsd: number) {
        super(message);
        this.name = 'OpenAiProviderError';
        this.subtype = subtype;
        this.costUsd = costUsd;
    }
}

/** Construction options for {@link OpenAiCompatibleProvider}. */
export interface OpenAiCompatibleProviderOptions {
    /**
     * Base URL of the OpenAI-compatible server. A bare host
     * (`http://10.0.230.76:1234`) or a versioned base
     * (`https://api.openai.com/v1`) are both accepted — see
     * {@link resolveChatCompletionsUrl} for the exact normalization to the
     * `/chat/completions` endpoint.
     */
    baseUrl: string;
    /** Default model id sent in the request body when a call does not override it. */
    model: string;
    /**
     * API key. REQUIRED for real OpenAI (the factory passes
     * `process.env.OPENAI_API_KEY`); OMITTED for a local server. When present it
     * is sent as `Authorization: Bearer <key>`; when absent NO auth header is
     * sent (local servers are typically key-less).
     */
    apiKey?: string;
    /**
     * Native structured-output mode. DEFAULT `true`: send the
     * `response_format: { type: 'json_schema', … }` envelope. `false` falls back
     * to the portable prompt-mode directive (schema embedded in the user prompt).
     * EITHER way the response is still parsed + validated locally.
     */
    jsonMode?: boolean;
    /**
     * Optional metered pricing in dollars per MILLION tokens. When supplied,
     * {@link ProviderResult.costUsd} is computed from the response's token usage;
     * when ABSENT (the default — typical for a local server) every call reports
     * `costUsd: 0`. There is NO built-in price table.
     */
    pricing?: { inputPerMTok: number; outputPerMTok: number };
    /**
     * Which config provider name this instance is serving. Becomes the prefix of
     * {@link LLMProvider.name}. DEFAULT `'openai-compatible'`.
     */
    providerLabel?: 'openai' | 'openai-compatible';
    /**
     * The `fetch` implementation. DEFAULT `globalThis.fetch`. INJECTED so offline
     * tests pass a fake that returns canned `Response`s and never opens a socket.
     */
    fetchImpl?: typeof fetch;
    /** Per-request timeout in milliseconds. DEFAULT {@link DEFAULT_TIMEOUT_MS}. */
    timeoutMs?: number;
    /**
     * Number of TRANSPORT retries (429 / 5xx / network error) before surfacing a
     * terminal error. DEFAULT {@link DEFAULT_MAX_RETRIES}. This is independent of
     * the ONE parse/validate re-request {@link OpenAiCompatibleProvider.generate}
     * performs on a schema miss.
     */
    maxRetries?: number;
    /**
     * Sampling temperature sent in the request body. DEFAULT `0` for the most
     * reproducible output the server will give us.
     */
    temperature?: number;
}

/** True when `value` is a non-null, non-array plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce to a finite number, or `undefined` for anything else. */
function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

/**
 * Normalize a configured base URL to the concrete Chat Completions endpoint.
 * PURE and OFFLINE so every normalization case is unit-testable:
 * - trailing slashes are stripped;
 * - a base with NO path (`http://h:1234` or `http://h:1234/`) gets the default
 *   version + endpoint appended → `…/v1/chat/completions`;
 * - a base that ALREADY ends with `/chat/completions` is returned unchanged
 *   (idempotent), so re-normalizing a resolved URL is a no-op;
 * - otherwise `/chat/completions` is appended to the base AS-IS (the base is
 *   assumed to already carry its own version segment, e.g. `…/v1`).
 *
 * Invariants that MUST hold (and are pinned by tests):
 *   `http://h:1234`                  → `http://h:1234/v1/chat/completions`
 *   `http://h:1234/v1`               → `http://h:1234/v1/chat/completions`
 *   `https://api.openai.com/v1`      → `https://api.openai.com/v1/chat/completions`
 *   `http://h/v1/chat/completions`   → unchanged
 */
export function resolveChatCompletionsUrl(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, '');
    const path = new URL(trimmed).pathname.replace(/\/+$/, '');
    if (path === '' || path === '/') {
        // Bare host with no path → add both the default version segment and endpoint.
        return `${trimmed}/v1/chat/completions`;
    }
    if (path.endsWith('/chat/completions')) {
        // Already a full endpoint → idempotent.
        return trimmed;
    }
    // Versioned base (e.g. `…/v1`) → just append the endpoint.
    return `${trimmed}/chat/completions`;
}

/**
 * Assemble the Chat Completions request body. PURE and OFFLINE so the json-mode
 * vs prompt-mode envelope, the optional system message, and the temperature are
 * unit-testable without a socket.
 *
 * Messages: an optional `{ role: 'system', content: request.system }` when a
 * system prompt is present, then a single `{ role: 'user', … }` whose content is
 * the raw `request.prompt` in json mode, or {@link buildPromptModePrompt}'s
 * schema-embedding directive in prompt mode. In json mode the
 * `response_format: { type: 'json_schema', json_schema: { name, strict, schema } }`
 * envelope is added; in prompt mode it is omitted entirely.
 */
export function buildChatRequestBody(
    request: ProviderRequest,
    opts: { model: string; jsonMode: boolean; temperature: number },
): Record<string, unknown> {
    const messages: { role: string; content: string }[] = [];
    if (request.system !== undefined) {
        messages.push({ role: 'system', content: request.system });
    }
    messages.push({
        role: 'user',
        content: opts.jsonMode
            ? request.prompt
            : buildPromptModePrompt(request.prompt, request.schema),
    });

    return {
        model: opts.model,
        messages,
        temperature: opts.temperature,
        ...(opts.jsonMode
            ? {
                  response_format: {
                      type: 'json_schema',
                      json_schema: { name: 'response', strict: true, schema: request.schema },
                  },
              }
            : {}),
    };
}

/**
 * Pull `choices[0].message.content` (a STRING) out of a parsed Chat Completions
 * response. PURE and OFFLINE. Throws {@link OpenAiProviderError}
 * (`openai_bad_response`) when the content is missing or not a string — a
 * well-formed-looking response that carries no usable text.
 */
export function extractMessageContent(responseJson: unknown): string {
    const root = responseJson as { choices?: { message?: { content?: unknown } }[] };
    const content = root.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
        throw new OpenAiProviderError(
            'OpenAiCompatibleProvider: response had no string choices[0].message.content.',
            'openai_bad_response',
            0,
        );
    }
    return content;
}

/**
 * Map an OpenAI-style `usage` object onto the project's {@link ProviderUsage}
 * shape. PURE, OFFLINE, and TOLERANT of partial usage: `prompt_tokens` →
 * `inputTokens`, `completion_tokens` → `outputTokens`, and the cache counters
 * (`prompt_tokens_details.cached_tokens`, or the Anthropic-style
 * `cache_read_input_tokens` / `cache_creation_input_tokens`) are included ONLY
 * when the server actually reports them. Returns `undefined` when there is no
 * usage object at all.
 */
export function mapUsage(usageJson: unknown): ProviderUsage | undefined {
    if (!isRecord(usageJson)) {
        return undefined;
    }
    const usage: ProviderUsage = {
        inputTokens: asNumber(usageJson.prompt_tokens),
        outputTokens: asNumber(usageJson.completion_tokens),
    };
    const details = isRecord(usageJson.prompt_tokens_details)
        ? usageJson.prompt_tokens_details
        : undefined;
    const cacheRead =
        details === undefined
            ? asNumber(usageJson.cache_read_input_tokens)
            : asNumber(details.cached_tokens);
    const cacheWrite = asNumber(usageJson.cache_creation_input_tokens);
    if (cacheRead !== undefined) {
        usage.cacheReadTokens = cacheRead;
    }
    if (cacheWrite !== undefined) {
        usage.cacheWriteTokens = cacheWrite;
    }
    return usage;
}

/**
 * Compute the dollar cost of a call from token usage and OPTIONAL config-supplied
 * pricing. PURE and OFFLINE. With pricing absent (the default, and the only
 * possibility for a local server) the cost is always `0`. With pricing present
 * the cost is `(inputTokens / 1e6) * inputPerMTok + (outputTokens / 1e6) *
 * outputPerMTok`, treating a missing token count as `0`.
 */
export function computeCostUsd(
    usage: ProviderUsage | undefined,
    pricing?: { inputPerMTok: number; outputPerMTok: number },
): number {
    if (pricing === undefined) {
        return 0;
    }
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    return (
        (inputTokens / 1e6) * pricing.inputPerMTok + (outputTokens / 1e6) * pricing.outputPerMTok
    );
}

/**
 * The OpenAI-compatible one-shot provider. Implements the single
 * {@link LLMProvider} operation by POSTing a Chat Completions request and parsing
 * + validating the returned text locally against the request schema.
 */
export class OpenAiCompatibleProvider implements LLMProvider {
    readonly name: string;

    readonly #url: string;
    readonly #model: string;
    readonly #apiKey?: string;
    readonly #jsonMode: boolean;
    readonly #pricing?: { inputPerMTok: number; outputPerMTok: number };
    readonly #fetchImpl: typeof fetch;
    readonly #timeoutMs: number;
    readonly #maxRetries: number;
    readonly #temperature: number;

    constructor(options: OpenAiCompatibleProviderOptions) {
        this.#url = resolveChatCompletionsUrl(options.baseUrl);
        this.#model = options.model;
        this.#apiKey = options.apiKey;
        this.#jsonMode = options.jsonMode ?? true;
        this.#pricing = options.pricing;
        this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.#temperature = options.temperature ?? DEFAULT_TEMPERATURE;
        const label = options.providerLabel ?? DEFAULT_PROVIDER_LABEL;
        this.name = `${label}(${this.#model})`;
    }

    /**
     * Generate a schema-validated object via the OpenAI-compatible Chat
     * Completions endpoint.
     *
     * Aborts up front if `request.signal` is already aborted. Builds the request
     * body once (json or prompt mode), then runs the SAME parse/validate loop as
     * the Anthropic prompt path: POST, read `choices[0].message.content`,
     * {@link extractJsonObject} + {@link validateAgainstSchema} it; on a
     * parse/validate MISS re-request ONCE (one initial attempt + one retry); on a
     * second miss throw {@link OpenAiProviderError} (`openai_parse_failed`). The
     * provider NEVER resolves with an unvalidated value. Transport-level retries
     * (429 / 5xx / network) happen INSIDE {@link OpenAiCompatibleProvider#post}
     * and are independent of this one parse retry; an HTTP/auth/abort failure
     * propagates straight out.
     */
    async generate<T>(request: ProviderRequest): Promise<ProviderResult<T>> {
        if (request.signal?.aborted) {
            throw new OpenAiProviderError(
                'OpenAiCompatibleProvider.generate: request aborted.',
                'aborted',
                0,
            );
        }

        const fallbackModel = request.model ?? this.#model;
        const body = buildChatRequestBody(request, {
            model: fallbackModel,
            jsonMode: this.#jsonMode,
            temperature: this.#temperature,
        });

        let lastFailure = '';
        // One initial attempt + one retry on a LOCAL parse/validate miss, exactly
        // like the Anthropic prompt-mode loop. (Transport 429/5xx/network retries
        // are handled separately inside #post.)
        for (let attempt = 0; attempt < 2; attempt++) {
            // eslint-disable-next-line no-await-in-loop -- sequential by design: the retry must wait for the first attempt's response.
            const responseJson = await this.#post(body, request.signal);
            const content = extractMessageContent(responseJson);

            let validated: unknown;
            try {
                validated = validateAgainstSchema(extractJsonObject(content), request.schema);
            } catch (error) {
                // extractJsonObject raises AgentProviderError on a parse failure;
                // treat that exactly like a validation miss (retry, then surface).
                // Anything else is a genuine bug and propagates untouched.
                if (!(error instanceof AgentProviderError)) {
                    throw error;
                }
                lastFailure = error.message;
                continue;
            }
            if (validated === undefined) {
                lastFailure = 'output failed schema validation';
                continue;
            }

            const root = responseJson as { model?: unknown; usage?: unknown };
            const usage = mapUsage(root.usage);
            return {
                value: validated as T,
                costUsd: computeCostUsd(usage, this.#pricing),
                model: typeof root.model === 'string' ? root.model : fallbackModel,
                rawText: content,
                usage,
                cached: false,
            };
        }

        throw new OpenAiProviderError(
            `OpenAiCompatibleProvider: failed to produce a schema-valid object after a retry (${lastFailure}).`,
            'openai_parse_failed',
            0,
        );
    }

    /**
     * The SINGLE live network round-trip — the ONLY impure code in this module
     * (everything else is a pure, offline-tested helper). `fetch` is injected, so
     * the offline tests drive this method via a fake; the real socket is exercised
     * only by the human-run smoke script.
     *
     * Combines `request.signal` with `AbortSignal.timeout(timeoutMs)` so the call
     * aborts on either the caller's cancellation OR the per-request deadline, and
     * retries up to `maxRetries` on a 429 / 5xx / network error with a small linear
     * backoff. A caller abort is terminal (never retried). A non-retryable HTTP
     * error (4xx other than 429) throws {@link OpenAiProviderError} with the status
     * and the response body text. Returns the parsed JSON response body on success.
     */
    async #post(body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (this.#apiKey !== undefined) {
            headers.authorization = `Bearer ${this.#apiKey}`;
        }
        const payload = JSON.stringify(body);

        let lastError: OpenAiProviderError | undefined;
        for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
            let response: Response;
            try {
                // eslint-disable-next-line no-await-in-loop -- retries are sequential by nature.
                response = await this.#fetchImpl(this.#url, {
                    method: 'POST',
                    headers,
                    body: payload,
                    signal: combineSignals(signal, this.#timeoutMs),
                });
            } catch (error) {
                // A caller abort is terminal; a timeout / transport blip is retryable.
                if (signal?.aborted) {
                    throw new OpenAiProviderError(
                        'OpenAiCompatibleProvider: request aborted.',
                        'aborted',
                        0,
                    );
                }
                lastError = new OpenAiProviderError(
                    `OpenAiCompatibleProvider: network error contacting ${this.#url}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    'openai_network_error',
                    0,
                );
                // eslint-disable-next-line no-await-in-loop -- sequential backoff between attempts.
                await backoff(attempt, this.#maxRetries);
                continue;
            }

            if (response.ok) {
                // eslint-disable-next-line no-await-in-loop -- one body read for the resolved response.
                return await response.json();
            }

            const status = response.status;
            if (status === 429 || status >= 500) {
                lastError = new OpenAiProviderError(
                    `OpenAiCompatibleProvider: HTTP ${status} from ${this.#url}.`,
                    `openai_http_${status}`,
                    0,
                );
                // eslint-disable-next-line no-await-in-loop -- sequential backoff between attempts.
                await backoff(attempt, this.#maxRetries);
                continue;
            }

            // Non-retryable HTTP error (4xx other than 429): surface with the body text.
            // eslint-disable-next-line no-await-in-loop -- one body read before throwing.
            const text = await safeReadText(response);
            throw new OpenAiProviderError(
                `OpenAiCompatibleProvider: HTTP ${status} from ${this.#url}: ${text}`,
                `openai_http_${status}`,
                0,
            );
        }

        throw (
            lastError ??
            new OpenAiProviderError(
                `OpenAiCompatibleProvider: request to ${this.#url} failed after ${
                    this.#maxRetries + 1
                } attempts.`,
                'openai_network_error',
                0,
            )
        );
    }
}

/**
 * Combine the caller's optional abort signal with a fresh per-request timeout
 * signal so the fetch aborts on EITHER. Returns the timeout signal alone when no
 * caller signal is present. Used only by the network method.
 */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Wait a small linear backoff before the next retry attempt — `RETRY_BACKOFF_MS *
 * (attempt + 1)` — but only when another attempt remains (no sleep after the
 * final attempt). Used only by the network method.
 */
async function backoff(attempt: number, maxRetries: number): Promise<void> {
    if (attempt >= maxRetries) {
        return;
    }
    await new Promise<void>(resolve => {
        setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1));
    });
}

/**
 * Read a response body as text without throwing — used to enrich a non-retryable
 * HTTP error message. Returns a placeholder if the body cannot be read.
 */
async function safeReadText(response: Response): Promise<string> {
    try {
        return await response.text();
    } catch {
        return '<unreadable body>';
    }
}
