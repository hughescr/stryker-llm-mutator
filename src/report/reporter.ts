/*
 * M4 reporter (functional-architecture §6 Reporting). PURE, OFFLINE,
 * ~100% bun-testable with synthetic `MutantResult[]`. No Stryker import (it codes
 * against the result SHAPE via `@stryker-mutator/api`'s type-only export), no
 * network.
 *
 * Our mutants run INSIDE Stryker, so they already appear in Stryker's standard
 * report. This reporter adds OUR view on top:
 *   • a SURVIVORS section — the test holes the tool exists to find — one line per
 *     survived mutant: `file:line:col  mutatorName  original -> replacement
 *     (rationale)`, heuristic vs the precise `llm/<tag>` distinguished;
 *   • a NOT-COMPARABLE note — the blended score includes our injected mutants and
 *     is NOT a vanilla Stryker mutation score;
 *   • a COST line — `Total LLM cost: $X.XX across N calls` from the snapshot;
 *   • an optional FILTERED artifact — only our (heuristic/* + llm/*) mutants as a
 *     plain object the driver can write to `reports/mutation-llm.json`.
 *
 * LOCATION CONVENTION (the triple-mismatch pitfall). `MutantResult.location`
 * comes from the mutation-testing-report-schema and is 1-based line AND 1-based
 * column — DISTINCT from our 0-based `SourceRange` and from Babel's 1-based-line/
 * 0-based-column. The reporter consumes Stryker's 1-based location VERBATIM for
 * display; it does NOT re-subtract.
 *
 * `original`/`rationale` are NOT on `MutantResult` (Stryker only carries
 * `replacement`). The driver passes an optional enrichment side-map keyed by
 * mutant id (built from the pre-pass `Replacement[]` / the precomputed map's
 * tags) so the survivor view can show the original text + the precise `llm/<tag>`
 * + the rationale. Heuristic mutants have no original text and no enrichment —
 * the line shows just the replacement.
 */

import type { MutantResult } from '@stryker-mutator/api/core';

import type { CostSnapshot } from '../llm/index';
import { heuristicMutators } from '../mutators/index';

/** The `llm/` mutator-name prefix (mirrors propose.ts PROPOSE_MUTATOR_PREFIX). */
export const LLM_PREFIX = 'llm';

/**
 * The bare heuristic mutator names (functional-architecture §5 catalog), DERIVED
 * from the single source of truth — the registered `heuristicMutators` barrel —
 * rather than hand-maintained. This guarantees `isOurMutant` tags exactly the
 * operators the tool actually injects: a future operator added to the catalog is
 * picked up automatically, with no silent drift mis-tagging its survivors as
 * not-ours. The import is type-and-value but acyclic and pure (the mutators
 * package depends on no provider/network/report/config module).
 */
const HEURISTIC_NAMES = new Set(heuristicMutators.map(m => m.name));

/** Per-mutant enrichment the driver supplies from the pre-pass side-table. */
export interface MutantEnrichment {
    /** The original source text the mutant replaced (LLM mutants only). */
    original?: string;
    /** The precise per-candidate `llm/<tag>` (overrides Stryker's coarse `llm`). */
    tag?: string;
    /** The LLM rationale for why this is an interesting mutant. */
    rationale?: string;
}

/** Options for {@link formatReport}. */
export interface FormatReportOptions {
    /** id → enrichment side-map from the pre-pass (original/tag/rationale). */
    enrichment?: Map<string, MutantEnrichment>;
}

/** One survivor row in the filtered artifact (JSON-serializable). */
export interface FilteredMutant {
    /** Stryker mutant id. */
    id: string;
    /** The source file. */
    fileName: string;
    /** 1-based line (Stryker schema location). */
    line: number;
    /** 1-based column (Stryker schema location). */
    column: number;
    /** The effective mutator name (enriched `llm/<tag>` when available). */
    mutatorName: string;
    /** Stryker's mutant status. */
    status: string;
    /** The replacement text (when Stryker carried it). */
    replacement?: string;
    /** The original span text (LLM enrichment only). */
    original?: string;
    /** The LLM rationale (enrichment only). */
    rationale?: string;
}

/** The filtered, OUR-mutants-only artifact the driver may persist. */
export interface FilteredReport {
    /** Only `heuristic/*` + `llm/*` mutants, across all statuses. */
    mutants: FilteredMutant[];
}

