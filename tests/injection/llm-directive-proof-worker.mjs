/*
 * Node-side worker for the LLM DIRECTIVE proof (functional-architecture §5
 * "Equivalence/disable-comment handling" / the `Llm<Category>` naming fix).
 *
 * WHY A NODE SUBPROCESS (not Bun): Stryker's instrumenter constructs each
 * `Mutant` via `@babel/generator`'s `generate.default`, which is `undefined`
 * under Bun (the CJS-default-interop wall documented in
 * `src/seam/instrument-worker.mjs`). So the REAL instrument step MUST run in Node.
 *
 * WHAT IT PROVES, against the REAL `transformBabel` + `DirectiveBookkeeper`:
 *   • REGISTRATION: after pushing `createLlmMutators(map)` (+ the heuristics)
 *     `allMutators` contains every `LLM_MUTATOR_NAMES` entry exactly once and no
 *     lowercase collision with any built-in;
 *   • on a shared span `hour >= 12` carrying THREE real category entries
 *     (LlmComparison `hour > 12`, LlmLogical `hour >= 12 || false`, LlmNumber
 *     `hour >= 13`), every legacy directive form found in isambard ignores all
 *     three — reported by Stryker itself as `status: 'Ignored'` with the
 *     directive's reason — while a category directive ignores only its own, the
 *     `restore LlmNumber` inside a `disable llm` region restores only that one,
 *     `excludedMutations` from the CLI plan's own expanded list ignores all three
 *     while the unexpanded `['llm']` control leaves them live, and the logger's
 *     `warn()` is never called and the printed source keeps the ORIGINAL comment.
 *
 * INPUT (argv): [2] path to a bundled ESM module exporting the builders +
 * `installLlmDirectiveAliasIntoStryker` + `heuristicMutators` + `LLM_MUTATOR_NAMES`
 * + `buildRunPlan` + `llmMutatorConfigSchema`; [3] a JSON object of named
 * fixture sources; [4] a JSON `Replacement[]` template for the three entries —
 * the worker re-keys them onto every `hour >= 12` occurrence of each fixture.
 * Reported `line`s are Stryker API locations (0-based).
 *
 * OUTPUT: one JSON object:
 *   { registration: { names, duplicates, collisions }, cases: { <name>: [{ mutatorName,
 *     line, status, statusReason }] }, excluded: { expanded: [...], control: [...],
 *     planList }, warns: [...], commentsIntact: { <name>: boolean } }
 */

import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { allMutators } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js';
import { transformBabel } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/babel-transformer.js';
import { MutantCollector } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/mutant-collector.js';
import { createParser } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/parsers/index.js';
import { print } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/printers/index.js';

const warns = [];
const logger = {
    isTraceEnabled: () => false,
    isDebugEnabled: () => false,
    isInfoEnabled: () => false,
    isWarnEnabled: () => true,
    isErrorEnabled: () => false,
    isFatalEnabled: () => false,
    trace() {},
    debug() {},
    info() {},
    warn(message) {
        warns.push(message);
    },
    error() {},
    fatal() {},
};

/** Instrument one fixture; return our mutants (+ status) and the printed source. */
async function instrument(source, fileName, excludedMutations, isOurs) {
    const options = { plugins: null, excludedMutations, ignorers: [], noHeader: false };
    const parser = createParser(options);
    const ast = await parser(source, fileName);
    const collector = new MutantCollector();
    transformBabel(ast, collector, { options, mutateDescription: true, logger });
    const output = print(ast);
    const ours = collector.mutants
        .map(m => m.toApiMutant())
        .filter(m => isOurs(m.mutatorName))
        .map(m => ({
            mutatorName: m.mutatorName,
            line: m.location.start.line,
            ...(m.status === undefined ? {} : { status: m.status }),
            ...(m.statusReason === undefined ? {} : { statusReason: m.statusReason }),
        }));
    return { ours, output };
}

/** The 0-based line + column of each `hour >= 12` occurrence in a fixture source. */
function spanLines(source) {
    return source
        .split('\n')
        .map((line, index) => ({ line: index, column: line.indexOf('hour >= 12') }))
        .filter(({ column }) => column !== -1);
}

