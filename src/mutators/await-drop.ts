/*
 * Heuristic NodeMutator: AwaitDrop (functional-architecture §5, P2).
 *
 * Dropping an `await` is a precise concurrency/ordering probe: code that depends
 * on a promise being RESOLVED before the next statement runs (`const x = await
 * f(); use(x)`) breaks when the `await` is removed, but a test that never pins
 * the timing — or that happens to pass because the promise resolves fast enough —
 * cannot kill it. Stryker's built-ins have no await-removal operator. This one
 * fills that gap.
 *
 * AUTHORING IDIOM — identical to the P1 trio, but with NO factory: the
 * replacement is the original `node.argument`, which is already a valid
 * `Expression` from the parse, yielded directly (the same "reuse the operand
 * node" move `BoundaryOffByOne`'s drop uses).
 *
 * MATCH: `path.isAwaitExpression()`. Every `AwaitExpression` is a candidate; no
 * further structural condition.
 *
 * REPLACEMENT (always exactly one, always a real change, so no equivalent-mutant
 * guard is needed):
 *   • drop the `await`: yield the bare `node.argument`. `await g(1)` → `g(1)`.
 *
 * LEGALITY: Stryker replaces the WHOLE visited `AwaitExpression` with its
 * argument, which is always an `Expression` — legal anywhere the `AwaitExpression`
 * sat (expression placer, `path.isExpression()`). Verified live: `await g(1)`
 * placed as `g(1)`.
 *
 * HONEST BUCKETING (functional-architecture §5): dropping `await` can produce a
 * TypeScript type error (a `Promise<T>` where a `T` was expected). Under Stryker
 * that surfaces as a transpile/compile failure on the mutant, scored as
 * `error` / `compileError`, NOT `survived`. That is the INTENDED, honest behavior
 * — a build-time-caught mutant is a kill of a different colour — and is not a
 * placement failure. Many drops will land as `error`, few as `survived`; that is
 * the point of the operator.
 *
 * EDGE CASES:
 *   • `for await (… of …)` is a `ForOfStatement` with an `await` FLAG, NOT an
 *     `AwaitExpression`, so it is not matched (correct — dropping its await would
 *     be a syntax-shape change, out of scope).
 *   • Top-level await in a module is still an `AwaitExpression` and still legal to
 *     unwrap to its argument expression.
 */

import type { NodeMutator } from './types';

/**
 * The `AwaitDrop` heuristic mutator. For every `AwaitExpression`, yields its bare
 * argument expression (dropping the `await`). Yields nothing for any other node,
 * so it is safe to register globally.
 */
export const awaitDropMutator: NodeMutator = {
    name: 'AwaitDrop',

    *mutate(path) {
        if (!path.isAwaitExpression()) {
            return;
        }

        // The argument is already a valid Expression from the parse; reuse it.
        yield path.node.argument;
    },
};
