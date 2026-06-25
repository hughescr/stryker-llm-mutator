/*
 * ════════════════════════════════════════════════════════════════════════════
 * STARTUP-SPLIT BENCHMARK — decomposes one-shot `query()` latency into STARTUP
 * (subprocess spawn + agent init) vs POST-STARTUP (generation + multi-turn emit
 * loop + server latency) against the live Anthropic Agent SDK subscription path.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS:
 *   The dynamic-LLM Agent SDK path (`AnthropicAgentProvider`) costs ~34s+ per
 *   call. That total splits into two very different kinds of cost:
 *     - STARTUP   — spawning the `claude-code` subprocess and initializing the
 *                   agent BEFORE any generation begins. This is per-call overhead
 *                   that a SESSION-REUSE architecture (one long-lived subprocess,
 *                   many queries) could AMORTIZE away.
 *     - POST-STARTUP — the model's generation + the SDK's multi-turn
 *                   structured-output emit/validate loop + server round-trip
 *                   latency. This is intrinsic to each request and is NOT
 *                   amortizable by reusing a session.
 *   We measure each per call so we can decide whether building session reuse is
 *   worth it: if startup dominates, reuse pays off; if post-startup dominates, it
 *   does not. The decomposition is done purely from SDK MESSAGE TIMESTAMPS — we
 *   do NOT parse or validate the structured output here; only the wall-clock
 *   between t0, the first SDK message, and the terminal `result` message matters.
 *
 * HOW STARTUP vs POST-STARTUP IS TIMED:
 *   For one `query()` call we mark `t0` immediately before iterating the async
 *   stream. The FIRST message the SDK emits (expected `type: 'system'`, the init
 *   message — the subprocess is up and the agent is initialized) marks `tFirst`;
 *   `tFirst - t0` is STARTUP. The terminal `type: 'result'` message (last one
 *   wins) marks `tResult`; `tResult - tFirst` is POST-STARTUP. `tResult - t0` is
 *   the TOTAL. An error-subtype result still records its timestamp as `tResult`.
 *
 * OPTIONS PARITY:
 *   The `query()` Options below are built to MATCH the shipped defaults
 *   `AnthropicAgentProvider` uses for its `json_schema` path WITH isolation +
 *   connectors-off on (its production configuration): the resolved subscription
 *   auth env (via the provider's exported `resolveAuthEnv`, so ANTHROPIC_API_KEY
 *   cannot shadow the OAuth token), `model: DEFAULT_MODEL` (`claude-haiku-4-5`),
 *   `outputFormat: { type: 'json_schema', schema }`, the by-name tool ban,
 *   `maxTurns: 6`, `permissionMode: 'dontAsk'`, the system prompt via
 *   `systemPrompt`, and the isolation block `settingSources: [] / mcpServers: {} /
 *   strictMcpConfig: true / managedSettings: { disableClaudeAiConnectors: true }`.
 *   The propose stage does not export its schema/prompt, so a representative
 *   ~30-line fixture function + an equivalent propose-shaped JSON schema (array
 *   of {original, replacement, mutatorTag, rationale}) are embedded so the work
 *   is representative of a real propose() call.
 *
 * HOW THE HUMAN RUNS THIS (network call — run in the MAIN thread, not headless):
 *   # Bun executes TS directly and auto-loads .env, so CLAUDE_CODE_OAUTH_TOKEN
 *   # is populated from the environment.
 *   bun scripts/bench-startup-split.ts [iterations] [maxCandidates]
 *   # Defaults: iterations=3, maxCandidates=8.
 *
 * NOTE ON SANDBOX: this spawns a `claude-code` subprocess and makes a live
 * network call; in a restricted shell it needs the network sandbox cleared (a
 * human in a normal terminal needs no special flag). It NEVER prints the token.
 *
 * Imports from SRC (not dist): the build bundles internals, so dist has no
 * per-module entry point for the provider's exported auth helper.
 */

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { DEFAULT_MODEL } from '../src/config';
import { resolveAuthEnv } from '../src/llm/anthropic-agent-provider';
import type { JsonSchema } from '../src/llm/types';

/** Defaults when no CLI args are given. */
const DEFAULT_ITERATIONS = 3;
const DEFAULT_MAX_CANDIDATES = 8;

/**
 * Turn budget matching the provider's `json_schema` path: the model's generation
 * turn PLUS the SDK's structured-output emit/validation turn(s).
 */
const JSON_SCHEMA_MAX_TURNS = 6;

/**
 * A representative ~30-line TS function the model has real sub-expressions to
 * mutate within: conditionals, off-by-one-able arithmetic literals, an optional
 * chain, a `??` fallback, and an array method. Mirrors the bench-isolation
 * fixture so the timed work is representative of a real propose() call.
 */
