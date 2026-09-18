/*
 * Offline tests for `scripts/migrate-incremental-llm-names.ts`: the PURE core
 * over a fabricated `stryker-incremental.json` (1-based line AND column, with the
 * embedded `source`), and the CLI's refusal / dry-run behaviour in a temp dir —
 * including that a symlinked, hard-linked, dangling-symlinked or plain existing
 * `--out` is refused, so the input inode can never be truncated through an alias.
 * No Stryker run; the real-differ reuse proof lives in
 * `tests/injection/incremental-migration-proof.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { link, lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    defaultOutputPath,
    migrateIncrementalLlmNames,
    writeReportExclusively,
    type MigrationStats,
} from '../../scripts/migrate-incremental-llm-names';

const SCRIPT = fileURLToPath(
    new URL('../../scripts/migrate-incremental-llm-names.ts', import.meta.url),
);

/** A 1-based report location. */
function loc(
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
): { start: { line: number; column: number }; end: { line: number; column: number } } {
    return {
        start: { line: startLine, column: startColumn },
        end: { line: endLine, column: endColumn },
    };
}

// Line 1: `const value = hour >= 12;`      → `hour >= 12` is cols 15..25 (1-based, end exclusive)
// Line 2: `const opts = { inline };`       → `{ inline }` is cols 14..24
// Line 3: `const total = a +`              → multi-line `a +\n    b` spans 3:15 → 4:6
// Line 4: `    b;`
// Line 5: `const n = 300;`                 → `300` is cols 11..14
// Line 6: `const t = true;`                → `true` is cols 11..15
const SOURCE = [
    'const value = hour >= 12;',
    'const opts = { inline };',
    'const total = a +',
    '    b;',
    'const n = 300;',
    'const t = true;',
    'const obj = { a: 1, b: 2 };',
].join('\n');

function report(): Record<string, unknown> {
    return {
        schemaVersion: '2',
        thresholds: { high: 80, low: 60 },
        files: {
            'src/a.ts': {
                language: 'typescript',
                source: SOURCE,
                mutants: [
                    // LlmComparison
                    {
                        id: '1',
                        mutatorName: 'llm',
                        replacement: 'hour > 12',
                        location: loc(1, 15, 1, 25),
                        status: 'Killed',
                        killedBy: ['t1'],
                        coveredBy: ['t1'],
                        testsCompleted: 1,
                    },
                    // Shorthand-object placement → LlmConstant (key `inline` → `false`)
                    {
                        id: '2',
                        mutatorName: 'llm',
                        replacement: '{\n  inline: false\n}',
                        location: loc(2, 14, 2, 24),
                        status: 'Killed',
                        killedBy: ['t1'],
                    },
                    // Multi-line row → LlmArithmetic
                    {
                        id: '3',
                        mutatorName: 'llm',
                        replacement: 'a - b',
                        location: loc(3, 15, 4, 6),
                        status: 'CompileError',
                    },
                    // LlmNumber
                    {
                        id: '4',
                        mutatorName: 'llm',
                        replacement: '301',
                        location: loc(5, 11, 5, 14),
                        status: 'Timeout',
                    },
                    // A heuristic row and a built-in row: untouched
                    {
                        id: '5',
                        mutatorName: 'NumberLiteralValue',
                        replacement: '299',
                        location: loc(5, 11, 5, 14),
                        status: 'Killed',
                    },
                    {
                        id: '6',
                        mutatorName: 'heuristic/x',
                        replacement: 'false',
                        location: loc(6, 11, 6, 15),
                        status: 'Killed',
                    },
                    // bad location (line 99 does not exist)
                    {
                        id: '7',
                        mutatorName: 'llm',
                        replacement: 'x',
                        location: loc(99, 1, 99, 2),
                        status: 'Killed',
                    },
                    // missing replacement
                    { id: '8', mutatorName: 'llm', location: loc(1, 15, 1, 25), status: 'Killed' },
                    // unparseable replacement
                    {
                        id: '9',
                        mutatorName: 'llm',
                        replacement: 'hour >',
                        location: loc(1, 15, 1, 25),
                        status: 'Ignored',
                        statusReason: 'Ignored using a comment',
                    },
                    // ambiguous shorthand: both objects, but not a single shorthand expansion
                    {
                        id: '10',
                        mutatorName: 'llm',
                        replacement: '{ a: 1, b: 3 }',
                        location: loc(7, 13, 7, 27),
                        status: 'Killed',
                    },
                    // LlmConstant (a plain boolean literal edit)
                    {
                        id: '11',
                        mutatorName: 'llm',
                        replacement: 'false',
                        location: loc(6, 11, 6, 15),
                        status: 'Killed',
                    },
                ],
            },
            'src/no-source.ts': {
                language: 'typescript',
                mutants: [
                    {
                        id: '12',
                        mutatorName: 'llm',
                        replacement: 'x',
                        location: loc(1, 1, 1, 2),
                        status: 'Killed',
                    },
                ],
            },
        },
        testFiles: { '': { tests: [{ id: 't1', name: 'kills' }] } },
    };
}

