/*
 * The Node-only driver orchestration (functional-architecture §2 / §3.1 / §6).
 *
 * `runLlmMutation(opts)` is the single-process driver, mirroring the proven
 * `scripts/m0-isambard-proof.mjs`:
 *   (1) read + parse the target config (`readTargetConfig`);
 *   (2) build the PURE run plan (`buildRunPlan`) — gate switches, select
 *       heuristics, map flags → Stryker options, decide injection mode;
 *   (3) dynamicLLM gating: credential fail-fast, then the M3 async pre-pass that
 *       targets → batched propose → filters → builds the precomputed map → ONE
 *       injected synchronous `llm` LLMMutator;
 *   (4) `injectMutators(selected, { mode })` into the deep-imported `allMutators`;
 *   (5) `process.chdir(projectDir)` so Stryker resolves config/target/reporters
 *       from the project root (exactly as m0 does);
 *   (6) construct `new Stryker(partialOptions)` and `await runMutationTest()`;
 *   (7) run the M4 reporter (survivor view + cost) over the `MutantResult[]`.
 *
 * SAME-INSTANCE GUARANTEE: `injectMutators` deep-imports `allMutators` from THIS
 * package's `node_modules/@stryker-mutator/instrumenter/...`, and `Stryker` here
 * imports from THIS package's `@stryker-mutator/core`, so Stryker's in-process
 * `MutantInstrumenterExecutor` reads the very array we mutated. Injection + the
 * `new Stryker()` call MUST be in the same process — they are.
 *
 * NODE-ONLY: this module imports `@stryker-mutator/core`, whose instrumenter
 * throws `generator is not a function` under Bun. It therefore CANNOT be exercised
 * by `bun test` and is COVERAGE-EXEMPT (added to bunfig `coveragePathIgnorePatterns`,
 * like `scripts/`); the live invocation is the human-run isambard proof. All the
 * PURE decision logic it calls (`buildRunPlan`, `selectHeuristicMutators`,
 * `gateSwitches`, `assertLlmCredentials`, `buildLlmMutator`, `parseArgs`,
 * `readTargetConfig`, `formatReport`) IS unit-tested offline. The DRY-RUN path
 * here also avoids `new Stryker()`, so it is sandbox-safe.
 */

import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Stryker } from '@stryker-mutator/core';
import type { MutantResult, PartialStrykerOptions } from '@stryker-mutator/api/core';

import { injectMutators } from '../injection';
import { createProvider } from '../llm/factory';
import { CostAccumulator, ResponseCache } from '../llm/index';
import { createBudgetedProvider } from '../pipeline/budgeted-provider';
import type { LlmMutatorMap } from '../pipeline/llm-map';
import { correlateEnrichment } from '../report/correlate';
import { formatReport, type ReportOutput } from '../report/index';
import type { RunOptions } from './cli-args';
import { readTargetConfig } from './config-reader';
import { assertLlmCredentials, buildLlmMutator } from './gate';
import { buildRunPlan, type RunPlan } from './plan';
import { readMutateSources } from './read-sources';

/** A line emitter for the driver's human-facing output. Injectable for the bin. */
export type LogFn = (line: string) => void;

/** The default logger writes a line to stdout. */
const defaultLog: LogFn = line => {
    process.stdout.write(`${line}\n`);
};

/** The outcome of {@link runLlmMutation}. */
export interface RunLlmMutationResult {
    /** The plan that was built (always present, even on a dry run). */
    plan: RunPlan;
    /**
     * Stryker's `MutantResult[]` when `--live` actually ran, or `undefined` on a
     * `--dry-run` (which never constructs `new Stryker()`).
     */
    results?: MutantResult[];
}

/** Print the human-readable plan summary (shared by dry-run and live). */
function printPlan(plan: RunPlan, log: LogFn): void {
    log(
        `stryker-llm: project=${plan.projectDir} mode=${plan.mode} ${plan.live ? 'LIVE' : 'DRY-RUN'}`,
    );
    if (plan.gate.warning) {
        log(`WARNING: ${plan.gate.warning}`);
    }
    if (plan.selection.unimplemented.length > 0) {
        log(
            `note: requested operators not yet implemented (ignored): ${plan.selection.unimplemented.join(', ')}`,
        );
    }
    const names = plan.injectedMutators.map(m => m.name);
    log(
        names.length > 0
            ? `injecting ${String(names.length)} heuristic mutator(s): ${names.join(', ')}`
            : 'no custom heuristic mutators selected',
    );
}

/**
 * Run (or dry-run) an LLM-augmented mutation test against `opts.projectDir`. The
 * decision logic is the PURE {@link buildRunPlan}; this function performs the side
 * effects the plan describes.
 *
 * @param opts The parsed CLI run options.
 * @param log Output sink (defaults to stdout); injectable for the bin/tests.
 */
