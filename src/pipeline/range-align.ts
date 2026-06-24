/*
 * Gate-4 node-aligned range derivation (functional-architecture §4 Gate 4 / §5
 * constraint 3). PURE, OFFLINE, bun-testable — imports `@babel/parser`/
 * `@babel/types` ONLY, NEVER `@stryker-mutator/core`.
 *
 * THE BUG THIS FIXES. The dynamic-LLM pre-pass batches by ENCLOSING FUNCTION
 * (Gate 3): one `provider.generate()` per hot function. The propose contract now
 * asks the model to identify the SPECIFIC sub-expression it mutates (echoed as
 * the candidate's verbatim `original`), NOT to rewrite the whole function. But a
 * `Replacement.range` MUST equal a REAL AST node's span that the replacement
 * node-type can validly replace — the map-builder + `LLMMutator` key by node
 * location and yield the replacement parsed as an EXPRESSION (parens-wrapped, see
 * `parse-fragment.ts`). If a candidate's range were the whole FunctionDeclaration
 * (a Statement) but its replacement parsed as a BinaryExpression, Stryker's
 * instrumenter throws `statementMutantPlacer could not place mutants … expected
 * node to be of a type ["Statement"] but instead got "BinaryExpression"`.
 *
 * THE FIX: derive each candidate's range from OUR OWN parse — NEVER trust LLM
 * coordinates. Given the verbatim sub-expression `original`, locate it INSIDE the
 * enclosing function, find the AST node whose span EXACTLY equals it, verify that
 * node is an EXPRESSION (so the expression/ternary placer accepts the
 * parsed-as-expression replacement), and emit THAT node's Stryker 0-based range.
 *
 * THE FOUR DROP REASONS (a candidate that fails any of these is dropped-and-
 * logged, NOT emitted — Stryker would reject it at an expression position anyway):
 *   • 'not-found'         — `original` does not appear in the function's source;
 *   • 'ambiguous'         — `original` appears MORE THAN ONCE in the function (we
 *                           cannot pick which occurrence the model meant);
 *   • 'non-node-aligned'  — no AST node's span EXACTLY equals the located
 *                           substring (it crosses node boundaries / is a partial);
 *   • 'not-an-expression' — the exactly-aligned node is a Statement (or other
 *                           non-Expression), which the expression placer rejects.
 *
 * POSITIONS. We locate by ABSOLUTE char offset (function start + index-in-function)
 * so a sub-expression that also appears ELSEWHERE in the file is never mis-located.
 * The exact-span match compares the located node's `[node.start, node.end)` to the
 * located substring's absolute `[offset, offset + original.length)`. The emitted
 * range is the node's babel `loc` run through `toStrykerRange` (1-based line − 1,
 * columns unchanged) — IDENTICAL to targeting's convention, so it flows cleanly
 * onto `Replacement.range` and the map-builder's `+1` keying round-trips.
 */

import { parse } from '@babel/parser';
import { isExpression } from '@babel/types';

import { type AnyNode, BABEL_PLUGINS, childNodes, toStrykerRange } from './babel-walk';
import type { SourceRange } from '../seam/types';

/** A node carrying a non-null `loc` — the shape `toStrykerRange` consumes. */
type LocatedNode = AnyNode & { loc: NonNullable<AnyNode['loc']> };

/** True when a node has a non-null babel `loc` (always so for `@babel/parser`). */
function hasLoc(node: AnyNode): node is LocatedNode {
    return node.loc !== null && node.loc !== undefined;
}

/** Why a candidate could not be node-aligned (the four §4 Gate 4 drop reasons). */
export type AlignDropReason = 'not-found' | 'ambiguous' | 'non-node-aligned' | 'not-an-expression';

/** A successful alignment: the node's Stryker range + the verbatim sub-expression. */
interface AlignSuccess {
    /** The exactly-aligned EXPRESSION node's 0-based Stryker range. */
    range: SourceRange;
    /** The verbatim sub-expression source (flows onto `Replacement.original`). */
    original: string;
}

/** A dropped candidate: the reason it could not be node-aligned. */
interface AlignDrop {
    /** Discriminant so callers branch on success vs. drop without a null check. */
    dropped: true;
    /** Which of the four §4 Gate 4 conditions failed. */
    reason: AlignDropReason;
}

/** The result of {@link alignCandidateRange}: a success or a typed drop. */
export type AlignResult = AlignSuccess | AlignDrop;