async function run() {
    const [, , bundlePath, fixturesJson, templateJson] = process.argv;
    if (!bundlePath || !fixturesJson || !templateJson) {
        throw new Error(
            'usage: node llm-directive-proof-worker.mjs <bundle.mjs> <fixturesJson> <templateJson>',
        );
    }
    const { mods } = await import(pathToFileURL(bundlePath).href);
    const {
        buildLlmMutatorMap,
        createLlmMutators,
        isLlmMutatorName,
        LLM_MUTATOR_NAMES,
        heuristicMutators,
        installLlmDirectiveAliasIntoStryker,
        buildRunPlan,
        llmMutatorConfigSchema,
    } = mods;
    const fixtures = JSON.parse(fixturesJson);
    const template = JSON.parse(templateJson);
    const absFileName = path.resolve('fixture.ts');

    const pristine = [...allMutators];
    const installed = await installLlmDirectiveAliasIntoStryker(() => {});

    /** Entries for every `hour >= 12` line of a fixture, from the template. */
    const entriesFor = source =>
        spanLines(source).flatMap(({ line, column }) =>
            template.map(r => ({
                ...r,
                fileName: absFileName,
                range: {
                    start: { line, column },
                    end: { line, column: column + r.original.length },
                },
            })),
        );

    // REGISTRATION: push ours (+ heuristics) once and inspect the registry.
    const registrationSource = fixtures.none;
    allMutators.push(
        ...heuristicMutators,
        ...createLlmMutators(buildLlmMutatorMap(entriesFor(registrationSource)).map),
    );
    const names = allMutators.map(m => m.name);
    const lower = names.map(n => n.toLowerCase());
    const registration = {
        names: LLM_MUTATOR_NAMES.filter(n => names.includes(n)),
        duplicates: LLM_MUTATOR_NAMES.filter(n => names.filter(x => x === n).length !== 1),
        collisions: lower.filter((n, i) => lower.indexOf(n) !== i),
    };
    allMutators.splice(0, allMutators.length, ...pristine);

    const cases = {};
    const commentsIntact = {};
    for (const [name, source] of Object.entries(fixtures)) {
        // Heuristics registered too, as on a real run: the list-form fixtures
        // name `NumberLiteralValue`, which must be a known mutator.
        allMutators.push(
            ...heuristicMutators,
            ...createLlmMutators(buildLlmMutatorMap(entriesFor(source)).map),
        );
        try {
            // oxlint-disable-next-line no-await-in-loop -- each case must run against its own registry state (push → instrument → restore); they cannot overlap.
            const { ours, output } = await instrument(source, absFileName, [], isLlmMutatorName);
            cases[name] = ours;
            const directives = source
                .split('\n')
                .filter(line => line.includes('// Stryker'))
                .map(line => line.trim());
            commentsIntact[name] = directives.every(d => output.includes(d));
        } finally {
            allMutators.splice(0, allMutators.length, ...pristine);
        }
    }

    // [Finding 1] excludedMutations — the CLI plan's OWN expanded list vs the
    // unexpanded control, on the directive-free fixture.
    const plan = buildRunPlan(
        { projectDir: '/proj', mode: 'augment', live: false, mutate: [] },
        llmMutatorConfigSchema.parse({ provider: 'mock', dynamicLLM: { enabled: true } }),
        undefined,
        ['llm'],
    );
    const planList = plan.strykerOptions.excludedMutations;
    const excluded = { planList };
    for (const [key, list] of [
        ['expanded', planList],
        ['control', ['llm']],
    ]) {
        allMutators.push(...createLlmMutators(buildLlmMutatorMap(entriesFor(fixtures.none)).map));
        try {
            // oxlint-disable-next-line no-await-in-loop -- same registry-state discipline as above.
            const pass = await instrument(fixtures.none, absFileName, list, isLlmMutatorName);
            excluded[key] = pass.ours;
        } finally {
            allMutators.splice(0, allMutators.length, ...pristine);
        }
    }

    return { installed, registration, cases, excluded, warns, commentsIntact };
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
