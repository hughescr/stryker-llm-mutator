/*
 * Local typing for Stryker's `NodeMutator` contract + a minimal Babel `NodePath`
 * (M0 proof).
 *
 * TWO type-sourcing constraints shape this file:
 *
 *   1. `@stryker-mutator/instrumenter`'s `package.json` `exports` map only
 *      exposes `.` and `./package.json`; its `NodeMutator` interface lives in
 *      the non-exported `dist/src/mutators/node-mutator.d.ts` and cannot be
 *      imported by path. The interface is tiny and stable, so we mirror it here.
 *
 *   2. The AST types it references come from Babel. `@babel/types` ships full
 *      typings (resolvable), but `@babel/core` itself ships NO typings and
 *      `@types/babel__core` / `@types/babel__traverse` are NOT installed — so
 *      `NodePath` has no published type. We therefore source the node types from
 *      `@babel/types` and declare the SMALL structural slice of `NodePath` that a
 *      heuristic mutator actually touches (the type-guard predicates that narrow
 *      `node`, plus `node` itself). This is enough to type-check our mutators and
 *      to accept the REAL `NodePath` Babel's `traverse` hands a visitor at
 *      runtime (structural typing — the real path is a superset of this slice).
 *
 * Verbatim instrumenter contract (9.6.1, `dist/src/mutators/node-mutator.d.ts`):
 *   export interface NodeMutator {
 *       mutate(path: NodePath): Iterable<types.Node>;
 *       readonly name: string;
 *   }
 */

import type {
    BigIntLiteral,
    BinaryExpression,
    BooleanLiteral,
    Identifier,
    LogicalExpression,
    Node,
    NumericLiteral,
    StringLiteral,
} from '@babel/types';

/**
 * The minimal structural slice of Babel's `NodePath` a heuristic mutator uses.
 * The real `NodePath` (untyped here — `@babel/traverse` ships no typings) is a
 * structural superset, so a real path passed by `traverse` satisfies this type.
 *
 * Each `is*()` predicate is a type guard that narrows `node` to the matching
 * Babel node, mirroring the real `NodePath` API. We expose only the predicates
 * the current mutators (and their tests) rely on; add more as new heuristics
 * need them.
 */
export interface NodePath {
    /** The AST node this path points at. */
    readonly node: Node;
    /** Narrows `node` to `NumericLiteral` (e.g. `42`, `3.14`, `0xff`, `1_000`). */
    isNumericLiteral(): this is { readonly node: NumericLiteral };
    /** Narrows `node` to `StringLiteral`. */
    isStringLiteral(): this is { readonly node: StringLiteral };
    /** Narrows `node` to `BooleanLiteral`. */
    isBooleanLiteral(): this is { readonly node: BooleanLiteral };
    /** Narrows `node` to `BigIntLiteral` (`9n`) — distinct from `NumericLiteral`. */
    isBigIntLiteral(): this is { readonly node: BigIntLiteral };
    /** Narrows `node` to `Identifier`. */
    isIdentifier(): this is { readonly node: Identifier };
    /**
     * Narrows `node` to `BinaryExpression` (e.g. `i + 1`, `len - 1`, `a < b`).
     * Used by `BoundaryOffByOne` (and later the P2 `ComparisonBoundaryShift`).
     */
    isBinaryExpression(): this is { readonly node: BinaryExpression };
    /**
     * Narrows `node` to `LogicalExpression` (`??`, `||`, `&&`). Used by
     * `FallbackOperandSubstitution`.
     */
    isLogicalExpression(): this is { readonly node: LogicalExpression };
    /** Halts the surrounding `traverse` early (used by test helpers). */
    stop(): void;
}

/**
 * Structural contract a Stryker mutator must satisfy. Any object matching this
 * shape can be registered in the instrumenter's `allMutators` array and will be
 * invoked by `transformBabel` for every traversed Babel node.
 */
export interface NodeMutator {
    /**
     * Given a Babel `NodePath`, yield zero or more replacement AST nodes. Each
     * yielded node becomes one candidate mutant on the visited node. Returning
     * an empty iterable (the common case for non-matching node types) means "no
     * mutation here".
     */
    mutate(path: NodePath): Iterable<Node>;
    /** Stable mutator name, surfaced as `mutatorName` on every emitted mutant. */
    readonly name: string;
}
