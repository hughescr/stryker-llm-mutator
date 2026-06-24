/*
 * THE M0 INJECTION PROOF (development-plan §3.3, functional-architecture.md §3).
 *
 * The load-bearing offline proof of the whole monkeypatch architecture: pushing
 * our `NumberLiteralValue` mutator into Stryker's REAL, shared `allMutators`
 * registry makes Stryker's OWN instrumenter emit our mutant — with no plugin
 * descriptor, entirely offline (no `stryker run`, no network).
 *
 * IT IS IN TWO HALVES, because of a Bun/Node interop wall:
 *
 *   HALF 1 — registry monkeypatch (runs IN-PROCESS, under Bun). Asserts that our
 *   `injectMutators()` mutates the SAME shared `allMutators` array instance that
 *   `babel-transformer.js` captured as its default `mutators` parameter (augment
 *   appends; replace clears-then-fills; identity preserved). This proves the
 *   monkeypatch reaches the real registry. It needs no AST generation, so Bun is
 *   fine. We snapshot the registry's full contents and restore them after EACH
 *   test so the global mutation never leaks to other test files (Bun randomizes
 *   file order).
 *
 *   HALF 2 — end-to-end through Stryker's instrumenter (runs in a NODE
 *   subprocess). Stryker's `Mutant` constructor calls `@babel/generator`'s
 *   `generate.default`, which is `undefined` under Bun (it unwraps the CJS
 *   default to the function itself), so the instrumenter THROWS under Bun. This
 *   is the exact interop wall `src/seam/instrument-worker.mjs` documents, and the
 *   exact reason that seam runs in Node. So we bundle our real mutator+injection
 *   to a temp ESM module, spawn `tests/injection/injection-proof-worker.mjs`
 *   under Node, and assert on its JSON: our mutant appears in BOTH the manifest
 *   AND the printed activation switches (§3.1's two coupled artifacts).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { injectMutators } from '../../src/injection';
import { numberLiteralValueMutator } from '../../src/mutators/number-literal-value';

// The SAME `allMutators` instance babel-transformer.js reads by reference (it IS
// typed: NodeMutator[]). Worker-path-style deep import past the exports map.
import { allMutators } from '../../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js';

const WORKER_PATH = fileURLToPath(new URL('./injection-proof-worker.mjs', import.meta.url));

const FIXTURE_NAME = 'config.ts';
// A single numeric literal `5000` — our mutator must turn it into 5001 / 4999 / 0.
const FIXTURE_SOURCE = 'export const timeoutMs = 5000;\n';

/** Shape of the Node worker's JSON response. */
interface WorkerResponse {
    before: number;
    after: number;
    injectedNames: string[];
    ours: { id: string; mutatorName: string; replacement: string }[];
    output: string;
    hasHeader: boolean;
    error?: string;
}

/** Run the Node injection-proof worker and resolve its parsed JSON response. */
function runWorker(bundlePath: string, source: string, fileName: string): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [WORKER_PATH, bundlePath, source, fileName], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.on('error', error => {
            reject(new Error(`Failed to spawn injection-proof worker: ${error.message}`));
        });
        child.on('close', code => {
            let parsed: WorkerResponse;
            try {
                parsed = JSON.parse(stdout) as WorkerResponse;
            } catch {
                reject(
                    new Error(
                        `Worker emitted invalid JSON (exit ${String(code)}): ${stdout || stderr}`,
                    ),
                );
                return;
            }
            if (parsed.error) {
                reject(new Error(`Worker failed: ${parsed.error}`));
                return;
            }
            resolve(parsed);
        });
    });
}

