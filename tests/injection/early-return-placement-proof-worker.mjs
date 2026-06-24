/*
 * Node-side worker for the EARLY-RETURN PLACEMENT proof (functional-architecture
 * §3.1 / §5 constraint 3 + the EarlyReturnInjection footnote).
 *
 * WHY A NODE SUBPROCESS (not Bun): Stryker's instrumenter constructs each
 * `Mutant` via `@babel/generator`'s `generate.default`, which is `undefined`
 * under Bun (the CJS-default-interop wall documented in
 * `src/seam/instrument-worker.mjs`, `injection-proof-worker.mjs`, and
 * `llm-placement-proof-worker.mjs`). So the REAL instrument step MUST run in Node.
 *
 * WHAT IT PROVES — THE STATEMENT-SHAPED PLACEMENT CONTRACT: EarlyReturnInjection
 * is the ONLY statement-shaped heuristic operator. Its `mutate()` yields a
 * `BlockStatement` to REPLACE a function-body `BlockStatement` node. Stryker's
 * `statementMutantPlacer` (`canPlace = path.isStatement()`) must accept that — it
 * special-cases `path.isBlockStatement()` and wraps the placed block correctly. If
 * a future Stryker changed that contract, an early-return mutant would fail to
 * place with a `statementMutantPlacer could not place mutants` throw. This worker
 * pushes `earlyReturnInjectionMutator` onto the REAL `allMutators` and instruments
 * a real function through the REAL `transformBabel`/`createParser`/`print`,
 * asserting instrumentation COMPLETES (no throw), BOTH mutants appear in the
 * manifest, and BOTH activation switches appear in the printed source.
 *
 * INPUT (argv): [2] the fixture source; [3] its file name. The mutator is imported
 * straight from its TypeScript source — Node's native type-stripping handles it
 * because that file's only non-type import (`@babel/types`) resolves cleanly (the
 * same move `injection-proof-worker.mjs` uses), so NO pre-built bundle is needed.
 *
 * OUTPUT: one JSON object on stdout:
 *   { instrumented, threw, error?, before, after, ours: [{ id, mutatorName,
 *     replacement }], output, hasSwitches }
 */

import process from 'node:process';
import path from 'node:path';

// Deep imports into the installed instrumenter `dist` tree — worker path style.
// `allMutators` here is the exact instance babel-transformer.js reads by ref.
import { allMutators } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js';
import { transformBabel } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/babel-transformer.js';
import { MutantCollector } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/mutant-collector.js';
import { createParser } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/parsers/index.js';
import { print } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/printers/index.js';

// OUR real statement-shaped mutator, straight from its TS source (Node strips the
// type-only sibling import; `@babel/types` resolves).
import { earlyReturnInjectionMutator } from '../../src/mutators/early-return-injection.ts';

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
    const source = process.argv[2];
    const fileName = process.argv[3];
    if (source === undefined || !fileName) {
        throw new Error('usage: node early-return-placement-proof-worker.mjs <source> <fileName>');
    }

    const absFileName = path.resolve(fileName);

    const before = allMutators.length;
    // AUGMENT: push our statement-shaped mutator onto the REAL registry.
    allMutators.push(earlyReturnInjectionMutator);
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
        .filter(m => m.mutatorName === 'EarlyReturnInjection')
        .map(m => ({ id: m.id, mutatorName: m.mutatorName, replacement: m.replacement }));

    return {
        instrumented,
        threw,
        before,
        after,
        ours,
        output,
        hasSwitches:
            ours.length > 0 && ours.every(m => output.includes(`stryMutAct_9fa48("${m.id}")`)),
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