/** The full reporter output. */
export interface ReportOutput {
    /** The rendered SURVIVORS section (one line per our survived mutant). */
    survivorsText: string;
    /** The summary (counts + not-comparable note + cost line). */
    summaryText: string;
    /** The filtered, our-mutants-only artifact. */
    filtered: FilteredReport;
}

/** True when a mutator name is one of OURS (heuristic/* or llm/*). */
export function isOurMutant(mutatorName: string): boolean {
    return (
        mutatorName === LLM_PREFIX ||
        mutatorName.startsWith(`${LLM_PREFIX}/`) ||
        mutatorName.startsWith('heuristic/') ||
        HEURISTIC_NAMES.has(mutatorName)
    );
}

/** The effective mutator name: prefer the enriched `llm/<tag>` over coarse `llm`. */
function effectiveName(result: MutantResult, enrichment?: MutantEnrichment): string {
    if (enrichment?.tag !== undefined && enrichment.tag.length > 0) {
        return `${LLM_PREFIX}/${enrichment.tag}`;
    }
    return result.mutatorName;
}

/** Stable sort key: fileName, then start line, then start column. */
function sortKey(a: MutantResult, b: MutantResult): number {
    if (a.fileName !== b.fileName) {
        return a.fileName < b.fileName ? -1 : 1;
    }
    if (a.location.start.line !== b.location.start.line) {
        return a.location.start.line - b.location.start.line;
    }
    return a.location.start.column - b.location.start.column;
}

/** Render one survivor line. */
function survivorLine(result: MutantResult, enrichment?: MutantEnrichment): string {
    const { line, column } = result.location.start;
    const name = effectiveName(result, enrichment);
    const replacement = result.replacement ?? '';
    const original = enrichment?.original;
    const arrow =
        original !== undefined && original.length > 0
            ? `${original} -> ${replacement}`
            : replacement;
    const rationale =
        enrichment?.rationale !== undefined && enrichment.rationale.length > 0
            ? `  (${enrichment.rationale})`
            : '';
    return `${result.fileName}:${String(line)}:${String(column)}  ${name}  ${arrow}${rationale}`;
}

/**
 * Format the reporter output from Stryker's `MutantResult[]` + the LLM cost
 * snapshot + an optional enrichment side-map.
 *
 * @param results Stryker's full mutant results (built-ins + ours, all statuses).
 * @param cost The per-run LLM cost snapshot (zero on a heuristics-only run).
 * @param options Optional id→enrichment side-map.
 * @returns The survivors text, the summary text, and the filtered artifact.
 */
export function formatReport(
    results: readonly MutantResult[],
    cost: CostSnapshot,
    options: FormatReportOptions = {},
): ReportOutput {
    const enrichment = options.enrichment;
    const ours = results.filter(r => isOurMutant(r.mutatorName));

    const survived = ours
        .filter(r => r.status === 'Survived')
        .slice()
        .sort(sortKey);

    const survivorLines = survived.map(r => survivorLine(r, enrichment?.get(r.id)));
    const survivorsText =
        survivorLines.length > 0
            ? [
                  'SURVIVORS (test holes — our mutants the suite did not kill):',
                  ...survivorLines,
              ].join('\n')
            : 'SURVIVORS: none — every injected mutant was killed.';

    const killed = ours.filter(r => r.status === 'Killed').length;
    const noCoverage = ours.filter(r => r.status === 'NoCoverage').length;
    const timeout = ours.filter(r => r.status === 'Timeout').length;

    const summaryText = [
        `Injected mutants: ${String(ours.length)} ` +
            `(killed ${String(killed)}, survived ${String(survived.length)}, ` +
            `no-coverage ${String(noCoverage)}, timeout ${String(timeout)})`,
        'NOTE: the standard Stryker score is BLENDED — it includes these injected ' +
            'mutants and is NOT comparable to a vanilla Stryker mutation score.',
        `Total LLM cost: $${cost.totalUsd.toFixed(2)} across ${String(cost.calls)} calls`,
    ].join('\n');

    const filtered: FilteredReport = {
        mutants: ours.map(r => {
            const enr = enrichment?.get(r.id);
            return {
                id: r.id,
                fileName: r.fileName,
                line: r.location.start.line,
                column: r.location.start.column,
                mutatorName: effectiveName(r, enr),
                status: r.status,
                ...(r.replacement === undefined ? {} : { replacement: r.replacement }),
                ...(enr?.original === undefined ? {} : { original: enr.original }),
                ...(enr?.rationale === undefined ? {} : { rationale: enr.rationale }),
            };
        }),
    };

    return { survivorsText, summaryText, filtered };
}
