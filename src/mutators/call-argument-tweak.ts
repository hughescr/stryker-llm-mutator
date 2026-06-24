/*
 * Heuristic NodeMutator: CallArgumentTweak (functional-architecture §5, P2).
 *
 * Length-ish and slice-ish calls hide off-by-one and argument-order bugs behind
 * tests that never pin the exact bounds — `s.slice(0, 10)`, `s.padStart(8)`,
 * `s.substring(start, end)`. Two independent probes over the SAME
 * `CallExpression` fill gaps the built-ins leave:
 *   (A) ±1 on a numeric argument of a known length-ish method, and
 *   (B) swap of the first two positional arguments.
 * Stryker's built-ins do not express either: there is no numeric-literal-value
 * mutator (so a call's numeric arg is never nudged), and no argument-reordering
 * mutator.
 *
 * AUTHORING IDIOM — identical to the P1 trio: an object literal with a `name` and
 * a synchronous `*mutate(path)` generator guarding on a Babel path predicate and
 * yielding freshly-built `callExpression` nodes via `@babel/types`, never strings.
 *
 * MATCH: `path.isCallExpression()`. Then two sub-behaviors over `node.arguments`:
 *
 *   (A) NUMERIC-ARG ±1 — SCOPED to known length-ish callees to keep volume down
 *       (the catalog method-name-gated form): the callee must be a non-computed
 *       `MemberExpression` whose property `Identifier` name is in {@link LENGTH_METHODS}
 *       ({slice, substring, substr, padStart, padEnd, repeat, splice}). For each
 *       argument index `i` whose arg is a `NumericLiteral`, yield two calls — the
 *       arg `+1` and the arg `-1` — each a fresh args-array copy with only the i-th
 *       literal tweaked. (BigInt args are `BigIntLiteral`, excluded automatically.)
 *
 *   (B) ARG-SWAP — independent of the callee: when `arguments.length >= 2` and the
 *       first two args are both bare `Expression`s (NOT `SpreadElement` /
 *       `ArgumentPlaceholder`), and they are not structurally equal, yield one call
 *       with the first two positional args swapped.
 *
 * LEGALITY: Stryker replaces the WHOLE visited `CallExpression`; each replacement
 * is a `CallExpression` of the same category (expression placer,
 * `path.isExpression()`). The callee node is reused unchanged so the call shape is
 * preserved. Verified live: `s.slice(0, 10)` placed as `s.slice(1, 10)` /
 * `s.slice(0, 11)`, and `fn(a, b)` placed as `fn(b, a)`.
 *
 * EDGE CASES:
 *   • Arg-swap skipped when < 2 args, or when either of the first two args is a
 *     `SpreadElement` / `ArgumentPlaceholder` (not an `Expression`).
 *   • Arg-swap of two structurally-equal args is a no-op — skipped via
 *     `isNodesEquivalent`.
 *   • The ±1 tweak fires only on `NumericLiteral` args (an `Identifier` index, a
 *     `BigIntLiteral`, etc. are skipped) and only for the gated length-ish methods.
 *   • Overlaps with `NumberLiteralValue` on the numeric arg (distinct mutants),
 *     acceptable per the `BoundaryOffByOne` precedent.
 */

import {
    type CallExpression,
    callExpression,
    type Expression,
    isExpression,
    isIdentifier,
    isMemberExpression,
    isNodesEquivalent,
    isNumericLiteral,
    numericLiteral,
} from '@babel/types';

import type { NodeMutator } from './types';

/**
 * Method names whose numeric arguments are length/offset-shaped, so a ±1 nudge is
 * a meaningful boundary probe. Gating the ±1 sub-behavior to these (rather than
 * firing on every numeric arg everywhere) keeps mutant volume down while still
 * targeting the classic off-by-one call sites.
 */
const LENGTH_METHODS: ReadonlySet<string> = new Set([
    'slice',
    'substring',
    'substr',
    'padStart',
    'padEnd',
    'repeat',
    'splice',
]);

/**
 * Return the called method name when `callee` is a non-computed `MemberExpression`
 * with an `Identifier` property (`s.slice`), else `undefined` (computed access
 * `s['slice']`, a bare `Identifier` callee `slice(…)`, etc.).
 */
function calleeMethodName(node: CallExpression): string | undefined {
    const { callee } = node;
    if (isMemberExpression(callee) && !callee.computed && isIdentifier(callee.property)) {
        return callee.property.name;
    }
    return undefined;
}

/**
 * The `CallArgumentTweak` heuristic mutator. For length-ish method calls, yields
 * `±1` variants of each numeric argument; for any call with ≥2 positional
 * `Expression` args, yields the first-two-args-swapped variant. Yields nothing for
 * non-call nodes, so it is safe to register globally.
 */
export const callArgumentTweakMutator: NodeMutator = {
    name: 'CallArgumentTweak',

    *mutate(path) {
        if (!path.isCallExpression()) {
            return;
        }

        const { node } = path;
        const args = node.arguments;

        // (A) ±1 on numeric args of a gated length-ish method.
        const methodName = calleeMethodName(node);
        if (methodName !== undefined && LENGTH_METHODS.has(methodName)) {
            for (const [i, arg] of args.entries()) {
                if (!isNumericLiteral(arg)) {
                    continue;
                }
                const plus = args.map((a, j) => (j === i ? numericLiteral(arg.value + 1) : a));
                const minus = args.map((a, j) => (j === i ? numericLiteral(arg.value - 1) : a));
                yield callExpression(node.callee, plus);
                yield callExpression(node.callee, minus);
            }
        }

        // (B) Swap the first two positional args (independent of the callee).
        const [first, second] = args;
        if (
            first !== undefined &&
            second !== undefined &&
            isExpression(first) &&
            isExpression(second) &&
            !isNodesEquivalent(first as Expression, second as Expression)
        ) {
            yield callExpression(node.callee, [second, first, ...args.slice(2)]);
        }
    },
};
