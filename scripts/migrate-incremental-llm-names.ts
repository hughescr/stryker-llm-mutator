/*
 * ════════════════════════════════════════════════════════════════════════════
 * INCREMENTAL-REPORT NAME MIGRATION — rename the legacy `llm` rows of an
 * existing `stryker-incremental.json` to the live `Llm<Category>` names, so the
 * next incremental run REUSES their verdicts instead of re-executing them.
 * Offline, $0, guarded: it only READS `--in` and writes a SEPARATE file.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS:
 *   Stryker's incremental differ identifies a mutant by
 *   `relFile@start.line:start.column-end.line:end.column\n<mutatorName>: <replacement>`
 *   (`@stryker-mutator/core` `incremental-differ.js` `mutantToIdentifyingKey`).
 *   Every dynamic-LLM mutant used to be named `llm`; it is now named by its
 *   category (`src/pipeline/classify.ts`). So on the first run after upgrading,
 *   every existing `llm` row is a key MISS and would re-execute once (isambard:
 *   ~3,900 rows — roughly a tenth of a full run). The live name is a
 *   DETERMINISTIC function of the `(original, replacement)` pair, and the report
 *   carries both: the original is the `source` slice at the row's `location`,
 *   the replacement is the row's `replacement`. So the name can be recomputed
 *   offline and the row renamed in place.
 *
 * HOW IT WORKS (`migrateIncrementalLlmNames`, PURE):
 *   For every `files[<rel>].mutants[i]` with `mutatorName === 'llm'`:
 *     1. slice `source` at `location` (1-based line AND column on disk — Stryker's
 *        `project-reader.js` subtracts 1 from both when it reads the report);
 *     2. parse both the slice and `replacement` as expressions (the tolerant route
 *        the pipeline uses);
 *     3. SHORTHAND-OBJECT placement: the live mutator lifts a candidate keyed on a
 *        shorthand property KEY (`{ signal }` → `{ signal: null }`) to the whole
 *        ObjectExpression, so the report row's location is the object and its
 *        replacement the printed object, while the live map entry classified
 *        `(key identifier, fragment)`. When both sides are ObjectExpressions of
 *        the same length differing in exactly ONE property that goes shorthand →
 *        non-shorthand with the same key, classify `(key, value)`; any other
 *        object↔object pair is SKIPPED (ambiguous — a wrong name only costs a
 *        rerun, but the row would carry a misleading name meanwhile);
 *     4. otherwise `classifyNodes(original, replacement)`;
 *     5. write ONLY `mutatorName`. Every other byte — ids, locations, statuses,
 *        coverage, killedBy, tests, schema fields — is preserved, and rows with
 *        any other name are untouched.
 *   Rows it cannot handle (bad location, no replacement, unparseable, ambiguous
 *   shorthand) keep `llm` and simply re-run once.
 *
 * SOUNDNESS: the differ still performs its full source diff and test-key checks
 *   on the migrated report; the migration changes nothing those checks read.
 *   Renaming can only turn a guaranteed miss into a hit when the live plugin
 *   assigns the SAME name to the same `(file, location, replacement)`, and that
 *   name is a deterministic function of the original-at-location and the
 *   replacement — the very code change the old verdict was recorded for. A
 *   wrong or skipped migration is a miss (rerun), never a false verdict.
 *   Built-ins can never produce an `Llm*` name, so no cross-mutator collision
 *   exists. `tests/injection/incremental-migration-proof.test.ts` proves reuse,
 *   killedBy remap, and invalidation after a source / test change against the
 *   real `IncrementalDiffer`.
 *
 * HOW THE HUMAN RUNS THIS (offline, $0):
 *   bun scripts/migrate-incremental-llm-names.ts --in reports/stryker-incremental.json
 *       [--out <path>] [--dry-run]
 *   `--out` defaults to `<in-dir>/<in-basename>.llm-migrated.json`. The script
 *   REFUSES (exit 2) when `--out` resolves to the same path as `--in` — it never
 *   writes in place and never touches any other file. Run it only when NO
 *   Stryker run is writing the report; then copy the migrated file over
 *   `reports/stryker-incremental.json` yourself.
 *
 * Imports from SRC (not dist): scripts are runnable drivers, not library code.
 * The core is exported so it is unit-tested; the CLI runs only when this file is
 * the entry point.
 */

import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { classifyNodes, LLM_CATEGORIES, type LlmCategory } from '../src/pipeline/classify';
import { nodeShape, parseExpressionTolerant } from '../src/pipeline/fingerprint';

/** The legacy name every dynamic-LLM row carried before the categories. */
const LEGACY_NAME = 'llm';

/** Tally of what the migration did. */
export interface MigrationStats {
    /** Rows named `llm` examined. */
    total: number;
    /** Rows renamed, per live category. */
    migrated: Record<LlmCategory, number>;
    /** Rows left as `llm`, by reason. */
    skipped: {
        badLocation: number;
        noReplacement: number;
        unparseable: number;
        ambiguousShorthand: number;
    };
    /** The `llm` rows' statuses (migrated and skipped alike). */
    byStatus: Record<string, number>;
}

