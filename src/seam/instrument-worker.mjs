/*
 * Node-side instrumentation worker (development-plan §3.3 step 1).
 *
 * WHY A SEPARATE NODE SUBPROCESS: Stryker's instrumenter is authored for Node's
 * CommonJS/ESM default-interop. Specifically `@stryker-mutator/instrumenter`'s
 * `mutant.js` does `const generator = generate.default` against
 * `@babel/generator` (a CJS module). Under Node, `import generate from
 * '@babel/generator'` yields the CJS `module.exports` object whose `.default`
 * is the function — so `generate.default` works. Under Bun, the same default
 * import is unwrapped to the function itself, so `.default` is `undefined` and
 * the instrumenter throws `generator is not a function`. Our tests and the rest
 * of the toolchain run under Bun, so we run the instrumentation step here in a
 * Node child process and ferry the result back as JSON. The runner (which only
 * executes the emitted, plain-JS instrumented source) stays on Bun.
 *
 * WHY THE DEEP `dist/src/...` IMPORTS: `@stryker-mutator/instrumenter`'s
 * package `exports` map only exposes `.` (its barrel) and `./package.json`. The
 * barrel re-exports `Instrumenter` and `createInstrumenter` but NOT the
 * lower-level `transformBabel` / `MutantCollector` / `createParser` / `print`
 * we need to drive Stryker's OWN collector + placers with OUR mutator. We reach
 * those via direct file paths into the installed `dist` tree. This is the
 * out-of-band seam of §3.3 — we construct and drive the machinery ourselves, so
 * the refuted `instrumenterTokens.transform` DI route (§3.2) never applies.
 *
 * WHAT WE DRIVE: a single custom `NodeMutator` that, for each babel node whose
 * location exactly matches one of our requested {@link Replacement} spans,
 * yields the parsed replacement AST. Stryker's real `transformBabel` then runs
 * its collector + placers + syntax-helper header + printer, emitting BOTH
 * coupled artifacts (§3.1) — the `stryMutAct_9fa48("<id>") ? mutated : original`
 * switch in source AND the matching `Mutant` manifest record — in lockstep, for
 * free. A subclassed collector overrides Stryker's sequential numeric id with
 * OUR deterministic id, so the SAME id appears in the switch, the manifest, and
 * (later) the `__STRYKER_ACTIVE_MUTANT__` activation.
 *
 * PROTOCOL: reads one JSON request object from stdin, writes one JSON response
 * object to stdout. On any failure it writes `{ error: <message> }` and exits 1.
 *
 *   request:  { files: [{ name, content }], replacements: [{ id, fileName,
 *               range: { start:{line,column}, end:{line,column} }, replacement,
 *               mutatorName }] }
 *   response: { files: [{ name, content }],
 *               mutants: [{ id, fileName, mutatorName, replacement, location }] }
 *
 * `range` positions are Stryker-convention ZERO-based (line 0 = first line),
 * matching `@stryker-mutator/api` `Position`. We convert to Babel's 1-based
 * line for node matching here, so callers never deal with Babel's convention.
 */

import { transformBabel } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/babel-transformer.js';
import { MutantCollector } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/transformers/mutant-collector.js';
import { createParser } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/parsers/index.js';
import { print } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/printers/index.js';
import babel from '@babel/core';

const { parse } = babel;

/** A logger object shaped like the one Stryker's instrumenter expects, but silent. */
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

/**
 * Parse a replacement source fragment into a single expression/statement AST
 * node suitable for grafting. We wrap in parens so bare object literals and
 * sequence-like fragments parse as expressions; this mirrors how Stryker's own
 * mutators produce replacement nodes.
 */
function parseFragment(code) {
    const wrapped = parse(`(${code})`, { configFile: false, babelrc: false });
    return wrapped.program.body[0].expression;
}

