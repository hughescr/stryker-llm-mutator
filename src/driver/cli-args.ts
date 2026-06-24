/*
 * PURE CLI argument parser for `stryker-llm run [projectDir] [flags]`
 * (functional-architecture §6 CLI surface). Hand-rolled (the demo idiom) to keep
 * the bin self-contained — `commander` is only a TRANSITIVE dep of Stryker core,
 * and adding it as a direct dep grows the knip/dependency surface. This module
 * imports NOTHING side-effecting (no Stryker, no process.argv, no exit), so it is
 * fully unit-testable under `bun test`; `src/cli.ts` wires it to `process.argv`
 * and `process.exit`.
 *
 * Flags → drive options:
 *   • `[projectDir]` positional → chdir + config-resolution root (default cwd).
 *   • `--ours-only` / `--augment` → injection mode (`replace` vs `augment`);
 *     default `augment` (the safer general default per §6). Mutually exclusive.
 *   • `--dry-run` (default) / `--live` → `--dry-run` builds + selects + injects +
 *     validates and PRINTS the plan WITHOUT calling Stryker (sandbox-safe);
 *     `--live` actually invokes Stryker.
 *   • `--mutate <glob>` (repeatable; comma-lists allowed) → Stryker `mutate: [...]`.
 *   • `--config-file <path>` → forwarded to readTargetConfig + Stryker.
 *   • `--concurrency <n>`, `--reporters <r,...>`, `--incremental`/`--no-incremental`,
 *     `--temp-dir <name>` → assembled into the partial Stryker options.
 * Unknown flags / bad values → a usage error (the CLI exits 1).
 */

/** The injection mode the driver applies to `allMutators`. */
export type InjectionMode = 'augment' | 'replace';

/**
 * The fully-parsed run options the driver consumes. Side-effect-free data; the
 * driver (`runLlmMutation`) turns this into the gating decision + Stryker options.
 */
export interface RunOptions {
    /** Project root (chdir + config root). Default: the parser's `cwd`. */
    projectDir: string;
    /** `replace` for `--ours-only`, `augment` (default) for `--augment`. */
    mode: InjectionMode;
    /** `false` for `--dry-run` (default), `true` for `--live`. */
    live: boolean;
    /** `--mutate` globs (flattened comma-lists); empty = use the target config's own `mutate`. */
    mutate: string[];
    /** `--config-file` override, or `undefined` to probe the default names. */
    configFile?: string;
    /** `--concurrency <n>`, or `undefined` for Stryker's default. */
    concurrency?: number;
    /** `--reporters <r,...>` (flattened), or `undefined` for the target config's reporters. */
    reporters?: string[];
    /** `--incremental` → `true`, `--no-incremental` → `false`, absent → `undefined`. */
    incremental?: boolean;
    /** `--temp-dir <name>`, or `undefined` for Stryker's default. */
    tempDirName?: string;
}

/** A discriminated parse outcome: success carries options; failure carries a usage message. */
export type ParseResult = { ok: true; options: RunOptions } | { ok: false; error: string };

/** The single supported subcommand. */
const SUBCOMMAND = 'run';

/** One-line usage string surfaced on any parse error. */
export const USAGE =
    'usage: stryker-llm run [projectDir] [--ours-only|--augment] [--dry-run|--live] ' +
    '[--mutate <glob>]... [--config-file <path>] [--concurrency <n>] ' +
    '[--reporters <r,...>] [--incremental|--no-incremental] [--temp-dir <name>]';

/** Parse a positive integer flag value; returns `undefined` when invalid. */
function parsePositiveInt(value: string): number | undefined {
    if (!/^\d+$/.test(value)) {
        return undefined;
    }
    const n = Number(value);
    return n > 0 ? n : undefined;
}

