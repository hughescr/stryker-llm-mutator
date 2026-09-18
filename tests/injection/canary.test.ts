/*
 * THE CONSOLIDATED PER-VERSION MONKEYPATCH CANARY (functional-architecture §3.4
 * silent-break risk / M5). This is the SINGLE CI-gated assertion of the whole
 * monkeypatch-injection architecture: in ONE Node-subprocess round-trip it checks
 * the eight load-bearing invariants, so a Stryker bump that freezes/moves
 * `allMutators`, moves the directive bookkeeper, changes placement semantics or
 * the incremental identity key fails LOUDLY instead of silently producing zero
 * mutants (or silently un-ignoring hundreds of vetted equivalents).
 *
 * It is INTENTIONALLY THIN — the detailed proofs (`injection-proof.test.ts`,
 * `llm-placement-proof.test.ts`, `llm-directive-proof.test.ts`,
 * `incremental-migration-proof.test.ts`) remain for regression depth; this canary
 * asserts the invariants in one worker spawn so CI can run it in isolation as a
 * named, blocking step (`bun run canary`) distinct from the coverage-gated full
 * `bun test`.
 *
 * THE EIGHT INVARIANTS (functional-architecture §3.4 / spec):
 *   (1) STRUCTURAL: `allMutators` is `Array.isArray`, NOT `Object.isFrozen`, and
 *       has the built-in count 16 — a drift flags a registry reshape.
 *   (2) DEEP-IMPORT PATHS RESOLVE: the five deep `dist/src/...` imports load (the
 *       worker's top-level imports ARE the assertion); and babel-transformer reads
 *       the SAME array we push to (push → transform → see our mutant).
 *   (3) HEURISTIC mutant instruments+places: `numberLiteralValueMutator` on
 *       `timeoutMs = 5000` → 3 NumberLiteralValue mutants + activation switches.
 *   (4) LLM mutant instruments+places: a node-aligned `hour >= 12 → hour > 12`
 *       survivor → 1 `LlmComparison` mutant (all 17 names registered), NO
 *       statementMutantPlacer throw, + its switch.
 *   (5) RESOLUTION-PARITY and (6) WITHLLMMUTATORS end-to-end (see the worker).
 *   (7) DIRECTIVE ALIAS: the bookkeeper deep path resolves, the alias installs,
 *       and a legacy `// Stryker disable next-line llm` yields an Ignored
 *       LlmComparison mutant with zero warn() calls — the guard for the second
 *       monkeypatch.
 *   (8) INCREMENTAL IDENTITY: the real differ reuses a report row renamed to the
 *       live name and re-runs a legacy `llm` row — the guard for the migration
 *       script's identity-format assumption.
 *
 * THE BUN/NODE WALL still applies: Stryker's instrumenter throws under Bun, so the
 * instrument step runs in a Node subprocess (the `canary-worker.mjs`). The Bun
 * side builds the LLM survivors via the REAL propose → range-align path (with a
 * MockProvider — no network) and bundles our pure seam + map builders to a temp
 * ESM module the Node worker imports.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MockProvider } from '../../src/llm/index';
import { propose, type ProposeTarget } from '../../src/pipeline/index';
import type { Replacement } from '../../src/seam/types';

const WORKER_PATH = fileURLToPath(new URL('./canary-worker.mjs', import.meta.url));

const LLM_FIXTURE_SOURCE =
    'export function isAfternoon(hour: number): boolean {\n    return hour >= 12;\n}\n';

/** Shape of the Node canary worker's JSON response. */
interface CanaryResponse {
    frozen: boolean;
    isArray: boolean;
    builtinCount: number;
    deepImportsOk: boolean;
    resolutionParity: boolean;
    heuristic: { count: number; switches: boolean };
    llm: {
        instrumented: boolean;
        count: number;
        switches: boolean;
        names: string[];
        registered: number;
        threw?: string;
    };
    withLlmMutators: {
        count: number;
        switches: boolean;
        cleanConfig: boolean;
        idempotent: boolean;
    };
    directiveAlias: {
        installed: boolean;
        pathResolves: boolean;
        ignored: { mutatorName: string; status?: string; statusReason?: string }[];
        warns: string[];
        commentIntact: boolean;
    };
    incrementalIdentity: {
        renamedReused: boolean;
        legacyReruns: boolean;
        killedBy: string[];
    };
    error?: string;
}

