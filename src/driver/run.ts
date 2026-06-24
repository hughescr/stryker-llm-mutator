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
import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Stryker } from '@stryker-mutator/core';
import type { MutantResult, PartialStrykerOptions } from '@stryker-mutator/api/core';

import { injectMutators } from '../injection';
import { createProvider } from '../llm/factory';
import { CostAccumulator, ResponseCache } from '../llm/index';
import { createBudgetedProvider } from '../pipeline/budgeted-provider';
import { LLM_MUTATOR_NAME } from '../mutators/llm-mutator';
import { type LlmMutatorMap, locKeyFromBabelLoc } from '../pipeline/llm-map';
import type { SourceFileInput } from '../pipeline/targeting';
import { formatReport, type MutantEnrichment, type ReportOutput } from '../report/index';
import type { RunOptions } from './cli-args';
import { readTargetConfig } from './config-reader';
import { assertLlmCredentials, buildLlmMutator } from './gate';
import { buildRunPlan, type RunPlan } from './plan';

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
        const provider = createBudgetedProvider(createProvider(config), {
            cache,
            cost,
            maxCostUsd: config.dynamicLLM.budget.maxCostUsd,
            maxLlmCallsPerRun: config.dynamicLLM.budget.maxLlmCallsPerRun,
            defaultModel: config.model,
            log,
        });
        const files = await readMutateSources(plan);
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

/**
 * Read the source files Stryker will mutate (the `mutate` glob set), so the
 * pre-pass can target them. Node-only (filesystem); reuses the resolved `mutate`
 * globs, falling back to `src/**` TS. Returns absolute fileNames + content so the
 * pure pre-pass stays independent of glob mechanics.
 *
 * Uses Node 26's `glob` from `node:fs/promises` (an async iterator). It yields
 * paths RELATIVE to its `cwd` option, so each match is resolved against
 * `projectDir` to the ABSOLUTE fileName the pre-pass + reporter key on (see the
 * locKey contract in `src/pipeline/llm-map.ts`). Bun also implements this
 * `node:fs/promises` `glob`, so the same code runs under both runtimes. Negated
 * `!`-patterns are not handled (matching the prior Bun behaviour): each pattern
 * is treated positively.
 */
async function readMutateSources(plan: RunPlan): Promise<SourceFileInput[]> {
    const projectDir = resolve(plan.projectDir);
    const patterns =
        plan.strykerOptions.mutate !== undefined && plan.strykerOptions.mutate.length > 0
            ? plan.strykerOptions.mutate
            : ['src/**/*.ts'];

    const seen = new Set<string>();
    const files: SourceFileInput[] = [];
    for (const pattern of patterns) {
        // oxlint-disable-next-line no-await-in-loop -- sequential glob scans accumulate into one set; the volume is small (one or a few patterns).
        for await (const match of glob(pattern, { cwd: projectDir })) {
            // Node yields cwd-relative paths; resolve to the absolute fileName.
            const absolute = resolve(projectDir, match);
            if (seen.has(absolute)) {
                continue;
            }
            seen.add(absolute);
            // oxlint-disable-next-line no-await-in-loop -- reading discovered files; bounded by the mutate glob set.
            const content = await readFile(absolute, 'utf8');
            files.push({ fileName: absolute, content });
        }
    }
    return files;
}

/**
 * Build the reporter's id→enrichment side-table by correlating each LLM
 * `MutantResult` back to its precomputed-map entry via location. Stryker assigns
 * mutant ids at instrument time (unknown to the pre-pass), so post-run
 * correlation by `(fileName, location)` is the only way to recover the per-
 * candidate `llm/<tag>` + original + rationale for OUR survivor view.
 *
 * LOCATION CONVERSION: the map's locKey is babel (1-based line / 0-based column);
 * `MutantResult.location` is the schema's 1-based line AND 1-based column, so the
 * babel column = `location.column - 1`. When a span carries multiple candidates
 * we cannot tell which result is which (Stryker collapses per-candidate identity),
 * so we attach the FIRST entry's metadata — coarse but honest; the filtered
 * artifact still lists every candidate.
 */
function correlateEnrichment(
    results: readonly MutantResult[],
    map: LlmMutatorMap,
): Map<string, MutantEnrichment> {
    const enrichment = new Map<string, MutantEnrichment>();
    for (const result of results) {
        if (result.mutatorName !== LLM_MUTATOR_NAME) {
            continue;
        }
        const byLoc = map.get(result.fileName);
        if (byLoc === undefined) {
            continue;
        }
        const loc = result.location;
        const key = locKeyFromBabelLoc({
            start: { line: loc.start.line, column: loc.start.column - 1 },
            end: { line: loc.end.line, column: loc.end.column - 1 },
        });
        const entries = byLoc.get(key);
        const entry = entries?.[0];
        if (entry === undefined) {
            continue;
        }
        const tag = entry.mutatorName.startsWith('llm/')
            ? entry.mutatorName.slice('llm/'.length)
            : undefined;
        enrichment.set(result.id, {
            ...(entry.original === undefined ? {} : { original: entry.original }),
            ...(tag === undefined ? {} : { tag }),
            ...(entry.rationale === undefined ? {} : { rationale: entry.rationale }),
        });
    }
    return enrichment;
}

/** Write the filtered our-mutants-only artifact to `reports/mutation-llm.json`. */
async function writeFilteredReport(plan: RunPlan, report: ReportOutput): Promise<void> {
    const outPath = resolve(plan.projectDir, 'reports', 'mutation-llm.json');
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report.filtered, null, 2)}\n`, 'utf8');
}
