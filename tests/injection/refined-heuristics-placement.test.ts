import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const worker = fileURLToPath(new URL('./refined-heuristics-worker.mjs', import.meta.url));
let dir = '';
let bundle = '';
beforeAll(async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    dir = await mkdtemp(path.join(root, '.tmp-refined-heuristics-'));
    bundle = path.join(dir, 'injection.mjs');
    const built = await Bun.build({
        entrypoints: [fileURLToPath(new URL('./refined-heuristics-bundle.ts', import.meta.url))],
        target: 'node',
        format: 'esm',
        external: [
            '@stryker-mutator/*',
            '@babel/*',
            '../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js',
        ],
    });
    if (!built.success) {
        throw new Error(built.logs.join('\n'));
    }
    await Bun.write(bundle, await built.outputs[0]!.text());
});
afterAll(async () => {
    if (dir) {
        await rm(dir, { recursive: true, force: true });
    }
});
function run(instrumenterRoot: string): Promise<Array<{ name: string; replacement: string }>> {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [worker, bundle, instrumenterRoot], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', x => {
            out += x;
        });
        child.stderr.on('data', x => {
            err += x;
        });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) {
                reject(new Error(`worker exited ${String(code)}: ${out || err}`));
                return;
            }
            try {
                const parsed = JSON.parse(out);
                if (parsed.error) {
                    reject(new Error(parsed.error));
                } else {
                    resolve(parsed);
                }
            } catch {
                reject(new Error(out || err));
            }
        });
    });
}
describe('refined heuristics real instrumenter placement', () => {
    it('places each retained refined form through the installed Stryker instrumenter', async () => {
        const instrumenterRoot = fileURLToPath(
            new URL('../../node_modules/@stryker-mutator/instrumenter', import.meta.url),
        );
        const rows = await run(instrumenterRoot);
        expect(rows.filter(r => r.name === 'CallArgumentTweak').map(r => r.replacement)).toEqual([
            'xs.slice(end, start)',
        ]);
        expect(rows.filter(r => r.name === 'ArrayMethodSwap').map(r => r.replacement)).toEqual([
            'xs.unshift(a, b, ...rest)',
        ]);
        expect(
            rows
                .filter(r => r.name === 'PromiseCombinatorSwap')
                .map(r => r.replacement)
                .sort(),
        ).toEqual(['Promise.allSettled([a, b])', 'Promise.race([a, b])']);
    });
});