/** A 1-based report position. */
interface ReportPosition {
    line: number;
    column: number;
}

/** A well-formed 1-based report location. */
interface ReportLocation {
    start: ReportPosition;
    end: ReportPosition;
}

/** A positive integer check. */
function isPositiveInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Narrow an unknown `location` to a well-formed 1-based one. */
function readLocation(value: unknown): ReportLocation | undefined {
    const loc = value as { start?: Partial<ReportPosition>; end?: Partial<ReportPosition> } | null;
    if (
        typeof loc !== 'object' ||
        loc === null ||
        !isPositiveInt(loc.start?.line) ||
        !isPositiveInt(loc.start?.column) ||
        !isPositiveInt(loc.end?.line) ||
        !isPositiveInt(loc.end?.column)
    ) {
        return undefined;
    }
    return {
        start: { line: loc.start.line, column: loc.start.column },
        end: { line: loc.end.line, column: loc.end.column },
    };
}

/**
 * The source text at a 1-based report location, across lines; `undefined` when
 * the location falls outside the source.
 */
function sliceSource(source: string, location: ReportLocation): string | undefined {
    const lines = source.split('\n');
    const { start, end } = location;
    if (
        start.line > lines.length ||
        end.line > lines.length ||
        end.line < start.line ||
        (end.line === start.line && end.column < start.column)
    ) {
        return undefined;
    }
    const first = lines[start.line - 1] as string;
    const last = lines[end.line - 1] as string;
    if (start.column - 1 > first.length || end.column - 1 > last.length) {
        return undefined;
    }
    if (start.line === end.line) {
        return first.slice(start.column - 1, end.column - 1);
    }
    return [
        first.slice(start.column - 1),
        ...lines.slice(start.line, end.line - 1),
        last.slice(0, end.column - 1),
    ].join('\n');
}

/** A normalized-enough view of a parsed node for the shorthand rule. */
interface ObjectPropertyLike {
    type: string;
    shorthand?: boolean;
    key: unknown;
    value: unknown;
}

/**
 * Reproduce the live map entry for a shorthand-object placement: when
 * `original` and `replacement` are ObjectExpressions of equal length whose ONLY
 * differing property goes shorthand → non-shorthand with the same key, return
 * the `(key, value)` pair the live classifier saw. `'ambiguous'` for any other
 * object↔object pair; `undefined` when the pair is not two objects.
 */
function shorthandPair(
    original: { type: string; properties?: unknown[] },
    replacement: { type: string; properties?: unknown[] },
): { key: unknown; value: unknown } | 'ambiguous' | undefined {
    if (original.type !== 'ObjectExpression' || replacement.type !== 'ObjectExpression') {
        return undefined;
    }
    const o = original.properties ?? [];
    const r = replacement.properties ?? [];
    if (o.length !== r.length) {
        return 'ambiguous';
    }
    const differing = o
        .map((_, index) => index)
        .filter(index => nodeShape(o[index]) !== nodeShape(r[index]));
    if (differing.length !== 1) {
        return 'ambiguous';
    }
    const index = differing[0] as number;
    const op = o[index] as ObjectPropertyLike;
    const rp = r[index] as ObjectPropertyLike;
    if (
        op.type !== 'ObjectProperty' ||
        op.shorthand !== true ||
        rp.type !== 'ObjectProperty' ||
        rp.shorthand === true ||
        nodeShape(op.key) !== nodeShape(rp.key)
    ) {
        return 'ambiguous';
    }
    return { key: op.key, value: rp.value };
}

/** The shape of one report row we read. */
interface ReportMutant {
    mutatorName?: unknown;
    replacement?: unknown;
    location?: unknown;
    status?: unknown;
}

/** One migration decision for a row. */
type Decision =
    | { kind: 'migrated'; category: LlmCategory }
    | { kind: 'skipped'; reason: keyof MigrationStats['skipped'] };

/** Decide one `llm` row's live name. PURE. */
function decide(source: string | undefined, mutant: ReportMutant): Decision {
    const location = readLocation(mutant.location);
    const original =
        source === undefined || location === undefined ? undefined : sliceSource(source, location);
    if (original === undefined) {
        return { kind: 'skipped', reason: 'badLocation' };
    }
    if (typeof mutant.replacement !== 'string') {
        return { kind: 'skipped', reason: 'noReplacement' };
    }
    const originalNode = parseExpressionTolerant(original);
    const replacementNode = parseExpressionTolerant(mutant.replacement);
    if (originalNode === undefined || replacementNode === undefined) {
        return { kind: 'skipped', reason: 'unparseable' };
    }
    const pair = shorthandPair(
        originalNode as { type: string; properties?: unknown[] },
        replacementNode as { type: string; properties?: unknown[] },
    );
    if (pair === 'ambiguous') {
        return { kind: 'skipped', reason: 'ambiguousShorthand' };
    }
    if (pair !== undefined) {
        return {
            kind: 'migrated',
            category: classifyNodes(pair.key as never, pair.value as never),
        };
    }
    return { kind: 'migrated', category: classifyNodes(originalNode, replacementNode) };
}

