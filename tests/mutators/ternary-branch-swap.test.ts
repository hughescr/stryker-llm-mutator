/*
 * Offline unit tests for the TernaryBranchSwap heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert the branches swap
 * (test preserved), the equivalent-branches skip, nested-ternary independence, and
 * that non-conditional nodes yield nothing. Pure AST — no network, no Stryker.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    type ConditionalExpression,
    type Identifier,
    isConditionalExpression,
    isIdentifier,
    type Node,
} from '@babel/types';

import { ternaryBranchSwapMutator } from '../../src/mutators/ternary-branch-swap';
import type { NodePath } from '../../src/mutators/types';

const { parse, traverse } = babel as {
    parse: (code: string, opts?: object) => unknown;
    traverse: (ast: unknown, visitor: { enter(path: NodePath): void }) => void;
};

/** Parse `code` and return the FIRST `NodePath` for which `predicate` is true. */
function firstPath(code: string, predicate: (path: NodePath) => boolean): NodePath {
    const ast = parse(code, { configFile: false, babelrc: false });
    let found: NodePath | undefined;
    traverse(ast, {
        enter(path: NodePath) {
            if (!found && predicate(path)) {
                found = path;
                path.stop();
            }
        },
    });
    if (!found) {
        throw new Error(`No node matched the predicate in: ${code}`);
    }
    return found;
}

/** Collect the yielded replacement nodes for the first conditional in `code`. */
function mutate(code: string): Node[] {
    const path = firstPath(code, p => p.isConditionalExpression());
    return [...ternaryBranchSwapMutator.mutate(path)];
}

const idName = (node: Node): string => {
    expect(isIdentifier(node)).toBe(true);
    return (node as Identifier).name;
};

describe('ternaryBranchSwapMutator', () => {
    it('has the Stryker-facing name "TernaryBranchSwap"', () => {
        expect(ternaryBranchSwapMutator.name).toBe('TernaryBranchSwap');
    });

    it('swaps consequent and alternate (`c ? p : q` → `c ? q : p`)', () => {
        const out = mutate('const x = c ? p : q;');
        expect(out).toHaveLength(1);
        const swap = out[0] as ConditionalExpression;
        expect(isConditionalExpression(swap)).toBe(true);
        // test preserved.
        expect(idName(swap.test)).toBe('c');
        // branches swapped.
        expect(idName(swap.consequent)).toBe('q');
        expect(idName(swap.alternate)).toBe('p');
    });

    it('reuses the test node unchanged', () => {
        const path = firstPath('const x = c ? p : q;', p => p.isConditionalExpression());
        const originalTest = (path.node as ConditionalExpression).test;
        const out = [...ternaryBranchSwapMutator.mutate(path)];
        expect((out[0] as ConditionalExpression).test).toBe(originalTest);
    });

    it('skips when consequent and alternate are structurally equal (`c ? p : p`)', () => {
        expect(mutate('const x = c ? p : p;')).toHaveLength(0);
    });

    it('skips structurally-equal complex branches (`c ? a.b : a.b`)', () => {
        expect(mutate('const x = c ? a.b : a.b;')).toHaveLength(0);
    });

    it('swaps when complex branches differ (`c ? a.b : a.c`)', () => {
        const out = mutate('const x = c ? a.b : a.c;');
        expect(out).toHaveLength(1);
    });

    it('handles nested ternaries by swapping the OUTER one first (depth-first enter)', () => {
        // Outer: `c1 ? (c2 ? p : q) : r`. The first conditional entered is the outer.
        const out = mutate('const x = c1 ? (c2 ? p : q) : r;');
        expect(out).toHaveLength(1);
        const swap = out[0] as ConditionalExpression;
        // outer test preserved; outer branches swapped (alternate `r` now first).
        expect(idName(swap.test)).toBe('c1');
        expect(idName(swap.consequent)).toBe('r');
        expect(isConditionalExpression(swap.alternate)).toBe(true);
    });

    it('yields nothing for a non-conditional node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...ternaryBranchSwapMutator.mutate(path)]).toHaveLength(0);
    });
});
