/*
 * ════════════════════════════════════════════════════════════════════════════
 * M0 LIVE DRIVER — stock `stryker run` on ONE isambard file, with our injected
 * NumberLiteralValue mutator (development-plan §3.3 / functional-architecture §3).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS PROVES (live, end-to-end, what the offline test cannot):
 *   The offline `tests/injection/injection-proof.test.ts` proves our mutator is
 *   picked up by Stryker's OWN instrumenter. THIS script closes the loop: it runs
 *   the FULL stock Stryker pipeline — instrument → bun test runner → typescript
 *   checker → reporters — over ONE real isambard source file, and prints which of
 *   OUR mutants ran and whether each was killed or survived. No LLM, no network.
 *
 * HOW IT WORKS:
 *   1. Deep-imports Stryker's shared `allMutators` registry (the SAME instance
 *      the in-process instrumenter reads — see src/injection.ts) and our built
 *      mutator, both from THIS package's node_modules / dist.
 *   2. `injectMutators(..., { mode: 'replace' })` — clears the 16 built-ins and
 *      registers ONLY NumberLiteralValue, so the run emits our mutants in
 *      isolation (easy to read; no built-in noise).
 *   3. `process.chdir()` into isambard so Stryker resolves its config + the
 *      target file + reporters relative to the isambard project root.
 *   4. Constructs `new Stryker({ configFile: 'stryker.conf.mjs', mutate:
 *      [targetFile], incremental: false, ... })` and awaits `runMutationTest()`.
 *   5. Prints a summary of the returned `MutantResult[]` filtered to ours.
 *
 *   `incremental: false` + a disposable `tempDirName` avoid stale-cache hits from
 *   isambard's normal incremental runs. We keep isambard's `bun` testRunner and
 *   `typescript` checker so the proof exercises the real validation path — if the
 *   checker rejects `5000 → 5001` etc., that surfaces here as a `CompileError`.
 *
 * WHY A SEPARATE NODE SCRIPT (not Bun): Stryker's instrumenter relies on Node's
 * CJS/ESM default-interop for `@babel/generator`, which Bun unwraps differently
 * (see src/seam/instrument-worker.mjs) — under Bun the in-process instrumentation
 * throws `generator is not a function`. So Stryker-the-library MUST run under
 * Node. Node ≥ 23's native TypeScript type-stripping lets this `.mjs` import our
 * mutator straight from its `.ts` source — NO build step required. The bun TEST
 * RUNNER still runs under Bun: that is isambard's `testRunner: bun` plugin,
 * spawned by Stryker as configured; only this driver process is Node.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * HOW THE HUMAN RUNS THIS (the M0 live proof recipe)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 *   # No build step needed — the driver imports our mutator from TS source via
 *   # Node's native type-stripping (Node ≥ 23; this repo's Node is v26).
 *   #
 *   # Run the driver. ARG 1 = path to isambard, ARG 2 = ONE file to mutate
 *   # (relative to the isambard root). Pick a small file with numeric literals —
 *   # e.g. src/config/retry-config.ts (has 2, 5, 3, 500, 1000, 5000, 60_000 …).
 *   # cwd does NOT matter; the script chdir()s itself.
 *   node /Users/craig/code/hughescr/stryker-llm-mutator/scripts/m0-isambard-proof.mjs \
 *        /Users/craig/code/hughescr/isambard \
 *        src/config/retry-config.ts
 *
 *   # NOTE ON SANDBOX: a real Stryker run spawns child processes and writes the
 *   # temp dir; in a restricted shell this needs the sandbox disabled. In Claude
 *   # Code that means running it WITH dangerouslyDisableSandbox / after approving
 *   # the prompt. A human running it in a normal terminal needs no special flag.
 *
 *   # 2. Expected output (shape):
 *   #   === M0 PROOF: injected NumberLiteralValue mutants on retry-config.ts ===
 *   #   injected: [ 'NumberLiteralValue' ]  (registry now 1 mutator, built-ins cleared)
 *   #   12 mutant(s) from NumberLiteralValue:
 *   #     retry-config.ts 7:24  5000 → 5001   Killed
 *   #     retry-config.ts 7:24  5000 → 4999   Killed
 *   #     retry-config.ts 7:24  5000 → 0       Killed
 *   #     ...
 *   #   summary: Killed=10 Survived=1 NoCoverage=0 CompileError=1 Timeout=0
 *   #
 *   #   PASS criteria for M0: at least one row says `NumberLiteralValue` and has a
 *   #   real status (Killed/Survived) — that means stock Stryker instrumented,
 *   #   ran, and scored OUR mutant through its own machinery. (Survivors and
 *   #   CompileErrors are fine for the proof; they are a quality signal, not a
 *   #   failure of the injection seam.)
 *
 * THINGS TO WATCH (verification points, per the investigate findings):
 *   • Does NumberLiteralValue actually match literals in the chosen file? (Pick a
 *     file with at least one numeric literal; otherwise the run yields 0 mutants.)
 *   • Does isambard's typescript-checker reject any replacement? Those show as
 *     `CompileError` — expected for some literals, NOT a seam failure.
 *   • Identity: this script's `Stryker` and `allMutators` MUST resolve to THIS
 *     package's node_modules so the injected array is the one Stryker reads. They
 *     do, because both imports are relative to this script's location.
 *
 * THIS FILE IS EXAMPLE/SCRIPT CODE — coverage-exempt (like demo/); it is never
 * imported by the offline test suite and performs a live, sandboxed run.
 */

