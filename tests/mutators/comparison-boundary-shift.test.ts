/*
 * Offline unit tests for the ComparisonBoundaryShift heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert the single yielded
 * node is a BinaryExpression with the strictness-flipped operator and the two
 * original operands reused, and that non-relational / non-binary nodes yield
 * nothing. Pure AST — no network, no Stryker process.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    type BinaryExpression,
    type Identifier,
    isBinaryExpression,
    isIdentifier,
    isNumericLiteral,
    type Node,
    type NumericLiteral,
} from '@babel/types';

import { comparisonBoundaryShiftMutator } from '../../src/mutators/comparison-boundary-shift';
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
    return [...comparisonBoundaryShiftMutator.mutate(path)];
}

/** The single yielded operator (asserting it IS a BinaryExpression first). */
function swappedOperator(code: string): string {
    const out = mutate(code);
    expect(out).toHaveLength(1);
    expect(isBinaryExpression(out[0]!)).toBe(true);
    return (out[0] as BinaryExpression).operator;
}

describe('comparisonBoundaryShiftMutator', () => {
    it('has the Stryker-facing name "ComparisonBoundaryShift"', () => {
        expect(comparisonBoundaryShiftMutator.name).toBe('ComparisonBoundaryShift');
    });

    it('flips >= to >', () => {
        expect(swappedOperator('const x = h >= 12;')).toBe('>');
    });

    it('flips > to >=', () => {
        expect(swappedOperator('const x = h > 12;')).toBe('>=');
    });

    it('flips < to <=', () => {
        expect(swappedOperator('const x = i < n;')).toBe('<=');
    });

    it('flips <= to <', () => {
        expect(swappedOperator('const x = i <= n;')).toBe('<');
    });

    it('reuses both original operand nodes unchanged (`h >= 12`)', () => {
        const out = mutate('const x = h >= 12;');
        const swap = out[0] as BinaryExpression;
        expect(isIdentifier(swap.left) && (swap.left as Identifier).name === 'h').toBe(true);
        expect(isNumericLiteral(swap.right) && (swap.right as NumericLiteral).value === 12).toBe(
            true,
        );
    });

    it('skips strict equality `===`', () => {
        expect(mutate('const x = a === b;')).toHaveLength(0);
    });

    it('skips loose equality `==`', () => {
        expect(mutate('const x = a == b;')).toHaveLength(0);
    });

    it('skips inequality `!==` and `!=`', () => {
        expect(mutate('const x = a !== b;')).toHaveLength(0);
        expect(mutate('const x = a != b;')).toHaveLength(0);
    });

    it('skips arithmetic `+`', () => {
        expect(mutate('const x = a + b;')).toHaveLength(0);
    });

    it('skips bitwise `&`', () => {
        expect(mutate('const x = a & b;')).toHaveLength(0);
    });

    it('skips `instanceof` (BinaryExpression operator, not in the swap map)', () => {
        expect(mutate('const x = a instanceof B;')).toHaveLength(0);
    });

    it('skips `in` (BinaryExpression operator, not in the swap map)', () => {
        expect(mutate("const x = 'a' in b;")).toHaveLength(0);
    });

    it('yields nothing for a non-binary node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...comparisonBoundaryShiftMutator.mutate(path)]).toHaveLength(0);
    });

    it('yields nothing for a logical expression (`a < 1 && b`)', () => {
        const path = firstPath('const x = a && b;', p => p.isLogicalExpression());
        expect([...comparisonBoundaryShiftMutator.mutate(path)]).toHaveLength(0);
    });
});
