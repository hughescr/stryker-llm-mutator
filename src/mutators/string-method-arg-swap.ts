/*
 * Heuristic NodeMutator: StringMethodArgSwap (functional-architecture §5, P4).
 *
 * The string-predicate methods `includes` / `startsWith` / `endsWith` answer
 * subtly different questions about the SAME needle, and a test that only checks
 * the "obviously true" case may not distinguish them — `path.endsWith('.ts')`
 * passing does not prove the code did not mean `includes('.ts')`. Swapping among
 * them probes that distinction. Stryker's built-ins have no string-predicate
 * swap. This one fills the gap.
 *
 * NOTE on the name: despite "ArgSwap", the real swap is the METHOD NAME, not the
 * arguments (the catalog example is `includes → startsWith`). The receiver and
 * args are reused unchanged.
 *
 * AUTHORING IDIOM — the CALL-EXPRESSION-rebuild idiom shared with
 * `ArrayMethodSwap` / `PromiseCombinatorSwap`: match the enclosing
 * `CallExpression` (NOT the callee member, which is part-of-chain and not
 * independently placeable), and rebuild it with a new method-name `Identifier`.
 *
 * MATCH:
 *   • `path.isCallExpression()`, AND
 *   • `callee` is a non-computed `MemberExpression` with an `Identifier` property,
 *     AND
 *   • the property name is a key of {@link SWAP_TABLE} ({includes, startsWith,
 *     endsWith}).
 *
 * REPLACEMENTS — one per swap target: `includes` → {startsWith, endsWith};
 * `startsWith` → {endsWith, includes}; `endsWith` → {startsWith, includes}:
 *   • `s.includes(x)` → `s.startsWith(x)` and `s.endsWith(x)`.
 *
 * LEGALITY: Stryker replaces the WHOLE visited `CallExpression` with a
 * `CallExpression` (expression placer). Verified live: `s.includes(x)` placed as
 * `s.startsWith(x)` and `s.endsWith(x)`.
 *
 * EDGE CASES:
 *   • Computed `s['includes'](x)` → skipped.
 *   • No receiver type-check: any `x.includes(...)` matches, including
 *     `Array.prototype.includes`. Array has no `startsWith`/`endsWith`, so the
 *     swapped call throws / type-errors at runtime → scored `error` (honest, not a
 *     false survivor). Static receiver typing is not attempted (no reliable signal
 *     in the NodePath slice).
 *   • Each swap target is a distinct name, so no equivalent-mutant guard is needed.
 *   • `indexOf` / `lastIndexOf` are out of the catalog's stated scope.
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
 * The string-predicate swap table. Each known predicate maps to the other two it
 * should be replaced by (one mutant per target).
 */
const SWAP_TABLE: Readonly<Record<string, readonly string[]>> = {
    includes: ['startsWith', 'endsWith'],
    startsWith: ['endsWith', 'includes'],
    endsWith: ['startsWith', 'includes'],
};

/**
 * The `StringMethodArgSwap` heuristic mutator. For a `s.<predicate>(…)` call whose
 * predicate is in the swap table, yields the call with the predicate name swapped.
 * Yields nothing for computed calls, non-member callees, unknown methods, or
 * non-call nodes — so it is safe to register globally.
 */
export const stringMethodArgSwapMutator: NodeMutator = {
    name: 'StringMethodArgSwap',

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
