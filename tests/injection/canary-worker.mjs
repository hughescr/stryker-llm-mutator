/*
 * Node-side worker for the CONSOLIDATED per-version monkeypatch canary
 * (functional-architecture §3.4 silent-break risk / M5). ONE Node-subprocess
 * round-trip that asserts the FOUR load-bearing invariants of the whole
 * monkeypatch-injection architecture, so a Stryker bump that freezes/moves
 * `allMutators` or changes placement semantics fails LOUDLY.
 *
 * WHY A NODE SUBPROCESS (not Bun): Stryker's instrumenter constructs each
 * `Mutant` via `@babel/generator`'s `generate.default`, which is `undefined`
 * under Bun (the CJS-default-interop wall documented in
 * `src/seam/instrument-worker.mjs`). So the REAL instrument step MUST run in Node.
 *
 * THE FOUR INVARIANTS (emitted as one JSON object on stdout):
 *   (1) STRUCTURAL — `allMutators` is still `Array.isArray`, NOT `Object.isFrozen`,
 *       and has the built-in count (16). A drift flags a registry reshape.
 *   (2) DEEP-IMPORT PATHS RESOLVE — mutate.js / babel-transformer.js /
 *       mutant-collector.js / parsers/index.js / printers/index.js all import.
 *       The import statements at the top of this file ARE the assertion: a
 *       moved/renamed dist path throws at module load and fails the spawn. We
 *       also verify BEHAVIORALLY that babel-transformer reads the SAME array we
 *       push to (push → transform → see our mutant).
 *   (3) HEURISTIC instruments+places — inject `numberLiteralValueMutator`
 *       (augment), instrument `export const timeoutMs = 5000;`, see 3
 *       NumberLiteralValue mutants (5001/4999/0) + activation switches.
 *   (4) LLM instruments+places — build a one-entry map (hour>=12 → hour>12),
 *       inject the `llm` mutator, instrument the is-afternoon fixture, see NO
 *       statementMutantPlacer throw, 1 `llm` mutant, + its switch.
 *
 * INPUT (argv): [2] path to a bundled ESM module exporting `injectMutators` +
 * `buildLlmMutatorMap` + `createLlmMutator` (pre-bundled by the Bun test so Node
 * can import past the repo's extensionless TS imports); [3] a JSON-serialized
 * `Replacement[]` (the LLM survivors the Bun test produced via the REAL propose →
 * range-align path).
 *
 * OUTPUT: one JSON object:
 *   { frozen, isArray, builtinCount, deepImportsOk,
 *     heuristic: { count, switches },
 *     llm: { instrumented, count, switches, threw } }
 * On failure: { error } and exit 1.
 */

import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// (2) DEEP-IMPORT PATHS — these five imports ARE the resolution assertion: a
// moved/renamed dist path throws here at module load. `allMutators` is the exact
// instance babel-transformer.js reads by reference.
import { allMutators } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js';
import { transformBabel } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/babel-transformer.js';
import { MutantCollector } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/mutant-collector.js';
import { createParser } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/parsers/index.js';
import { print } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/printers/index.js';

// OUR real heuristic mutator, straight from its TS source (Node strips the
// type-only sibling import; `@babel/types` resolves). The seam + map builders
// come from the bundle (argv) because their barrels use extensionless imports
// Node can't follow.
import { numberLiteralValueMutator } from '../../src/mutators/number-literal-value.ts';

const silentLogger = {
    isTraceEnabled: () => false,
    isDebugEnabled: () => false,
    isInfoEnabled: () => false,
    isWarnEnabled: () => false,
    isErrorEnabled: () => false,
    isFatalEnabled: () => false,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
};

const INSTRUMENT_OPTIONS = { plugins: null, excludedMutations: [], ignorers: [], noHeader: false };

const HEURISTIC_FIXTURE_NAME = 'config.ts';
const HEURISTIC_FIXTURE_SOURCE = 'export const timeoutMs = 5000;\n';

const LLM_FIXTURE_NAME = 'is-afternoon.ts';
const LLM_FIXTURE_SOURCE =
    'export function isAfternoon(hour: number): boolean {\n    return hour >= 12;\n}\n';

