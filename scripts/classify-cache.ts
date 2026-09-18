/*
 * ════════════════════════════════════════════════════════════════════════════
 * CLASSIFIER DISTRIBUTION over a real `.stryker-llm-cache` — an offline probe
 * for the `Llm<Category>` taxonomy (`src/pipeline/classify.ts`). $0, no network,
 * READ-ONLY on the cache.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY: the taxonomy is a closed set of 16 names chosen deterministically from
 * the `(original, replacement)` pair. Its fallback `LlmOther` must stay rare
 * (< 5 % of the candidates that can reach the map) or the categories are not
 * pulling their weight. This script measures that over every cached candidate.
 *
 * HOW: reads every `<cache>/*.json`, iterates `value.candidates`, and buckets
 * each by `classifyMutation(original, replacement)` when BOTH sides parse via
 * `parseExpressionTolerant`; a candidate whose original or replacement is not
 * an expression is counted under `unparseable (never reaches the map)` — the
 * map-builder / range-align drop those before any mutant exists.
 *
 * HOW THE HUMAN RUNS THIS:
 *   bun scripts/classify-cache.ts --cache /path/to/.stryker-llm-cache
 * Exits 1 when `LlmOther` is ≥ 5 % of the expression-parseable population.
 */

import { parseArgs } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { classifyMutation, LLM_CATEGORIES, type LlmCategory } from '../src/pipeline/classify';
import { parseExpressionTolerant } from '../src/pipeline/fingerprint';

/** The per-name tally plus the unparseable count. */
export interface CacheDistribution {
    /** Candidates whose both sides parse as expressions, by category. */
    counts: Record<LlmCategory, number>;
    /** Candidates with a non-expression side (dropped before the map). */
    unparseable: number;
    /** Cache files read. */
    files: number;
}

/** One cached candidate's two sides (other fields ignored). */
interface Candidate {
    original?: unknown;
    replacement?: unknown;
}

/** Bucket every candidate of every cache file. Pure over the file contents. */
export async function classifyCache(cacheDir: string): Promise<CacheDistribution> {
    const counts = Object.fromEntries(LLM_CATEGORIES.map(name => [name, 0])) as Record<
        LlmCategory,
        number
    >;
    const names = (await readdir(cacheDir)).filter(name => name.endsWith('.json'));
    const texts = await Promise.all(names.map(name => readFile(join(cacheDir, name), 'utf8')));
    let unparseable = 0;
    for (const text of texts) {
        const parsed = JSON.parse(text) as { value?: { candidates?: unknown } };
        const candidates = parsed.value?.candidates;
        if (!Array.isArray(candidates)) {
            continue;
        }
        for (const candidate of candidates as Candidate[]) {
            const { original, replacement } = candidate;
            if (
                typeof original !== 'string' ||
                typeof replacement !== 'string' ||
                parseExpressionTolerant(original) === undefined ||
                parseExpressionTolerant(replacement) === undefined
            ) {
                unparseable += 1;
                continue;
            }
            counts[classifyMutation(original, replacement)] += 1;
        }
    }
    return { counts, unparseable, files: names.length };
}

/** Render the distribution as the per-category counts line + a table. */
export function formatDistribution(dist: CacheDistribution): string {
    const total = Object.values(dist.counts).reduce((sum, n) => sum + n, 0);
    const rows = (Object.entries(dist.counts) as Array<[LlmCategory, number]>)
        .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(
            ([name, n]) =>
                `${name.padEnd(14)} ${String(n).padStart(6)}  ${((100 * n) / Math.max(total, 1)).toFixed(1).padStart(5)}%`,
        );
    const line = (Object.entries(dist.counts) as Array<[LlmCategory, number]>)
        .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, n]) => `${name}=${String(n)}`)
        .join(', ');
    return [
        `${String(dist.files)} cache file(s); ${String(total + dist.unparseable)} candidate(s): ` +
            `${String(total)} expression-parseable, ${String(dist.unparseable)} unparseable (never reaches the map)`,
        ...rows,
        `by category: ${line}`,
    ].join('\n');
}

/** The LlmOther ceiling (fraction of the expression-parseable population). */
export const OTHER_CEILING = 0.05;

if (import.meta.main) {
    const { values } = parseArgs({ options: { cache: { type: 'string' } } });
    if (values.cache === undefined) {
        throw new Error('usage: bun scripts/classify-cache.ts --cache <dir>');
    }
    const dist = await classifyCache(values.cache);
    // eslint-disable-next-line no-console -- CLI output.
    console.log(formatDistribution(dist));
    const total = Object.values(dist.counts).reduce((sum, n) => sum + n, 0);
    if (dist.counts.LlmOther >= OTHER_CEILING * total) {
        process.exitCode = 1;
    }
}
