/*
 * Heuristic NodeMutator: DefaultParamValueTweak (functional-architecture §5, P4).
 *
 * A parameter's default value (`function page(size = 20)`, `f(verbose = false)`,
 * `g(label = 'x')`) is exercised only when the caller OMITS the argument — a path
 * tests routinely skip. Tweaking the default probes whether any test pins the
 * omit-the-argument behavior. Stryker's built-ins do not target the default
 * specifically (there is no numeric-value mutator, and the boolean/string
 * built-ins mutate literals generally, not the default-binding position). This
 * operator narrows in on the `right` side of an `AssignmentPattern`.
 *
 * AUTHORING IDIOM — identical to the P1 trio: an object literal with a `name` and
 * a synchronous `*mutate(path)` generator guarding on a Babel path predicate and
 * yielding freshly-built `assignmentPattern` nodes via `@babel/types`, never
 * strings. `node.left` (the binding) is reused unchanged; only `right` (the
 * default value) changes.
 *
 * MATCH: the visited node is the `right` literal of an `AssignmentPattern`, so
 * Stryker replaces only the default value and preserves its binding shape.
 *   • `NumericLiteral` → `+1`, `-1`, and `0` (skip `0` when already 0).
 *   • `BooleanLiteral` → flip.
 *   • `StringLiteral`  → `''` (skip when already empty).
 *
 * REPLACEMENTS (each a fresh literal in the same default-value slot):
 *   • numeric `a = 5` → `a = 6`, `a = 4`, `a = 0`.
 *   • boolean `a = true` → `a = false`.
 *   • string  `a = 'x'` → `a = ''`.
 *
 * LEGALITY: replacement is literal-for-literal in the existing default slot.
 *
 * EDGE CASES:
 *   • `right` not a tweakable literal (Identifier, CallExpression, object/array
 *     defaults) → skipped, keeping the operator narrow and equivalence-safe.
 *   • Skip the `0` numeric variant when already 0 (mirrors NumberLiteralValue).
 *   • Skip the `''` string variant when already empty.
 *   • BigInt default (`a = 5n`) is `BigIntLiteral`, not `NumericLiteral` →
 *     excluded.
 *   • Overlaps with NumberLiteralValue on the numeric default literal (distinct
 *     mutants) — accepted per the BoundaryOffByOne precedent.
 *   • Destructuring defaults (`{ a = 5 } = {}`) are also `AssignmentPattern` →
 *     matched (intended).
 */

import {
    booleanLiteral,
    isBooleanLiteral,
    isNumericLiteral,
    isStringLiteral,
    numericLiteral,
    stringLiteral,
} from '@babel/types';

import type { NodeMutator } from './types';

/**
 * The `DefaultParamValueTweak` heuristic mutator mutates numeric, boolean, and
 * string literals only when they occupy an `AssignmentPattern.right` slot.
 */
export const defaultParamValueTweakMutator: NodeMutator = {
    name: 'DefaultParamValueTweak',

    *mutate(path) {
        const parent = path.parentPath;
        if (!parent?.isAssignmentPattern() || parent.node.right !== path.node) {
            return;
        }

        const right = path.node;

        if (isNumericLiteral(right)) {
            yield numericLiteral(right.value + 1);
            yield numericLiteral(right.value - 1);
            if (right.value !== 0) {
                yield numericLiteral(0);
            }
            return;
        }

        if (isBooleanLiteral(right)) {
            yield booleanLiteral(!right.value);
            return;
        }

        if (isStringLiteral(right) && right.value !== '') {
            yield stringLiteral('');
        }
    },
};