/** JSON with every `mutatorName` blanked, so two reports can be compared modulo names. */
function modNames(value: unknown): string {
    return JSON.stringify(value, (key, v: unknown) => (key === 'mutatorName' ? '' : v));
}

describe('migrateIncrementalLlmNames (pure core)', () => {
    it('renames each llm row to its live category and counts by category / status', () => {
        const input = report();
        const { report: out, stats } = migrateIncrementalLlmNames(input);
        const mutants = (
            out as { files: Record<string, { mutants: { id: string; mutatorName: string }[] }> }
        ).files['src/a.ts']!.mutants;
        const name = (id: string): string => mutants.find(m => m.id === id)!.mutatorName;
        expect(name('1')).toBe('LlmComparison');
        expect(name('2')).toBe('LlmConstant');
        expect(name('3')).toBe('LlmArithmetic');
        expect(name('4')).toBe('LlmNumber');
        expect(name('11')).toBe('LlmConstant');
        // Untouched rows.
        expect(name('5')).toBe('NumberLiteralValue');
        expect(name('6')).toBe('heuristic/x');
        // Skipped rows keep `llm`.
        for (const id of ['7', '8', '9', '10']) {
            expect(name(id)).toBe('llm');
        }

        const expected: MigrationStats = {
            total: 10,
            migrated: {
                LlmComparison: 1,
                LlmConstant: 2,
                LlmArithmetic: 1,
                LlmNumber: 1,
            } as MigrationStats['migrated'],
            skipped: { badLocation: 2, noReplacement: 1, unparseable: 1, ambiguousShorthand: 1 },
            byStatus: { Killed: 7, CompileError: 1, Timeout: 1, Ignored: 1 },
        };
        expect(stats.total).toBe(expected.total);
        expect(stats.skipped).toEqual(expected.skipped);
        expect(stats.byStatus).toEqual(expected.byStatus);
        for (const [category, n] of Object.entries(expected.migrated)) {
            expect(stats.migrated[category as keyof MigrationStats['migrated']]).toBe(n);
        }
        const migratedTotal = Object.values(stats.migrated).reduce((a, b) => a + b, 0);
        expect(migratedTotal).toBe(5);
        expect(migratedTotal + Object.values(stats.skipped).reduce((a, b) => a + b, 0)).toBe(
            stats.total,
        );
    });

    it('changes ONLY mutatorName fields and never mutates its input', () => {
        const input = report();
        const before = JSON.stringify(input);
        const { report: out } = migrateIncrementalLlmNames(input);
        expect(JSON.stringify(input)).toBe(before);
        expect(out).not.toBe(input);
        expect(modNames(out)).toBe(modNames(input));
    });

    it('tolerates a report with no files / a malformed shape (no throw, nothing migrated)', () => {
        for (const value of [undefined, null, 3, 'x', {}, { files: null }, { files: { a: 4 } }]) {
            const { stats } = migrateIncrementalLlmNames(value);
            expect(stats.total).toBe(0);
        }
    });

    it('treats an out-of-range column as a bad location', () => {
        const input = report() as { files: Record<string, { mutants: unknown[] }> };
        input.files['src/a.ts']!.mutants = [
            {
                id: 'x',
                mutatorName: 'llm',
                replacement: 'y',
                location: loc(1, 20, 1, 80),
                status: 'Killed',
            },
            {
                id: 'y',
                mutatorName: 'llm',
                replacement: 'y',
                location: { start: { line: 0, column: 1 }, end: { line: 1, column: 2 } },
                status: 'Killed',
            },
            { id: 'z', mutatorName: 'llm', replacement: 'y', status: 'Killed' },
        ];
        const { stats } = migrateIncrementalLlmNames(input);
        // The three rows above plus the `src/no-source.ts` row (no `source` at all).
        expect(stats.skipped.badLocation).toBe(4);
    });
});