import process from 'node:process';
import path from 'node:path';

import { Stryker } from '@stryker-mutator/core';

// Deep-import the shared registry (worker path style) and our built mutator +
// injection seam from THIS package, so the injected array is the very instance
// Stryker's in-process instrumenter reads.
import { allMutators } from '../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js';
// Our real mutator, straight from its TypeScript source — Node's native
// type-stripping loads it (its only runtime import, `@babel/types`, resolves;
// the sibling type-import is erased). We do NOT import the bundled `dist/index.js`
// barrel here: bundling inlines `@stryker-mutator/api`'s schema loader, whose
// `import.meta`-relative `schema/stryker-core.json` read breaks from `dist/`.
import { numberLiteralValueMutator } from '../src/mutators/number-literal-value.ts';

/** Print one mutant result row in a compact, human-scannable form. */
function describeMutant(result) {
    const loc = result.location?.start;
    const where = loc ? `${result.fileName} ${loc.line}:${loc.column}` : result.fileName;
    return `  ${where}  → ${result.replacement ?? '(n/a)'}   ${result.status}`;
}

async function main() {
    const isambardPath = process.argv[2];
    const targetFile = process.argv[3];

    if (!isambardPath || !targetFile) {
        process.stderr.write(
            'usage: node scripts/m0-isambard-proof.mjs <path-to-isambard> <target-file-relative-to-isambard>\n' +
                'example: node scripts/m0-isambard-proof.mjs /Users/craig/code/hughescr/isambard src/config/retry-config.ts\n',
        );
        process.exitCode = 1;
        return;
    }

    // Register ONLY our mutator BEFORE Stryker instruments anything. This is the
    // exact two-step `src/injection.ts#injectMutators(..., { mode: 'replace' })`
    // performs — clear the 16 built-ins IN PLACE (preserving the array identity
    // `babel-transformer.js` holds), then push ours — inlined here because that
    // seam's TS barrel uses extensionless imports Node cannot resolve at runtime.
    // The seam function itself is proven offline by tests/injection/*.
    allMutators.length = 0;
    allMutators.push(numberLiteralValueMutator);
    const injection = { injectedNames: [numberLiteralValueMutator.name], mode: 'replace' };

    // Run Stryker from inside the isambard project root so its config, target
    // file, and reporter outputs all resolve correctly.
    process.chdir(path.resolve(isambardPath));

    const stryker = new Stryker({
        // Use isambard's own config for runner/checker/plugins, then override
        // the bits that scope this to a clean single-file proof.
        configFile: 'stryker.conf.mjs',
        mutate: [targetFile],
        incremental: false, // ignore isambard's incremental cache for a clean run
        reporters: ['clear-text'],
        tempDirName: '.stryker-tmp-m0', // disposable temp dir, separate from normal runs
        concurrency: 2,
    });

    const results = await stryker.runMutationTest();

    const ours = results.filter(r => r.mutatorName === 'NumberLiteralValue');
    const counts = {};
    for (const r of ours) {
        counts[r.status] = (counts[r.status] ?? 0) + 1;
    }

    process.stdout.write(
        `\n=== M0 PROOF: injected NumberLiteralValue mutants on ${targetFile} ===\n`,
    );
    process.stdout.write(
        `injected: ${JSON.stringify(injection.injectedNames)}  ` +
            `(registry now ${String(allMutators.length)} mutator(s), mode=${injection.mode})\n`,
    );
    process.stdout.write(`${String(ours.length)} mutant(s) from NumberLiteralValue:\n`);
    for (const r of ours) {
        process.stdout.write(`${describeMutant(r)}\n`);
    }
    const summary = Object.entries(counts)
        .map(([status, n]) => `${status}=${String(n)}`)
        .join(' ');
    process.stdout.write(`summary: ${summary || '(no NumberLiteralValue mutants produced)'}\n`);

    // PASS for M0 = stock Stryker instrumented + scored at least one of OUR
    // mutants through its own machinery. Any real status counts.
    if (ours.length === 0) {
        process.stderr.write(
            '\nNO NumberLiteralValue mutants were produced. Pick a target file that contains ' +
                'at least one numeric literal, and confirm the build is current (bun run build).\n',
        );
        process.exitCode = 1;
    }
}

await main();
