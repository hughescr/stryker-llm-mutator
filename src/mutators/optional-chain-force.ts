/*
 * Heuristic NodeMutator: OptionalChainForce (functional-architecture §5, P4).
 *
 * Forcing optional chaining (`a.b` → `a?.b`) suppresses the TypeError a plain
 * member access would throw when the object is null/undefined. That changes
 * THROW behavior: a test that relies on an access throwing on a nullish object —
 * or that asserts a value is always present — can be broken by silently returning
 * `undefined` instead. Stryker's built-ins have an `OptionalChaining` mutator that
 * REMOVES optionality; none ADDS it. This operator is the complementary probe.
 *
 * AUTHORING IDIOM — identical to the P1 trio, but emitting a DIFFERENT node type:
 * Babel models `a?.b` as an `OptionalMemberExpression` (a distinct node with
 * `optional: true`), NOT a `MemberExpression` with a flag. So the replacement is
 * built with the `optionalMemberExpression(object, property, computed, optional)`
 * factory — merely setting `node.optional` would NOT produce the optional form.
 *
 * MATCH: `path.isMemberExpression()`. This narrows to PLAIN (non-optional) member
 * expressions only: `a?.b` parses to an `OptionalMemberExpression`, which
 * `isMemberExpression()` does NOT match, so already-optional members are excluded
 * automatically (no explicit `node.optional` check needed). Every plain member —
 * standalone (`a.b`), chained inner/outer (`a.b.c`), callee (`a.b()`), computed
 * (`a[i]`), and this-member (`this.x`) — is matched and places (verified live).
 *
 * REPLACEMENT (always exactly one, always a real change):
 *   • `a.b`     → `a?.b`
 *   • `a[i]`    → `a?.[i]`  (computed preserved)
 *   • `this.x`  → `this?.x`
 * The original `object`, `property`, and `computed` flag are reused; only
 * optionality is forced on.
 *
 * LEGALITY: Stryker replaces the WHOLE visited `MemberExpression` with an
 * `OptionalMemberExpression`. Stryker's `expression-mutant-placer` treats an
 * `OptionalMemberExpression` as a member expression
 * (`isMemberExpression = path.isMemberExpression() || path.isOptionalMemberExpression()`),
 * so it is placeable in the same position, subject to the same part-of-chain rules
 * the original member already satisfied. Verified live across standalone, chained
 * (both inner and outer), callee, computed, and `this.x`.
 *
 * EDGE CASES:
 *   • Already-optional members (`a?.b`, an `OptionalMemberExpression`) are not
 *     matched by `isMemberExpression()` — skipped automatically.
 *   • Private-field members (`a.#x`, where `property` is a `PrivateName`) are
 *     skipped: `@babel/types`' `optionalMemberExpression` factory accepts only an
 *     `Expression` property, and a `PrivateName` is not one. This is a rare member
 *     shape and forcing optionality on it adds little signal, so a clean skip is
 *     the right call rather than an unsafe cast.
 *   • Forcing `?.` may be an equivalent mutant when the object is provably
 *     non-nullish — accepted noise, human-audit per §5.
 *   • On a non-nullable typed object the mutated source may be a TS type/lint
 *     concern but instruments fine; if it type-errors it scores as `error`
 *     (honest), not a placement failure.
 */

import { isPrivateName, optionalMemberExpression } from '@babel/types';

import type { NodeMutator } from './types';

/**
 * The `OptionalChainForce` heuristic mutator. For every plain (non-optional)
 * `MemberExpression`, yields the optional-chained form (an
 * `OptionalMemberExpression` with `optional: true`), preserving the object,
 * property, and computed flag. Yields nothing for already-optional members or any
 * non-member node, so it is safe to register globally.
 */
export const optionalChainForceMutator: NodeMutator = {
    name: 'OptionalChainForce',

    *mutate(path) {
        if (!path.isMemberExpression()) {
            return;
        }

        const { object, property, computed } = path.node;
        // A PrivateName property (`a.#x`) is not an Expression and the
        // optionalMemberExpression factory cannot build it — skip cleanly.
        if (isPrivateName(property)) {
            return;
        }

        yield optionalMemberExpression(object, property, computed, true);
    },
};
