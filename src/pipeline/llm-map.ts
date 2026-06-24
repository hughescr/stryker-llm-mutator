/*
 * Gate-4 precomputed-map builder (functional-architecture §4 Gate 4 /
 * LLMMutator design spec). PURE, OFFLINE, bun-testable.
 *
 * The injected `LLMMutator` is SYNCHRONOUS — it cannot call an LLM inside
 * `mutate(path)`. All LLM work is the async pre-pass; its output is a precomputed
 * lookup table this module builds. Given the FILTERED survivor {@link Replacement}[]
 * (after `applyFilters` + near-equivalence), it:
 *
 *   1. pre-parses each replacement string into an AST node via the shared
 *      {@link parseReplacementFragment} (the same parens-wrap the worker uses);
 *   2. keys each by (ABSOLUTE fileName, babel-loc) using the worker's EXACT
 *      Stryker-0-based → Babel-1-based `+1` line conversion;
 *   3. stores multiple candidates at one span as a LIST (diverse mutants share
 *      one function span).
 *
 * THE +1 KEYING (load-bearing — silent-fail-prone, see §4 risks). A
 * {@link Replacement.range} is a Stryker `SourceRange`: 0-based line, 0-based
 * column. Babel `node.loc` is 1-based line, 0-based column. The map key is built
 * with `start.line + 1` / `end.line + 1` (columns UNCHANGED) — IDENTICAL to
 * `instrument-worker.mjs` `buildMutator` (line 106). The `LLMMutator` then reads
 * `path.node.loc` (already babel-1-based) and forms the lookup key with NO
 * offset. Get the `+1` wrong in either direction and every lookup misses
 * SILENTLY. {@link locKeyFromRange} (here) and {@link locKeyFromBabelLoc} (the
 * mutator's reader) are the two halves of this contract and live together so
 * they stay in lockstep.
 *
 * ABSOLUTE-PATH KEYING (load-bearing). Stryker passes the ABSOLUTE source path
 * as `path.hub.file.opts.filename`, so the map's outer key MUST be absolute or
 * every lookup misses silently. We normalize every fileName via `path.resolve`
 * at build time, so a producer that populated a relative path still keys
 * correctly (as long as it resolves against the same cwd Stryker uses — the
 * pre-pass reads sources by absolute path, so it does).
 *
 * EXPRESSION-ONLY DROP. A statement-shaped replacement (`return x;`) passes
 * `applyFilters` (it tries a function-body wrap) but {@link parseReplacementFragment}
 * rejects it (the parens-wrap is expression-only). Such replacements are
 * DROPPED-AND-LOGGED here rather than throwing — they would be rejected by
 * Stryker's placers at an expression position anyway (§5 constraint 3).
 */

import { resolve } from 'node:path';

import type { Node } from '@babel/types';

import type { Replacement, SourceRange } from '../seam/types';
import { parseReplacementFragment } from './parse-fragment';

/**
 * One pre-parsed replacement entry stored in the map. The `node` is a fresh AST
 * node parsed from `replacement`; the metadata fields travel WITH the entry so
 * the reporter's id→tag/rationale side-table can be built from the same map.
 */
export interface ParsedEntry {
    /** The pre-parsed replacement AST node (a fresh tree, distinct identity). */
    node: Node;
    /** The per-candidate mutator name, e.g. `llm/off-by-one` (from propose.ts). */
    mutatorName: string;
    /** The replacement source text (re-parsed per yield for distinct node identity). */
    replacement: string;
    /** The original span text, carried for the reporter's survivor view. */
    original: string;
    /** Optional LLM rationale, carried for the reporter's survivor view. */
    rationale?: string;
}

/**
 * The precomputed lookup table the `LLMMutator` reads: outer key = absolute
 * fileName, inner key = babel-loc key, value = the LIST of candidates at that
 * span. Two O(1) lookups + an early bail for every non-targeted file/node (the
 * overwhelmingly common case across a whole-repo instrument).
 */