/**
 * Find the single absolute char offset at which `needle` occurs inside the
 * function source `[fnStartOffset, fnEndOffset)`. Returns the absolute offset, or
 * a drop reason when `needle` is absent ('not-found') or occurs more than once
 * ('ambiguous'). The search is scoped to the function so an `original` that also
 * appears elsewhere in the file cannot be mis-located.
 */
function locateInFunction(
    fileContent: string,
    fnStartOffset: number,
    fnEndOffset: number,
    needle: string,
): number | AlignDropReason {
    const fnSource = fileContent.slice(fnStartOffset, fnEndOffset);
    const first = fnSource.indexOf(needle);
    if (first === -1) {
        return 'not-found';
    }
    if (fnSource.indexOf(needle, first + 1) !== -1) {
        return 'ambiguous';
    }
    return fnStartOffset + first;
}

/**
 * Walk the parsed file's AST for the node whose source span `[node.start,
 * node.end)` EXACTLY equals `[absStart, absEnd)`. Returns the deepest such node
 * (the descent naturally reaches the tightest match), or `undefined` when no node
 * aligns exactly to the located substring.
 *
 * `@babel/parser` always populates numeric `start`/`end` AND a `loc` on every
 * node, including the `Program` root; the `?? -Infinity` fallback makes a (never-
 * observed) missing offset simply fail BOTH the exact-match and the containment
 * test, so such a node neither matches nor is descended into. We only record a
 * match that also carries a `loc` (via {@link hasLoc}), so the returned node is a
 * {@link LocatedNode} the caller can convert without a further guard.
 */
function findExactSpanNode(
    root: AnyNode,
    absStart: number,
    absEnd: number,
): LocatedNode | undefined {
    let match: LocatedNode | undefined;
    const visit = (node: AnyNode): void => {
        const start = (node as { start?: number | null }).start ?? Number.NEGATIVE_INFINITY;
        const end = (node as { end?: number | null }).end ?? Number.NEGATIVE_INFINITY;
        if (start === absStart && end === absEnd && hasLoc(node)) {
            match = node;
        }
        // Descend only into a node whose span CONTAINS the target — pruning the
        // walk to the relevant subtree (and avoiding spurious matches elsewhere).
        if (start <= absStart && end >= absEnd) {
            for (const child of childNodes(node)) {
                visit(child);
            }
        }
    };
    visit(root);
    return match;
}

/**
 * Derive a candidate's true {@link SourceRange} + verbatim `original` by locating
 * its sub-expression inside the enclosing function and node-aligning it. NEVER
 * trusts LLM coordinates — the range comes from OUR OWN parse.
 *
 * @param fileContent The FULL file source text.
 * @param fnStartOffset The enclosing function's absolute char START offset.
 * @param fnEndOffset The enclosing function's absolute char END offset (exclusive).
 * @param original The candidate's verbatim sub-expression substring.
 * @returns {@link AlignSuccess} with the EXPRESSION node's range, or an
 *   {@link AlignDrop} carrying one of the four drop reasons.
 */
export function alignCandidateRange(
    fileContent: string,
    fnStartOffset: number,
    fnEndOffset: number,
    original: string,
): AlignResult {
    // (a/b) Locate `original` inside the function: not-found / ambiguous drop.
    const located = locateInFunction(fileContent, fnStartOffset, fnEndOffset, original);
    if (typeof located === 'string') {
        return { dropped: true, reason: located };
    }
    const absStart = located;
    const absEnd = absStart + original.length;

    // (c) Re-parse the file and find the node whose span EXACTLY equals the
    // located substring. No exact-span node ⇒ non-node-aligned drop.
    const ast = parse(fileContent, {
        sourceType: 'module',
        plugins: [...BABEL_PLUGINS],
        errorRecovery: false,
    });
    const program = ast.program as unknown as AnyNode;
    const node = findExactSpanNode(program, absStart, absEnd);
    if (node === undefined) {
        return { dropped: true, reason: 'non-node-aligned' };
    }

    // (d) The aligned node MUST be an EXPRESSION (the expression/ternary placer
    // rejects a Statement at an expression position). Use @babel/types'
    // robust isExpression() guard.
    if (!isExpression(node)) {
        return { dropped: true, reason: 'not-an-expression' };
    }

    // (e) Success: convert the located node's babel loc to a 0-based Stryker range
    // (the node is a LocatedNode, so `loc` is guaranteed present).
    return { range: toStrykerRange(node.loc), original };
}
