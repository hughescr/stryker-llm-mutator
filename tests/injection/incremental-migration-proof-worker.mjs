/*
 * Node-side worker for the INCREMENTAL MIGRATION proof — runs the REAL
 * `IncrementalDiffer` from this package's `@stryker-mutator/core` against a
 * fixture report to show what `scripts/migrate-incremental-llm-names.ts` buys
 * and what it can never do.
 *
 * WHY A NODE SUBPROCESS: `@stryker-mutator/core` cannot load under Bun (its
 * instrumenter throws `generator is not a function`), so the differ runs here.
 *
 * WHAT IT PROVES (one JSON object on stdout):
 *   (a) an old row still named `llm` → the current `LlmComparison` mutant gets
 *       no status (it re-runs);
 *   (b) the SAME on-disk (1-based) report fed through `migrateIncrementalLlmNames`
 *       and then converted to 0-based the way Stryker's `project-reader.js` does →
 *       the current mutant is REUSED as `Killed`, `killedBy` remapped to the
 *       current test id, `coveredBy` from the current coverage;
 *   (c) the source text INSIDE the mutated span changed → re-run (the differ's own
 *       source diff still applies after migration);
 *   (d) the killing test renamed → re-run (the test-key check still applies);
 *   (e) a migrated row whose name differs from the live mutant's (a forced
 *       different category) → re-run, never a false reuse.
 *
 * INPUT (argv): [2] path to a bundled ESM module exporting `migrateIncrementalLlmNames`.
 */

import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { IncrementalDiffer } from '../../node_modules/@stryker-mutator/core/dist/src/mutants/incremental-differ.js';

const logger = {
    isInfoEnabled: () => false,
    isDebugEnabled: () => false,
    trace() {},
    debug() {},
    info() {},
};

const REL_FILE = 'fixture.ts';
const SOURCE = 'const value = hour >= 12;';
/** `hour >= 12` at 0-based differ coordinates; 1-based on the on-disk report. */
const DIFFER_LOC = { start: { line: 0, column: 14 }, end: { line: 0, column: 24 } };
const DISK_LOC = { start: { line: 1, column: 15 }, end: { line: 1, column: 25 } };

/** The on-disk (1-based) report with ONE legacy `llm` row, Killed by `old-test`. */
function diskReport() {
    return {
        schemaVersion: '2',
        thresholds: { high: 80, low: 60 },
        files: {
            [REL_FILE]: {
                language: 'typescript',
                source: SOURCE,
                mutants: [
                    {
                        id: 'old-id',
                        mutatorName: 'llm',
                        replacement: 'hour > 12',
                        location: DISK_LOC,
                        status: 'Killed',
                        statusReason: 'killed',
                        coveredBy: ['old-test'],
                        killedBy: ['old-test'],
                        testsCompleted: 1,
                    },
                ],
            },
        },
        testFiles: { '': { tests: [{ id: 'old-test', name: 'kills' }] } },
    };
}

/** Convert an on-disk report to the differ's 0-based positions (project-reader.js). */
function toDiffer(report) {
    const files = Object.fromEntries(
        Object.entries(report.files).map(([name, file]) => [
            name,
            {
                ...file,
                mutants: file.mutants.map(m => ({
                    ...m,
                    location: {
                        start: {
                            line: m.location.start.line - 1,
                            column: m.location.start.column - 1,
                        },
                        end: { line: m.location.end.line - 1, column: m.location.end.column - 1 },
                    },
                })),
            },
        ]),
    );
    return { ...report, files };
}

/** Run the real differ over one current mutant against `oldReport`. */
function diff(
    oldReport,
    { currentName = 'LlmComparison', source = SOURCE, testName = 'kills' } = {},
) {
    const absFile = path.resolve(REL_FILE);
    const current = {
        id: 'new-id',
        fileName: absFile,
        location: DIFFER_LOC,
        mutatorName: currentName,
        replacement: 'hour > 12',
    };
    const test = { id: 'new-test', name: testName, status: 'success' };
    const coverage = {
        hasCoverage: true,
        hasStaticCoverage: () => false,
        testsById: new Map([[test.id, test]]),
        forMutant: () => new Set([test]),
        addTest() {},
        addCoverage() {},
    };
    const differ = new IncrementalDiffer(logger, { force: false }, { [absFile]: { mutate: true } });
    const [result] = differ.diff([current], coverage, oldReport, new Map([[REL_FILE, source]]));
    return {
        status: result.status ?? 'rerun',
        killedBy: result.killedBy ?? [],
        coveredBy: result.coveredBy ?? [],
    };
}

async function run() {
    const bundlePath = process.argv[2];
    if (!bundlePath) {
        throw new Error('usage: node incremental-migration-proof-worker.mjs <bundle.mjs>');
    }
    const { mods } = await import(pathToFileURL(bundlePath).href);
    const { migrateIncrementalLlmNames } = mods;

    const legacy = diskReport();
    const { report: migrated, stats } = migrateIncrementalLlmNames(legacy);
    const migratedName = migrated.files[REL_FILE].mutants[0].mutatorName;

    // (e) a row forced to a DIFFERENT category than the live mutant's.
    const forced = structuredClone(migrated);
    forced.files[REL_FILE].mutants[0].mutatorName = 'LlmNumber';

    return {
        migratedName,
        stats,
        a_unmigrated: diff(toDiffer(legacy)),
        b_migrated: diff(toDiffer(migrated)),
        c_sourceChanged: diff(toDiffer(migrated), { source: 'const value = hour >= 13;' }),
        d_testRenamed: diff(toDiffer(migrated), { testName: 'renamed test' }),
        e_wrongName: diff(toDiffer(forced)),
    };
}

try {
    const result = await run();
    process.stdout.write(JSON.stringify(result));
} catch (error) {
    process.stdout.write(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
}
