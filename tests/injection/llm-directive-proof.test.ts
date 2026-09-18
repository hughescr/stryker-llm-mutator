/*
 * THE LLM DIRECTIVE PROOF (functional-architecture §5 "Equivalence/disable-
 * comment handling") — the offline real-instrumenter test for the
 * `Llm<Category>` naming fix and its backward-compatible `llm` wildcard.
 *
 * THE BUG: every LLM mutant was named `llm`, and Stryker's bookkeeper ignores
 * by `(line, name)`, so a `// Stryker disable next-line llm` written for ONE
 * vetted-equivalent proposal also hid every other proposal on that line.
 *
 * THE FIX (proven here against the REAL `transformBabel` + `DirectiveBookkeeper`
 * in a Node subprocess — the Bun/Node interop wall): on a span carrying three
 * different-kind entries (LlmComparison / LlmLogical / LlmNumber),
 *   (a) `disable next-line llm: reason` → all three Ignored with that reason;
 *   (b)/(c) `llm, NumberLiteralValue` and `NumberLiteralValue,llm` → all Ignored;
 *   (d) region `disable llm … restore llm` → first span Ignored, second live;
 *   (e) `disable llm … restore LlmNumber` → second span: LlmNumber live, others Ignored;
 *   (f) `disable next-line LlmComparison` → only LlmComparison Ignored;
 *   (g) `disable next-line all` → all Ignored;
 *   (h) no directive → all live;
 *   (i) [Finding 1] the CLI plan's expanded `excludedMutations` → all Ignored with
 *       the excluded-mutation reason; the unexpanded `['llm']` control stays live;
 *   (j) `logger.warn` is never called (every expanded name is registered);
 *   (k) the printed source keeps the ORIGINAL comment text (the AST is untouched);
 *   plus REGISTRATION: every `LLM_MUTATOR_NAMES` entry exactly once, no
 *   case-insensitive collision with a built-in or heuristic name.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { LLM_CATEGORIES } from '../../src/pipeline/classify';
import { LLM_MUTATOR_NAMES } from '../../src/mutators/llm-mutator';
import type { Replacement } from '../../src/seam/types';

const WORKER_PATH = fileURLToPath(new URL('./llm-directive-proof-worker.mjs', import.meta.url));

const FIXTURES: Record<string, string> = {
    plainLegacy:
        'function f(hour: number) {\n' +
        '    // Stryker disable next-line llm: vetted equivalent\n' +
        '    return hour >= 12;\n}\n',
    listLegacy:
        'function f(hour: number) {\n' +
        '    // Stryker disable next-line llm, NumberLiteralValue\n' +
        '    return hour >= 12;\n}\n',
    listLegacyBuiltinFirst:
        'function f(hour: number) {\n' +
        '    // Stryker disable next-line EqualityOperator,llm\n' +
        '    return hour >= 12;\n}\n',
    listLegacyMiddle:
        'function f(hour: number) {\n' +
        '    // Stryker disable next-line ConditionalExpression,EqualityOperator,llm,BlockStatement\n' +
        '    return hour >= 12;\n}\n',
    region:
        'function f(hour: number) {\n' +
        '    // Stryker disable llm\n' +
        '    const a = hour >= 12;\n' +
        '    // Stryker restore llm\n' +
        '    return hour >= 12;\n}\n',
    regionRestoreOneCategory:
        'function f(hour: number) {\n' +
        '    // Stryker disable llm\n' +
        '    const a = hour >= 12;\n' +
        '    // Stryker restore LlmNumber\n' +
        '    return hour >= 12;\n}\n',
    categoryOnly:
        'function f(hour: number) {\n' +
        '    // Stryker disable next-line LlmComparison: equivalent\n' +
        '    return hour >= 12;\n}\n',
    all:
        'function f(hour: number) {\n' +
        '    // Stryker disable next-line all\n' +
        '    return hour >= 12;\n}\n',
    none: 'function f(hour: number) {\n    return hour >= 12;\n}\n',
};

/** A placeholder range; the worker re-keys each entry onto every `hour >= 12` of a fixture. */
const RANGE = { start: { line: 0, column: 0 }, end: { line: 0, column: 10 } };

/** The three different-kind entries on the shared span (range filled in by the worker). */
const TEMPLATE: Replacement[] = [
    {
        fileName: 'fixture.ts',
        range: RANGE,
        original: 'hour >= 12',
        replacement: 'hour > 12',
        mutatorName: 'llm/boundary',
    },
    {
        fileName: 'fixture.ts',
        range: RANGE,
        original: 'hour >= 12',
        replacement: 'hour >= 12 || false',
        mutatorName: 'llm/guard',
    },
    {
        fileName: 'fixture.ts',
        range: RANGE,
        original: 'hour >= 12',
        replacement: 'hour >= 13',
        mutatorName: 'llm/literal',
    },
];

/** One collected mutant of ours. */
interface OurMutant {
    mutatorName: string;
    line: number;
    status?: string;
    statusReason?: string;
}

/** Shape of the worker's JSON response. */
interface WorkerResponse {
    installed: boolean;
    registration: { names: string[]; duplicates: string[]; collisions: string[] };
    cases: Record<string, OurMutant[]>;
    excluded: { expanded: OurMutant[]; control: OurMutant[]; planList: string[] };
    warns: string[];
    commentsIntact: Record<string, boolean>;
    error?: string;
}

function runWorker(bundlePath: string): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'node',
            [WORKER_PATH, bundlePath, JSON.stringify(FIXTURES), JSON.stringify(TEMPLATE)],
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
            reject(new Error(`Failed to spawn directive-proof worker: ${error.message}`));
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

