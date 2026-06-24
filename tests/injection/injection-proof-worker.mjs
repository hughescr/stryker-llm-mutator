/*
 * Node-side worker for the M0 injection proof (development-plan §3.3).
 *
 * WHY A NODE SUBPROCESS (not Bun): Stryker's instrumenter constructs each
 * `Mutant` via `@babel/generator`'s `generate.default` (mutant.js). Under Node,
 * the default import of the CJS `@babel/generator` is the module namespace whose
 * `.default` is the function; under Bun it is the function itself, so `.default`
 * is `undefined` and `Mutant` construction throws `generator is not a function`.
 * This is the SAME interop wall documented in `src/seam/instrument-worker.mjs`.
 * So — exactly like that worker — we run the inject + instrument step in Node.
 *
 * WHAT IT PROVES: pushing OUR real `numberLiteralValueMutator` onto Stryker's
 * shared `allMutators` registry makes Stryker's OWN `transformBabel` (called
 * WITHOUT a `mutators` argument, so it uses the default `allMutators` that now
 * includes ours) emit our mutant — BOTH the manifest record AND the activation
 * switch in the printed source (§3.1). Offline: no `stryker run`, no network.
 *
 * INPUT (argv): [2] path to a bundled ESM module exporting our real
 * `injectMutators` (pre-bundled by the Bun test so Node can import it without
 * the repo's extensionless-import resolution); [3] the source-under-mutation
 * snippet; [4] its file name. Our `numberLiteralValueMutator` is imported
 * straight from its TypeScript source — Node's native type-stripping handles it
 * because that file's only non-type import (`@babel/types`) resolves cleanly.
 *
 * OUTPUT: one JSON object on stdout:
 *   { before, after, injectedNames, ours: [{ id, mutatorName, replacement }],
 *     output, hasHeader }
 * On failure: { error } and exit 1.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Deep imports into the installed instrumenter `dist` tree — worker path style.
// `allMutators` here is the exact instance babel-transformer.js reads by ref.
import { allMutators } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js';
import { transformBabel } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/babel-transformer.js';
import { MutantCollector } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/mutant-collector.js';
import { createParser } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/parsers/index.js';
import { print } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/printers/index.js';

// OUR real mutator, straight from its TS source (Node strips the type-only
// sibling import; `@babel/types` resolves). injectMutators comes from the
// bundle (argv) because its barrel uses extensionless imports Node can't follow.
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

async function run() {
    const bundlePath = process.argv[2];
    const source = process.argv[3];
    const fileName = process.argv[4];
    if (!bundlePath || source === undefined || !fileName) {
        throw new Error('usage: node injection-proof-worker.mjs <bundle.mjs> <source> <fileName>');
    }

    // Import OUR real injection seam from the pre-built bundle.
    const { injectMutators } = await import(pathToFileURL(bundlePath).href);

    const before = allMutators.length;
    // Use OUR real injection function (augment mode), passing THIS process's
    // `allMutators` as the target so it mutates the exact array the in-process
    // instrumenter below reads — sidestepping any module-identity ambiguity
    // between the bundled copy of our source and the worker's own imports.
    const injection = injectMutators([numberLiteralValueMutator], {
        mode: 'augment',
        target: allMutators,
    });
    const after = allMutators.length;

    // Drive Stryker's real pipeline with the DEFAULT mutators (no 4th arg).
    const parser = createParser(INSTRUMENT_OPTIONS);
    const ast = await parser(source, fileName);
    const collector = new MutantCollector();
    transformBabel(ast, collector, {
        options: INSTRUMENT_OPTIONS,
        mutateDescription: true,
        logger: silentLogger,
    });
    const output = print(ast);

    const collected = collector.mutants.map(m => m.toApiMutant());
    const oursMutants = collected
        .filter(m => m.mutatorName === 'NumberLiteralValue')
        .map(m => ({ id: m.id, mutatorName: m.mutatorName, replacement: m.replacement }));

    return {
        before,
        after,
        injectedNames: injection.injectedNames,
        ours: oursMutants,
        output,
        hasHeader: output.includes('__STRYKER_ACTIVE_MUTANT__'),
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