/**
 * Build the custom mutator for one file. Matches babel node locations against
 * the requested spans (converted to Babel's 1-based line) and yields the parsed
 * replacement(s). The matched id is recorded so the collector can stamp it.
 *
 * MULTIPLE CANDIDATES PER SPAN: `propose()` generates N candidates for ONE
 * target span, so several distinct replacements can share the SAME
 * fileName+range (different replacement text). The span key must therefore map
 * to a LIST of replacements, and `*mutate` yields one fresh replacement node per
 * entry. Keying by span alone and storing a single replacement would silently
 * overwrite all but the last (the §3.1 failure the plan warns about), dropping
 * those mutants from BOTH the source switches and the manifest. Stryker's
 * `transformBabel` already iterates every yielded replacement per node
 * (`[...mutate(path)].map(...)`) and its placers/placement-map co-locate
 * multiple mutants on one node, so yielding a fresh, separately-parsed node per
 * entry keeps id-stamping correct via node identity.
 */
function buildMutator(replacementsForFile, idByMatchedNode) {
    // Index requested spans by a "babelLine:col-babelLine:col" key for O(1)
    // lookup, mapping each key to the LIST of replacements targeting that span.
    const wanted = new Map();
    for (const r of replacementsForFile) {
        const key = `${r.range.start.line + 1}:${r.range.start.column}-${r.range.end.line + 1}:${r.range.end.column}`;
        const list = wanted.get(key) ?? [];
        list.push(r);
        wanted.set(key, list);
    }
    return {
        name: 'LLMMutator',
        *mutate(path) {
            const loc = path.node.loc;
            if (!loc) {
                return;
            }
            const key = `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`;
            const matches = wanted.get(key);
            if (!matches) {
                return;
            }
            for (const match of matches) {
                // Parse a FRESH node per entry so each has a distinct node
                // identity for id-stamping in the collector.
                const replacementNode = parseFragment(match.replacement);
                idByMatchedNode.set(replacementNode, match);
                yield replacementNode;
            }
        },
    };
}

/**
 * Collector that overrides Stryker's sequential numeric id with our
 * deterministic id. `mutable.replacement` is the exact AST node our mutator
 * yielded, so we look the requested replacement (and its id + mutatorName) back
 * up by node identity. Both the manifest record and the placed source switch
 * read `mutant.id` AFTER `collect()`, so stamping it here lands in both.
 */
class DeterministicIdCollector extends MutantCollector {
    constructor(idByMatchedNode) {
        super();
        this._idByMatchedNode = idByMatchedNode;
    }

    collect(fileName, original, mutable, offset) {
        const mutant = super.collect(fileName, original, mutable, offset);
        const requested = this._idByMatchedNode.get(mutable.replacement);
        if (requested) {
            mutant.id = requested.id;
            mutant.mutatorName = requested.mutatorName;
        }
        return mutant;
    }
}

async function run(request) {
    const options = {
        plugins: null,
        excludedMutations: [],
        ignorers: [],
        noHeader: false,
    };
    const parser = createParser(options);

    const replacementsByFile = new Map();
    for (const r of request.replacements) {
        const list = replacementsByFile.get(r.fileName) ?? [];
        list.push(r);
        replacementsByFile.set(r.fileName, list);
    }

    const idByMatchedNode = new Map();
    const collector = new DeterministicIdCollector(idByMatchedNode);
    const outFiles = [];

    for (const file of request.files) {
        const forFile = replacementsByFile.get(file.name) ?? [];
        // oxlint-disable-next-line no-await-in-loop -- shared collector + id map require sequential, ordered processing
        const ast = await parser(file.content, file.name);
        const mutator = buildMutator(forFile, idByMatchedNode);
        transformBabel(ast, collector, { options, mutateDescription: true, logger: silentLogger }, [
            mutator,
        ]);
        outFiles.push({ name: file.name, content: print(ast) });
    }

    return {
        files: outFiles,
        mutants: collector.mutants.map(m => m.toApiMutant()),
    };
}

async function readStdin() {
    const chunks = [];
    // oxlint-disable-next-line no-await-in-loop -- stream consumption is inherently sequential
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

try {
    const request = JSON.parse(await readStdin());
    const response = await run(request);
    process.stdout.write(JSON.stringify(response));
} catch (error) {
    process.stdout.write(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
}
