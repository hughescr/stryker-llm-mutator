/*
 * ════════════════════════════════════════════════════════════════════════════
 * OUTPUT-MODE BENCHMARK — times the SDK json_schema structured-output mode vs a
 * prompt-and-parse (raw JSON) mode on a real propose() call against the live
 * Anthropic Agent SDK subscription path.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS:
 *   `AnthropicAgentProvider` drives `@anthropic-ai/claude-agent-sdk`'s `query()`.
 *   In its default `'json_schema'` output mode it sets
 *   `outputFormat: { type: 'json_schema', schema }`, and the SDK runs a MULTI-TURN
 *   generate → emit → validate loop (`maxTurns: 6`) to produce the validated
 *   object — the source of the wild per-call latency variance we observed. The
 *   provider's new `'prompt'` output mode OMITS `outputFormat`, asks the model to
 *   emit raw JSON in the prompt, and parses + validates it LOCALLY in a single
 *   turn (`maxTurns: 2`) — same subscription, fewer turns. This driver runs the
 *   SAME real propose() under both modes (BOTH isolated, the shipped default) and
 *   reports the wall-clock speedup + a reliability check so a human can measure
 *   the win live.
 *
 * HOW THE HUMAN RUNS THIS (network call — run in the MAIN thread, not headless):
 *   # Bun executes TS directly and auto-loads .env, so CLAUDE_CODE_OAUTH_TOKEN
 *   # is populated from the environment.
 *   bun scripts/bench-outputmode.ts [iterations] [maxCandidates]
 *   # Defaults: iterations=2, maxCandidates=8.
 *
 * NOTE ON SANDBOX: this spawns a `claude-code` subprocess and makes a live
 * network call; in a restricted shell it needs the network sandbox cleared (a
 * human in a normal terminal needs no special flag). It NEVER prints the token.
 *
 * Imports from SRC (not dist): the build bundles internals, so dist has no
 * per-module entry points for the provider / propose stage.
 */

import { AnthropicAgentProvider } from '../src/llm/anthropic-agent-provider';
import { type ProposeTarget, propose } from '../src/pipeline/propose';
import type { SourceRange } from '../src/seam/types';

/** Defaults when no CLI args are given. */
const DEFAULT_ITERATIONS = 2;
const DEFAULT_MAX_CANDIDATES = 8;

/**
 * A representative ~30-line TS function the model has real sub-expressions to
 * mutate within: conditionals, off-by-one-able arithmetic literals, an optional
 * chain, a `??` fallback, and an array method. Embedded inline as a string and
 * used verbatim as the {@link ProposeTarget.spanText}.
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
 * Build the ONE fixed target both conditions reuse. `range` is a plausible
 * zero-based Stryker span for the function; `fileContent`/offsets default (so the
 * propose stage treats `spanText` as a standalone single-function file).
 */
function buildTarget(): ProposeTarget {
    const lineCount = FIXTURE_FUNCTION.split('\n').length;
    const range: SourceRange = {
        start: { line: 0, column: 0 },
        end: { line: lineCount - 1, column: 1 },
    };
    return {
        fileName: 'bench-fixture.ts',
        range,
        spanText: FIXTURE_FUNCTION,
    };
}

/** One timed propose() call: wall-clock ms + candidate count, or an error. */
interface IterationResult {
    /** 1-based iteration index for the report. */
    index: number;
    /** Wall-clock duration of the propose() call in milliseconds. */
    ms: number;
    /** Candidates returned (replacements + drops), or undefined on error. */
    candidates?: number;
    /** Error message when the call threw, else undefined. */
    error?: string;
}

/** The accumulated outcome for one condition (json_schema / prompt). */
interface ConditionResult {
    /** Human label used in the report, e.g. `prompt`. */
    label: string;
    /** Per-iteration timings + counts in run order. */
    iterations: IterationResult[];
}

/**
 * Run `iterations` SEQUENTIAL real propose() calls against `provider`, timing
 * each with `performance.now()` and recording the candidate count. Each call is
 * wrapped so one failure records an error and continues rather than aborting the
 * whole benchmark.
 */