describe('M0 injection proof — HALF 1: registry monkeypatch (in-process, Bun)', () => {
    // Snapshot the FULL pristine registry (a copy of its contents, not just its
    // length) so we can restore it after EACH test — `replace` mode empties the
    // array, so a length-only restore could not re-add the built-ins. Restoring
    // contents in place (`splice(0, len, ...snapshot)`) preserves the array
    // identity transformBabel holds, so the global mutation never leaks to other
    // tests in this file or others (Bun randomizes file order).
    let pristine: typeof allMutators = [];

    beforeAll(() => {
        pristine = [...allMutators];
    });

    afterEach(() => {
        allMutators.splice(0, allMutators.length, ...pristine);
    });

    afterAll(() => {
        allMutators.splice(0, allMutators.length, ...pristine);
    });

    it('the registry starts WITHOUT our mutator (sanity: 16 built-ins only)', () => {
        expect(allMutators.some(m => m.name === 'NumberLiteralValue')).toBe(false);
        expect(allMutators).toHaveLength(16);
    });

    it('injectMutators(augment) appends NumberLiteralValue onto the SAME live array', () => {
        const result = injectMutators([numberLiteralValueMutator], { mode: 'augment' });
        expect(result.mode).toBe('augment');
        expect(result.countBefore).toBe(16);
        expect(result.countAfter).toBe(17);
        expect(result.injectedNames).toEqual(['NumberLiteralValue']);
        // The push landed on the very array transformBabel reads by reference.
        expect(allMutators.at(-1)).toBe(numberLiteralValueMutator);
        expect(allMutators.some(m => m.name === 'NumberLiteralValue')).toBe(true);
    });

    it('injectMutators(replace) clears the built-ins and registers ONLY ours', () => {
        const result = injectMutators([numberLiteralValueMutator], { mode: 'replace' });
        expect(result.mode).toBe('replace');
        expect(result.countAfter).toBe(1);
        expect(allMutators).toHaveLength(1);
        expect(allMutators[0]).toBe(numberLiteralValueMutator);
    });

    it('defaults to the heuristicMutators set in augment mode', () => {
        const result = injectMutators();
        expect(result.mode).toBe('augment');
        expect(result.injectedNames).toEqual(['NumberLiteralValue']);
        expect(allMutators.some(m => m.name === 'NumberLiteralValue')).toBe(true);
    });
});

describe("M0 injection proof — HALF 2: end-to-end via Stryker's instrumenter (Node)", () => {
    // Bundle our REAL injection seam to a temp ESM module the Node worker can
    // import (Node cannot follow the repo's extensionless TS imports; the bundle
    // inlines them, keeping only Stryker/Babel external). Built once per block.
    let tmpDir = '';
    let bundlePath = '';

    beforeAll(async () => {
        // Write the bundle INSIDE the project root (`.tmp-*`, ignored by lint).
        // This matters: the bundle keeps `allMutators` external as the relative
        // specifier `../node_modules/.../mutate.js`, which resolves correctly
        // only when the bundle's parent dir is a sibling of `node_modules` — i.e.
        // inside the project. `@babel/types` (bare) likewise resolves via the
        // project's node_modules. Because the bundle and the worker then import
        // the SAME absolute `mutate.js`, Node caches one shared `allMutators`
        // instance — the exact array the worker's instrumenter reads.
        const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
        tmpDir = await mkdtemp(path.join(projectRoot, '.tmp-m0-injection-proof-'));
        bundlePath = path.join(tmpDir, 'ours.mjs');
        const built = await Bun.build({
            entrypoints: [fileURLToPath(new URL('../../src/injection.ts', import.meta.url))],
            target: 'node',
            format: 'esm',
            // Keep Stryker + Babel external so the instrumenter is NOT inlined
            // (inlining breaks its load-time `import.meta`-relative schema read).
            // The relative deep-import is externalized by its exact specifier.
            external: [
                '@stryker-mutator/*',
                '@babel/*',
                '../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js',
            ],
        });
        if (!built.success) {
            throw new Error(`Failed to bundle src/injection.ts: ${built.logs.join('\n')}`);
        }
        await Bun.write(bundlePath, await built.outputs[0]!.text());
    });

    afterAll(async () => {
        if (tmpDir) {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    it("Stryker's OWN instrumenter emits our mutant: BOTH coupled artifacts (§3.1)", async () => {
        const res = await runWorker(bundlePath, FIXTURE_SOURCE, FIXTURE_NAME);

        // The worker injected via OUR real injectMutators onto the REAL registry.
        expect(res.before).toBe(16);
        expect(res.after).toBe(17);
        expect(res.injectedNames).toEqual(['NumberLiteralValue']);

        // (a) MANIFEST artifact: our mutator produced the full tasteful set on
        // the literal `5000` → 5001 / 4999 / 0.
        expect(res.ours.length).toBe(3);
        for (const mutant of res.ours) {
            expect(mutant.mutatorName).toBe('NumberLiteralValue');
        }
        const replacements = new Set(res.ours.map(m => m.replacement));
        expect(replacements).toEqual(new Set(['5001', '4999', '0']));

        // (b) SOURCE-SWITCH artifact: every one of our mutant ids has an
        // activation switch in the printed source, gated on Stryker's helper.
        for (const mutant of res.ours) {
            expect(res.output).toContain(`stryMutAct_9fa48("${mutant.id}")`);
        }
        expect(res.hasHeader).toBe(true);
        // Mutated branches present (real placement); original survives in else.
        expect(res.output).toContain('5001');
        expect(res.output).toContain('4999');
        expect(res.output).toContain('5000');
    });
});