export type LlmMutatorMap = Map<string, Map<string, ParsedEntry[]>>;

/**
 * One dropped (non-expression / unparseable) replacement, for logging. The
 * map-builder drops-and-collects these rather than throwing.
 */
export interface DroppedReplacement {
    /** Absolute file the dropped replacement targeted. */
    fileName: string;
    /** The 0-based Stryker range it targeted (for a `file:line` log). */
    range: SourceRange;
    /** The replacement text that failed to parse as an expression. */
    replacement: string;
    /** Why it was dropped. */
    reason: string;
}

/** The result of {@link buildLlmMutatorMap}: the map plus the dropped log. */
export interface BuildLlmMutatorMapResult {
    /** The precomputed `(absFileName, locKey) → ParsedEntry[]` map. */
    map: LlmMutatorMap;
    /** Replacements dropped because they did not parse as an expression. */
    dropped: DroppedReplacement[];
}

/**
 * Build the babel-loc key from a Stryker 0-based {@link SourceRange}, applying
 * the worker's `+1` line conversion (columns unchanged). This is the BUILD half
 * of the keying contract — `instrument-worker.mjs` line 106 verbatim.
 */
export function locKeyFromRange(range: SourceRange): string {
    return `${range.start.line + 1}:${range.start.column}-${range.end.line + 1}:${range.end.column}`;
}

/**
 * A babel `loc` shape (1-based line, 0-based column) — the structural slice the
 * `LLMMutator` reads off `path.node.loc`.
 */
export interface BabelLoc {
    start: { line: number; column: number };
    end: { line: number; column: number };
}

/**
 * Build the lookup key from a live babel `node.loc` (already 1-based line) with
 * NO offset. This is the READ half of the keying contract — `instrument-worker.mjs`
 * line 118 verbatim. Pairs with {@link locKeyFromRange}: a 0-based range at line
 * L keys to `L+1`, and a babel loc at line `L+1` reads to the SAME `L+1`.
 */
export function locKeyFromBabelLoc(loc: BabelLoc): string {
    return `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`;
}

/**
 * Build the precomputed `LLMMutator` map from the FILTERED survivor
 * replacements. Each survivor is pre-parsed (parens-wrap, expression-only) and
 * entered under its absolute fileName + babel-loc key; a replacement that fails
 * to parse as an expression is dropped-and-collected (NOT thrown).
 *
 * @param survivors The filtered `Replacement[]` (post `applyFilters` + near-equiv).
 * @param cwd Base dir for resolving non-absolute `fileName`s to the absolute
 *   path Stryker keys by. Defaults to `process.cwd()`.
 * @returns The map and the dropped-replacement log.
 */
export function buildLlmMutatorMap(
    survivors: readonly Replacement[],
    cwd: string = process.cwd(),
): BuildLlmMutatorMapResult {
    const map: LlmMutatorMap = new Map();
    const dropped: DroppedReplacement[] = [];

    for (const r of survivors) {
        const node = parseReplacementFragment(r.replacement);
        if (node === undefined) {
            dropped.push({
                fileName: r.fileName,
                range: r.range,
                replacement: r.replacement,
                reason: 'replacement does not parse as an expression (statement-shaped or invalid)',
            });
            continue;
        }

        const absFileName = resolve(cwd, r.fileName);
        const locKey = locKeyFromRange(r.range);

        let byLoc = map.get(absFileName);
        if (byLoc === undefined) {
            byLoc = new Map();
            map.set(absFileName, byLoc);
        }
        const entries = byLoc.get(locKey) ?? [];
        entries.push({
            node,
            mutatorName: r.mutatorName,
            replacement: r.replacement,
            original: r.original,
            ...(r.rationale === undefined ? {} : { rationale: r.rationale }),
        });
        byLoc.set(locKey, entries);
    }

    return { map, dropped };
}
