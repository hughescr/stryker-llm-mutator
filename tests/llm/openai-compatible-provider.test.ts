/*
 * OFFLINE tests for the OpenAI-compatible Chat Completions provider.
 *
 * These NEVER open a socket — every test injects a FAKE `fetch` (`fetchImpl`)
 * that returns canned `Response`s, so the whole provider (including the single
 * `#post` network method, its 429/5xx/network retry loop, and abort handling) is
 * exercised without the network. The live end-to-end check is the human-run
 * `scripts/smoke-openai-compatible.ts`. They cover URL normalization, request-body
 * assembly (json vs prompt mode), response extraction, usage mapping, cost, the
 * one parse/validate re-request, transport retries, the abort paths, and the
 * provider name for both labels.
 */

import { describe, expect, it } from 'bun:test';

import {
    buildChatRequestBody,
    computeCostUsd,
    extractMessageContent,
    mapUsage,
    OpenAiCompatibleProvider,
    OpenAiProviderError,
    resolveChatCompletionsUrl,
} from '../../src/llm/openai-compatible-provider';
import type { JsonSchema } from '../../src/llm/types';

const BASE_URL = 'http://h:1234';
const MODEL = 'google/gemma-4-26b-a4b-qat';

/** A minimal schema: a top-level object with a single required `x` number. */
const numberSchema: JsonSchema = {
    type: 'object',
    required: ['x'],
    properties: { x: { type: 'number' } },
};

/** A propose-style schema with a required string + a required string array. */
const summarySchema: JsonSchema = {
    type: 'object',
    required: ['summary', 'keywords'],
    properties: {
        summary: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
    },
};

/** A single recorded fetch invocation: the resolved URL and the request init. */
interface FetchCall {
    url: string;
    init?: RequestInit;
}

/**
 * Build a FAKE `fetch` that records each call and returns whatever `responder`
 * produces for that call index. `responder` may return a `Response`, a promise
 * for one, or THROW (rejecting the fetch, to simulate a transport error).
 */
function recordingFetch(responder: (callIndex: number) => Response | Promise<Response>): {
    fetch: typeof fetch;
    calls: FetchCall[];
} {
    const calls: FetchCall[] = [];
    const fn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        calls.push({ url: String(input), init });
        return responder(calls.length - 1);
    }) as unknown as typeof fetch;
    return { fetch: fn, calls };
}

