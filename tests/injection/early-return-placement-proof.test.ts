/*
 * THE EARLY-RETURN PLACEMENT PROOF (functional-architecture §3.1 / §5 constraint 3
 * + the EarlyReturnInjection footnote) — the offline real-instrumenter canary for
 * the ONLY statement-shaped heuristic operator.
 *
 * WHY THIS EXISTS: every other heuristic operator yields an EXPRESSION replacement
 * for an expression node, covered by the unit-test idiom and the M0 injection
 * canary. EarlyReturnInjection instead yields a `BlockStatement` to replace a
 * function-body `BlockStatement` — a STATEMENT replacing a STATEMENT. That goes
 * through Stryker's `statementMutantPlacer` (`canPlace = path.isStatement()`),
 * which special-cases `path.isBlockStatement()` and wraps the placed block. §5
 * constraint 3 requires placement of a statement-shaped operator be VERIFIED
 * against the real placers before shipping; this is that verification, and the
 * per-version canary that fails loudly if a Stryker bump changes the
 * statement-placement contract.
 *
 * TWO HALVES (the Bun/Node interop wall): the REAL instrument step runs in a NODE
 * subprocess (Stryker's instrumenter throws under Bun — the `generate.default`
 * wall). The Bun test spawns the worker, passing a fixture function; the worker
 * pushes `earlyReturnInjectionMutator` onto the REAL `allMutators`, instruments
 * through the REAL `transformBabel`/`createParser`/`print`, and returns JSON. We
 * assert: instrumentation COMPLETED with NO throw, BOTH mutants (`return;` and
 * `return undefined;`) appear in the manifest, and BOTH activation switches appear
 * in the printed source.
 *
 * IF THIS PROOF EVER FAILS TO GO GREEN, EarlyReturnInjection MUST BE DEFERRED
 * (unregistered from the heuristic barrel) per the §5 footnote — a broken
 * statement-shaped operator must not ship.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'bun:test';

const WORKER_PATH = fileURLToPath(
    new URL('./early-return-placement-proof-worker.mjs', import.meta.url),
);

const FIXTURE_NAME = 'compute.ts';
// A FunctionDeclaration with a real, non-empty body. EarlyReturnInjection must
// place `{ return; … }` and `{ return undefined; … }` at this body's
// BlockStatement node WITHOUT a statementMutantPlacer throw.
const FIXTURE_SOURCE =
    'export function compute(x: number): number {\n    const y = x + 1;\n    return y;\n}\n';

/** Shape of the Node worker's JSON response. */
interface WorkerResponse {
    instrumented: boolean;
    threw?: string;
    before: number;
    after: number;
    ours: { id: string; mutatorName: string; replacement: string }[];
    output: string;
    hasSwitches: boolean;
    error?: string;
}

/** Run the Node early-return placement-proof worker and resolve its parsed JSON. */
function runWorker(source: string, fileName: string): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [WORKER_PATH, source, fileName], {
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
            reject(
                new Error(`Failed to spawn early-return placement-proof worker: ${error.message}`),
            );
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

describe('EarlyReturnInjection placement proof — statement replaces a function-body block (Node instrumenter)', () => {
    it('instruments WITHOUT a statementMutantPlacer throw and emits BOTH mutants + switches', async () => {
        const res = await runWorker(FIXTURE_SOURCE, FIXTURE_NAME);

        // Our statement-shaped mutator was pushed onto the REAL registry.
        expect(res.after).toBe(res.before + 1);

        // (1) NO statementMutantPlacer throw — instrumentation COMPLETED.
        expect(res.threw).toBeUndefined();
        expect(res.instrumented).toBe(true);

        // (2) MANIFEST: BOTH early-return variants are present, mutatorName
        // 'EarlyReturnInjection'.
        expect(res.ours).toHaveLength(2);
        for (const mutant of res.ours) {
            expect(mutant.mutatorName).toBe('EarlyReturnInjection');
        }
        // The two replacements are the `return;`-headed and `return undefined;`-headed
        // blocks (Stryker prints the whole replacement block as the `replacement`).
        const bareReturn = res.ours.find(m => /\breturn;/.test(m.replacement));
        const undefinedReturn = res.ours.find(m => /return undefined;/.test(m.replacement));
        expect(bareReturn).toBeDefined();
        expect(undefinedReturn).toBeDefined();

        // (3) SOURCE-SWITCH: every mutant's activation switch appears in the
        // printed source (real placement at the function-body block).
        expect(res.hasSwitches).toBe(true);
        for (const mutant of res.ours) {
            expect(res.output).toContain(`stryMutAct_9fa48("${mutant.id}")`);
        }
        // The injected early-returns appear as the head of the mutated branches,
        // and the original body (`x + 1`, `return y`) survives in the else branch.
        // (The original `const y = x + 1` is itself instrumented by the built-in
        // arithmetic mutator, so it is not a contiguous substring — assert its
        // pieces instead.)
        expect(res.output).toContain('return undefined;');
        expect(res.output).toContain('x + 1');
        expect(res.output).toContain('return y;');
    });
});
