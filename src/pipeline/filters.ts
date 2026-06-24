/*
 * Pipeline stage 2 — cheap deterministic filters (development-plan §4.3 stage 2,
 * phase 3). NO LLM, fully offline, pure functions.
 *
 * After the propose stage emits raw {@link Replacement}s, these filters cut the
 * obvious waste before any further (expensive) LLM work or seam instrumentation:
 *
 *   1. parse-check   — drop replacements whose text does not parse as valid
 *                      JS/TS (kills the ~36% non-compile tax the literature
 *                      reports for raw LLM mutants);
 *   2. identical     — drop `replacement === original` (a no-op mutant);
 *   3. dedup         — collapse replacements identical in
 *                      `{ fileName, range, replacement }` to one.
 *
 * All three are order-independent in effect, but {@link applyFilters} runs them
 * cheapest-first (identical, then dedup, then parse) so the costly parse only
 * sees survivors. Every function is pure: same input slice in, same array out,
 * input never mutated.
 *
 * Parser note: we use `@babel/parser` (a direct dependency — it also backs
 * Stryker's instrumenter, so the version stays in lockstep — and is fully
 * offline, no I/O or network). A
 * replacement may be an expression (`a > b ? 1 : 0`), a top-level statement
 * (`x = 1;`), or a statement only valid inside a function body (`return x;`).
 * {@link isParseable} accepts ANY of these — expression first, then a full
 * program, then the text wrapped in a function body — and only rejects text
 * that none of those three accept.
 */

import { parse, parseExpression } from '@babel/parser';

import type { Replacement } from '../seam/types';

/** Babel plugins enabling the TS + JSX superset the instrumenter also parses. */
const BABEL_PLUGINS = ['typescript', 'jsx'] as const;

/** Parse `code` as a full ESM program; throws on any syntax error. */
function parseProgram(code: string): void {
    parse(code, { sourceType: 'module', plugins: [...BABEL_PLUGINS], errorRecovery: false });
}

/**
 * True when `code` parses as a syntactically valid JS/TS expression, a top-level
 * statement program, OR a statement valid only inside a function body. The three
 * attempts run cheapest-/likeliest-first: a bare expression (the common mutant
 * shape), then a full program (top-level statements), then the text wrapped in a
 * function body (so a function-only statement like `return x;` is accepted).
 * Returns `false` for any input none of the three accept, or for empty/
 * whitespace-only text.
 *
 * Pure and offline: `@babel/parser` does no I/O and no network.
 */
export function isParseable(code: string): boolean {
    if (code.trim().length === 0) {
        return false;
    }
    try {
        parseExpression(code, { plugins: [...BABEL_PLUGINS], errorRecovery: false });
        return true;
    } catch {
        // Not a bare expression — try a full statement program next.
    }
    try {
        parseProgram(code);
        return true;
    } catch {
        // Not a top-level statement — try it inside a function body last.
    }
    try {
        parseProgram(`function __mutantProbe__() {\n${code}\n}`);
        return true;
    } catch {
        return false;
    }
}

/**
 * Drop replacements whose `replacement` text does not parse (filter #1). Pure:
 * returns a new array, preserving input order of the survivors.
 */
export function filterUnparseable(replacements: readonly Replacement[]): Replacement[] {
    return replacements.filter(r => isParseable(r.replacement));
}

/**
 * Drop no-op mutants where `replacement === original` (filter #2). Comparison is
 * exact-string; callers wanting whitespace-insensitive equality should normalize
 * upstream. Pure: returns a new array preserving order.
 */
export function filterIdentical(replacements: readonly Replacement[]): Replacement[] {
    return replacements.filter(r => r.replacement !== r.original);
}

/**
 * Build the dedup identity key for a replacement: the same
 * `{ fileName, range, replacement }` tuple the seam hashes into a deterministic
 * mutant id (development-plan §4.2). Two replacements with the same key would
 * produce the same mutant, so only the first is kept. `original` and
 * `mutatorName`/`rationale` are deliberately NOT part of the identity — they do
 * not change what the mutant DOES.
 *
 * Uses `JSON.stringify` over a fixed field order so the key is stable and
 * collision-free for these flat values.
 */
export function dedupKey(replacement: Replacement): string {
    const { fileName, range, replacement: text } = replacement;
    return JSON.stringify([
        fileName,
        range.start.line,
        range.start.column,
        range.end.line,
        range.end.column,
        text,
    ]);
}

/**
 * Collapse replacements identical in `{ fileName, range, replacement }` to the
 * first occurrence (filter #3). Pure: returns a new array preserving the order
 * of first appearance.
 */
export function dedupReplacements(replacements: readonly Replacement[]): Replacement[] {
    const seen = new Set<string>();
    const out: Replacement[] = [];
    for (const r of replacements) {
        const key = dedupKey(r);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(r);
    }
    return out;
}

/**
 * Run all three cheap deterministic filters in cheapest-first order:
 * identical-reject, then dedup, then the (more expensive) parse-check on the
 * survivors. Pure and offline; the input array is never mutated.
 *
 * @param replacements raw propose-stage output.
 * @returns the survivors, in first-appearance order.
 */
export function applyFilters(replacements: readonly Replacement[]): Replacement[] {
    return filterUnparseable(dedupReplacements(filterIdentical(replacements)));
}
