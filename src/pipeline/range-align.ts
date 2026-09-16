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
 * THE FIVE DROP REASONS (a candidate that fails any of these is dropped-and-
 * logged, NOT emitted — Stryker would reject it at an expression position anyway):
 *   • 'not-found'         — `original` does not appear in the function's source;
 *   • 'ambiguous'         — `original` appears MORE THAN ONCE in the function (we
 *                           cannot pick which occurrence the model meant);
 *   • 'non-node-aligned'  — no AST node's span EXACTLY equals the located
 *                           substring (it crosses node boundaries / is a partial);
 *   • 'not-an-expression' — the exactly-aligned node is a Statement (or other
 *                           non-Expression), which the expression placer rejects.
 *   • 'not-expression-placeable' — the node IS an Expression by type, but
 *                           Stryker's expression placer would not place a mutant
 *                           at it OR at any expression ancestor, so the mutant
 *                           would bubble to a STATEMENT placement (see below).
 *
 * THE STATEMENT-BUBBLE CRASH (isambard `export class ReviewHandler`, 2026-09).
 * Stryker registers a mutant on the nearest self-or-ancestor node a placer
 * accepts. Its expression placer accepts `path.isExpression() &&
 * isValidExpression(path)` — and babel-traverse's VIRTUAL `path.isExpression()`
 * treats an Identifier as an expression ONLY when it is REFERENCED (a method/
 * property key, a declaration id, a binding or a label is NOT). `@babel/types`'
 * node-type `isExpression()` accepts every Identifier, so the `not-an-expression`
 * gate let a ClassMethod-key rename (`dispatchReviewAction` →
 * `dispatchReviewAction_alt`) through. No ancestor up to the ClassDeclaration is
 * an expression, so Stryker fell back to the STATEMENT placer on the class and
 * wrapped it in `if (…) {…} else {…}` — illegal as the `declaration` of an
 * `ExportNamedDeclaration` (`expected node to be of a type ["Declaration"] but
 * instead got "IfStatement"`), aborting the whole instrumentation. Even without
 * `export`, an if-wrapped declaration becomes block-scoped, so such a mutant is
 * never meaningful. {@link findExpressionPlacement} mirrors Stryker's placement
 * walk (`@stryker-mutator/instrumenter` expression-mutant-placer `canPlace` +
 * babel-transformer `registerInPlacementMap`) and any candidate whose placement
 * is not an EXPRESSION placer is dropped here, at build time.
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
import {
    isCallExpression,
    isExpression,
    isMemberExpression,
    isObjectProperty,
    isOptionalCallExpression,
    isOptionalMemberExpression,
    isReferenced,
    isStatement,
    isTaggedTemplateExpression,
    isTSNonNullExpression,
    isUnaryExpression,
} from '@babel/types';

import { type AnyNode, BABEL_PLUGINS, childNodes, toStrykerRange } from './babel-walk';
import type { SourceRange } from '../seam/types';

/** A node carrying a non-null `loc` — the shape `toStrykerRange` consumes. */
type LocatedNode = AnyNode & { loc: NonNullable<AnyNode['loc']> };

/** True when a node has a non-null babel `loc` (always so for `@babel/parser`). */
function hasLoc(node: AnyNode): node is LocatedNode {
    return node.loc !== null && node.loc !== undefined;
}

