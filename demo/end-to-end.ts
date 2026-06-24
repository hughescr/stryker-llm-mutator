/*
 * End-to-end vertical-slice demo (development-plan §5 phase 2).
 *
 * Wires the thin runtime slice end to end on a tiny bundled example:
 *
 *   pipeline.propose(provider, target)   // stage-2: LLM proposes candidates
 *     -> applyFilters(...)               // cheap, no-LLM winnowing (§4.3)
 *     -> seam.instrument(files, edits)   // Stryker's own instrumenter, out-of-band
 *     -> seam.runMutants(...)            // score each mutant killed/survived
 *     -> print a per-mutant verdict + total LLM cost.
 *
 * It is provider-agnostic by construction: `propose` takes an `LLMProvider` by
 * dependency injection and never branches on whether the backend is agentic or
 * one-shot. By DEFAULT it runs fully OFFLINE with the deterministic
 * `MockProvider` (no network, canned candidate), so `bun run demo/end-to-end.ts`
 * works with no credentials.
 *
 * ── Running it LIVE against Anthropic (subscription path) ────────────────────
 * A human runs the real LLM end-to-end in the MAIN thread (background agents
 * cannot clear this environment's network sandbox prompt — development-plan §5
 * network note). Provide a subscription OAuth token and select the live
 * provider:
 *
 *     export CLAUDE_CODE_OAUTH_TOKEN=...        # subscription token
 *     unset ANTHROPIC_API_KEY                   # the API key OUTRANKS the token;
 *                                               # the provider strips it per-call,
 *                                               # but unsetting it is the clearest
 *                                               # way to force the subscription path
 *     bun run demo/end-to-end.ts --live
 *
 * With `--live` the demo constructs an `AnthropicAgentProvider` (model
 * `claude-haiku-4-5`) which makes ONE real network call inside `propose`. Costs
 * for that call are summed and printed. Without `--live` (the default), nothing
 * touches the network.
 *
 * Runtime requirements (same as the seam): `node` on PATH (the instrumenter runs
 * in a short-lived Node child process — see src/seam/instrument.ts) and `bun` on
 * PATH (the runner executes the fixture's tests with `bun test`).
 */

import { DEFAULT_MODEL } from '../src/config';
import {
    AnthropicAgentProvider,
    CostAccumulator,
    type LLMProvider,
    MockProvider,
    type ProviderRequest,
    type ProviderResult,
} from '../src/llm/index';
import { applyFilters, propose, type ProposeTarget } from '../src/pipeline/index';
import { instrument, runMutants, type SourceFile } from '../src/seam/index';

// ── The bundled example ──────────────────────────────────────────────────────
//
// A trivial pure function plus a behaviour-pinning test. The span we target is
// the `a + b` expression on line index 1 (Stryker's zero-based line / column
// convention — see src/seam/types.ts). `a` is at column 11; `a + b` spans
// columns [11, 16). A test pins `add(2, 3) === 5`, which any `a + b` -> `a * b`
// / `a - b` mutant flips to failing, so such a mutant is reported killed.

const EXAMPLE_NAME = 'add.ts';
const EXAMPLE_SOURCE = `export function add(a: number, b: number): number {\n    return a + b;\n}\n`;
const EXAMPLE_TEST = `import { test, expect } from 'bun:test';\nimport { add } from './add.ts';\ntest('add pins behaviour', () => {\n    expect(add(2, 3)).toBe(5);\n});\n`;

// The sub-expression the model targets (`a + b`), echoed verbatim as `original`.
// Under the node-aligned contract `spanText` is the ENCLOSING FUNCTION and
// propose locates `a + b` inside it to derive the BinaryExpression node's range.
const SPAN_TEXT = 'a + b';
const TARGET: ProposeTarget = {
    fileName: EXAMPLE_NAME,
    // The function's whole-span range (0-based); a fallback only — the per-edit
    // range is the aligned `a + b` BinaryExpression node.
    range: { start: { line: 0, column: 0 }, end: { line: 2, column: 1 } },
    spanText: EXAMPLE_SOURCE,
    context: EXAMPLE_SOURCE,
    fileContent: EXAMPLE_SOURCE,
    spanStartOffset: 0,
    spanEndOffset: EXAMPLE_SOURCE.length,
};

