/*
 * Heuristic NodeMutator: ComparisonBoundaryShift (functional-architecture §5, P2).
 *
 * Relational-boundary bugs hide behind tests that exercise the "comfortable
 * middle" of a range but never pin its exact edge — `hour >= 12`, `i < n`,
 * `len > 0`. Flipping the STRICTNESS of the comparison (`>=` ↔ `>`, `<` ↔ `<=`)
 * shifts that boundary by one position, which a test that never probes the edge
 * cannot kill. Stryker's built-ins do NOT express this: `EqualityOperator` swaps
 * `==`/`!=`/`===`/`!==` (whole-equality flips), never the strictness of a
 * relational comparison. This operator fills that gap.
 *
 * AUTHORING IDIOM — identical to `boundary-off-by-one.ts`: an object literal with
 * a `name` and a synchronous `*mutate(path)` generator that guards on a Babel
 * path predicate, reads the node, and `yield`s a freshly-built `binaryExpression`
 * (never a string). Both original operand nodes are reused unchanged.
 *
 * MATCH:
 *   • the node is a `BinaryExpression`, AND
 *   • its operator is one of the four relational comparisons in {@link SWAP}.
 * No operand inspection is needed — only the operator changes.
 *
 * DELIBERATELY NOT MATCHED:
 *   • `==`, `!=`, `===`, `!==` — equality/inequality, owned by the built-in
 *     `EqualityOperator`; not relational boundaries.
 *   • arithmetic / bitwise / shift operators (`+ - * / % & | ^ << >> >>>`) —
 *     owned by `BoundaryOffByOne` / arithmetic built-ins.
 *   • `in` / `instanceof` — `BinaryExpression` operators, but absent from
 *     {@link SWAP}, so skipped automatically.
 *
 * REPLACEMENT (always exactly one, always textually distinct from the original,
 * so no equivalent-mutant guard is needed):
 *   • flip strictness: `h >= 12` → `h > 12`, `i < n` → `i <= n`, reusing both
 *     original operand nodes.
 *
 * LEGALITY: Stryker replaces the WHOLE visited `BinaryExpression`; the
 * replacement is itself a `BinaryExpression` of the same category, so the
 * expression placer (`path.isExpression()`) accepts it in exactly the same
 * position. Verified live through the real instrumenter: `h >= 12` placed as
 * `h > 12`.
 */

import { binaryExpression } from '@babel/types';

import type { NodeMutator } from './types';

/**
 * The relational strictness-flip map. Each of the four relational comparison
 * operators maps to its strictness-flipped counterpart; an operator absent from
 * this map (equality, arithmetic, `in`, `instanceof`, …) is not mutated. The
 * value type is the `BinaryExpression['operator']` union so the `binaryExpression`
 * factory call type-checks without a cast.
 */
const SWAP: Readonly<Record<string, '<' | '<=' | '>' | '>='>> = {
    '<': '<=',
    '<=': '<',
    '>': '>=',
    '>=': '>',
};

/**
 * The `ComparisonBoundaryShift` heuristic mutator. For any relational
 * `BinaryExpression` (`<`, `<=`, `>`, `>=`) yields the same expression with its
 * operator strictness flipped. Yields nothing for any other node (equality,
 * arithmetic, `in`/`instanceof`, non-binary), so it is safe to register globally.
 */
export const comparisonBoundaryShiftMutator: NodeMutator = {
    name: 'ComparisonBoundaryShift',

    *mutate(path) {
        if (!path.isBinaryExpression()) {
            return;
        }

        const { node } = path;
        const swapped = Object.hasOwn(SWAP, node.operator) ? SWAP[node.operator] : undefined;
        if (swapped === undefined) {
            return;
        }

        yield binaryExpression(swapped, node.left, node.right);
    },
};
