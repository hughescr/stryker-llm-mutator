/*
 * ════════════════════════════════════════════════════════════════════════════
 * OPENAI-COMPATIBLE LIVE SMOKE — one real Chat Completions round-trip against a
 * REAL OpenAI-compatible endpoint (LM Studio / vLLM / llama.cpp, or real OpenAI),
 * proving the end-to-end {@link OpenAiCompatibleProvider} path: build body → POST
 * `/v1/chat/completions` → read `choices[0].message.content` → parse + validate
 * locally against a JSON Schema → return a typed, validated value.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS:
 *   The provider's UNIT tests are 100% offline (an injected fake `fetch`, no
 *   socket). This script is the ONE thing they cannot be: a live exercise of the
 *   real network seam — the actual HTTP shape, the server's `response_format`
 *   handling, its `usage` accounting, and whether its raw output survives our
 *   local extract + validate. It is INTENTIONALLY not a `bun test` (it touches the
 *   network); a human runs it in the MAIN thread, never headless.
 *
 * WHAT IT DOES:
 *   Constructs ONE {@link OpenAiCompatibleProvider} (the local `openai-compatible`
 *   preset: `jsonMode: true`, key-less unless `OPENAI_API_KEY` is set), sends a
 *   SIMPLE instruction with a SIMPLE schema (`summary` string + `keywords` string
 *   array), and prints the validated value, served model, token usage, and cost,
 *   then a single PASS / FAIL line. Exits NON-ZERO on any failure so it is usable
 *   as a CI/manual gate.
 *
 * HOW THE HUMAN RUNS THIS (network call — run in the MAIN thread, not headless):
 *   # Bun executes TS directly and auto-loads .env. Defaults target a local
 *   # LM Studio box; override via env as needed.
 *   SMOKE_BASE_URL=http://10.0.230.76:1234 \
 *   SMOKE_MODEL=google/gemma-4-26b-a4b-qat \
 *   bun scripts/smoke-openai-compatible.ts
 *   # For real OpenAI: SMOKE_BASE_URL=https://api.openai.com/v1 SMOKE_MODEL=gpt-4o-mini
 *   #                  OPENAI_API_KEY=sk-... bun scripts/smoke-openai-compatible.ts
 *
 * NOTE ON SANDBOX: this makes a live network call; in a restricted shell it needs
 * the network sandbox cleared (a human in a normal terminal needs no special
 * flag). It NEVER prints the API key.
 *
 * Imports from SRC (not dist): the build bundles internals, so dist has no
 * per-module entry point for the provider.
 */

import { OpenAiCompatibleProvider } from '../src/llm/openai-compatible-provider';
import type { JsonSchema } from '../src/llm/types';

/** Default base URL — a local LM Studio server (bare host; the provider adds `/v1/chat/completions`). */
const DEFAULT_BASE_URL = 'http://10.0.230.76:1234';
/** Default model id served by that local box. */
const DEFAULT_MODEL = 'google/gemma-4-26b-a4b-qat';

/** The SIMPLE instruction the model is asked to answer with a structured object. */
const PROMPT =
    'Summarize the following note in one short sentence and list its key topics ' +
    'as keywords.\n\nNote: "We migrated the dynamic-LLM mutator to an ' +
    'OpenAI-compatible Chat Completions backend so it can drive local LM Studio, ' +
    'vLLM, and llama.cpp servers with zero new runtime dependencies."';

/**
 * The SIMPLE schema the response must satisfy: a `summary` string plus a
 * `keywords` array of strings. Small on purpose — enough to prove json-schema
 * structured output round-trips and validates without exercising edge cases.
 */
const SCHEMA: JsonSchema = {
    type: 'object',
    required: ['summary', 'keywords'],
    properties: {
        summary: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
    },
};

/** The typed shape we expect back, mirroring {@link SCHEMA}. */
interface SmokeResult {
    summary: string;
    keywords: string[];
}

async function main(): Promise<void> {
    const baseUrl = process.env.SMOKE_BASE_URL ?? DEFAULT_BASE_URL;
    const model = process.env.SMOKE_MODEL ?? DEFAULT_MODEL;
    const apiKey = process.env.OPENAI_API_KEY;

    // eslint-disable-next-line no-console -- this is a runnable driver; console IS its output.
    console.log(
        `smoke-openai-compatible: POST ${baseUrl} (model=${model}, ` +
            `auth=${apiKey ? 'bearer' : 'none'}, jsonMode=true)\n`,
    );

    const provider = new OpenAiCompatibleProvider({
        baseUrl,
        model,
        providerLabel: 'openai-compatible',
        jsonMode: true,
        apiKey,
    });

    try {
        const result = await provider.generate<SmokeResult>({ prompt: PROMPT, schema: SCHEMA });

        // eslint-disable-next-line no-console -- driver output.
        console.log('value:', JSON.stringify(result.value, null, 2));
        // eslint-disable-next-line no-console -- driver output.
        console.log('model:', result.model);
        // eslint-disable-next-line no-console -- driver output.
        console.log('usage:', JSON.stringify(result.usage ?? {}));
        // eslint-disable-next-line no-console -- driver output.
        console.log('costUsd:', result.costUsd);

        // A schema-valid value is already guaranteed by generate(); add a light
        // sanity check so the PASS line means the content is actually usable.
        const ok =
            typeof result.value.summary === 'string' &&
            result.value.summary.length > 0 &&
            Array.isArray(result.value.keywords) &&
            result.value.keywords.length > 0;

        // eslint-disable-next-line no-console -- driver output.
        console.log(`\n${ok ? 'PASS' : 'FAIL'}: ${provider.name} returned a validated object.`);
        if (!ok) {
            process.exit(1);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console -- driver output.
        console.error(`\nFAIL: ${provider.name} threw: ${message}`);
        process.exit(1);
    }
}

await main();