/** A fresh, all-zero stats object. */
function emptyStats(): MigrationStats {
    return {
        total: 0,
        migrated: Object.fromEntries(LLM_CATEGORIES.map(name => [name, 0])) as Record<
            LlmCategory,
            number
        >,
        skipped: { badLocation: 0, noReplacement: 0, unparseable: 0, ambiguousShorthand: 0 },
        byStatus: {},
    };
}

/**
 * Rename the `llm` rows of an incremental report to their live `Llm<Category>`
 * names. PURE: no I/O, the input is never mutated (a structural clone is
 * returned), and ONLY `mutatorName` fields change. A malformed report yields a
 * clone with nothing migrated.
 *
 * @param report The parsed `stryker-incremental.json` (1-based positions, as on disk).
 * @returns The migrated clone and the tallies.
 */
export function migrateIncrementalLlmNames(report: unknown): {
    report: unknown;
    stats: MigrationStats;
} {
    const stats = emptyStats();
    const clone: unknown = structuredClone(report);
    const files = (clone as { files?: unknown } | null)?.files;
    if (typeof files !== 'object' || files === null) {
        return { report: clone, stats };
    }
    for (const file of Object.values(files as Record<string, unknown>)) {
        const entry = file as { source?: unknown; mutants?: unknown } | null;
        if (typeof entry !== 'object' || entry === null || !Array.isArray(entry.mutants)) {
            continue;
        }
        const source = typeof entry.source === 'string' ? entry.source : undefined;
        for (const mutant of entry.mutants as ReportMutant[]) {
            if (mutant.mutatorName !== LEGACY_NAME) {
                continue;
            }
            stats.total += 1;
            const status = typeof mutant.status === 'string' ? mutant.status : 'undefined';
            stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
            const decision = decide(source, mutant);
            if (decision.kind === 'skipped') {
                stats.skipped[decision.reason] += 1;
                continue;
            }
            stats.migrated[decision.category] += 1;
            mutant.mutatorName = decision.category;
        }
    }
    return { report: clone, stats };
}

/** The default `--out` path: `<in-dir>/<in-basename>.llm-migrated.json`. */
export function defaultOutputPath(inputPath: string): string {
    const ext = extname(inputPath);
    const stem = ext === '.json' ? basename(inputPath, ext) : basename(inputPath);
    return join(dirname(inputPath), `${stem}.llm-migrated.json`);
}

/** Render the stats as a small table. */
export function formatStats(stats: MigrationStats, dryRun: boolean): string {
    const migrated = Object.values(stats.migrated).reduce((a, b) => a + b, 0);
    const skipped = Object.values(stats.skipped).reduce((a, b) => a + b, 0);
    const lines = [
        `${dryRun ? '[dry-run] ' : ''}${String(stats.total)} llm row(s): ${String(migrated)} migrated, ${String(skipped)} skipped`,
        ...(Object.entries(stats.migrated) as Array<[LlmCategory, number]>)
            .filter(([, n]) => n > 0)
            .toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
            .map(([name, n]) => `  ${name.padEnd(20)} ${String(n).padStart(6)}`),
        ...Object.entries(stats.skipped)
            .filter(([, n]) => n > 0)
            .map(([reason, n]) => `  skipped: ${reason.padEnd(11)} ${String(n).padStart(6)}`),
        ...Object.entries(stats.byStatus)
            .toSorted((a, b) => b[1] - a[1])
            .map(([status, n]) => `  status: ${status.padEnd(12)} ${String(n).padStart(6)}`),
    ];
    return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            in: { type: 'string' },
            out: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
        },
    });
    if (values.in === undefined) {
        throw new Error(
            'usage: bun scripts/migrate-incremental-llm-names.ts --in <report.json> [--out <path>] [--dry-run]',
        );
    }
    const inputPath = resolve(values.in);
    const outputPath = resolve(values.out ?? defaultOutputPath(inputPath));
    if (outputPath === inputPath) {
        process.stderr.write(
            `refusing: --out resolves to --in (${inputPath}); this script never writes in place. ` +
                'Let it write the sibling .llm-migrated.json and copy that over yourself.\n',
        );
        process.exit(2);
    }
    const report: unknown = JSON.parse(await readFile(inputPath, 'utf8'));
    const { report: migrated, stats } = migrateIncrementalLlmNames(report);
    // eslint-disable-next-line no-console -- CLI summary.
    console.log(formatStats(stats, values['dry-run']));
    if (!values['dry-run']) {
        await writeFile(outputPath, JSON.stringify(migrated), 'utf8');
        // eslint-disable-next-line no-console -- CLI summary.
        console.log(`wrote ${outputPath}`);
    }
}