/** Why a candidate could not be node-aligned (the five §4 Gate 4 drop reasons). */
export type AlignDropReason =
    | 'not-found'
    | 'ambiguous'
    | 'non-node-aligned'
    | 'not-an-expression'
    | 'not-expression-placeable';

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
    /** Which of the five §4 Gate 4 conditions failed. */
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
 * An exact-span match plus its ancestor chain, nearest first (`ancestors[0]` is
 * the node's parent, the last entry is the `Program` root). The chain is what
 * {@link findExpressionPlacement} walks to mirror Stryker's placement lookup.
 */
interface SpanMatch {
    /** The deepest node whose span exactly equals the located substring. */
    node: LocatedNode;
    /** The node's ancestors, parent first, up to and including the root. */
    ancestors: readonly AnyNode[];
}

/**
 * Walk the parsed file's AST for the node whose source span `[node.start,
 * node.end)` EXACTLY equals `[absStart, absEnd)`. Returns the deepest such node
 * (the descent naturally reaches the tightest match) together with its ancestor
 * chain, or `undefined` when no node aligns exactly to the located substring.
 *
 * `@babel/parser` always populates numeric `start`/`end` AND a `loc` on every
 * node, including the `Program` root; the `?? -Infinity` fallback makes a (never-
 * observed) missing offset simply fail BOTH the exact-match and the containment
 * test, so such a node neither matches nor is descended into. We only record a
 * match that also carries a `loc` (via {@link hasLoc}), so the returned node is a
 * {@link LocatedNode} the caller can convert without a further guard.
 */
function findExactSpanNode(root: AnyNode, absStart: number, absEnd: number): SpanMatch | undefined {
    let match: SpanMatch | undefined;
    // The descent path from the root to the node currently being visited, root
    // first; snapshotted (reversed, so parent-first) when a match is recorded.
    const lineage: AnyNode[] = [];
    const visit = (node: AnyNode): void => {
        const start = (node as { start?: number | null }).start ?? Number.NEGATIVE_INFINITY;
        const end = (node as { end?: number | null }).end ?? Number.NEGATIVE_INFINITY;
        if (start === absStart && end === absEnd && hasLoc(node)) {
            match = { node, ancestors: [...lineage].reverse() };
        }
        // Descend only into a node whose span CONTAINS the target — pruning the
        // walk to the relevant subtree (and avoiding spurious matches elsewhere).
        if (start <= absStart && end >= absEnd) {
            lineage.push(node);
            for (const child of childNodes(node)) {
                visit(child);
            }
            lineage.pop();
        }
    };
    visit(root);
    return match;
}

/** Mirror of the expression placer's `isMemberExpression(path)` (plain or optional). */
function isAnyMemberExpression(node: AnyNode): boolean {
    return isMemberExpression(node) || isOptionalMemberExpression(node);
}

/** Mirror of the expression placer's `isCallExpression(path)` (plain or optional). */
function isAnyCallExpression(node: AnyNode): boolean {
    return isCallExpression(node) || isOptionalCallExpression(node);
}

/**
 * Mirror of babel-traverse's VIRTUAL `path.isExpression()` — the check Stryker's
 * expression placer runs first. For an Identifier the virtual check is
 * `isReferencedIdentifier()`, i.e. `@babel/types` `isReferenced(node, parent,
 * grandparent)`: a method/property key, a declaration id, a binding, a label or
 * a non-computed member property is NOT an expression even though the node-type
 * `isExpression()` says it is. We apply `isReferenced` to EVERY expression node,
 * not only Identifiers: for every other type it agrees with the virtual check
 * wherever the placer's own rules already bubble the mutant (assignment targets,
 * non-computed object keys), and it is stricter only in the positions where the
 * placer's `replaceWith` would itself throw (a literal class-property key, a JSX
 * attribute literal) — so nothing Stryker can place is rejected here.
 */
function isPlacerExpression(node: AnyNode, parent: AnyNode, grandparent?: AnyNode): boolean {
    return isExpression(node) && isReferenced(node, parent, grandparent);
}

/**
 * Mirror of the expression placer's `isValidExpression(path)`: the positions at
 * which Stryker declines to wrap an expression in a mutant-switch ternary. Such a
 * node is not a placement itself; Stryker bubbles its mutants to an ancestor.
 */
function isValidPlacerExpression(node: AnyNode, parent: AnyNode): boolean {
    // A (computed) object-property key (`{ [foo]: 1 }` — `foo`).
    if (isObjectProperty(parent) && parent.key === node) {
        return false;
    }
    // Part of a member/call/non-null chain (`foo.bar.baz()` — `foo.bar`).
    if (
        (isAnyMemberExpression(node) || isAnyCallExpression(node) || isTSNonNullExpression(node)) &&
        ((isAnyMemberExpression(parent) &&
            !((parent as { computed?: boolean }).computed === true && parent.property === node)) ||
            isTSNonNullExpression(parent) ||
            (isAnyCallExpression(parent) && parent.callee === node))
    ) {
        return false;
    }
    // A tagged template's parts and a `delete` operand. (The placer's remaining
    // rule — an assignment TARGET, `foo.bar = 42` — needs no mirror here: babel's
    // `isReferenced` already returns false for `AssignmentExpression.left`, so
    // {@link isPlacerExpression} has rejected that position before this runs.)
    if (isTaggedTemplateExpression(parent)) {
        return false;
    }
    return !(isUnaryExpression(parent) && parent.operator === 'delete');
}

/**
 * Simulate Stryker's placement lookup for a mutant on `match.node`: walk from the
 * node up its ancestors and stop at the first node a placer accepts, in the
 * instrumenter's order — expression placer (`isPlacerExpression` +
 * `isValidPlacerExpression`) before statement placer (`isStatement`). Returns
 * `true` only when that first placement is the EXPRESSION placer; a statement
 * placement means the expression-parsed replacement would be spliced by the
 * statement placer — the `export class` crash — so the caller drops the candidate.
 *
 * Stryker's third placer (switch-case) is unreachable from an expression node: a
 * `case` test's parent is the SwitchCase itself, which none of the invalid-
 * expression rules mention, so the test is always an expression placement. The
 * walk likewise never runs off the root: a module body is `Statement[]`, so every
 * expression node meets a Statement before the `Program`.
 */
function findExpressionPlacement(match: SpanMatch): boolean {
    let placedAsExpression = false;
    let node = match.node as AnyNode;
    for (const [index, parent] of match.ancestors.entries()) {
        if (
            isPlacerExpression(node, parent, match.ancestors[index + 1]) &&
            isValidPlacerExpression(node, parent)
        ) {
            placedAsExpression = true;
            break;
        }
        if (isStatement(node)) {
            break;
        }
        node = parent;
    }
    return placedAsExpression;
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
 *   {@link AlignDrop} carrying one of the five drop reasons.
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
    const match = findExactSpanNode(program, absStart, absEnd);
    if (match === undefined) {
        return { dropped: true, reason: 'non-node-aligned' };
    }
    const { node } = match;

    // (d) The aligned node MUST be an EXPRESSION (the expression/ternary placer
    // rejects a Statement at an expression position). Use @babel/types'
    // robust isExpression() guard.
    if (!isExpression(node)) {
        return { dropped: true, reason: 'not-an-expression' };
    }

    // (e) Stryker must be able to place the mutant with its EXPRESSION placer — at
    // the node itself or at an expression ancestor it bubbles to. Otherwise the
    // mutant falls to the STATEMENT placer (a method key → its ClassDeclaration,
    // a binding → its VariableDeclaration), which is a crash under an
    // Export*Declaration and a scope-breaking `if`-wrap everywhere else.
    if (!findExpressionPlacement(match)) {
        return { dropped: true, reason: 'not-expression-placeable' };
    }

    // (f) Success: convert the located node's babel loc to a 0-based Stryker range
    // (the node is a LocatedNode, so `loc` is guaranteed present).
    return { range: toStrykerRange(node.loc), original };
}
