/*
 * The real Stryker REPORTER PLUGIN (M6 consumable path / functional-architecture
 * §6 reporting). On the `stryker-llm` CLI path, `run.ts` calls `formatReport`
 * directly on the `MutantResult[]`. On the STOCK `stryker run` path the consumer
 * cannot call our reporter — so we ship a real `PluginKind.Reporter` plugin the
 * consumer activates by listing it in `reporters: ['llm-mutator', ...]`. It renders
 * OUR view (survivors + LLM cost) on top of Stryker's standard report.
 *
 * WIRING (documented in the README):
 *   plugins:   ['@hughescr/stryker-llm-mutator']   // so the loader reads our strykerPlugins
 *   reporters: ['llm-mutator', 'html', 'clear-text'] // so this plugin actually runs
 * Stryker auto-loads `node_modules/@stryker-mutator/*` plugins but NOT third-party
 * ones, so the explicit `plugins:[...]` entry is required.
 *
 * HOOK CHOICE — collect via `onMutantTested`, render at `onMutationTestReportReady`:
 *   `formatReport` consumes the native `MutantResult` shape (id / fileName /
 *   location / mutatorName / status / replacement). `onMutantTested(result)`
 *   receives exactly that shape, so we COLLECT each result; the alternative
 *   (`onMutationTestReportReady`'s `schema.MutationTestResult`) is keyed
 *   files→{mutants[]} and would need a lossy remap. We collect, then at
 *   `onMutationTestReportReady` (fired once at the end) we render.
 *
 * COST + ENRICHMENT come from the runtime-state singleton the wrapper populated
 * during config evaluation (same process): the pre-pass cost snapshot + the
 * precomputed map. We rebuild the id→enrichment table the same way `run.ts` does —
 * via the shared `correlateEnrichment` — so the survivor view shows original text +
 * the precise `llm/<tag>` + rationale. On a heuristics-only run the map is absent
 * and cost is zero (no enrichment, cost line reads $0.00).
 *
 * NODE-ONLY DI: it imports `@stryker-mutator/api/*` only (NOT core). The plugin is
 * declared with `declareFactoryPlugin` and injects `commonTokens.logger` so it can
 * emit through Stryker's own logger.
 */

import {
    commonTokens,
    declareFactoryPlugin,
    PluginKind,
    tokens,
} from '@stryker-mutator/api/plugin';
import type { MutantResult } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import type { Reporter } from '@stryker-mutator/api/report';

import { correlateEnrichment } from './correlate';
import { formatReport } from './reporter';
import { getRuntimeState, resetRuntimeState } from '../runtime-state';

/** The plugin name the user lists in `reporters: ['llm-mutator', ...]`. */
export const LLM_MUTATOR_REPORTER_NAME = 'llm-mutator';

/**
 * The `llm-mutator` Reporter. Collects each `MutantResult` as it is tested, then at
 * report-ready renders OUR survivor view + LLM cost (from the runtime-state the
 * wrapper populated) through the injected Stryker logger.
 */
class LlmMutatorReporter implements Reporter {
    readonly #logger: Logger;
    readonly #results: MutantResult[] = [];

    constructor(logger: Logger) {
        this.#logger = logger;
    }

    /** Collect each tested mutant in its native shape (the shape `formatReport` wants). */
    onMutantTested(result: Readonly<MutantResult>): void {
        this.#results.push(result);
    }

    /**
     * Render our view once at the end. Reads the pre-pass cost + map from the
     * runtime-state singleton, correlates LLM enrichment, and logs the survivor +
     * summary sections via Stryker's logger. Resets the runtime-state afterward so a
     * subsequent run in the same process starts clean.
     */
    onMutationTestReportReady(): void {
        const { cost, map } = getRuntimeState();
        const enrichment = map === undefined ? undefined : correlateEnrichment(this.#results, map);
        const report = formatReport(
            this.#results,
            cost,
            enrichment === undefined ? {} : { enrichment },
        );
        this.#logger.info(report.survivorsText);
        this.#logger.info(report.summaryText);
        // The injected mutators left their cost/map in the shared singleton; clear
        // it so a re-run (watch mode, a second test) does not inherit this run's state.
        resetRuntimeState();
    }
}

/** Factory that constructs the reporter with the injected Stryker logger. */
function llmMutatorReporterFactory(logger: Logger): Reporter {
    return new LlmMutatorReporter(logger);
}
llmMutatorReporterFactory.inject = tokens(commonTokens.logger);

/**
 * The declared `llm-mutator` Reporter plugin. Exported into `strykerPlugins` from
 * `src/index.ts`; Stryker's plugin-loader reads that array when the consumer lists
 * this package in `plugins:[...]`.
 */
export const llmMutatorReporterPlugin = declareFactoryPlugin(
    PluginKind.Reporter,
    LLM_MUTATOR_REPORTER_NAME,
    llmMutatorReporterFactory,
);
