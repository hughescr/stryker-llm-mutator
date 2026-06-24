/*
 * Heuristic NodeMutator: TernaryBranchSwap (functional-architecture §5, P4).
 *
 * A conditional expression `c ? p : q` is a compact two-way branch, and tests
 * frequently exercise only ONE side (the common case) while leaving the other
 * unpinned. Swapping the branches (`c ? q : p`) inverts the selection for the
 * same condition — a precise probe that kills any test relying on which branch a
 * given condition picks. Stryker's built-ins have a `ConditionalExpression`
 * mutator that forces the condition to `true`/`false`, but none that SWAPS the two
 * value branches while keeping the condition. This operator fills that gap.
 *
 * AUTHORING IDIOM — identical to the P1 trio: an object literal with a `name` and
 * a synchronous `*mutate(path)` generator guarding on a Babel path predicate and
 * yielding a freshly-built `conditionalExpression` via `@babel/types`, never a
 * string. The `test` node is reused unchanged; only the two branches swap.
 *
 * MATCH: `path.isConditionalExpression()`. Skip when the two branches are
 * structurally equal (`isNodesEquivalent(consequent, alternate)`) — swapping equal
 * branches is a no-op equivalent mutant.
 *
 * REPLACEMENT (one, when the branches differ):
 *   • `c ? p : q` → `c ? q : p`.
 *
 * LEGALITY: Stryker replaces the WHOLE visited `ConditionalExpression` with a
 * `ConditionalExpression` (expression placer). Verified live: `c ? p : q` placed
 * as `c ? q : p`; and `c ? p : p` correctly skipped via `isNodesEquivalent`.
 *
 * EDGE CASES:
 *   • Structurally-equivalent branches → skipped (the only equivalent-mutant case).
 *   • Nested ternaries: each `ConditionalExpression` node is visited independently
 *     and swapped on its own — correct.
 *   • The `test` is never touched — only the two value branches swap.
 */

import { conditionalExpression, isNodesEquivalent } from '@babel/types';

import type { NodeMutator } from './types';

/**
 * The `TernaryBranchSwap` heuristic mutator. For a `c ? p : q` conditional whose
 * two branches differ, yields `c ? q : p`. Yields nothing when the branches are
 * structurally equal or for any non-conditional node, so it is safe to register
 * globally.
 */
export const ternaryBranchSwapMutator: NodeMutator = {
    name: 'TernaryBranchSwap',

    *mutate(path) {
        if (!path.isConditionalExpression()) {
            return;
        }

        const { test, consequent, alternate } = path.node;
        if (isNodesEquivalent(consequent, alternate)) {
            return;
        }

        yield conditionalExpression(test, alternate, consequent);
    },
};