/** The mutants of `mutants` on 0-based (Stryker API) `line`, as `name:status` strings, sorted. */
function onLine(mutants: OurMutant[], line: number): string[] {
    return mutants
        .filter(m => m.line === line)
        .map(m => `${m.mutatorName}:${m.status ?? 'live'}`)
        .toSorted();
}

const THREE = ['LlmComparison', 'LlmLogical', 'LlmNumber'] as const;
const allIgnored = THREE.map(n => `${n}:Ignored`);
const allLive = THREE.map(n => `${n}:live`);

describe('LLM directive proof — category names + legacy llm wildcard (Node instrumenter)', () => {
    let tmpDir = '';
    let bundlePath = '';
    let res: WorkerResponse;

    beforeAll(async () => {
        const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
        tmpDir = await mkdtemp(path.join(projectRoot, '.tmp-llm-directive-proof-'));
        const entryPath = path.join(tmpDir, 'entry.ts');
        await Bun.write(
            entryPath,
            "import { buildLlmMutatorMap } from '../src/pipeline/llm-map';\n" +
                "import { createLlmMutators, isLlmMutatorName, LLM_MUTATOR_NAMES } from '../src/mutators/llm-mutator';\n" +
                "import { heuristicMutators } from '../src/mutators/index';\n" +
                "import { installLlmDirectiveAliasIntoStryker } from '../src/directive-alias';\n" +
                "import { buildRunPlan } from '../src/driver/plan';\n" +
                "import { llmMutatorConfigSchema } from '../src/config';\n" +
                'export const mods = { buildLlmMutatorMap, createLlmMutators, isLlmMutatorName, LLM_MUTATOR_NAMES, heuristicMutators, installLlmDirectiveAliasIntoStryker, buildRunPlan, llmMutatorConfigSchema };\n',
        );
        bundlePath = path.join(tmpDir, 'directive-mods.mjs');
        const built = await Bun.build({
            entrypoints: [entryPath],
            target: 'node',
            format: 'esm',
            external: ['@babel/*', '@stryker-mutator/*', '@anthropic-ai/*'],
        });
        if (!built.success) {
            throw new Error(`Failed to bundle directive mods: ${built.logs.join('\n')}`);
        }
        await Bun.write(bundlePath, await built.outputs[0]!.text());
        res = await runWorker(bundlePath);
    });

    afterAll(async () => {
        if (tmpDir) {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('REGISTRATION: every LLM name exactly once, no case-insensitive collision', () => {
        expect(res.installed).toBe(true);
        expect(res.registration.names).toEqual([...LLM_MUTATOR_NAMES]);
        expect(res.registration.duplicates).toEqual([]);
        expect(res.registration.collisions).toEqual([]);
    });

    it('(a) plain legacy `disable next-line llm: reason` ignores all three with that reason', () => {
        const mutants = res.cases.plainLegacy!;
        expect(onLine(mutants, 2)).toEqual(allIgnored);
        expect(mutants.every(m => m.statusReason === 'vetted equivalent')).toBe(true);
    });

    it('(b)/(c) list forms in either order and in the middle ignore all three', () => {
        expect(onLine(res.cases.listLegacy!, 2)).toEqual(allIgnored);
        expect(onLine(res.cases.listLegacyBuiltinFirst!, 2)).toEqual(allIgnored);
        expect(onLine(res.cases.listLegacyMiddle!, 2)).toEqual(allIgnored);
    });

    it('(d) region `disable llm … restore llm`: first span Ignored, second live', () => {
        expect(onLine(res.cases.region!, 2)).toEqual(allIgnored);
        expect(onLine(res.cases.region!, 4)).toEqual(allLive);
    });

    it('(e) `restore LlmNumber` inside a `disable llm` region restores only that category', () => {
        expect(onLine(res.cases.regionRestoreOneCategory!, 2)).toEqual(allIgnored);
        expect(onLine(res.cases.regionRestoreOneCategory!, 4)).toEqual([
            'LlmComparison:Ignored',
            'LlmLogical:Ignored',
            'LlmNumber:live',
        ]);
    });

    it('(f) `disable next-line LlmComparison` ignores only that category on the shared span', () => {
        expect(onLine(res.cases.categoryOnly!, 2)).toEqual([
            'LlmComparison:Ignored',
            'LlmLogical:live',
            'LlmNumber:live',
        ]);
        const ignored = res.cases.categoryOnly!.find(m => m.mutatorName === 'LlmComparison')!;
        expect(ignored.statusReason).toBe('equivalent');
    });

    it('(g) `all` still ignores everything; (h) no directive leaves all live', () => {
        expect(onLine(res.cases.all!, 2)).toEqual(allIgnored);
        expect(onLine(res.cases.none!, 1)).toEqual(allLive);
    });

    it("(i) [Finding 1] the CLI plan's expanded excludedMutations ignores all three; the ['llm'] control does not", () => {
        expect(res.excluded.planList).toEqual(['llm', ...LLM_CATEGORIES]);
        expect(onLine(res.excluded.expanded, 1)).toEqual(allIgnored);
        for (const m of res.excluded.expanded) {
            expect(m.statusReason).toBe(`Ignored because of excluded mutation "${m.mutatorName}"`);
        }
        expect(onLine(res.excluded.control, 1)).toEqual(allLive);
    });

    it('(j) logger.warn is never called; (k) the printed source keeps the original comments', () => {
        expect(res.warns).toEqual([]);
        for (const [name, intact] of Object.entries(res.commentsIntact)) {
            expect(`${name}:${String(intact)}`).toBe(`${name}:true`);
        }
    });
});
