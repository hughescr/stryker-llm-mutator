/*
 * The Node-only driver orchestration (functional-architecture §2 / §3.1 / §6).
 *
 * `runLlmMutation(opts)` is the single-process driver, mirroring the proven
 * `scripts/m0-isambard-proof.mjs`:
 *   (1) read + parse the target config (`readTargetConfig`);
 *   (2) build the PURE run plan (`buildRunPlan`) — gate switches, select
 *       heuristics, map flags → Stryker options, decide injection mode;
 *   (3) dynamicLLM gating: credential fail-fast + the Phase-A throw-stub;
 *   (4) `injectMutators(selected, { mode })` into the deep-imported `allMutators`;
 *   (5) `process.chdir(projectDir)` so Stryker resolves config/target/reporters
 *       from the project root (exactly as m0 does);
 *   (6) construct `new Stryker(partialOptions)` and `await runMutationTest()`;
 *   (7) return the `MutantResult[]`.
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
 * `gateSwitches`, `assertLlmCredentials`, `parseArgs`, `readTargetConfig`) IS
 * unit-tested offline. The DRY-RUN path here also avoids `new Stryker()`, so it is
 * sandbox-safe.
 */

import process from 'node:process';

import { Stryker } from '@stryker-mutator/core';
import type { MutantResult, PartialStrykerOptions } from '@stryker-mutator/api/core';

import { injectMutators } from '../injection';
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

    // (3) DynamicLLM gating: credential fail-fast (real), then the Phase-A stub.
    //     buildLlmMutator() throws NotImplementedError today; the credential check
    //     runs FIRST so missing creds surface as a credentials error. Both fire on
    //     a dry-run too, so a user planning a dynamicLLM run learns it is gated.
    if (plan.gate.runDynamicLLM) {
        assertLlmCredentials(config);
        // M3 replaces this throw with: pre-pass → precomputed map → push an
        // `llm/<tag>` LLMMutator into `plan.injectedMutators`.
        buildLlmMutator(config);
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
    return { plan, results };
}