/** Split a comma-list flag value into trimmed, non-empty entries. */
function splitList(value: string): string[] {
    return value
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

/**
 * The mutable accumulator the parser fills as it walks the argv. Kept flat so the
 * boolean- and value-flag tables can set fields by name without growing the main
 * loop's branch count (which keeps cyclomatic complexity low).
 */
interface Acc {
    projectDir?: string;
    oursOnly: boolean;
    augment: boolean;
    dryRun: boolean;
    live: boolean;
    mutate: string[];
    configFile?: string;
    concurrency?: number;
    reporters?: string[];
    incremental?: boolean;
    tempDirName?: string;
}

/** Boolean flags: each sets one accumulator field to a fixed value. */
const BOOLEAN_FLAGS: Record<string, (acc: Acc) => void> = {
    '--ours-only': acc => {
        acc.oursOnly = true;
    },
    '--augment': acc => {
        acc.augment = true;
    },
    '--dry-run': acc => {
        acc.dryRun = true;
    },
    '--live': acc => {
        acc.live = true;
    },
    '--incremental': acc => {
        acc.incremental = true;
    },
    '--no-incremental': acc => {
        acc.incremental = false;
    },
};

/**
 * Value flags: each consumes the NEXT token. The handler returns an error string
 * on a bad value, or `undefined` on success (having mutated the accumulator).
 */
const VALUE_FLAGS: Record<string, (acc: Acc, value: string) => string | undefined> = {
    '--mutate': (acc, value) => {
        acc.mutate.push(...splitList(value));
        return undefined;
    },
    '--config-file': (acc, value) => {
        acc.configFile = value;
        return undefined;
    },
    '--reporters': (acc, value) => {
        acc.reporters = splitList(value);
        return undefined;
    },
    '--temp-dir': (acc, value) => {
        acc.tempDirName = value;
        return undefined;
    },
    '--concurrency': (acc, value) => {
        const n = parsePositiveInt(value);
        if (n === undefined) {
            return `--concurrency must be a positive integer (got "${value}").`;
        }
        acc.concurrency = n;
        return undefined;
    },
};

/** Validate the mutual-exclusion constraints; returns an error string or `undefined`. */
function checkExclusivity(acc: Acc): string | undefined {
    if (acc.oursOnly && acc.augment) {
        return `--ours-only and --augment are mutually exclusive.\n${USAGE}`;
    }
    if (acc.dryRun && acc.live) {
        return `--dry-run and --live are mutually exclusive.\n${USAGE}`;
    }
    return undefined;
}

/** Assemble the public {@link RunOptions} from a filled accumulator. */
function toOptions(acc: Acc, cwd: string): RunOptions {
    return {
        projectDir: acc.projectDir ?? cwd,
        mode: acc.oursOnly ? 'replace' : 'augment',
        live: acc.live,
        mutate: acc.mutate,
        ...(acc.configFile === undefined ? {} : { configFile: acc.configFile }),
        ...(acc.concurrency === undefined ? {} : { concurrency: acc.concurrency }),
        ...(acc.reporters === undefined ? {} : { reporters: acc.reporters }),
        ...(acc.incremental === undefined ? {} : { incremental: acc.incremental }),
        ...(acc.tempDirName === undefined ? {} : { tempDirName: acc.tempDirName }),
    };
}

/**
 * Parse the argument vector for `stryker-llm run` (the args AFTER the node/bin
 * prefix — i.e. `process.argv.slice(2)`). PURE: returns a {@link ParseResult},
 * never throws and never touches process state.
 *
 * @param argv The raw argument list (subcommand-first).
 * @param cwd The default project dir when no positional is given.
 */
export function parseArgs(argv: readonly string[], cwd: string): ParseResult {
    if (argv.length === 0 || argv[0] !== SUBCOMMAND) {
        return { ok: false, error: `expected subcommand "run".\n${USAGE}` };
    }

    const rest = argv.slice(1);
    const acc: Acc = { oursOnly: false, augment: false, dryRun: false, live: false, mutate: [] };

    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i] as string;

        const boolHandler = BOOLEAN_FLAGS[arg];
        if (boolHandler) {
            boolHandler(acc);
            continue;
        }

        const valueHandler = VALUE_FLAGS[arg];
        if (valueHandler) {
            const value = rest[i + 1];
            if (value === undefined || value.startsWith('--')) {
                return { ok: false, error: `flag ${arg} requires a value.\n${USAGE}` };
            }
            const error = valueHandler(acc, value);
            if (error !== undefined) {
                return { ok: false, error };
            }
            i++;
            continue;
        }

        if (arg.startsWith('--')) {
            return { ok: false, error: `unknown flag: ${arg}\n${USAGE}` };
        }
        if (acc.projectDir !== undefined) {
            return { ok: false, error: `unexpected extra positional argument: ${arg}\n${USAGE}` };
        }
        acc.projectDir = arg;
    }

    const exclusivityError = checkExclusivity(acc);
    if (exclusivityError !== undefined) {
        return { ok: false, error: exclusivityError };
    }

    return { ok: true, options: toOptions(acc, cwd) };
}