export async function runLlmMutation(
    opts: RunOptions,
    log: LogFn = defaultLog,
): Promise<RunLlmMutationResult> {
    // (1) Read the target config (fills all defaults; absent block → heuristics-on).
    const { config, configFilePath } = await readTargetConfig(opts.projectDir, opts.configFile);

    // (2) Build the pure plan.
    const plan = buildRunPlan(opts, config, configFilePath);
    printPlan(plan, log);

    // (3) DynamicLLM gating: credential fail-fast (real), then the M3 pre-pass.
    //     The credential check runs FIRST so missing creds surface as a
    //     credentials error before any provider is constructed.
    let costSnapshot = { totalUsd: 0, calls: 0 };
    let llmMap: LlmMutatorMap | undefined;
    if (plan.gate.runDynamicLLM) {
        assertLlmCredentials(config);
        // Construct the provider, wrap it with cache + cost + budget enforcement,
        // read the mutate-glob sources, and run the async pre-pass → precomputed
        // map → ONE injected `llm` LLMMutator (the seam invariant: all LLM work is
        // the pre-pass; the injected mutator is synchronous).
        const cost = new CostAccumulator();
        const cache = new ResponseCache(resolve(plan.projectDir, config.cacheDir));
        // FROZEN-SET / CI-gating mode: `--frozen` (CLI) overrides config
        // `dynamicLLM.frozen`. When effective, the budgeted provider runs
        // CACHE-ONLY — a cache MISS yields no mutant (no network), so the run is a
        // deterministic, free re-score of the already-cached LLM proposals
        // (functional-architecture §3.4 / §7). When `--frozen` is absent the config
        // value stands (so a config `frozen: true` still takes effect).
        const frozen = opts.frozen ?? config.dynamicLLM.frozen;
        const provider = createBudgetedProvider(createProvider(config), {
            cache,
            cost,
            maxCostUsd: config.dynamicLLM.budget.maxCostUsd,
            maxLlmCallsPerRun: config.dynamicLLM.budget.maxLlmCallsPerRun,
            defaultModel: config.model,
            log,
            ...(frozen ? { cacheOnly: true } : {}),
        });
        if (frozen) {
            log(
                'stryker-llm: frozen-set mode (cache-only): re-scoring only already-cached ' +
                    'LLM proposals; cache misses yield no mutant — deterministic re-score.',
            );
        }
        const files = await readMutateSources(plan.projectDir, plan.strykerOptions.mutate);
        const built = await buildLlmMutator(config, {
            provider,
            costAccumulator: cost,
            files,
            cwd: resolve(plan.projectDir),
            log,
        });
        plan.injectedMutators.push(built.mutator);
        costSnapshot = built.costSnapshot;
        llmMap = built.map;
        log(
            `stryker-llm: LLM pre-pass cost $${costSnapshot.totalUsd.toFixed(2)} / ` +
                `${String(costSnapshot.calls)} calls`,
        );
    }

    // DRY-RUN: never construct Stryker (no child procs, sandbox-safe).
    if (!plan.live) {
        log('dry-run: plan validated; Stryker NOT invoked (pass --live to run).');
        return { plan };
    }

    // (4) Inject our mutators into the shared `allMutators` registry.
    if (plan.injectedMutators.length > 0) {
        injectMutators(plan.injectedMutators, { mode: plan.mode });
    }

    // (5) chdir so Stryker resolves config/target/reporters from the project root.
    process.chdir(plan.projectDir);

    // (6) Construct stock Stryker with the assembled options and run.
    const stryker = new Stryker(plan.strykerOptions as PartialStrykerOptions);
    const results = await stryker.runMutationTest();

    log(`stryker-llm: completed with ${String(results.length)} mutant result(s).`);

    // (7) M4 reporter: our survivor view + cost summary on top of Stryker's
    //     standard report (also called on the heuristics-only path — cost is 0).
    const enrichment = llmMap === undefined ? undefined : correlateEnrichment(results, llmMap);
    const report = formatReport(
        results,
        costSnapshot,
        enrichment === undefined ? {} : { enrichment },
    );
    log(report.survivorsText);
    log(report.summaryText);
    await writeFilteredReport(plan, report);

    return { plan, results };
}

/** Write the filtered our-mutants-only artifact to `reports/mutation-llm.json`. */
async function writeFilteredReport(plan: RunPlan, report: ReportOutput): Promise<void> {
    const outPath = resolve(plan.projectDir, 'reports', 'mutation-llm.json');
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report.filtered, null, 2)}\n`, 'utf8');
}
