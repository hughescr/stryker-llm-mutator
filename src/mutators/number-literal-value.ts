/*
 * Heuristic NodeMutator: NumberLiteralValue (development-plan §3.1.3, M0 proof).
 *
 * Stryker v9 ships sixteen built-in mutators but NONE of them mutate a numeric
 * literal's VALUE — `42` is never turned into `43`, `41`, or `0`. This is a real
 * gap: off-by-one bugs and "magic constant" mistakes (timeouts, retry counts,
 * page sizes) hide behind tests that never pin the exact number. This mutator
 * fills that gap and doubles as the M0 monkeypatch-injection proof: it is a
 * plain object satisfying Stryker's `NodeMutator` shape, so it can be pushed
 * straight into the instrumenter's `allMutators` registry and picked up by
 * `transformBabel` with no plugin descriptor (Stryker has no public Mutator
 * plugin kind; see `src/injection.ts`).
 *
 * AUTHORING IDIOM — faithful to Stryker's own built-ins
 * (e.g. `boolean-literal-mutator.js`, `string-literal-mutator.js`):
 *   1. Use Babel's node factories for replacements. Stryker's built-ins reach
 *      them as `babel.types.*`; we import the same factory directly from
 *      `@babel/types` (`numericLiteral`) because `@babel/core` ships no typings
 *      and `@types/babel__core` is not installed — `@babel/types` IS fully
 *      typed, and `babel.types.numericLiteral === require('@babel/types').numericLiteral`,
 *      so this is the identical factory, just type-safe.
 *   2. Export an object literal with a `name` and a `*mutate(path)` generator.
 *   3. Guard on the Babel `path` type predicate, read the node, and `yield`
 *      freshly-CONSTRUCTED replacement nodes via the `numericLiteral` factory.
 * A numeric literal's value is a primitive, so — exactly like the boolean and
 * string mutators — we build new nodes with `numericLiteral(n)` rather than
 * `deepCloneNode`-ing the original (cloning is only needed when mutating a
 * complex node in place, as the arithmetic-operator mutator does).
 *
 * REPLACEMENT SET — small and tasteful, matching Stryker's "few, high-signal
 * variants per node" convention (boolean yields 2, string yields 2):
 *   • n  → n + 1   (probes the upper off-by-one boundary)
 *   • n  → n - 1   (probes the lower off-by-one boundary)
 *   • n  → 0       (probes "constant is load-bearing"), ONLY when n !== 0
 * For n === 0 the `0` variant is identical to the original, so it is skipped —
 * yielding it would create a no-op "equivalent" mutant that can never be killed,
 * which is the kind of noise Stryker's deterministic filters exist to avoid.
 * `n + 1` and `n - 1` are always distinct from `n`, so they are always yielded.
 *
 * SCOPE NOTE: `path.isNumericLiteral()` matches only `NumericLiteral` nodes
 * (e.g. `42`, `3.14`, `0xff`, `1_000`). Negative numbers like `-5` are a
 * `UnaryExpression` wrapping a positive `NumericLiteral`, so the inner literal
 * `5` is what this mutator sees — correct and intentional. `BigInt` literals are
 * a distinct `BigIntLiteral` node and are deliberately NOT matched here.
 */

import { numericLiteral } from '@babel/types';

import type { NodeMutator } from './types';

/**
 * The `NumberLiteralValue` heuristic mutator. Yields up to three replacement
 * nodes for each numeric literal: `n + 1`, `n - 1`, and (when `n !== 0`) `0`.
 * Yields nothing for any non-numeric node, so it is safe to register globally.
 */
export const numberLiteralValueMutator: NodeMutator = {
    name: 'NumberLiteralValue',

    *mutate(path) {
        if (!path.isNumericLiteral()) {
            return;
        }

        const { value } = path.node;

        // Off-by-one boundaries: always distinct from the original value.
        yield numericLiteral(value + 1);
        yield numericLiteral(value - 1);

        // "Constant is load-bearing" probe. Skip when the original is already 0
        // (the replacement would equal the original — a dead, unkillable mutant).
        if (value !== 0) {
            yield numericLiteral(0);
        }
    },
};
