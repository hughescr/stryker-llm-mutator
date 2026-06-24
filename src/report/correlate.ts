/*
 * The id→enrichment CORRELATOR (functional-architecture §6 reporting) — the single
 * implementation shared by the `stryker-llm` CLI driver (`run.ts`) and the real
 * Stryker Reporter plugin (`reporter-plugin.ts`). Both render OUR survivor view via
 * `formatReport`, which wants a per-mutant enrichment side-table (original text +
 * the precise `llm/<tag>` + rationale); both recover that table the same way — by
 * correlating each LLM `MutantResult` back to its precomputed-map entry via
 * `(fileName, babel-loc)`. Factoring it here keeps one correlation rather than two
 * that could drift in their location math.
 *
 * PURE — no Stryker import (codes against the `MutantResult` SHAPE via the
 * type-only `@stryker-mutator/api/core` export), no network, no I/O. Fully
 * bun-testable with synthetic results + a synthetic map.
 *
 * LOCATION CONVERSION (the pitfall): the map's locKey is babel (1-based line /
 * 0-based column); `MutantResult.location` is the schema's 1-based line AND 1-based
 * column, so the babel column = `location.column - 1`. When a span carries multiple
 * candidates we cannot tell which result is which (Stryker collapses per-candidate
 * identity), so we attach the FIRST entry's metadata — coarse but honest; the
 * filtered artifact still lists every candidate.
 */

import type { MutantResult } from '@stryker-mutator/api/core';

import { LLM_MUTATOR_NAME } from '../mutators/llm-mutator';
import { type LlmMutatorMap, locKeyFromBabelLoc } from '../pipeline/llm-map';
import type { MutantEnrichment } from './reporter';

/**
 * Build the reporter's id→enrichment side-table by correlating each LLM
 * `MutantResult` back to its precomputed-map entry via location. Stryker assigns
 * mutant ids at instrument time (unknown to the pre-pass), so post-run correlation
 * by `(fileName, location)` is the only way to recover the per-candidate
 * `llm/<tag>` + original + rationale for OUR survivor view.
 *
 * @param results Stryker's full mutant results (only `llm` ones are correlated).
 * @param map The precomputed `(absFileName, locKey) → ParsedEntry[]` map from the pre-pass.
 * @returns A map of Stryker mutant id → enrichment (original/tag/rationale).
 */
export function correlateEnrichment(
    results: readonly MutantResult[],
    map: LlmMutatorMap,
): Map<string, MutantEnrichment> {
    const enrichment = new Map<string, MutantEnrichment>();
    for (const result of results) {
        if (result.mutatorName !== LLM_MUTATOR_NAME) {
            continue;
        }
        const byLoc = map.get(result.fileName);
        if (byLoc === undefined) {
            continue;
        }
        const loc = result.location;
        const key = locKeyFromBabelLoc({
            start: { line: loc.start.line, column: loc.start.column - 1 },
            end: { line: loc.end.line, column: loc.end.column - 1 },
        });
        const entries = byLoc.get(key);
        const entry = entries?.[0];
        if (entry === undefined) {
            continue;
        }
        const tag = entry.mutatorName.startsWith('llm/')
            ? entry.mutatorName.slice('llm/'.length)
            : undefined;
        enrichment.set(result.id, {
            ...(entry.original === undefined ? {} : { original: entry.original }),
            ...(tag === undefined ? {} : { tag }),
            ...(entry.rationale === undefined ? {} : { rationale: entry.rationale }),
        });
    }
    return enrichment;
}
