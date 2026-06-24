/*
 * Offline unit tests for the pure CLI arg parser `parseArgs`
 * (functional-architecture §6 CLI surface). Covers defaults, mode/run-mode mutual
 * exclusion, --mutate glob mapping (repeat + comma-list), all pass-through flags,
 * and usage errors. Tests the PURE parser only — never the Stryker invocation.
 */

import { describe, expect, it } from 'bun:test';

import { parseArgs, type RunOptions } from '../../src/driver/cli-args';

const CWD = '/work/project';

/** Assert a successful parse and return its options. */
function ok(argv: string[]): RunOptions {
    const result = parseArgs(argv, CWD);
    if (!result.ok) {
        throw new Error(`expected ok parse, got error: ${result.error}`);
    }
    return result.options;
}

/** Assert a failed parse and return its error message. */
function fail(argv: string[]): string {
    const result = parseArgs(argv, CWD);
    if (result.ok) {
        throw new Error('expected parse failure, got ok');
    }
    return result.error;
}

describe('parseArgs — subcommand', () => {
    it('requires the "run" subcommand', () => {
        expect(fail([])).toContain('run');
        expect(fail(['nope'])).toContain('run');
    });
});

describe('parseArgs — defaults', () => {
    it('defaults projectDir to cwd, mode augment, dry-run, empty mutate', () => {
        const opts = ok(['run']);
        expect(opts.projectDir).toBe(CWD);
        expect(opts.mode).toBe('augment');
        expect(opts.live).toBe(false);
        expect(opts.mutate).toEqual([]);
        expect(opts.configFile).toBeUndefined();
        expect(opts.concurrency).toBeUndefined();
        expect(opts.reporters).toBeUndefined();
        expect(opts.incremental).toBeUndefined();
        expect(opts.tempDirName).toBeUndefined();
        expect(opts.frozen).toBeUndefined();
    });

    it('accepts a positional projectDir', () => {
        expect(ok(['run', '/other/dir']).projectDir).toBe('/other/dir');
    });

    it('rejects a second positional argument', () => {
        expect(fail(['run', 'a', 'b'])).toContain('extra positional');
    });
});

describe('parseArgs — injection mode', () => {
    it('--ours-only → replace mode', () => {
        expect(ok(['run', '--ours-only']).mode).toBe('replace');
    });

    it('--augment → augment mode', () => {
        expect(ok(['run', '--augment']).mode).toBe('augment');
    });

    it('rejects --ours-only and --augment together', () => {
        expect(fail(['run', '--ours-only', '--augment'])).toContain('mutually exclusive');
    });
});

describe('parseArgs — run mode', () => {
    it('--live → live true', () => {
        expect(ok(['run', '--live']).live).toBe(true);
    });

    it('--dry-run keeps live false', () => {
        expect(ok(['run', '--dry-run']).live).toBe(false);
    });

    it('rejects --dry-run and --live together', () => {
        expect(fail(['run', '--dry-run', '--live'])).toContain('mutually exclusive');
    });
});

describe('parseArgs — --mutate', () => {
    it('maps a single glob', () => {
        expect(ok(['run', '--mutate', 'src/a.ts']).mutate).toEqual(['src/a.ts']);
    });

    it('flattens a comma-list', () => {
        expect(ok(['run', '--mutate', 'src/a.ts,src/b.ts']).mutate).toEqual([
            'src/a.ts',
            'src/b.ts',
        ]);
    });

    it('accumulates repeated --mutate flags', () => {
        expect(ok(['run', '--mutate', 'a.ts', '--mutate', 'b.ts,c.ts']).mutate).toEqual([
            'a.ts',
            'b.ts',
            'c.ts',
        ]);
    });

    it('errors when --mutate has no value', () => {
        expect(fail(['run', '--mutate'])).toContain('requires a value');
    });

    it('errors when --mutate is followed by another flag', () => {
        expect(fail(['run', '--mutate', '--live'])).toContain('requires a value');
    });
});

describe('parseArgs — pass-through flags', () => {
    it('--config-file', () => {
        expect(ok(['run', '--config-file', 'stryker.config.mjs']).configFile).toBe(
            'stryker.config.mjs',
        );
    });

    it('--concurrency (positive integer)', () => {
        expect(ok(['run', '--concurrency', '4']).concurrency).toBe(4);
    });

    it('rejects a non-numeric --concurrency', () => {
        expect(fail(['run', '--concurrency', 'lots'])).toContain('positive integer');
    });

    it('rejects a zero --concurrency', () => {
        expect(fail(['run', '--concurrency', '0'])).toContain('positive integer');
    });

    it('--reporters comma-list', () => {
        expect(ok(['run', '--reporters', 'clear-text,html']).reporters).toEqual([
            'clear-text',
            'html',
        ]);
    });

    it('--incremental and --no-incremental', () => {
        expect(ok(['run', '--incremental']).incremental).toBe(true);
        expect(ok(['run', '--no-incremental']).incremental).toBe(false);
    });

    it('--temp-dir', () => {
        expect(ok(['run', '--temp-dir', '.tmp-x']).tempDirName).toBe('.tmp-x');
    });

    it('--frozen → frozen true (overrides config to cache-only)', () => {
        expect(ok(['run', '--frozen']).frozen).toBe(true);
    });
});

describe('parseArgs — missing flag values', () => {
    it('errors when --config-file has no value', () => {
        expect(fail(['run', '--config-file'])).toContain('requires a value');
    });

    it('errors when --concurrency has no value', () => {
        expect(fail(['run', '--concurrency'])).toContain('requires a value');
    });

    it('errors when --reporters has no value', () => {
        expect(fail(['run', '--reporters'])).toContain('requires a value');
    });

    it('errors when --temp-dir has no value', () => {
        expect(fail(['run', '--temp-dir'])).toContain('requires a value');
    });
});

describe('parseArgs — unknown flags', () => {
    it('rejects an unknown flag', () => {
        expect(fail(['run', '--frobnicate'])).toContain('unknown flag');
    });
});

describe('parseArgs — combined', () => {
    it('parses a realistic invocation end to end', () => {
        const opts = ok([
            'run',
            '/proj',
            '--ours-only',
            '--live',
            '--mutate',
            'src/x.ts,src/y.ts',
            '--concurrency',
            '8',
            '--reporters',
            'clear-text',
            '--no-incremental',
            '--temp-dir',
            '.stryker-tmp',
            '--config-file',
            'stryker.config.mjs',
        ]);
        expect(opts).toEqual({
            projectDir: '/proj',
            mode: 'replace',
            live: true,
            mutate: ['src/x.ts', 'src/y.ts'],
            concurrency: 8,
            reporters: ['clear-text'],
            incremental: false,
            tempDirName: '.stryker-tmp',
            configFile: 'stryker.config.mjs',
        });
    });
});