const FIXTURE_FUNCTION = `function summarizeOrders(orders, options) {
    const taxRate = options?.taxRate ?? 0.08;
    const minTotal = options?.minTotal ?? 10;
    let subtotal = 0;
    let counted = 0;
    for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        if (order.status === 'cancelled') {
            continue;
        }
        const lineTotal = order.quantity * order.unitPrice;
        if (lineTotal >= minTotal) {
            subtotal += lineTotal;
            counted += 1;
        }
    }
    const discounted = orders
        .filter(o => o.status !== 'cancelled')
        .map(o => o.quantity)
        .reduce((sum, q) => sum + q, 0);
    const tax = subtotal * taxRate;
    const total = subtotal + tax;
    const average = counted > 0 ? total / counted : 0;
    return {
        subtotal,
        tax,
        total,
        average,
        itemCount: discounted,
        flagged: total > 1000,
    };
}`;

/**
 * The system prompt — an equivalent of the propose stage's fixed instructions
 * (propose.ts does not export them), so the model is asked to do representative
 * mutation-proposal work.
 */
const SYSTEM_PROMPT = [
    'You are a mutation-testing assistant for JavaScript/TypeScript.',
    'You are given the exact source text of ONE function.',
    'Propose localized, behavior-changing mutations, each targeting a SMALL, SELF-CONTAINED sub-expression WITHIN the function.',
    'For EACH mutation: pick a single small sub-expression (e.g. "hour >= 12", "a ?? b", "len - 1"); put its EXACT verbatim source in "original"; put the edited sub-expression in "replacement"; give a short kebab-case "mutatorTag" and a one-sentence "rationale".',
    'Prefer plausible real bugs (off-by-one, flipped condition, wrong operator, dropped guard, wrong boundary literal).',
    'Return ONLY the structured object; no prose outside it.',
].join('\n');

/**
 * Build an equivalent of the propose stage's JSON schema (propose.ts does not
 * export `buildProposeSchema`): an object with a `candidates` array of
 * {original, replacement, mutatorTag, rationale}. Capped at `maxCandidates`.
 */
function buildProposeSchema(maxCandidates: number): JsonSchema {
    return {
        type: 'object',
        additionalProperties: false,
        required: ['candidates'],
        properties: {
            candidates: {
                type: 'array',
                minItems: 0,
                maxItems: maxCandidates,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['original', 'replacement', 'mutatorTag', 'rationale'],
                    properties: {
                        original: {
                            type: 'string',
                            description:
                                'The EXACT verbatim source of a SMALL sub-expression inside the function to mutate.',
                        },
                        replacement: {
                            type: 'string',
                            description:
                                'The edited sub-expression that replaces "original" in place.',
                        },
                        mutatorTag: {
                            type: 'string',
                            description: 'Short kebab-case label for the kind of mutation.',
                        },
                        rationale: {
                            type: 'string',
                            description:
                                'One sentence on why this is a plausible, behavior-changing mutation.',
                        },
                    },
                },
            },
        },
    };
}

/** Build the per-function user prompt embedding the fixture function. */
function buildPrompt(maxCandidates: number): string {
    return [
        `Propose up to ${maxCandidates} distinct, behavior-changing mutations, each on a small sub-expression WITHIN the FUNCTION below.`,
        '',
        'FUNCTION ("original" must be a verbatim substring of it):',
        '```',
        FIXTURE_FUNCTION,
        '```',
    ].join('\n');
}

/**
 * One iteration's timing decomposition, or an error. All times in ms.
 * `startup = tFirst - t0`, `postStartup = tResult - tFirst`, `total = tResult - t0`.
 */
interface IterationResult {
    /** 1-based iteration index for the report. */
    index: number;
    /** Subprocess spawn + agent init: t0 → first SDK message. */
    startup?: number;
    /** Generation + multi-turn emit loop + server latency: first message → result. */
    postStartup?: number;
    /** End to end: t0 → terminal result. */
    total?: number;
    /** The `type` of the FIRST SDK message (expected `system`). */
    firstType?: string;
    /** The terminal result `subtype` when it was an error subtype, else undefined. */
    errorSubtype?: string;
    /** Error message when the call threw, else undefined. */
    error?: string;
}

/**
 * Drive ONE `query()` with the given `prompt`/`options`, timing t0 → first
 * message (startup) and first message → terminal result (post-startup) purely
 * from message timestamps. Wrapped so one failure records an error and the
 * caller continues to the next iteration. Does NOT parse the structured output.
 */