/** Run the Node canary worker and resolve its parsed JSON response. */
function runWorker(bundlePath: string, replacements: Replacement[]): Promise<CanaryResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [WORKER_PATH, bundlePath, JSON.stringify(replacements)], {
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
            reject(new Error(`Failed to spawn canary worker: ${error.message}`));
        });
        child.on('close', code => {
            let parsed: CanaryResponse;
            try {
                parsed = JSON.parse(stdout) as CanaryResponse;
            } catch {
                reject(
                    new Error(
                        `Canary worker emitted invalid JSON (exit ${String(code)}): ${stdout || stderr}`,
                    ),
                );
                return;
            }
            if (parsed.error) {
                reject(new Error(`Canary worker failed: ${parsed.error}`));
                return;
            }
            resolve(parsed);
        });
    });
}

/**
 * Build the LLM survivors via the REAL propose → range-align path with a
 * MockProvider returning a localized sub-expression edit (`hour >= 12` →
 * `hour > 12`). No network. The candidate's `original` is the SUB-EXPRESSION, so
 * range-align derives the BinaryExpression node's range (the placement crux).
 */
async function buildLlmSurvivors(): Promise<Replacement[]> {
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
        fileName: 'is-afternoon.ts',
        range: { start: { line: 0, column: 0 }, end: { line: 2, column: 1 } },
        spanText: LLM_FIXTURE_SOURCE,
        context: LLM_FIXTURE_SOURCE,
        fileContent: LLM_FIXTURE_SOURCE,
        spanStartOffset: 0,
        spanEndOffset: LLM_FIXTURE_SOURCE.length,
    };
    const { replacements, dropped } = await propose(provider, target);
    expect(dropped).toHaveLength(0);
    expect(replacements).toHaveLength(1);
    return replacements;
}

