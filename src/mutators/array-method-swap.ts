/*
 * Heuristic NodeMutator: ArrayMethodSwap (functional-architecture §5, P3).
 *
 * Array iteration methods are easy to mix up and their differences are subtle —
 * `map` vs `filter` (transform vs predicate), `forEach` (no return value),
 * `push` vs `unshift` (which end). A test that only checks the final aggregate
 * may not pin which method was used. Stryker's built-ins have no method-name swap.
 * This operator swaps among a small, behaviorally-distinct table.
 *
 * AUTHORING IDIOM — the CALL-EXPRESSION-rebuild idiom shared with
 * `PromiseCombinatorSwap` / `StringMethodArgSwap`: match the enclosing
 * `CallExpression` (NOT the callee member — a callee member is part-of-chain and
 * is not independently placeable per Stryker's `expression-mutant-placer`), and
 * rebuild it with a new method-name `Identifier`, reusing `callee.object` and
 * `node.arguments` unchanged. Replacement nodes are built with `@babel/types`
 * factories, never strings.
 *
 * MATCH:
 *   • `path.isCallExpression()`, AND
 *   • `callee` is a non-computed `MemberExpression` with an `Identifier` property
 *     (`isMemberExpression(callee) && !callee.computed && isIdentifier(callee.property)`),
 *     AND
 *   • the property name is a key of {@link SWAP_TABLE}.
 *
 * REPLACEMENTS — one per swap target for the matched name (`map`/`filter`/`forEach`
 * each swap to the OTHER two; `push`/`unshift` swap to each other):
 *   • `xs.map(f)` → `xs.filter(f)` and `xs.forEach(f)`; `xs.push(x)` → `xs.unshift(x)`.
 *
 * LEGALITY: Stryker replaces the WHOLE visited `CallExpression`; the replacement
 * is a `CallExpression` (expression placer). The callee is rebuilt non-computed
 * with the SAME object — same shape, legal in place. Verified live: `xs.map(f)`
 * placed as `xs.filter(f)`.
 *
 * EDGE CASES:
 *   • Computed calls (`xs['map'](f)`, `callee.computed === true`) are skipped (the
 *     property is not a bare `Identifier`).
 *   • No receiver type-check: any `x.map(...)` matches (a non-array with a `map`
 *     method too) — accepted noise per the broad convention; mismatches land as
 *     `error` not `survived`, which is honest.
 *   • `map`↔`filter` changes return semantics, `forEach` drops the return value
 *     (often a type error → `error`) — both strong probes.
 *   • Self-swap is impossible (the name is always replaced by a DIFFERENT name).
 */

import {
    callExpression,
    identifier,
    isIdentifier,
    isMemberExpression,
    memberExpression,
} from '@babel/types';

import type { NodeMutator } from './types';

/**
 * The array-method swap table. Each key maps to the other behaviorally-related
 * method names it should be replaced by (one mutant per target). `map`/`filter`/
 * `forEach` form a 3-cycle (each swaps to the other two); `push`/`unshift` swap to
 * each other.
 */
const SWAP_TABLE: Readonly<Record<string, readonly string[]>> = {
    map: ['filter', 'forEach'],
    filter: ['map', 'forEach'],
    forEach: ['map', 'filter'],
    push: ['unshift'],
    unshift: ['push'],
};

/**
 * The `ArrayMethodSwap` heuristic mutator. For a `xs.<method>(…)` call whose
 * method is in the swap table, yields the call with the method name replaced by
 * each behaviorally-related alternative. Yields nothing for computed calls,
 * non-member callees, unknown methods, or non-call nodes — so it is safe to
 * register globally.
 */
export const arrayMethodSwapMutator: NodeMutator = {
    name: 'ArrayMethodSwap',

    *mutate(path) {
        if (!path.isCallExpression()) {
            return;
        }

        const { node } = path;
        const { callee } = node;
        if (!isMemberExpression(callee) || callee.computed || !isIdentifier(callee.property)) {
            return;
        }

        const targets = SWAP_TABLE[callee.property.name];
        if (!targets) {
            return;
        }

        for (const swapName of targets) {
            yield callExpression(
                memberExpression(callee.object, identifier(swapName), false),
                node.arguments,
            );
        }
    },
};
