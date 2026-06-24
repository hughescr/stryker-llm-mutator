/*
 * Heuristic NodeMutator: FallbackOperandSubstitution (functional-architecture §5, P1).
 *
 * Default/fallback values — `config.timeout ?? 5000`, `name || 'anonymous'`,
 * `opts.tz ?? resolveTimezone()` — are a classic test hole: the test exercises
 * the LEFT side (the value is present) and never pins what happens when the
 * fallback fires. Stryker's built-ins do not probe this: `LogicalOperator` swaps
 * the OPERATOR (`??` ↔ `&&`), not the fallback VALUE. This operator targets the
 * RIGHT operand of a `??` / `||` expression — the default value — and replaces it
 * with each of the empty/zero primitives, probing whether any test pins the
 * fallback.
 *
 * AUTHORING IDIOM — identical to `number-literal-value.ts`: an object literal
 * with a `name` and a synchronous `*mutate(path)` generator that guards on a
 * Babel path predicate and `yield`s freshly-built replacement nodes via
 * `@babel/types` factories, never strings.
 *
 * MATCH:
 *   • the node is a `LogicalExpression`, AND
 *   • its operator is `??` or `||`. `&&` is EXCLUDED — it is not a
 *     fallback/default operator (its right operand is a guarded ACTION, not a
 *     default value), so substituting an empty value there is meaningless.
 * No further structural condition: the right operand IS the fallback.
 *
 * REPLACEMENTS — a fresh `LogicalExpression` preserving the operator and the
 * ORIGINAL left operand, with the right operand swapped for each empty primitive:
 *   • `undefined`  (an `Identifier` in Babel — a valid expression)
 *   • `null`
 *   • `0`
 *   • `''`  (empty string)
 * The doc says "type-appropriate", but the AST gives no reliable static type for
 * the right operand, so yielding all four is the safe over-approximation matching
 * the catalog's `undefined / null / 0 / ''` list — each is a distinct mutant
 * Stryker scores independently. Finer static type-narrowing is a future
 * refinement (not required for M1).
 *
 * LEGALITY: Stryker replaces the WHOLE visited `LogicalExpression`. Each
 * replacement is itself a `LogicalExpression` of the SAME operator with the SAME
 * left operand and only the right operand swapped — identical node category in
 * the identical position, legal wherever the original sat (assignment RHS, call
 * arg, return value, …). All four replacement right-operands are primary
 * `Expression` nodes, each legal as the right child of a `LogicalExpression`.
 *
 * EDGE CASES:
 *   • `&&` is skipped entirely.
 *   • EQUIVALENT-MUTANT SKIP (mirrors NumberLiteralValue's `value !== 0` skip):
 *     omit a variant whose value already equals the existing right operand, so we
 *     never yield a no-op equivalent — skip `undefined` when the right operand is
 *     already the `undefined` identifier; skip `null` when it is already `null`;
 *     skip `0` when it is already the literal `0`; skip `''` when it is already
 *     the empty string.
 *   • The LEFT operand is never mutated — only the right operand is the fallback.
 */

import {
    identifier,
    isIdentifier,
    isNullLiteral,
    isNumericLiteral,
    isStringLiteral,
    logicalExpression,
    nullLiteral,
    numericLiteral,
    stringLiteral,
} from '@babel/types';

import type { NodeMutator } from './types';

/**
 * The `FallbackOperandSubstitution` heuristic mutator. For any `??` / `||`
 * logical expression yields the same expression with its right (fallback) operand
 * replaced by `undefined`, `null`, `0`, and `''` — each skipped when it would
 * duplicate the existing right operand. Yields nothing for any other node (and
 * for `&&`), so it is safe to register globally.
 */
export const fallbackOperandSubstitutionMutator: NodeMutator = {
    name: 'FallbackOperandSubstitution',

    *mutate(path) {
        if (!path.isLogicalExpression()) {
            return;
        }

        const { node } = path;
        if (node.operator !== '??' && node.operator !== '||') {
            return;
        }

        const { left, operator, right } = node;

        // `undefined` — skip when the fallback is already the `undefined` identifier.
        if (!(isIdentifier(right) && right.name === 'undefined')) {
            yield logicalExpression(operator, left, identifier('undefined'));
        }

        // `null` — skip when the fallback is already `null`.
        if (!isNullLiteral(right)) {
            yield logicalExpression(operator, left, nullLiteral());
        }

        // `0` — skip when the fallback is already the literal `0`.
        if (!(isNumericLiteral(right) && right.value === 0)) {
            yield logicalExpression(operator, left, numericLiteral(0));
        }

        // `''` — skip when the fallback is already the empty string.
        if (!(isStringLiteral(right) && right.value === '')) {
            yield logicalExpression(operator, left, stringLiteral(''));
        }
    },
};
