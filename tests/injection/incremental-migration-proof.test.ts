/*
 * THE INCREMENTAL MIGRATION PROOF [Finding 4] — the real `IncrementalDiffer`
 * (this package's `@stryker-mutator/core` 9.6.1, in a Node subprocess) over a
 * fixture report, showing that `scripts/migrate-incremental-llm-names.ts` turns
 * a guaranteed miss into a reuse and can never manufacture a false verdict:
 *   (a) a row left as `llm` re-runs;
 *   (b) the migrated row is reused as Killed, killedBy remapped to the current
 *       test id, coveredBy from the current coverage;
 *   (c) a source change inside the span re-runs;
 *   (d) a renamed killing test re-runs;
 *   (e) a migrated row whose name differs from the live mutant's re-runs.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const WORKER_PATH = fileURLToPath(
    new URL('./incremental-migration-proof-worker.mjs', import.meta.url),
);

interface DiffOutcome {
    status: string;
    killedBy: string[];
    coveredBy: string[];
}

interface WorkerResponse {
    migratedName: string;
    stats: { total: number; migrated: Record<string, number> };
    a_unmigrated: DiffOutcome;
    b_migrated: DiffOutcome;
    c_sourceChanged: DiffOutcome;
    d_testRenamed: DiffOutcome;
    e_wrongName: DiffOutcome;
    error?: string;
}

function runWorker(bundlePath: string): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [WORKER_PATH, bundlePath], {
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
            reject(new Error(`Failed to spawn migration-proof worker: ${error.message}`));
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

describe('incremental migration proof — real IncrementalDiffer (Node)', () => {
    let tmpDir = '';
    let res: WorkerResponse;

    beforeAll(async () => {
        const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
        tmpDir = await mkdtemp(path.join(projectRoot, '.tmp-incremental-migration-proof-'));
        const entryPath = path.join(tmpDir, 'entry.ts');
        await Bun.write(
            entryPath,
            "import { migrateIncrementalLlmNames } from '../scripts/migrate-incremental-llm-names';\n" +
                'export const mods = { migrateIncrementalLlmNames };\n',
        );
        const bundlePath = path.join(tmpDir, 'migration-mods.mjs');
        const built = await Bun.build({
            entrypoints: [entryPath],
            target: 'node',
            format: 'esm',
            external: ['@babel/*', '@stryker-mutator/*', '@anthropic-ai/*'],
        });
        if (!built.success) {
            throw new Error(`Failed to bundle migration mods: ${built.logs.join('\n')}`);
        }
        await Bun.write(bundlePath, await built.outputs[0]!.text());
        res = await runWorker(bundlePath);
    });

    afterAll(async () => {
        if (tmpDir) {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('migrates the fixture row to the live name (LlmComparison)', () => {
        expect(res.migratedName).toBe('LlmComparison');
        expect(res.stats.total).toBe(1);
        expect(res.stats.migrated.LlmComparison).toBe(1);
    });

    it('(a) an unmigrated `llm` row re-runs', () => {
        expect(res.a_unmigrated.status).toBe('rerun');
    });

    it('(b) the migrated row is reused: Killed, killedBy remapped, coveredBy current', () => {
        expect(res.b_migrated.status).toBe('Killed');
        expect(res.b_migrated.killedBy).toEqual(['new-test']);
        expect(res.b_migrated.coveredBy).toEqual(['new-test']);
    });

    it('(c) a source change inside the span still re-runs after migration', () => {
        expect(res.c_sourceChanged.status).toBe('rerun');
    });

    it('(d) a renamed killing test still re-runs after migration', () => {
        expect(res.d_testRenamed.status).toBe('rerun');
    });

    it('(e) a migrated row whose name differs from the live mutant re-runs (no false reuse)', () => {
        expect(res.e_wrongName.status).toBe('rerun');
    });
});
