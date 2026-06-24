/*
 * The mutant runner (development-plan §3.3 step 2 / §4.2).
 *
 * Takes the instrumented source emitted by `instrument()` plus the mutant
 * manifest, and scores each mutant killed/survived/timeout/error by executing
 * the project's test suite once per mutant with that mutant activated.
 *
 * ACTIVATION is done exactly as Stryker does it: the `__STRYKER_ACTIVE_MUTANT__`
 * environment variable is set to the mutant's id, and the syntax-helper header
 * Stryker baked into the instrumented source reads it into
 * `global.__stryker__.activeMutant`, flipping that one switch to its mutated
 * branch while every other mutant stays dormant. No special runtime is needed —
 * the header is plain JS.
 *
 * RUNNER STRATEGY (honest, for this Phase-0 slice): we use the proof-grade
 * fallback the development plan sanctions for §3.3 step 2. We materialise the
 * instrumented source into a temporary fixture directory, then run that
 * fixture's tests directly with `bun test`, once per mutant, with the activation
 * env var set:
 *   - the test process exits non-zero (a test failed) -> the mutant is `killed`;
 *   - it exits zero (all passed) -> the mutant `survived`;
 *   - it exceeds the timeout -> `timeout`;
 *   - it fails to run at all (e.g. the harness errors) -> `error`.
 * This is sufficient to PROVE the seam end-to-end offline. The intended
 * production path is to drive execution through `@stryker-mutator/api`'s public
 * `TestRunner` contract together with `@hughescr/stryker-bun-runner`'s
 * `BunTestRunner.mutantRun({ activeMutant })` (which sets the SAME env var
 * internally). That wiring is deferred from this slice because `BunTestRunner`
 * needs Stryker DI plumbing — a `Logger` + `StrykerOptions`, an `init()` that
 * writes a sanitized bunfig, an inspector connection, and a sandbox cwd — which
 * is heavier than this thin proof requires. See the blocker note in the slice
 * summary. The output type below (`MutantRunResult` with the same status
 * vocabulary as Stryker's enum) is shaped so swapping in the real runner later
 * does not change this module's contract.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SourceFile } from './instrument';
import type { MutantRunResult, MutantRunStatus, SeamMutant } from './types';

/** Default per-mutant wall-clock timeout for a test run, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The env var Stryker (and the instrumented header) reads to activate a mutant. */
const ACTIVE_MUTANT_ENV = '__STRYKER_ACTIVE_MUTANT__';

/** Options for {@link runMutants}. */
export interface RunMutantsOptions {
    /**
     * The instrumented source files (as emitted by `instrument()`), keyed by the
     * file name they should be written to inside the fixture. File names may be
     * absolute or project-relative; only the basename is used inside the fixture.
     */
    files: readonly SourceFile[];
    /**
     * Extra non-instrumented files (e.g. the test file pinning behaviour) to
     * write into the fixture alongside `files`. Same naming rule.
     */
    extraFiles?: readonly SourceFile[];
    /** Per-mutant timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Path to the `bun` binary. Defaults to `'bun'` (resolved on PATH). */
    bunPath?: string;
}

/** Outcome of running the fixture's tests once. */
interface TestRunOutcome {
    /** True if the test process exited zero (all tests passed). */
    passed: boolean;
    /** True if the run was killed for exceeding the timeout. */
    timedOut: boolean;
    /** True if the test process could not be spawned/run at all (harness error). */
    errored: boolean;
    /** Combined stdout+stderr, for the result `detail`. */
    output: string;
}

/**
 * Run `bun test` in `cwd`, with `activeMutantId` activated (or none, for the
 * baseline), and report whether it passed. The process is killed if it exceeds
 * `timeoutMs`.
 */
function runBunTest(
    cwd: string,
    bunPath: string,
    activeMutantId: string | undefined,
    timeoutMs: number,
): Promise<TestRunOutcome> {
    return new Promise(resolve => {
        const env: Record<string, string> = { ...process.env } as Record<string, string>;
        if (activeMutantId === undefined) {
            delete env[ACTIVE_MUTANT_ENV];
        } else {
            env[ACTIVE_MUTANT_ENV] = activeMutantId;
        }

        const child = spawn(bunPath, ['test'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let timedOut = false;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            output += chunk;
        });
        child.stderr.on('data', chunk => {
            output += chunk;
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        child.on('error', error => {
            clearTimeout(timer);
            resolve({
                passed: false,
                timedOut: false,
                errored: true,
                output: `${output}\n${error.message}`,
            });
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ passed: code === 0 && !timedOut, timedOut, errored: false, output });
        });
    });
}

/**
 * Write the fixture (instrumented source + extra files) into a fresh temp
 * directory and return its path. Files are written by basename so a test file
 * can import the instrumented module by a relative `./name`.
 */
async function materializeFixture(
    files: readonly SourceFile[],
    extraFiles: readonly SourceFile[],
): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'stryker-llm-seam-'));
    await Promise.all(
        [...files, ...extraFiles].map(file =>
            writeFile(path.join(dir, path.basename(file.name)), file.content, 'utf8'),
        ),
    );
    return dir;
}

/**
 * Score every mutant in `mutants` against the instrumented fixture.
 *
 * The fixture is materialised once; the test suite is run once per mutant with
 * that mutant activated via `__STRYKER_ACTIVE_MUTANT__`. A mutant is `killed`
 * when the suite fails under it and `survived` when it passes, `timeout` when
 * the run is killed for exceeding the limit, and `error` when the run could not
 * be executed. Runs are sequential so each mutant is scored in isolation.
 *
 * @param mutants The mutant manifest from `instrument()`.
 * @param options The instrumented files, optional extra fixture files, timeout,
 *   and bun path.
 * @returns One {@link MutantRunResult} per input mutant, in input order.
 */
export async function runMutants(
    mutants: readonly SeamMutant[],
    options: RunMutantsOptions,
): Promise<MutantRunResult[]> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const bunPath = options.bunPath ?? 'bun';
    const dir = await materializeFixture(options.files, options.extraFiles ?? []);

    try {
        const results: MutantRunResult[] = [];
        for (const mutant of mutants) {
            // Sequential by design: each mutant must be scored with only itself
            // active, so we cannot parallelise within one shared fixture dir.
            // oxlint-disable-next-line no-await-in-loop
            const outcome = await runBunTest(dir, bunPath, mutant.id, timeoutMs);
            let status: MutantRunStatus;
            if (outcome.errored) {
                // The test process never ran (e.g. bun binary missing). This is a
                // harness failure, NOT a kill — classifying it as killed would be
                // false coverage (development-plan §7).
                status = 'error';
            } else if (outcome.timedOut) {
                status = 'timeout';
            } else if (!outcome.passed) {
                status = 'killed';
            } else {
                status = 'survived';
            }
            results.push({
                id: mutant.id,
                status,
                detail: status === 'survived' ? undefined : outcome.output.trim().slice(0, 2000),
            });
        }
        return results;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
