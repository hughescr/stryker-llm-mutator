/*
 * Offline unit tests for the BoundaryOffByOne heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert the yielded nodes
 * via `@babel/types` predicates (the swap is a BinaryExpression with the flipped
 * operator; the drop is the bare other operand) and that non-matching nodes yield
 * nothing. Pure AST — no network, no Stryker process.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    type BinaryExpression,
    type Identifier,
    isBinaryExpression,
    isIdentifier,
    isMemberExpression,
    isNumericLiteral,
    type MemberExpression,
    type Node,
    type NumericLiteral,
} from '@babel/types';

import { boundaryOffByOneMutator } from '../../src/mutators/boundary-off-by-one';
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

/** Collect the yielded replacement nodes for the binary expression in `code`. */
function mutate(code: string): Node[] {
    const path = firstPath(code, p => p.isBinaryExpression());
    return [...boundaryOffByOneMutator.mutate(path)];
}

describe('boundaryOffByOneMutator', () => {
    it('has the Stryker-facing name "BoundaryOffByOne"', () => {
        expect(boundaryOffByOneMutator.name).toBe('BoundaryOffByOne');
    });

    it('swaps + to - and drops the +1 for `i + 1` (literal on the RIGHT)', () => {
        const out = mutate('const x = i + 1;');
        expect(out).toHaveLength(2);

        // First yield: the operator-swapped BinaryExpression `i - 1`.
        const swap = out[0] as BinaryExpression;
        expect(isBinaryExpression(swap)).toBe(true);
        expect(swap.operator).toBe('-');
        expect(isIdentifier(swap.left) && (swap.left as Identifier).name === 'i').toBe(true);
        expect(isNumericLiteral(swap.right) && (swap.right as NumericLiteral).value === 1).toBe(
            true,
        );

        // Second yield: the dropped form — the bare other operand `i`.
        const drop = out[1] as Identifier;
        expect(isIdentifier(drop)).toBe(true);
        expect(drop.name).toBe('i');
    });

    it('swaps - to + and drops the -1 for `len - 1` (literal on the RIGHT)', () => {
        const out = mutate('const x = len - 1;');
        expect(out).toHaveLength(2);
        expect((out[0] as BinaryExpression).operator).toBe('+');
        expect((out[1] as Identifier).name).toBe('len');
    });

    it('drops the literal correctly for `1 + i` (literal on the LEFT)', () => {
        const out = mutate('const x = 1 + i;');
        expect(out).toHaveLength(2);
        // Swap keeps both operands in place, only flips operator.
        const swap = out[0] as BinaryExpression;
        expect(swap.operator).toBe('-');
        expect(isNumericLiteral(swap.left) && (swap.left as NumericLiteral).value === 1).toBe(true);
        // Drop yields the non-1 operand, which here is the RIGHT side `i`.
        expect((out[1] as Identifier).name).toBe('i');
    });

    it('works with a MemberExpression operand (`boundaries.length - 1`)', () => {
        const out = mutate('const x = boundaries.length - 1;');
        expect(out).toHaveLength(2);
        expect((out[0] as BinaryExpression).operator).toBe('+');
        // Drop yields the MemberExpression `boundaries.length` directly.
        const drop = out[1] as MemberExpression;
        expect(isMemberExpression(drop)).toBe(true);
    });

    it('matches a float literal that equals 1 (`x + 1.0`)', () => {
        const out = mutate('const x = y + 1.0;');
        expect(out).toHaveLength(2);
        expect((out[0] as BinaryExpression).operator).toBe('-');
        expect((out[1] as Identifier).name).toBe('y');
    });

    it('skips when NEITHER operand is 1 (`a + b`)', () => {
        expect(mutate('const x = a + b;')).toHaveLength(0);
    });

    it('skips a non-1 literal (`x + 2`)', () => {
        expect(mutate('const x = y + 2;')).toHaveLength(0);
    });

    it('skips when BOTH operands are 1 (`1 + 1`)', () => {
        expect(mutate('const x = 1 + 1;')).toHaveLength(0);
    });

    it('skips a non +/- operator even with a 1 operand (`a * 1`)', () => {
        expect(mutate('const x = a * 1;')).toHaveLength(0);
    });

    it('skips a comparison BinaryExpression (`a < 1`)', () => {
        // `<` is a BinaryExpression but not arithmetic — operator guard rejects it.
        expect(mutate('const x = a < 1;')).toHaveLength(0);
    });

    it('does NOT match a BigInt 1n operand (`x + 1n` — BigIntLiteral, not NumericLiteral)', () => {
        expect(mutate('const x = y + 1n;')).toHaveLength(0);
    });

    it('yields nothing for a non-binary node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...boundaryOffByOneMutator.mutate(path)]).toHaveLength(0);
    });

    it('yields nothing for a logical expression (`a ?? 1`)', () => {
        const path = firstPath('const x = a ?? 1;', p => p.isLogicalExpression());
        expect([...boundaryOffByOneMutator.mutate(path)]).toHaveLength(0);
    });
});
