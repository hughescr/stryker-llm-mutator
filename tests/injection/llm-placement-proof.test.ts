/*
 * THE LLM PLACEMENT PROOF (functional-architecture §3.1 / §4 Gate 4 / §5
 * constraint 3) — the offline real-instrumenter test that would have caught the
 * whole-function-range bug found in the live isambard run.
 *
 * THE BUG: the dynamic-LLM pre-pass batches by enclosing FUNCTION (Gate 3). The
 * old propose contract set every candidate's `Replacement.range` to the WHOLE
 * function span and `original` to the whole function text, while the map-builder
 * + `LLMMutator` parse the replacement as an EXPRESSION. So an expression node
 * (e.g. `hour > 12`) was asked to REPLACE a FunctionDeclaration STATEMENT node,
 * and Stryker's instrumenter threw:
 *   statementMutantPlacer could not place mutants with type(s): "llm and llm" …
 *   Property body[0] of BlockStatement expected node to be of a type ["Statement"]
 *   but instead got "BinaryExpression"
 *
 * THE FIX (proven here): the new contract has the model echo the SPECIFIC
 * sub-expression it mutates; `range-align.ts` locates + node-aligns that
 * sub-expression to the EXACT EXPRESSION node's range. So an expression edit now
 * replaces an expression node and Stryker's expression (ternary) placer accepts
 * it — instrumentation COMPLETES, the mutant appears in the manifest, and its
 * activation switch appears in the printed source.
 *
 * TWO HALVES (the Bun/Node interop wall):
 *   • THE BUN TEST runs the REAL propose → range-align path (pure, bun-safe) with
 *     a MockProvider returning a LOCALIZED sub-expression edit (NO network). It
 *     serializes the resulting `Replacement[]` (survivors) to JSON.
 *   • THE NODE WORKER rebuilds the map (`buildLlmMutatorMap`) + the mutator
 *     (`createLlmMutator`) IN-PROCESS, pushes it onto the REAL `allMutators`, and
 *     instruments the fixture through the REAL `transformBabel`/`createParser`/
 *     `print`. Stryker's instrumenter THROWS under Bun (the `generate.default`
 *     interop wall), so the INSTRUMENT step MUST run in Node.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MockProvider } from '../../src/llm/index';
import { propose, type ProposeTarget } from '../../src/pipeline/index';
import type { Replacement } from '../../src/seam/types';

const WORKER_PATH = fileURLToPath(new URL('./llm-placement-proof-worker.mjs', import.meta.url));

const FIXTURE_NAME = 'is-afternoon.ts';
// A function with a mutable BinaryExpression sub-expression `hour >= 12`. The
// whole thing is a FunctionDeclaration (a Statement); the OLD contract tried to
// put a BinaryExpression replacement at THIS node's range and Stryker threw.
const FIXTURE_SOURCE =
    'export function isAfternoon(hour: number): boolean {\n    return hour >= 12;\n}\n';

/** Shape of the Node worker's JSON response. */
interface WorkerResponse {
    instrumented: boolean;
    threw?: string;
    before: number;
    after: number;
    mapSize: number;
    droppedCount: number;
    ours: { id: string; mutatorName: string; replacement: string }[];
    output: string;
    hasSwitch: boolean;
    error?: string;
}

/** Run the Node placement-proof worker and resolve its parsed JSON response. */
function runWorker(
    bundlePath: string,
    source: string,
    fileName: string,
    replacements: Replacement[],
): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'node',
            [WORKER_PATH, bundlePath, source, fileName, JSON.stringify(replacements)],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
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
            reject(new Error(`Failed to spawn placement-proof worker: ${error.message}`));
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

/**
 * Build the survivors via the REAL propose → range-align path with a MockProvider
 * returning a localized sub-expression edit (`hour >= 12` → `hour > 12`). No
 * network. The candidate's `original` is the SUB-EXPRESSION (not the function),
 * so range-align derives the BinaryExpression node's range.
 */
