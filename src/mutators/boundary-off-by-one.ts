/*
 * Heuristic NodeMutator: BoundaryOffByOne (functional-architecture §5, P1).
 *
 * Off-by-one boundary bugs hide behind tests that exercise the "happy" index but
 * never pin the exact edge — `a[i + 1]`, `slice(0, len - 1)`, `i < n - 1`. None
 * of Stryker's sixteen built-ins probe the `±1` ADJUSTMENT directly: there is no
 * numeric-literal-arithmetic mutator, and `EqualityOperator` swaps comparison
 * OPERATORS, not the integer-literal offset on one side of a `+`/`-`. This
 * operator fills that gap by targeting any `x + 1` / `x - 1` / `1 + x` / `1 - x`
 * binary expression and yielding two boundary probes.
 *
 * AUTHORING IDIOM — identical to `number-literal-value.ts`: an object literal
 * with a `name` and a synchronous `*mutate(path)` generator that guards on a
 * Babel path predicate, reads the node, and `yield`s freshly-built (or directly
 * reused) AST nodes. Replacement nodes are built with `@babel/types` factories
 * (`binaryExpression`), never strings — Stryker's placers expect nodes.
 *
 * MATCH (deliberately broad — "fire on every match, let Stryker scope", matching
 * the NumberLiteralValue convention):
 *   • the node is a `BinaryExpression`, AND
 *   • its operator is `+` or `-`, AND
 *   • EXACTLY ONE operand is the integer literal `1` (`leftIsOne !== rightIsOne`).
 * We do NOT gate on "index/slice/loop/comparison context": Babel's minimal
 * NodePath slice gives no cheap parent-context signal, and `x ± 1` is an
 * off-by-one probe wherever it appears. Volume is Stryker's concern (§5 volume
 * guard), not ours.
 *
 * REPLACEMENTS (both always distinct from the original, so no equivalent-mutant
 * guard is needed beyond the match):
 *   • OPERATOR SWAP — `x + 1` → `x - 1` and `x - 1` → `x + 1`. Reuses the original
 *     left/right operand nodes unchanged; only the operator flips. Probes
 *     over-/under-shoot by one in the opposite direction.
 *   • DROP THE `±1` — yield the OTHER operand alone (`i + 1` → `i`, `len - 1` →
 *     `len`, `1 + i` → `i`). Probes whether the adjustment is load-bearing. The
 *     other operand is already a valid AST `Expression` from the parse, so it is
 *     yielded directly with no factory.
 *
 * LEGALITY: Stryker replaces the WHOLE visited `BinaryExpression`. (1) The swap
 * is itself a `BinaryExpression` — same node category, legal in exactly the same
 * position. (2) The drop yields one of the original arithmetic operands, which is
 * always an `Expression` (Identifier, MemberExpression, CallExpression,
 * NumericLiteral, …) and an Expression is legal anywhere a BinaryExpression was.
 * No statement-shaped replacement is ever produced.
 *
 * EDGE CASES:
 *   • Neither operand is `1` (`a + b`, `x - 2`, `2 + 3`) → skip (out of scope).
 *   • BOTH operands are `1` (`1 + 1`, `1 - 1`) → skip (ambiguous which is the
 *     offset; required via `leftIsOne !== rightIsOne`).
 *   • Floats parsing to value 1 (`x + 1.0`) ARE matched (intended); `x + 2` is not.
 *   • BigInt `1n` is a `BigIntLiteral`, not `NumericLiteral`, so `isNumericLiteral`
 *     excludes it automatically (don't mix Number/BigInt arithmetic) — correct.
 *   • This operator never mutates the `1` literal's VALUE — that is
 *     `NumberLiteralValue`'s job; the overlap is acceptable (distinct mutants).
 */

import { binaryExpression, isNumericLiteral } from '@babel/types';

import type { NodeMutator } from './types';

/**
 * The `BoundaryOffByOne` heuristic mutator. For any `x ± 1` binary expression
 * (with exactly one operand the integer literal `1`) yields the operator-swapped
 * expression and the other operand alone. Yields nothing for any other node, so
 * it is safe to register globally.
 */
export const boundaryOffByOneMutator: NodeMutator = {
    name: 'BoundaryOffByOne',

    *mutate(path) {
        if (!path.isBinaryExpression()) {
            return;
        }

        const { node } = path;
        if (node.operator !== '+' && node.operator !== '-') {
            return;
        }

        const leftIsOne = isNumericLiteral(node.left) && node.left.value === 1;
        const rightIsOne = isNumericLiteral(node.right) && node.right.value === 1;

        // Require EXACTLY ONE side to be the literal 1.
        if (leftIsOne === rightIsOne) {
            return;
        }

        // Operator swap: same operands, flipped operator. Always distinct.
        yield binaryExpression(node.operator === '+' ? '-' : '+', node.left, node.right);

        // Drop the `±1`: yield the non-1 operand directly (already a valid Expression).
        yield leftIsOne ? node.right : node.left;
    },
};