/** A 200 JSON response carrying an arbitrary body object. */
function jsonResponse(bodyObject: unknown): Response {
    return new Response(JSON.stringify(bodyObject), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

/** A 200 Chat Completions response whose single choice carries `content`. */
function chatResponse(content: string, extra: Record<string, unknown> = {}): Response {
    return jsonResponse({ choices: [{ message: { content } }], ...extra });
}

/** Read the recorded request body of a call back into an object. */
function sentBody(call: FetchCall): Record<string, unknown> {
    return JSON.parse(call.init?.body as string) as Record<string, unknown>;
}

/** Read the recorded request headers of a call as a plain record. */
function sentHeaders(call: FetchCall): Record<string, string> {
    return call.init?.headers as Record<string, string>;
}

describe('resolveChatCompletionsUrl', () => {
    it('appends /v1/chat/completions to a bare host', () => {
        expect(resolveChatCompletionsUrl('http://h:1234')).toBe(
            'http://h:1234/v1/chat/completions',
        );
    });

    it('strips a trailing slash on a bare host before appending', () => {
        expect(resolveChatCompletionsUrl('http://h:1234/')).toBe(
            'http://h:1234/v1/chat/completions',
        );
    });

    it('appends only /chat/completions to a versioned base', () => {
        expect(resolveChatCompletionsUrl('http://h:1234/v1')).toBe(
            'http://h:1234/v1/chat/completions',
        );
        expect(resolveChatCompletionsUrl('https://api.openai.com/v1')).toBe(
            'https://api.openai.com/v1/chat/completions',
        );
    });

    it('strips a trailing slash on a versioned base', () => {
        expect(resolveChatCompletionsUrl('https://api.openai.com/v1/')).toBe(
            'https://api.openai.com/v1/chat/completions',
        );
    });

    it('is idempotent when the base already ends with /chat/completions', () => {
        expect(resolveChatCompletionsUrl('http://h/v1/chat/completions')).toBe(
            'http://h/v1/chat/completions',
        );
    });
});

describe('buildChatRequestBody', () => {
    it('json mode: bare user prompt + response_format json_schema envelope', () => {
        const body = buildChatRequestBody(
            { prompt: 'P', schema: numberSchema },
            { model: 'm', jsonMode: true, temperature: 0 },
        );
        expect(body.model).toBe('m');
        expect(body.temperature).toBe(0);
        expect(body.messages).toEqual([{ role: 'user', content: 'P' }]);
        expect(body.response_format).toEqual({
            type: 'json_schema',
            json_schema: { name: 'response', strict: true, schema: numberSchema },
        });
    });

    it('prompt mode: omits response_format and embeds the schema directive in the prompt', () => {
        const body = buildChatRequestBody(
            { prompt: 'P', schema: numberSchema },
            { model: 'm', jsonMode: false, temperature: 0.5 },
        );
        expect('response_format' in body).toBe(false);
        expect(body.temperature).toBe(0.5);
        const messages = body.messages as { role: string; content: string }[];
        expect(messages[0].role).toBe('user');
        expect(messages[0].content.startsWith('P')).toBe(true);
        expect(messages[0].content).toContain('Output ONLY a single raw JSON object');
        expect(messages[0].content).toContain(JSON.stringify(numberSchema));
    });

    it('prepends a system message before the user message when present', () => {
        const body = buildChatRequestBody(
            { prompt: 'P', schema: numberSchema, system: 'SYS' },
            { model: 'm', jsonMode: true, temperature: 0 },
        );
        const messages = body.messages as { role: string; content: string }[];
        expect(messages[0]).toEqual({ role: 'system', content: 'SYS' });
        expect(messages[1].role).toBe('user');
    });
});

describe('extractMessageContent', () => {
    it('returns choices[0].message.content', () => {
        expect(extractMessageContent({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
    });

    it('throws openai_bad_response when content is missing', () => {
        try {
            extractMessageContent({ choices: [{ message: {} }] });
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(OpenAiProviderError);
            expect((err as OpenAiProviderError).subtype).toBe('openai_bad_response');
        }
    });

    it('throws openai_bad_response when there are no choices at all', () => {
        expect(() => extractMessageContent({})).toThrow(OpenAiProviderError);
    });

    it('throws when content is present but not a string', () => {
        expect(() => extractMessageContent({ choices: [{ message: { content: 42 } }] })).toThrow(
            /no string/,
        );
    });
});

describe('mapUsage', () => {
    it('maps prompt/completion tokens onto input/output', () => {
        expect(mapUsage({ prompt_tokens: 100, completion_tokens: 20 })).toEqual({
            inputTokens: 100,
            outputTokens: 20,
        });
    });

    it('includes OpenAI prompt_tokens_details.cached_tokens as cacheReadTokens', () => {
        expect(
            mapUsage({
                prompt_tokens: 100,
                completion_tokens: 20,
                prompt_tokens_details: { cached_tokens: 7 },
            }),
        ).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 7 });
    });

    it('falls back to Anthropic-style cache counters when no details object is present', () => {
        expect(mapUsage({ cache_read_input_tokens: 5, cache_creation_input_tokens: 3 })).toEqual({
            cacheReadTokens: 5,
            cacheWriteTokens: 3,
        });
    });

    it('returns undefined for a missing or non-object usage', () => {
        expect(mapUsage(undefined)).toBeUndefined();
        expect(mapUsage('nope')).toBeUndefined();
        expect(mapUsage(null)).toBeUndefined();
    });
});

describe('computeCostUsd', () => {
    const pricing = { inputPerMTok: 3, outputPerMTok: 15 };

    it('returns 0 when no pricing is supplied (local / unmetered)', () => {
        expect(computeCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0);
    });

    it('computes dollars-per-million-token cost when pricing is supplied', () => {
        expect(
            computeCostUsd({ inputTokens: 1_000_000, outputTokens: 2_000_000 }, pricing),
        ).toBeCloseTo(3 + 30);
    });

    it('treats missing token counts as 0', () => {
        expect(computeCostUsd({ outputTokens: 1_000_000 }, pricing)).toBeCloseTo(15);
        expect(computeCostUsd(undefined, pricing)).toBe(0);
    });
});

describe('OpenAiProviderError', () => {
    it('carries subtype and costUsd and is an Error', () => {
        const err = new OpenAiProviderError('boom', 'some_subtype', 0.5);
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('OpenAiProviderError');
        expect(err.subtype).toBe('some_subtype');
        expect(err.costUsd).toBe(0.5);
    });
});

describe('OpenAiCompatibleProvider name', () => {
    it('defaults the label to openai-compatible', () => {
        expect(new OpenAiCompatibleProvider({ baseUrl: BASE_URL, model: MODEL }).name).toBe(
            'openai-compatible(google/gemma-4-26b-a4b-qat)',
        );
    });

    it('uses the openai label when constructed for real OpenAI', () => {
        expect(
            new OpenAiCompatibleProvider({
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o',
                providerLabel: 'openai',
            }).name,
        ).toBe('openai(gpt-4o)');
    });
});

describe('OpenAiCompatibleProvider.generate (happy path)', () => {
    it('POSTs the resolved URL and returns the validated value + model + usage', async () => {
        const { fetch: fetchImpl, calls } = recordingFetch(() =>
            chatResponse(JSON.stringify({ summary: 's', keywords: ['a', 'b'] }), {
                model: 'served-model',
                usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
            }),
        );
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
            pricing: { inputPerMTok: 2, outputPerMTok: 4 },
        });

        const result = await provider.generate<{ summary: string; keywords: string[] }>({
            prompt: 'p',
            schema: summarySchema,
        });

        expect(calls[0].url).toBe('http://h:1234/v1/chat/completions');
        expect(result.value).toEqual({ summary: 's', keywords: ['a', 'b'] });
        expect(result.model).toBe('served-model');
        expect(result.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 500_000 });
        // 1M input * $2/M = $2; 0.5M output * $4/M = $2.
        expect(result.costUsd).toBeCloseTo(4);
        expect(result.rawText).toBe(JSON.stringify({ summary: 's', keywords: ['a', 'b'] }));
        expect(result.cached).toBe(false);
    });

    it('reports costUsd 0 when no pricing is configured', async () => {
        const { fetch: fetchImpl } = recordingFetch(() =>
            chatResponse('{"x":7}', { usage: { prompt_tokens: 999, completion_tokens: 999 } }),
        );
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
        });
        const result = await provider.generate({ prompt: 'p', schema: numberSchema });
        expect(result.value).toEqual({ x: 7 });
        expect(result.costUsd).toBe(0);
    });

    it('falls back to the request/config model when the response omits one', async () => {
        const { fetch: fetchImpl } = recordingFetch(() => chatResponse('{"x":7}'));
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: 'cfg-model',
            fetchImpl,
        });
        const result = await provider.generate({ prompt: 'p', schema: numberSchema });
        expect(result.model).toBe('cfg-model');
        expect(result.usage).toBeUndefined();
    });

    it('json mode off: sends no response_format and embeds the schema in the prompt', async () => {
        const { fetch: fetchImpl, calls } = recordingFetch(() => chatResponse('{"x":7}'));
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
            jsonMode: false,
        });
        await provider.generate({ prompt: 'P', schema: numberSchema });
        const body = sentBody(calls[0]);
        expect('response_format' in body).toBe(false);
        const messages = body.messages as { content: string }[];
        expect(messages[0].content).toContain('Output ONLY a single raw JSON object');
    });

    it('passes a live (non-aborted) caller signal through without aborting', async () => {
        const controller = new AbortController();
        const { fetch: fetchImpl, calls } = recordingFetch(() => chatResponse('{"x":7}'));
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
        });
        const result = await provider.generate({
            prompt: 'p',
            schema: numberSchema,
            signal: controller.signal,
        });
        expect(result.value).toEqual({ x: 7 });
        expect(calls.length).toBe(1);
    });
});

