/*
 * ════════════════════════════════════════════════════════════════════════════
 * THINKING / EFFORT BENCHMARK — times the SDK's default reasoning depth vs a
 * lowered `effort` vs disabled `thinking` on a real propose() call against the
 * live Anthropic Agent SDK subscription path.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS:
 *   A startup-split probe proved the dynamic-LLM call cost is ~99% post-startup
 *   GENERATION (~50s; startup only ~410ms). The prime suspect: the SDK defaults
 *   reasoning `effort` to `'high'` ("Deep reasoning") and uses adaptive thinking,
 *   so Haiku does DEEP reasoning for every MECHANICAL propose call. The provider
 *   now exposes two pass-through knobs forwarded straight to `query()`:
 *     • `effort: EffortLevel`  — `'low'` = minimal thinking / fastest
 *     • `thinking: ThinkingConfig` — `{ type: 'disabled' }` = no extended thinking
 *   Both UNSET by default (the SDK keeps `effort: 'high'` + adaptive thinking).
 *   This driver runs the SAME real propose() under three conditions (ALL isolated,
 *   ALL default `json_schema` output mode — the shipped path), varying ONLY the
 *   thinking/effort knobs, and reports the wall-clock speedup + a quality sanity
 *   check (did each condition still return valid, non-zero candidates?) so a human
 *   can measure the win — and the risk — live.
 *
 * HOW THE HUMAN RUNS THIS (network call — run in the MAIN thread, not headless):
 *   # Bun executes TS directly and auto-loads .env, so CLAUDE_CODE_OAUTH_TOKEN
 *   # is populated from the environment.
 *   bun scripts/bench-thinking.ts [iterations] [maxCandidates]
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
 * Build the ONE fixed target every condition reuses. `range` is a plausible
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

/** The accumulated outcome for one condition (baseline / effort-low / thinking-disabled). */
interface ConditionResult {
    /** Human label used in the report, e.g. `effort-low`. */
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

/**
 * Speedup of `condition` vs `baseline` = (min baseline ms / min condition ms),
 * formatted `N.Nx`, or an `n/a` note when either side had no successful call.
 */
function speedupVsBaseline(baseline: ConditionResult, condition: ConditionResult): string {
    const minBase = minSuccessMs(baseline);
    const minCond = minSuccessMs(condition);
    if (minBase === undefined || minCond === undefined || minCond <= 0) {
        return 'n/a (a condition had no successful call)';
    }
    return `${(minBase / minCond).toFixed(1)}x`;
}

async function main(): Promise<void> {
    const iterations = Number.parseInt(process.argv[2] ?? '', 10) || DEFAULT_ITERATIONS;
    const maxCandidates = Number.parseInt(process.argv[3] ?? '', 10) || DEFAULT_MAX_CANDIDATES;

    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        // eslint-disable-next-line no-console -- driver output.
        console.error(
            'bench-thinking: CLAUDE_CODE_OAUTH_TOKEN is not set; the subscription path cannot authenticate. Set it (or put it in .env) and re-run.',
        );
        process.exit(1);
    }

    const target = buildTarget();

    // RAW providers (not the budgeted/cached wrapper) so EVERY call is a real,
    // timed network round-trip. ALL isolated + ALL default `json_schema` output
    // mode (the shipped path); only the thinking/effort knobs vary. Baseline (the
    // current default: high effort + adaptive thinking) runs first so the slow
    // reference path is measured before the lowered-reasoning conditions.
    const baseline = new AnthropicAgentProvider({ isolate: true });
    const effortLow = new AnthropicAgentProvider({ isolate: true, effort: 'low' });
    const thinkingDisabled = new AnthropicAgentProvider({
        isolate: true,
        thinking: { type: 'disabled' },
    });

    // eslint-disable-next-line no-console -- driver output.
    console.log(
        `bench-thinking: ${iterations} iteration(s) per condition, maxCandidates=${maxCandidates}\n`,
    );

    const baselineResult = await runCondition(
        'baseline',
        baseline,
        target,
        iterations,
        maxCandidates,
    );
    const effortLowResult = await runCondition(
        'effort-low',
        effortLow,
        target,
        iterations,
        maxCandidates,
    );
    const thinkingDisabledResult = await runCondition(
        'thinking-disabled',
        thinkingDisabled,
        target,
        iterations,
        maxCandidates,
    );

    // eslint-disable-next-line no-console -- driver output.
    console.log('\n--- summary ---');
    printConditionSummary(baselineResult);
    printConditionSummary(effortLowResult);
    printConditionSummary(thinkingDisabledResult);

    const effortLowSpeedup = speedupVsBaseline(baselineResult, effortLowResult);
    const thinkingDisabledSpeedup = speedupVsBaseline(baselineResult, thinkingDisabledResult);

    // QUALITY SANITY: fewer / empty candidates under lowered reasoning is the risk
    // to watch — surface whether EVERY condition still returned valid candidates.
    const allValid =
        hasValidCandidates(baselineResult) &&
        hasValidCandidates(effortLowResult) &&
        hasValidCandidates(thinkingDisabledResult);

    // eslint-disable-next-line no-console -- driver output.
    console.log(
        `SPEEDUP vs baseline — effort-low: ${effortLowSpeedup}, thinking-disabled: ${thinkingDisabledSpeedup}`,
    );
    // eslint-disable-next-line no-console -- driver output.
    console.log(`all conditions returned valid (non-zero) candidates: ${allValid ? 'yes' : 'NO'}`);
}

await main();
