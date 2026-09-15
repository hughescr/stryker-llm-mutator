import process from 'node:process';
import { pathToFileURL } from 'node:url';

const logger = {
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
const options = { plugins: null, excludedMutations: [], ignorers: [], noHeader: false };
try {
    const instrumenterRoot = process.argv[3];
    const load = relative => import(pathToFileURL(`${instrumenterRoot}/dist/src/${relative}`).href);
    const [{ allMutators }, { transformBabel }, { MutantCollector }, { createParser }] =
        await Promise.all([
            load('mutators/mutate.js'),
            load('transformers/babel-transformer.js'),
            load('transformers/mutant-collector.js'),
            load('parsers/index.js'),
        ]);
    const {
        injectMutators,
        callArgumentTweakMutator,
        arrayMethodSwapMutator,
        promiseCombinatorSwapMutator,
    } = await import(pathToFileURL(process.argv[2]).href);
    const pristine = [...allMutators];
    injectMutators(
        [callArgumentTweakMutator, arrayMethodSwapMutator, promiseCombinatorSwapMutator],
        { target: allMutators },
    );
    const source =
        'const ys = xs.slice(start, end);\nxs.push(a, b, ...rest);\nasync function settle(){ await Promise.all([a, b]); }\n';
    const ast = await createParser(options)(source, 'refined.ts');
    const collector = new MutantCollector();
    transformBabel(ast, collector, { options, mutateDescription: true, logger });
    const ours = collector.mutants
        .map(m => m.toApiMutant())
        .filter(m =>
            ['CallArgumentTweak', 'ArrayMethodSwap', 'PromiseCombinatorSwap'].includes(
                m.mutatorName,
            ),
        );
    allMutators.splice(0, allMutators.length, ...pristine);
    process.stdout.write(
        JSON.stringify(ours.map(m => ({ name: m.mutatorName, replacement: m.replacement }))),
    );
} catch (error) {
    process.stdout.write(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
}
