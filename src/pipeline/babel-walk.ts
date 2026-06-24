/*
 * Shared `@babel/parser` traversal helpers (functional-architecture §4 Gate 1 /
 * Gate 4). PURE, OFFLINE, bun-safe — imports `@babel/parser`/`@babel/types`
 * ONLY, never `@stryker-mutator/core`.
 *
 * Both `targeting.ts` (Gate 1/2 risk scoring) and `range-align.ts` (Gate 4
 * node-aligned range derivation) walk a parsed file's AST the SAME way: a tiny
 * hand-rolled recursive descent over `@babel/types` nodes. We deliberately avoid
 * `@babel/traverse` (it ships no typings and would force an untyped surface) and
 * keep the whole walk fully typed from `@babel/types` so it runs under `bun test`.
 *
 * This module is the single source of those primitives — the {@link AnyNode}
 * shape, the {@link isNode} guard, the {@link childNodes} child-iterator, the
 * {@link BabelLocSlice} → {@link toStrykerRange} conversion (the inverse of the
 * map-builder's `+1`), and the {@link BABEL_PLUGINS} the instrumenter also uses —
 * so the two stages cannot drift in how they parse or walk.
 */

import type { Node } from '@babel/types';

import type { SourceRange } from '../seam/types';

/** Babel plugins enabling the TS + JSX superset the instrumenter also parses. */
export const BABEL_PLUGINS = ['typescript', 'jsx'] as const;

/**
 * A Babel position is `{ line (1-based), column (0-based) }`; a node carries an
 * optional `loc`. We narrow to the slice the traversals read.
 */
interface BabelLocSlice {
    start: { line: number; column: number };
    end: { line: number; column: number };
}

/** A node with the structural fields the traversals inspect. */
export type AnyNode = Node & {
    loc?: BabelLocSlice | null;
    [key: string]: unknown;
};

/**
 * Convert a 1-based Babel `loc` to a 0-based Stryker {@link SourceRange} by
 * subtracting 1 from each line (columns unchanged) — the inverse of the
 * map-builder's `+1` keying. Both `targeting.ts` and `range-align.ts` emit
 * Stryker ranges through this single conversion so they stay byte-aligned.
 */
export function toStrykerRange(loc: BabelLocSlice): SourceRange {
    return {
        start: { line: loc.start.line - 1, column: loc.start.column },
        end: { line: loc.end.line - 1, column: loc.end.column },
    };
}

/** True for an AST node object (has a string `type`). */
export function isNode(value: unknown): value is AnyNode {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { type?: unknown }).type === 'string'
    );
}

/**
 * Yield each direct child node (or node in a child array) of `node`.
 * @yields each direct child AST node, skipping non-node fields (loc/type/extra).
 */
export function* childNodes(node: AnyNode): Generator<AnyNode> {
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'type' || key === 'extra') {
            continue;
        }
        const value = node[key];
        if (Array.isArray(value)) {
            for (const item of value) {
                if (isNode(item)) {
                    yield item;
                }
            }
        } else if (isNode(value)) {
            yield value;
        }
    }
}
