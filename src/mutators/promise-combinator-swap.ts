/*
 * Heuristic NodeMutator: PromiseCombinatorSwap (functional-architecture §5, P3).
 *
 * The Promise combinators differ in rejection and result semantics in ways tests
 * frequently under-pin: `Promise.all` rejects on the FIRST rejection,
 * `Promise.allSettled` NEVER rejects, `Promise.race` resolves to a SINGLE value,
 * `Promise.any` rejects only if ALL reject. Swapping among them is a precise
 * probe of error-handling and result-shape assumptions. Stryker's built-ins have
 * no combinator swap. This one fills that gap, conservatively scoped to literal
 * `Promise.<combinator>(…)` calls.
 *
 * AUTHORING IDIOM — the CALL-EXPRESSION-rebuild idiom shared with
 * `ArrayMethodSwap` / `StringMethodArgSwap`: match the enclosing `CallExpression`
 * (NOT the `Promise.all` member, which is part-of-chain and not independently
 * placeable), and rebuild it with a new combinator-name `Identifier`, reusing
 * `callee.object` (the `Promise` identifier) and `node.arguments` unchanged.
 *
 * MATCH:
 *   • `path.isCallExpression()`, AND
 *   • `callee` is a non-computed `MemberExpression` whose OBJECT is the literal
 *     `Identifier` `Promise` and whose property is an `Identifier` that is a key of
 *     {@link SWAP_TABLE} ({all, allSettled, race, any}).
 *
 * REPLACEMENTS — one per swap target: `all` → {allSettled, race}; `allSettled` →
 * {all}; `race` → {all}; `any` → {all} (each pairs `any` with the closest
 * semantic neighbour while keeping the set small):
 *   • `Promise.all(xs)` → `Promise.allSettled(xs)` and `Promise.race(xs)`.
 *
 * LEGALITY: Stryker replaces the WHOLE visited `CallExpression` with a
 * `CallExpression` (expression placer). Verified live: `Promise.all(xs)` placed as
 * `Promise.allSettled(xs)` and `Promise.race(xs)`.
 *
 * EDGE CASES:
 *   • Object is not the literal `Identifier` `Promise` (e.g. a local `P.all`) →
 *     skipped (conservative match).
 *   • Computed `Promise['all'](xs)` → skipped (`callee.computed`).
 *   • `all`→`allSettled` changes rejection semantics (never rejects) — strong
 *     probe; `all`→`race` changes the resolved value shape (single vs array),
 *     often a type error → `error`, which is honest.
 *   • Each swap target is a distinct name, so no equivalent-mutant guard is needed.
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
 * The Promise-combinator swap table. Each known combinator maps to the
 * semantically-nearest alternatives it should be replaced by (one mutant per
 * target). Kept small to bound combinator noise.
 */
const SWAP_TABLE: Readonly<Record<string, readonly string[]>> = {
    all: ['allSettled', 'race'],
    allSettled: ['all'],
    race: ['all'],
    any: ['all'],
};

/**
 * The `PromiseCombinatorSwap` heuristic mutator. For a literal
 * `Promise.<combinator>(…)` call whose combinator is in the swap table, yields the
 * call with the combinator name swapped. Yields nothing for non-`Promise`
 * objects, computed access, unknown combinators, or non-call nodes — so it is safe
 * to register globally.
 */
export const promiseCombinatorSwapMutator: NodeMutator = {
    name: 'PromiseCombinatorSwap',

    *mutate(path) {
        if (!path.isCallExpression()) {
            return;
        }

        const { node } = path;
        const { callee } = node;
        if (!isMemberExpression(callee) || callee.computed || !isIdentifier(callee.property)) {
            return;
        }
        if (!isIdentifier(callee.object) || callee.object.name !== 'Promise') {
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