async function buildSurvivors(): Promise<Replacement[]> {
    const provider = new MockProvider({
        responder: () => ({
            candidates: [
                {
                    original: 'hour >= 12',
                    replacement: 'hour > 12',
                    mutatorTag: 'boundary',
                    rationale: 'Off-by-one on the afternoon boundary.',
                },
            ],
        }),
        costUsd: 0,
    });
    const target: ProposeTarget = {
        fileName: FIXTURE_NAME,
        // The whole-function range is the fallback only; the per-edit range is the
        // aligned `hour >= 12` BinaryExpression node.
        range: { start: { line: 0, column: 0 }, end: { line: 2, column: 1 } },
        spanText: FIXTURE_SOURCE,
        context: FIXTURE_SOURCE,
        fileContent: FIXTURE_SOURCE,
        spanStartOffset: 0,
        spanEndOffset: FIXTURE_SOURCE.length,
    };
    const { replacements, dropped } = await propose(provider, target);
    // Pre-condition for the proof: the sub-expression aligned (no drop).
    expect(dropped).toHaveLength(0);
    expect(replacements).toHaveLength(1);
    return replacements;
}

describe('LLM placement proof — expression edit replaces an expression node (Node instrumenter)', () => {
    let tmpDir = '';
    let bundlePath = '';

    beforeAll(async () => {
        // Bundle the pure (bun-safe) map builders to an ESM module the Node worker
        // can import past the repo's extensionless TS imports. We bundle a tiny
        // entrypoint that re-exports `buildLlmMutatorMap` + `createLlmMutator`;
        // @babel/* stays external (resolved via the project's node_modules), and
        // those modules use ONLY @babel/parser — no Stryker import — so the bundle
        // is self-contained and Node-importable. The bundle lives INSIDE the
        // project root (sibling of node_modules) so its @babel externals resolve.
        const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
        tmpDir = await mkdtemp(path.join(projectRoot, '.tmp-llm-placement-proof-'));
        const entryPath = path.join(tmpDir, 'entry.ts');
        // entry.ts lives at <projectRoot>/.tmp-…/entry.ts, so the source tree is
        // one level up (`../src/...`). We re-export the two builders wrapped in a
        // single `builders` const: a bare `export { … } from …` re-export entry
        // gets fully TREE-SHAKEN by Bun (the source pkg is `sideEffects:false`),
        // leaving an empty 53-byte stub Node rejects with "Export … is not
        // defined". Referencing the functions in an exported object retains them.
        await Bun.write(
            entryPath,
            "import { buildLlmMutatorMap } from '../src/pipeline/llm-map';\n" +
                "import { createLlmMutator } from '../src/mutators/llm-mutator';\n" +
                'export const builders = { buildLlmMutatorMap, createLlmMutator };\n',
        );
        bundlePath = path.join(tmpDir, 'map-builders.mjs');
        const built = await Bun.build({
            entrypoints: [entryPath],
            target: 'node',
            format: 'esm',
            external: ['@babel/*', '@stryker-mutator/*'],
        });
        if (!built.success) {
            throw new Error(`Failed to bundle map builders: ${built.logs.join('\n')}`);
        }
        await Bun.write(bundlePath, await built.outputs[0]!.text());
    });

    afterAll(async () => {
        if (tmpDir) {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('instruments WITHOUT a statementMutantPlacer throw and emits the mutant + switch', async () => {
        const survivors = await buildSurvivors();
        // The aligned range is the `hour >= 12` BinaryExpression node, NOT the
        // whole FunctionDeclaration — the crux of the fix.
        expect(survivors[0]!.range).toEqual({
            start: { line: 1, column: 11 },
            end: { line: 1, column: 21 },
        });
        expect(survivors[0]!.original).toBe('hour >= 12');

        const res = await runWorker(bundlePath, FIXTURE_SOURCE, FIXTURE_NAME, survivors);

        // (0) The map + mutator were rebuilt in Node with no drops.
        expect(res.mapSize).toBe(1);
        expect(res.droppedCount).toBe(0);
        expect(res.after).toBe(res.before + 1); // our llm mutator pushed.

        // (1) NO statementMutantPlacer throw — instrumentation COMPLETED.
        expect(res.threw).toBeUndefined();
        expect(res.instrumented).toBe(true);

        // (2) MANIFEST: the LLM mutant is present, mutatorName 'llm'.
        expect(res.ours).toHaveLength(1);
        expect(res.ours[0]!.mutatorName).toBe('llm');
        expect(res.ours[0]!.replacement).toBe('hour > 12');

        // (3) SOURCE-SWITCH: its activation switch appears in the printed source.
        expect(res.hasSwitch).toBe(true);
        expect(res.output).toContain(`stryMutAct_9fa48("${res.ours[0]!.id}")`);
        // Both mutated and original branches present (real placement).
        expect(res.output).toContain('hour > 12');
        expect(res.output).toContain('hour >= 12');
    });
});
