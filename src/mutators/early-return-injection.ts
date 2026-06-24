/*
 * Heuristic NodeMutator: EarlyReturnInjection (functional-architecture §5, P3).
 *
 * THE ONLY STATEMENT-SHAPED OPERATOR in the catalog. It prepends a bare
 * `return;` (and a `return undefined;`) to a FUNCTION BODY, short-circuiting the
 * function before any of its real work runs. A function whose side-effects /
 * return value are never pinned by a test cannot kill this mutant. Stryker's
 * built-ins have no early-return injection. This operator fills that gap, but —
 * because the replacement is a STATEMENT, not an expression — its placement is
 * load-bearing and is verified against the REAL instrumenter by a dedicated
 * canary (`tests/injection/early-return-placement-proof.test.ts` +
 * `early-return-placement-proof-worker.mjs`), per §5 constraint 3 and the
 * EarlyReturnInjection footnote.
 *
 * AUTHORING IDIOM — the P1 object-literal-with-generator shape, but yielding a
 * `BlockStatement` (a statement) rather than an expression. Replacement nodes are
 * built with `@babel/types` factories (`blockStatement`, `returnStatement`,
 * `identifier`), never strings.
 *
 * MATCH:
 *   • the node is a `BlockStatement`, AND
 *   • its PARENT is a function shape — `FunctionDeclaration`, `FunctionExpression`,
 *     `ArrowFunctionExpression`, `ObjectMethod`, or `ClassMethod` — read via
 *     `path.parentPath?.is*()`. This rejects plain control-flow blocks (the bodies
 *     of `if` / `for` / `while` / `try` / `catch` / bare blocks) whose parent is a
 *     control statement.
 *   • the body is NON-empty (`node.body.length > 0`); a leading `return;` in an
 *     already-empty body is a near-no-op, so it is skipped.
 *
 * `parentPath` is OPTIONAL on the local `NodePath` slice (mirroring `hub`): a
 * synthetic path that omits it degrades this operator to a clean no-match rather
 * than a throw. Stryker's real `NodePath` always populates it.
 *
 * REPLACEMENTS (two distinct mutants):
 *   • `{ return; …body }`           — prepend a bare `ReturnStatement`.
 *   • `{ return undefined; …body }` — prepend `return undefined;`.
 * For a non-void function these are distinct probes; for a function that already
 * returns nothing they are near-equivalent, but Stryker scores them separately —
 * acceptable noise (catalog edge case).
 *
 * LEGALITY: STATEMENT-SHAPED. Stryker's `statementMutantPlacer`
 * (`canPlace = path.isStatement()`) handles `path.isBlockStatement()` and wraps
 * the placed block correctly, so a `BlockStatement` replacement at a function-body
 * `BlockStatement` node places cleanly. VERIFIED LIVE through the real
 * instrumenter (see the placement-proof canary): no `statementMutantPlacer` throw.
 *
 * EDGE CASES:
 *   • Non-function blocks (if/for/while/try/catch/bare) — rejected by the
 *     parentPath guard.
 *   • Arrow functions with an EXPRESSION body (`x => x + 1`) have no
 *     `BlockStatement` child, so are not matched (no mutant) — correct; an
 *     early-return injection is meaningless there.
 *   • Generators / async functions: the body is still a `BlockStatement`;
 *     injecting `return;` short-circuits — still legal placement.
 */

import { blockStatement, identifier, returnStatement } from '@babel/types';

import type { NodeMutator, NodePath } from './types';

/** True when `parent` points at one of the five function-body-bearing shapes. */
function isFunctionParent(parent: NodePath): boolean {
    return (
        parent.isFunctionDeclaration() ||
        parent.isFunctionExpression() ||
        parent.isArrowFunctionExpression() ||
        parent.isObjectMethod() ||
        parent.isClassMethod()
    );
}

/**
 * The `EarlyReturnInjection` heuristic mutator. For a NON-empty function-body
 * `BlockStatement`, yields the body with a leading `return;` and (separately) a
 * leading `return undefined;`. Yields nothing for non-function blocks, empty
 * bodies, expression-bodied arrows, or any non-block node — so it is safe to
 * register globally.
 */
export const earlyReturnInjectionMutator: NodeMutator = {
    name: 'EarlyReturnInjection',

    *mutate(path) {
        if (!path.isBlockStatement()) {
            return;
        }

        // Require a function-body block (parent is a function shape). A missing
        // parentPath degrades to a clean no-match.
        const { parentPath } = path;
        if (!parentPath || !isFunctionParent(parentPath)) {
            return;
        }

        const { body } = path.node;
        // Skip an empty body — a leading `return;` there is a near-no-op.
        if (body.length === 0) {
            return;
        }

        yield blockStatement([returnStatement(), ...body]);
        yield blockStatement([returnStatement(identifier('undefined')), ...body]);
    },
};
