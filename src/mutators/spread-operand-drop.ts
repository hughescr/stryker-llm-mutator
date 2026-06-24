/*
 * Heuristic NodeMutator: SpreadOperandDrop (functional-architecture §5, P3).
 *
 * Object spreads carry merge/override semantics — `{ ...defaults, ...overrides }`,
 * `{ ...base, id }` — that tests often exercise only on the "happy" merged result
 * without pinning each contributing spread. Dropping ONE spread element probes
 * whether that source object is load-bearing. Stryker's built-ins have no
 * spread-removal operator. This one fills that gap, scoped to OBJECT spreads (the
 * catalog target).
 *
 * AUTHORING IDIOM — identical to the P1 trio: an object literal with a `name` and
 * a synchronous `*mutate(path)` generator guarding on a Babel path predicate and
 * yielding freshly-built `objectExpression` nodes via `@babel/types`, never
 * strings.
 *
 * MATCH: `path.isObjectExpression()`. Iterate `node.properties`; for each index
 * `i` whose property is a `SpreadElement`, yield a fresh `ObjectExpression` with
 * exactly that one spread removed (ONE spread dropped per mutant, so each is
 * scored independently).
 *
 * SCOPE — OBJECT spreads only: array spreads (`[...a]`, a `SpreadElement` inside
 * an `ArrayExpression`) and call-argument spreads (`fn(...a)`, a `SpreadElement`
 * inside a `CallExpression`) are NOT `ObjectExpression` children, so they are
 * excluded automatically (catalog scope).
 *
 * REPLACEMENT (one per spread; the OTHER properties' nodes are reused unchanged):
 *   • drop the i-th spread: `{ ...a, b: 1 }` → `{ b: 1 }`.
 *
 * LEGALITY: Stryker replaces the WHOLE visited `ObjectExpression`; the replacement
 * is an `ObjectExpression` of the same category (expression placer,
 * `path.isExpression()`). Verified live: `{ ...a, b: 1 }` placed as `{ b: 1 }`,
 * and a call-arg spread `fn(...a, b)` correctly NOT matched.
 *
 * EDGE CASES:
 *   • An object with no `SpreadElement` yields nothing (the loop finds no spread).
 *   • An object that is ONLY a spread (`{ ...a }` → `{}`) is a legal but possibly
 *     equivalent-ish mutant; still placed and scored (acceptable noise, not
 *     special-cased).
 *   • Multiple spreads yield multiple mutants, each dropping exactly one.
 */

import { isSpreadElement, objectExpression } from '@babel/types';

import type { NodeMutator } from './types';

/**
 * The `SpreadOperandDrop` heuristic mutator. For an `ObjectExpression` containing
 * one or more spread elements, yields one variant per spread with that spread
 * removed. Yields nothing for a spread-free object or any non-object node, so it
 * is safe to register globally.
 */
export const spreadOperandDropMutator: NodeMutator = {
    name: 'SpreadOperandDrop',

    *mutate(path) {
        if (!path.isObjectExpression()) {
            return;
        }

        const { properties } = path.node;
        for (const [i, property] of properties.entries()) {
            if (isSpreadElement(property)) {
                yield objectExpression(properties.filter((_, j) => j !== i));
            }
        }
    },
};