async function runIteration(
    index: number,
    prompt: string,
    options: Options,
): Promise<IterationResult> {
    const t0 = performance.now();
    let tFirst: number | undefined;
    let firstType: string | undefined;
    let tResult: number | undefined;
    let errorSubtype: string | undefined;

    try {
        for await (const message of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
            if (tFirst === undefined) {
                tFirst = performance.now();
                firstType = message.type;
            }
            if (message.type === 'result') {
                // Last result wins; record its timestamp even if it is an error
                // subtype (we care about WHEN the run terminated, not validity).
                tResult = performance.now();
                errorSubtype = message.subtype === 'success' ? undefined : message.subtype;
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { index, firstType, error: message };
    }

    if (tFirst === undefined || tResult === undefined) {
        return {
            index,
            firstType,
            error: 'stream ended without a first message and/or a terminal result message',
        };
    }

    return {
        index,
        startup: tFirst - t0,
        postStartup: tResult - tFirst,
        total: tResult - t0,
        firstType,
        errorSubtype,
    };
}

/** Median of a numeric array (mean of the two middle values for even length). */
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[mid] ?? 0;
    }
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

async function main(): Promise<void> {
    const iterations = Number.parseInt(process.argv[2] ?? '', 10) || DEFAULT_ITERATIONS;
    const maxCandidates = Number.parseInt(process.argv[3] ?? '', 10) || DEFAULT_MAX_CANDIDATES;

    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        // eslint-disable-next-line no-console -- driver output.
        console.error(
            'bench-startup-split: CLAUDE_CODE_OAUTH_TOKEN is not set; the subscription path cannot authenticate. Set it (or put it in .env) and re-run.',
        );
        process.exit(1);
    }

    const schema = buildProposeSchema(maxCandidates);
    const prompt = buildPrompt(maxCandidates);

    // Options built to MATCH the provider's shipped json_schema + isolation +
    // connectors-off defaults (see file header). resolveAuthEnv strips
    // ANTHROPIC_API_KEY so it cannot shadow the OAuth token.
    const options = {
        model: DEFAULT_MODEL,
        // Hermetic isolation (the provider's default): no settings, no CLAUDE.md,
        // no MCP servers, and force-disable claude.ai cloud connectors.
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        managedSettings: { disableClaudeAiConnectors: true },
        // Subscription auth with ANTHROPIC_API_KEY stripped.
        env: resolveAuthEnv(process.env),
        // Pure generation: ban side-effecting tools BY NAME (a blanket ban also
        // disables the json_schema emit path — see the provider).
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
        systemPrompt: SYSTEM_PROMPT,
        // JSON-schema structured-output mode + its multi-turn budget.
        outputFormat: { type: 'json_schema', schema },
        maxTurns: JSON_SCHEMA_MAX_TURNS,
    } satisfies Options;

    // eslint-disable-next-line no-console -- driver output.
    console.log(
        `bench-startup-split: ${iterations} iteration(s), maxCandidates=${maxCandidates}, model=${DEFAULT_MODEL}\n`,
    );

    const results: IterationResult[] = [];
    for (let i = 1; i <= iterations; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design: each call is one timed network round-trip we must not overlap.
        const r = await runIteration(i, prompt, options);
        results.push(r);
        if (r.error !== undefined) {
            // eslint-disable-next-line no-console -- driver output.
            console.log(
                `iter #${i}: ERROR: ${r.error}${r.firstType ? ` (first msg: ${r.firstType})` : ''}`,
            );
        } else {
            const note = r.errorSubtype ? `, result subtype: ${r.errorSubtype}` : '';
            // eslint-disable-next-line no-console -- driver output.
            console.log(
                `iter #${i}: startup=${(r.startup ?? 0).toFixed(0)} ms (first msg: ${r.firstType}), post=${(r.postStartup ?? 0).toFixed(0)} ms, total=${(r.total ?? 0).toFixed(0)} ms${note}`,
            );
        }
    }

    const ok = results.filter(r => r.error === undefined);

    // eslint-disable-next-line no-console -- driver output.
    console.log('\n--- summary ---');

    if (ok.length === 0) {
        // eslint-disable-next-line no-console -- driver output.
        console.log('no successful iterations — nothing to summarize.');
        return;
    }

    const startups = ok.map(r => r.startup ?? 0);
    const posts = ok.map(r => r.postStartup ?? 0);
    const totals = ok.map(r => r.total ?? 0);

    const minStartup = Math.min(...startups);
    const medStartup = median(startups);
    const minPost = Math.min(...posts);
    const medPost = median(posts);
    const minTotal = Math.min(...totals);
    const medTotal = median(totals);
    const startupFraction = medTotal > 0 ? (medStartup / medTotal) * 100 : 0;

    /* eslint-disable no-console -- driver output. */
    console.log(`successful iterations: ${ok.length}/${results.length}`);
    console.log(
        `startup    : min ${minStartup.toFixed(0)} ms | median ${medStartup.toFixed(0)} ms`,
    );
    console.log(`post-startup: min ${minPost.toFixed(0)} ms | median ${medPost.toFixed(0)} ms`);
    console.log(`total      : min ${minTotal.toFixed(0)} ms | median ${medTotal.toFixed(0)} ms`);
    console.log(
        `startup median = ${medStartup.toFixed(0)} ms (${startupFraction.toFixed(1)}% of total) — the amortizable share a session-reuse architecture could eliminate.`,
    );
    /* eslint-enable no-console */
}

await main();