describe('defaultOutputPath', () => {
    it('is <dir>/<basename>.llm-migrated.json', () => {
        expect(defaultOutputPath('/x/reports/stryker-incremental.json')).toBe(
            '/x/reports/stryker-incremental.llm-migrated.json',
        );
        expect(defaultOutputPath('/x/r.txt')).toBe('/x/r.txt.llm-migrated.json');
    });
});

describe('CLI (temp dir)', () => {
    let dir = '';

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stryker-llm-migrate-'));
        await writeFile(join(dir, 'stryker-incremental.json'), JSON.stringify(report()), 'utf8');
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
        return new Promise(resolve => {
            const child = spawn('bun', [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
            child.on('close', code => resolve({ code, stdout, stderr }));
        });
    }

    it('refuses --out equal to --in (exit 2) and writes nothing', async () => {
        const input = join(dir, 'stryker-incremental.json');
        const before = await readFile(input, 'utf8');
        const { code, stderr } = await run(['--in', input, '--out', input]);
        expect(code).toBe(2);
        expect(stderr).toContain('never writes in place');
        expect(await readFile(input, 'utf8')).toBe(before);
        expect(await readdir(dir)).toEqual(['stryker-incremental.json']);
    });

    it('--dry-run prints the table and writes nothing', async () => {
        const input = join(dir, 'stryker-incremental.json');
        const { code, stdout } = await run(['--in', input, '--dry-run']);
        expect(code).toBe(0);
        expect(stdout).toContain('[dry-run]');
        expect(stdout).toContain('LlmComparison');
        expect(await readdir(dir)).toEqual(['stryker-incremental.json']);
    });

    it('writes the migrated report to the default sibling path', async () => {
        const input = join(dir, 'stryker-incremental.json');
        const { code, stdout } = await run(['--in', input]);
        expect(code).toBe(0);
        expect(stdout).toContain('wrote');
        const out = join(dir, 'stryker-incremental.llm-migrated.json');
        const migrated = JSON.parse(await readFile(out, 'utf8')) as {
            files: Record<string, { mutants: { id: string; mutatorName: string }[] }>;
        };
        expect(migrated.files['src/a.ts']!.mutants[0]!.mutatorName).toBe('LlmComparison');
        // The input is byte-identical.
        expect(await readFile(input, 'utf8')).toBe(JSON.stringify(report()));
    });

    // The no-in-place guarantee must hold for filesystem ALIASES too: a path
    // comparison alone lets a symlink or hard link named `--out` truncate the
    // input inode. Each case: exit 2, nothing written, the input byte-identical,
    // and the alias itself left exactly as it was.
    async function expectRefusedAlias(
        outName: string,
        setup: (input: string, out: string) => Promise<void>,
    ): Promise<void> {
        const input = join(dir, 'stryker-incremental.json');
        const out = join(dir, outName);
        await setup(input, out);
        const before = await readFile(input, 'utf8');
        const outBefore = await lstat(out);
        const { code, stderr } = await run(['--in', input, '--out', out]);
        expect(code).toBe(2);
        expect(stderr).toContain('already exists');
        expect(await readFile(input, 'utf8')).toBe(before);
        expect(before).toBe(JSON.stringify(report()));
        const outAfter = await lstat(out);
        expect(outAfter.isSymbolicLink()).toBe(outBefore.isSymbolicLink());
        expect(outAfter.size).toBe(outBefore.size);
        expect((await readdir(dir)).toSorted()).toEqual(
            ['stryker-incremental.json', outName].toSorted(),
        );
    }

    it('refuses a symlinked --out (a symlink to --in): the input is never touched', async () => {
        await expectRefusedAlias('out.json', (input, out) => symlink(input, out));
    });

    it('refuses a hard-linked --out (a hard link to --in): the input is never touched', async () => {
        await expectRefusedAlias('out.json', (input, out) => link(input, out));
    });

    it('refuses an --out that already exists as a regular file (never overwrites)', async () => {
        await expectRefusedAlias('out.json', (_input, out) =>
            writeFile(out, '{"stale":1}', 'utf8'),
        );
    });

    it('refuses the default sibling path when a previous run left it behind', async () => {
        const input = join(dir, 'stryker-incremental.json');
        const out = join(dir, 'stryker-incremental.llm-migrated.json');
        await writeFile(out, '{"stale":1}', 'utf8');
        const { code, stderr } = await run(['--in', input]);
        expect(code).toBe(2);
        expect(stderr).toContain('already exists');
        expect(await readFile(out, 'utf8')).toBe('{"stale":1}');
    });

    it('refuses a dangling symlink at --out (it would be followed on create)', async () => {
        const input = join(dir, 'stryker-incremental.json');
        const out = join(dir, 'out.json');
        const target = join(dir, 'elsewhere.json');
        await symlink(target, out);
        const { code, stderr } = await run(['--in', input, '--out', out]);
        expect(code).toBe(2);
        expect(stderr).toContain('already exists');
        expect((await readdir(dir)).toSorted()).toEqual(['out.json', 'stryker-incremental.json']);
    });

    it('--dry-run with an existing --out still prints the table and writes nothing', async () => {
        const input = join(dir, 'stryker-incremental.json');
        const out = join(dir, 'out.json');
        await symlink(input, out);
        const { code, stdout } = await run(['--in', input, '--out', out, '--dry-run']);
        expect(code).toBe(0);
        expect(stdout).toContain('[dry-run]');
        expect(await readFile(input, 'utf8')).toBe(JSON.stringify(report()));
    });
});

describe('writeReportExclusively', () => {
    let dir = '';

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stryker-llm-migrate-wx-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('creates a new file', async () => {
        const out = join(dir, 'new.json');
        await writeReportExclusively(out, '{"a":1}');
        expect(await readFile(out, 'utf8')).toBe('{"a":1}');
    });

    it('rejects when the path already exists (the create is exclusive, so a race cannot truncate)', async () => {
        const original = join(dir, 'in.json');
        const alias = join(dir, 'alias.json');
        await writeFile(original, '{"keep":true}', 'utf8');
        await symlink(original, alias);
        await expect(writeReportExclusively(alias, '{"a":1}')).rejects.toThrow(/already exists/);
        await expect(writeReportExclusively(original, '{"a":1}')).rejects.toThrow(/already exists/);
        expect(await readFile(original, 'utf8')).toBe('{"keep":true}');
    });

    it('rethrows a non-EEXIST failure unchanged', async () => {
        const out = join(dir, 'missing-dir', 'new.json');
        await expect(writeReportExclusively(out, '{"a":1}')).rejects.toThrow(/ENOENT/);
    });
});