/**
 * The canned candidate the offline {@link MockProvider} returns. Keyed below by
 * the exact prompt `propose` builds, this stands in for a live model response:
 * a single `a + b` -> `a * b` mutation, schema-shaped exactly like the real
 * structured output (`{ candidates: [{ original, replacement, mutatorTag,
 * rationale }] }`).
 */
const CANNED_RESPONSE = {
    candidates: [
        {
            original: SPAN_TEXT,
            replacement: 'a * b',
            mutatorTag: 'arithmetic-swap',
            rationale: 'Swapping addition for multiplication changes the result for most inputs.',
        },
    ],
};

/**
 * Construct the provider. `--live` selects the real Anthropic Agent SDK provider
 * (subscription path, one real network call); otherwise the offline mock that
 * returns {@link CANNED_RESPONSE} for the propose prompt and never touches the
 * network.
 */
function makeProvider(live: boolean): LLMProvider {
    if (live) {
        // Reads CLAUDE_CODE_OAUTH_TOKEN from process.env and strips ANTHROPIC_API_KEY
        // per-call (the API key outranks the token — development-plan §7).
        return new AnthropicAgentProvider({ model: DEFAULT_MODEL });
    }
    // The mock is keyed on the EXACT prompt propose() builds; a responder makes
    // it robust to incidental prompt wording so the offline demo always resolves.
    return new MockProvider({
        responder: () => CANNED_RESPONSE,
        costUsd: 0,
        model: 'mock-model',
    });
}

/**
 * A thin {@link LLMProvider} wrapper that records each call's `costUsd` into a
 * {@link CostAccumulator}, then forwards the result unchanged. This is how the
 * pipeline surfaces per-run spend (development-plan §4.4) without `propose`
 * itself having to know about cost accounting.
 */
function withCostRecording(inner: LLMProvider, cost: CostAccumulator): LLMProvider {
    return {
        name: inner.name,
        async generate<T>(request: ProviderRequest): Promise<ProviderResult<T>> {
            const result = await inner.generate<T>(request);
            cost.add(result.costUsd);
            return result;
        },
    };
}

/** Run the slice and print per-mutant verdicts plus the total LLM cost. */
async function main(): Promise<void> {
    const live = process.argv.includes('--live');
    const cost = new CostAccumulator();
    const provider = withCostRecording(makeProvider(live), cost);

    // eslint-disable-next-line no-console
    console.log(
        `Running end-to-end demo (${live ? 'LIVE Anthropic' : 'offline mock'} provider).\n`,
    );

    // Stage 2: propose. The provider call's cost is summed for the run report.
    // Each candidate's sub-expression is node-aligned; alignment drops are returned
    // alongside the seam-ready replacements.
    const proposed = await propose(provider, TARGET, { maxCandidates: 8 });

    // Cheap deterministic filters: drop unparseable / identical / duplicate edits
    // before we pay to instrument and run them (§4.3).
    const edits = applyFilters(proposed.replacements);

    // eslint-disable-next-line no-console
    console.log(
        `Proposed ${proposed.replacements.length} candidate(s) ` +
            `(${proposed.dropped.length} dropped in node-alignment); ` +
            `${edits.length} survived filters.`,
    );

    const files: SourceFile[] = [{ name: EXAMPLE_NAME, content: EXAMPLE_SOURCE }];

    // Seam: drive Stryker's own instrumenter to emit BOTH coupled artifacts.
    const { files: instrumented, mutants } = await instrument(files, edits);

    // Runner: score each mutant by activating it and running the pinning test.
    const results = await runMutants(mutants, {
        files: instrumented,
        extraFiles: [{ name: 'add.test.ts', content: EXAMPLE_TEST }],
    });

    // eslint-disable-next-line no-console
    console.log(`\nScored ${results.length} mutant(s):`);
    for (const result of results) {
        const mutant = mutants.find(m => m.id === result.id);
        const label = mutant
            ? `${mutant.mutatorName} (${mutant.original} -> ${mutant.replacement})`
            : result.id;
        // eslint-disable-next-line no-console
        console.log(`  [${result.status.toUpperCase()}] ${label}`);
    }

    // Cost: in offline mode this is $0; live it reflects the real Haiku call.
    // The cost-recording wrapper summed each provider call's total_cost_usd.
    const snapshot = cost.snapshot();
    // eslint-disable-next-line no-console
    console.log(
        `\nTotal LLM cost: $${snapshot.totalUsd.toFixed(6)} across ${snapshot.calls} provider call(s).`,
    );
}

await main();
