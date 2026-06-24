/*
 * Node-side worker for the LLM PLACEMENT proof (functional-architecture §3.1 /
 * §4 Gate 4 / §5 constraint 3).
 *
 * WHY A NODE SUBPROCESS (not Bun): Stryker's instrumenter constructs each
 * `Mutant` via `@babel/generator`'s `generate.default`, which is `undefined`
 * under Bun (the CJS-default-interop wall documented in
 * `src/seam/instrument-worker.mjs` and `injection-proof-worker.mjs`). So the
 * REAL instrument step MUST run in Node.
 *
 * WHAT IT PROVES — THE BUG REGRESSION: an LLM mutant whose replacement is a
 * parsed EXPRESSION (e.g. `hour > 12` for `hour >= 12`) now carries a
 * NODE-ALIGNED range equal to the `hour >= 12` BinaryExpression node, so when we
 * push `createLlmMutator(map)` onto Stryker's REAL `allMutators` and instrument a
 * fixture function through the REAL `transformBabel`, Stryker's expression
 * (ternary) placer accepts it and instrumentation COMPLETES — no
 * `statementMutantPlacer could not place mutants … expected node to be of a type
 * ["Statement"] but instead got "BinaryExpression"` throw. Before the fix the
 * range was the whole FunctionDeclaration (a Statement), so an expression
 * replacement at a statement position threw.
 *
 * INPUT (argv): [2] path to a bundled ESM module exporting `buildLlmMutatorMap` +
 * `createLlmMutator` (pre-bundled by the Bun test so Node can import past the
 * repo's extensionless TS imports); [3] the fixture source; [4] its file name;
 * [5] a JSON-serialized `Replacement[]` (the survivors the Bun test produced via
 * the REAL propose → range-align path).
 *
 * OUTPUT: one JSON object on stdout:
 *   { instrumented, threw, error?, before, after, ours: [{ id, mutatorName,
 *     replacement }], output, hasSwitch }
 */

import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Deep imports into the installed instrumenter `dist` tree — worker path style.
// `allMutators` here is the exact instance babel-transformer.js reads by ref.
import { allMutators } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js';
import { transformBabel } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/babel-transformer.js';
import { MutantCollector } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/mutant-collector.js';
import { createParser } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/parsers/index.js';
import { print } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/printers/index.js';

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

async function run() {
    const bundlePath = process.argv[2];
    const source = process.argv[3];
    const fileName = process.argv[4];
    const replacementsJson = process.argv[5];
    if (!bundlePath || source === undefined || !fileName || !replacementsJson) {
        throw new Error(
            'usage: node llm-placement-proof-worker.mjs <bundle.mjs> <source> <fileName> <replacementsJson>',
        );
    }

    // Import the pre-built bundle exposing the pure (bun-safe) map builders. The
    // Bun test wraps them in a `builders` object (a bare re-export gets
    // tree-shaken to nothing).
    const { builders } = await import(pathToFileURL(bundlePath).href);
    const { buildLlmMutatorMap, createLlmMutator } = builders;

    // Stryker keys the per-file map by the ABSOLUTE filename it threads through
    // `path.hub.file.opts.filename`. The parser is given the same absolute path.
    const absFileName = path.resolve(fileName);
    const replacements = JSON.parse(replacementsJson).map(r => ({ ...r, fileName: absFileName }));

    // Rebuild the precomputed map + the injected mutator IN-PROCESS (Node).
    const { map, dropped } = buildLlmMutatorMap(replacements);
    const llmMutator = createLlmMutator(map);

    const before = allMutators.length;
    // AUGMENT: push our llm mutator onto the REAL registry (alongside built-ins).
    allMutators.push(llmMutator);
    const after = allMutators.length;

    // Drive Stryker's real pipeline with the DEFAULT mutators (no 4th arg), so it
    // picks up the live `allMutators` that now includes ours.
    const parser = createParser(INSTRUMENT_OPTIONS);
    const ast = await parser(source, absFileName);
    const collector = new MutantCollector();

    let threw;
    let instrumented = false;
    let output = '';
    try {
        transformBabel(ast, collector, {
            options: INSTRUMENT_OPTIONS,
            mutateDescription: true,
            logger: silentLogger,
        });
        output = print(ast);
        instrumented = true;
    } catch (error) {
        threw = error instanceof Error ? error.message : String(error);
    } finally {
        // Restore the registry so we never leak our mutator to other importers.
        allMutators.length = before;
    }

    const collected = instrumented ? collector.mutants.map(m => m.toApiMutant()) : [];
    const ours = collected
        .filter(m => m.mutatorName === 'llm')
        .map(m => ({ id: m.id, mutatorName: m.mutatorName, replacement: m.replacement }));

    return {
        instrumented,
        threw,
        before,
        after,
        mapSize: map.size,
        droppedCount: dropped.length,
        ours,
        output,
        hasSwitch: ours.length > 0 && output.includes(`stryMutAct_9fa48("${ours[0].id}")`),
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