describe('OpenAiCompatibleProvider.generate (auth)', () => {
    it('sends Authorization: Bearer only when an apiKey is set', async () => {
        const withKey = recordingFetch(() => chatResponse('{"x":7}'));
        await new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            apiKey: 'sk-1',
            fetchImpl: withKey.fetch,
        }).generate({ prompt: 'p', schema: numberSchema });
        expect(sentHeaders(withKey.calls[0]).authorization).toBe('Bearer sk-1');

        const noKey = recordingFetch(() => chatResponse('{"x":7}'));
        await new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl: noKey.fetch,
        }).generate({ prompt: 'p', schema: numberSchema });
        expect('authorization' in sentHeaders(noKey.calls[0])).toBe(false);
    });
});

describe('OpenAiCompatibleProvider.generate (parse/validate retry)', () => {
    it('re-requests once on a parse miss, then succeeds', async () => {
        const { fetch: fetchImpl, calls } = recordingFetch(callIndex =>
            callIndex === 0 ? chatResponse('not json at all') : chatResponse('{"x":7}'),
        );
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
        });
        const result = await provider.generate({ prompt: 'p', schema: numberSchema });
        expect(result.value).toEqual({ x: 7 });
        expect(calls.length).toBe(2);
    });

    it('throws openai_parse_failed after one retry when validation keeps failing', async () => {
        // Valid JSON but missing the required `x` key -> validation returns undefined.
        const { fetch: fetchImpl, calls } = recordingFetch(() => chatResponse('{"y":1}'));
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
        });
        try {
            await provider.generate({ prompt: 'p', schema: numberSchema });
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(OpenAiProviderError);
            expect((err as OpenAiProviderError).subtype).toBe('openai_parse_failed');
        }
        expect(calls.length).toBe(2);
    });

    it('throws openai_bad_response (without retrying) when the response has no content', async () => {
        const { fetch: fetchImpl, calls } = recordingFetch(() =>
            jsonResponse({ choices: [{ message: {} }] }),
        );
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
        });
        try {
            await provider.generate({ prompt: 'p', schema: numberSchema });
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as OpenAiProviderError).subtype).toBe('openai_bad_response');
        }
        expect(calls.length).toBe(1);
    });
});