describe('per-version monkeypatch canary — eight load-bearing invariants (Node instrumenter)', () => {
    let tmpDir = '';
    let bundlePath = '';

    beforeAll(async () => {
        // Bundle our pure seam + map builders to an ESM module the Node worker can
        // import past the repo's extensionless TS imports. `@babel/*` +
        // `@stryker-mutator/*` + the relative mutate.js deep-import stay external
        // (resolved via the project's node_modules); the bundle lives INSIDE the
        // project root so those externals resolve — identical to the two existing
        // proofs. We wrap the three exports in a `mods` object so Bun's tree-shaker
        // (the source pkg is `sideEffects:false`) does not strip a bare re-export.
        const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
        tmpDir = await mkdtemp(path.join(projectRoot, '.tmp-canary-'));
        const entryPath = path.join(tmpDir, 'entry.ts');
        await Bun.write(
            entryPath,
            "import { injectMutators } from '../src/injection';\n" +
                "import { buildLlmMutatorMap } from '../src/pipeline/llm-map';\n" +
                "import { createLlmMutators, isLlmMutatorName, LLM_MUTATOR_NAMES } from '../src/mutators/llm-mutator';\n" +
                "import { withLlmMutators } from '../src/with-llm-mutators';\n" +
                "import { installLlmDirectiveAliasIntoStryker, resolveDirectiveBookkeeperPath } from '../src/directive-alias';\n" +
                "import { migrateIncrementalLlmNames } from '../scripts/migrate-incremental-llm-names';\n" +
                'export const mods = { injectMutators, buildLlmMutatorMap, createLlmMutators, isLlmMutatorName, LLM_MUTATOR_NAMES, withLlmMutators, installLlmDirectiveAliasIntoStryker, resolveDirectiveBookkeeperPath, migrateIncrementalLlmNames };\n',
        );
        bundlePath = path.join(tmpDir, 'canary-mods.mjs');
        const built = await Bun.build({
            entrypoints: [entryPath],
            target: 'node',
            format: 'esm',
            external: [
                '@stryker-mutator/*',
                '@babel/*',
                '@anthropic-ai/*',
                '../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js',
            ],
        });
        if (!built.success) {
            throw new Error(`Failed to bundle canary mods: ${built.logs.join('\n')}`);
        }
        // The bundle exports a single `mods` object holding the three builders; the
        // worker destructures from it. (A bare top-level re-export would collide
        // with Bun's own retained binding names, e.g. `injectMutators`.)
        await Bun.write(bundlePath, await built.outputs[0]!.text());
    });

    afterAll(async () => {
        if (tmpDir) {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('asserts all eight invariants in one worker round-trip', async () => {
        const survivors = await buildLlmSurvivors();
        const res = await runWorker(bundlePath, survivors);

        // (1) STRUCTURAL: mutable, non-frozen array of the expected built-in count.
        expect(res.isArray).toBe(true);
        expect(res.frozen).toBe(false);
        expect(res.builtinCount).toBe(16);

        // (2) DEEP-IMPORT PATHS: all five resolved (the worker would have failed to
        // spawn otherwise) AND babel-transformer read the SAME array we push to.
        expect(res.deepImportsOk).toBe(true);

        // (3) HEURISTIC mutant instruments + places (5001 / 4999 / 0 + switches).
        expect(res.heuristic.count).toBe(3);
        expect(res.heuristic.switches).toBe(true);

        // (4) LLM mutant instruments + places — NO statementMutantPlacer throw —
        // and is named by its category; all 17 names were registered up front.
        expect(res.llm.threw).toBeUndefined();
        expect(res.llm.instrumented).toBe(true);
        expect(res.llm.count).toBe(1);
        expect(res.llm.names).toEqual(['LlmComparison']);
        expect(res.llm.registered).toBe(17);
        expect(res.llm.switches).toBe(true);

        // (7) DIRECTIVE ALIAS (the second monkeypatch): the bookkeeper deep path
        // resolves, the installer returns true, and a legacy
        // `// Stryker disable next-line llm` fixture yields an IGNORED
        // LlmComparison mutant (Stryker's own bookkeeping, the directive's
        // reason) with zero logger.warn calls and the source comment intact.
        expect(res.directiveAlias.pathResolves).toBe(true);
        expect(res.directiveAlias.installed).toBe(true);
        expect(res.directiveAlias.ignored).toEqual([
            { mutatorName: 'LlmComparison', status: 'Ignored', statusReason: 'vetted equivalent' },
        ]);
        expect(res.directiveAlias.warns).toEqual([]);
        expect(res.directiveAlias.commentIntact).toBe(true);

        // (8) INCREMENTAL IDENTITY: the real differ's identifying key includes
        // `mutatorName`, so a report row renamed to the live name by the migration
        // script is REUSED (killedBy remapped) while a legacy `llm` row re-runs —
        // the per-version guard for the migration's identity assumption.
        expect(res.incrementalIdentity.renamedReused).toBe(true);
        expect(res.incrementalIdentity.legacyReruns).toBe(true);
        expect(res.incrementalIdentity.killedBy).toEqual(['new-test']);

        // (5) RESOLUTION-PARITY: the M6 runtime-resolved `allMutators` is the SAME
        // instance as the hardcoded deep-import — the load-bearing guarantee that
        // the resolution fix targets the array Stryker actually reads.
        expect(res.resolutionParity).toBe(true);

        // (6) WITHLLMMUTATORS END-TO-END: the wrapper resolves allMutators via the
        // registry, injects, and the heuristic mutants + switches appear through the
        // real instrumenter; the returned config is clean; a double call is a no-op.
        expect(res.withLlmMutators.count).toBe(3);
        expect(res.withLlmMutators.switches).toBe(true);
        expect(res.withLlmMutators.cleanConfig).toBe(true);
        expect(res.withLlmMutators.idempotent).toBe(true);
    });
});