/** Instrument one source through the REAL pipeline; returns mutants + printed source. */
async function instrument(source, fileName) {
    const parser = createParser(INSTRUMENT_OPTIONS);
    const ast = await parser(source, fileName);
    const collector = new MutantCollector();
    transformBabel(ast, collector, {
        options: INSTRUMENT_OPTIONS,
        mutateDescription: true,
        logger: silentLogger,
    });
    const output = print(ast);
    return { mutants: collector.mutants.map(m => m.toApiMutant()), output };
}

async function run() {
    const bundlePath = process.argv[2];
    const replacementsJson = process.argv[3];
    if (!bundlePath || !replacementsJson) {
        throw new Error('usage: node canary-worker.mjs <bundle.mjs> <llmReplacementsJson>');
    }

    const { mods } = await import(pathToFileURL(bundlePath).href);
    const { injectMutators, buildLlmMutatorMap, createLlmMutator } = mods;

    // (1) STRUCTURAL invariants — assert BEFORE injecting.
    const isArray = Array.isArray(allMutators);
    const frozen = Object.isFrozen(allMutators);
    const builtinCount = allMutators.length;

    // Snapshot so we can restore the pristine registry between the two instrument
    // passes (each pass injects, then we restore — never leak to other importers).
    const pristine = [...allMutators];

    // (3) HEURISTIC: inject (augment) onto THIS process's `allMutators` (the array
    // the in-process instrumenter reads), instrument, observe our mutant.
    injectMutators([numberLiteralValueMutator], { mode: 'augment', target: allMutators });
    const heuristicRun = await instrument(HEURISTIC_FIXTURE_SOURCE, HEURISTIC_FIXTURE_NAME);
    const heuristicMutants = heuristicRun.mutants.filter(
        m => m.mutatorName === 'NumberLiteralValue',
    );
    const heuristicSwitches = heuristicMutants.every(m =>
        heuristicRun.output.includes(`stryMutAct_9fa48("${m.id}")`),
    );
    // Restore the pristine registry before the LLM pass.
    allMutators.splice(0, allMutators.length, ...pristine);

    // (4) LLM: rebuild the map + mutator IN-PROCESS, inject, instrument the
    // is-afternoon fixture, assert NO statementMutantPlacer throw + the mutant +
    // switch. Stryker keys the per-file map by the ABSOLUTE filename, so resolve.
    const absFileName = path.resolve(LLM_FIXTURE_NAME);
    const replacements = JSON.parse(replacementsJson).map(r => ({ ...r, fileName: absFileName }));
    const { map } = buildLlmMutatorMap(replacements);
    const llmMutator = createLlmMutator(map);
    allMutators.push(llmMutator);

    let llmThrew;
    let llmInstrumented = false;
    let llmMutants = [];
    let llmSwitches = false;
    try {
        const llmRun = await instrument(LLM_FIXTURE_SOURCE, absFileName);
        llmInstrumented = true;
        llmMutants = llmRun.mutants.filter(m => m.mutatorName === 'llm');
        llmSwitches =
            llmMutants.length > 0 &&
            llmMutants.every(m => llmRun.output.includes(`stryMutAct_9fa48("${m.id}")`));
    } catch (error) {
        llmThrew = error instanceof Error ? error.message : String(error);
    } finally {
        // Restore the pristine registry so we never leak our mutators.
        allMutators.splice(0, allMutators.length, ...pristine);
    }

    return {
        frozen,
        isArray,
        builtinCount,
        // (2) BEHAVIORAL deep-import proof: the heuristic pass above pushed onto
        // the array transformBabel reads and our mutant came back — so the array
        // we push (mutate.js) IS the one transformBabel sees (via mutators/index.js).
        deepImportsOk: heuristicMutants.length > 0,
        heuristic: { count: heuristicMutants.length, switches: heuristicSwitches },
        llm: {
            instrumented: llmInstrumented,
            count: llmMutants.length,
            switches: llmSwitches,
            ...(llmThrew === undefined ? {} : { threw: llmThrew }),
        },
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