describe('OpenAiCompatibleProvider.generate (transport)', () => {
    it('retries a 500 up to maxRetries, then throws openai_http_500', async () => {
        const { fetch: fetchImpl, calls } = recordingFetch(
            () =>
                new Response('overloaded', {
                    status: 500,
                }),
        );
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
            maxRetries: 2,
        });
        try {
            await provider.generate({ prompt: 'p', schema: numberSchema });
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(OpenAiProviderError);
            expect((err as OpenAiProviderError).subtype).toBe('openai_http_500');
        }
        expect(calls.length).toBe(3);
    });

    it('throws immediately on a 401, including the response body text', async () => {
        const { fetch: fetchImpl, calls } = recordingFetch(
            () =>
                new Response('invalid api key', {
                    status: 401,
                }),
        );
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
            maxRetries: 3,
        });
        try {
            await provider.generate({ prompt: 'p', schema: numberSchema });
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as OpenAiProviderError).subtype).toBe('openai_http_401');
            expect((err as Error).message).toContain('invalid api key');
        }
        expect(calls.length).toBe(1);
    });

    it('throws immediately on a 400 (no retry)', async () => {
        const { fetch: fetchImpl, calls } = recordingFetch(
            () =>
                new Response('bad request', {
                    status: 400,
                }),
        );
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
            maxRetries: 3,
        });
        await expect(provider.generate({ prompt: 'p', schema: numberSchema })).rejects.toThrow(
            /HTTP 400/,
        );
        expect(calls.length).toBe(1);
    });

    it('retries a transient network error, then succeeds', async () => {
        let attempts = 0;
        const fetchImpl = (async (): Promise<Response> => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error('ECONNRESET');
            }
            return chatResponse('{"x":7}');
        }) as unknown as typeof fetch;
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
            maxRetries: 2,
        });
        const result = await provider.generate({ prompt: 'p', schema: numberSchema });
        expect(result.value).toEqual({ x: 7 });
        expect(attempts).toBe(2);
    });

    it('retries a persistent network error, then throws openai_network_error', async () => {
        let attempts = 0;
        const fetchImpl = (async (): Promise<Response> => {
            attempts += 1;
            throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch;
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
            maxRetries: 1,
        });
        try {
            await provider.generate({ prompt: 'p', schema: numberSchema });
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as OpenAiProviderError).subtype).toBe('openai_network_error');
        }
        expect(attempts).toBe(2);
    });
});

describe('OpenAiCompatibleProvider.generate (abort)', () => {
    it('rejects an already-aborted request before any fetch', async () => {
        const { fetch: fetchImpl, calls } = recordingFetch(() => chatResponse('{"x":7}'));
        const controller = new AbortController();
        controller.abort();
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
        });
        await expect(
            provider.generate({ prompt: 'p', schema: numberSchema, signal: controller.signal }),
        ).rejects.toThrow(/aborted/);
        expect(calls.length).toBe(0);
    });

    it('throws aborted when the caller signal fires mid-flight', async () => {
        const controller = new AbortController();
        const fetchImpl = (async (): Promise<Response> => {
            controller.abort();
            throw new DOMException('aborted', 'AbortError');
        }) as unknown as typeof fetch;
        const provider = new OpenAiCompatibleProvider({
            baseUrl: BASE_URL,
            model: MODEL,
            fetchImpl,
            maxRetries: 3,
        });
        try {
            await provider.generate({
                prompt: 'p',
                schema: numberSchema,
                signal: controller.signal,
            });
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as OpenAiProviderError).subtype).toBe('aborted');
        }
    });
});