async function runCondition(
    label: string,
    provider: AnthropicAgentProvider,
    target: ProposeTarget,
    iterations: number,
    maxCandidates: number,
): Promise<ConditionResult> {
    const results: IterationResult[] = [];
    for (let i = 1; i <= iterations; i++) {
        const start = performance.now();
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential by design: each call is one timed network round-trip.
            const result = await propose(provider, target, { maxCandidates });
            const ms = performance.now() - start;
            const candidates = result.replacements.length + result.dropped.length;
            results.push({ index: i, ms, candidates });
            // eslint-disable-next-line no-console -- this is a runnable driver; console IS its output.
            console.log(`${label} #${i}: ${ms.toFixed(0)} ms, ${candidates} candidates`);
        } catch (error) {
            const ms = performance.now() - start;
            const message = error instanceof Error ? error.message : String(error);
            results.push({ index: i, ms, error: message });
            // eslint-disable-next-line no-console -- driver output.
            console.log(`${label} #${i}: ${ms.toFixed(0)} ms, ERROR: ${message}`);
        }
    }
    return { label, iterations: results };
}

/** The minimum successful-call duration for a condition, or undefined if none succeeded. */
function minSuccessMs(condition: ConditionResult): number | undefined {
    const oks = condition.iterations.filter(it => it.error === undefined);
    if (oks.length === 0) {
        return undefined;
    }
    return Math.min(...oks.map(it => it.ms));
}

/** True when at least one iteration returned a non-zero candidate count. */
function hasValidCandidates(condition: ConditionResult): boolean {
    return condition.iterations.some(it => (it.candidates ?? 0) > 0);
}

/** Print the per-condition MIN + raw values block. */
function printConditionSummary(condition: ConditionResult): void {
    const min = minSuccessMs(condition);
    const raws = condition.iterations
        .map(it => (it.error === undefined ? `${it.ms.toFixed(0)}` : `${it.ms.toFixed(0)}!`))
        .join(', ');
    const minText = min === undefined ? 'n/a (all failed)' : `${min.toFixed(0)} ms`;
    // eslint-disable-next-line no-console -- driver output.
    console.log(`  ${condition.label}: min ${minText} | raw [${raws}] ms`);
}

async function main(): Promise<void> {
    const iterations = Number.parseInt(process.argv[2] ?? '', 10) || DEFAULT_ITERATIONS;
    const maxCandidates = Number.parseInt(process.argv[3] ?? '', 10) || DEFAULT_MAX_CANDIDATES;

    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        // eslint-disable-next-line no-console -- driver output.
        console.error(
            'bench-outputmode: CLAUDE_CODE_OAUTH_TOKEN is not set; the subscription path cannot authenticate. Set it (or put it in .env) and re-run.',
        );
        process.exit(1);
    }

    const target = buildTarget();

    // RAW providers (not the budgeted/cached wrapper) so EVERY call is a real,
    // timed network round-trip. BOTH isolated (the shipped default); only the
    // output mode differs. json_schema (the current default) first, so the slow
    // multi-turn path is measured before the prompt path.
    const jsonSchema = new AnthropicAgentProvider({ isolate: true, outputMode: 'json_schema' });
    const promptMode = new AnthropicAgentProvider({ isolate: true, outputMode: 'prompt' });

    // eslint-disable-next-line no-console -- driver output.
    console.log(
        `bench-outputmode: ${iterations} iteration(s) per condition, maxCandidates=${maxCandidates}\n`,
    );

    const jsonSchemaResult = await runCondition(
        'json_schema',
        jsonSchema,
        target,
        iterations,
        maxCandidates,
    );
    const promptResult = await runCondition(
        'prompt',
        promptMode,
        target,
        iterations,
        maxCandidates,
    );

    // eslint-disable-next-line no-console -- driver output.
    console.log('\n--- summary ---');
    printConditionSummary(jsonSchemaResult);
    printConditionSummary(promptResult);

    const minJsonSchema = minSuccessMs(jsonSchemaResult);
    const minPrompt = minSuccessMs(promptResult);
    const speedup =
        minJsonSchema !== undefined && minPrompt !== undefined && minPrompt > 0
            ? `${(minJsonSchema / minPrompt).toFixed(1)}x`
            : 'n/a (a condition had no successful call)';
    const bothValid = hasValidCandidates(jsonSchemaResult) && hasValidCandidates(promptResult);

    // eslint-disable-next-line no-console -- driver output.
    console.log(`SPEEDUP (min json_schema / min prompt): ${speedup}`);
    // eslint-disable-next-line no-console -- driver output.
    console.log(
        `both conditions returned valid (non-zero) candidates: ${bothValid ? 'yes' : 'NO'}`,
    );
}

await main();
