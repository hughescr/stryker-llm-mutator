/*
 * Offline unit tests for the NumberLiteralValue heuristic mutator.
 *
 * These drive the mutator exactly as Stryker's `transformBabel` does: parse a
 * snippet with Babel, `traverse` to obtain a real `NodePath`, and call
 * `*mutate(path)`. We assert the YIELDED replacement nodes are the right kind
 * (`NumericLiteral`) with the right values, and that non-numeric nodes yield
 * nothing. No network, no Stryker process — pure AST.
 *
 * TYPING NOTE: `@babel/core` ships no typings and `@types/babel__traverse` is
 * not installed, so the `babel` value import is untyped (`any`). We annotate the
 * traverse callback's `path` with our local structural `NodePath` and source the
 * typed node-checking helpers from `@babel/types` (which IS typed).
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import { isNumericLiteral, type Node, type NumericLiteral } from '@babel/types';

import { numberLiteralValueMutator } from '../../src/mutators/number-literal-value';
import type { NodePath } from '../../src/mutators/types';

const { parse, traverse } = babel as {
    parse: (code: string, opts?: object) => unknown;
    traverse: (ast: unknown, visitor: { enter(path: NodePath): void }) => void;
};

/**
 * Parse `code` and return the FIRST `NodePath` for which `predicate` is true.
 * Throws if none matches, so a mis-written fixture fails loudly rather than
 * silently testing nothing.
 */
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

/** Collect the values of all yielded `NumericLiteral` replacement nodes. */
function mutatedValues(path: NodePath): number[] {
    const out: number[] = [];
    for (const node of numberLiteralValueMutator.mutate(path) as Iterable<Node>) {
        expect(isNumericLiteral(node)).toBe(true);
        out.push((node as NumericLiteral).value);
    }
    return out;
}

describe('numberLiteralValueMutator', () => {
    it('has the Stryker-facing name "NumberLiteralValue"', () => {
        expect(numberLiteralValueMutator.name).toBe('NumberLiteralValue');
    });

    it('yields n+1, n-1, and 0 (in order) for a positive integer literal', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect(mutatedValues(path)).toEqual([43, 41, 0]);
    });

    it('yields n+1, n-1, and 0 for a negative-looking literal (the inner positive literal)', () => {
        // `-5` is a UnaryExpression over the NumericLiteral `5`; the mutator
        // sees the inner `5`, so it produces 6, 4, 0.
        const path = firstPath('const x = -5;', p => p.isNumericLiteral());
        expect(mutatedValues(path)).toEqual([6, 4, 0]);
    });

    it('mutates floating-point literals by +/- 1 and to 0', () => {
        const path = firstPath('const x = 3.5;', p => p.isNumericLiteral());
        expect(mutatedValues(path)).toEqual([4.5, 2.5, 0]);
    });

    it('mutates numeric-separator and hex literals by their numeric value', () => {
        const sep = firstPath('const x = 1_000;', p => p.isNumericLiteral());
        expect(mutatedValues(sep)).toEqual([1001, 999, 0]);

        const hex = firstPath('const x = 0xff;', p => p.isNumericLiteral());
        expect(mutatedValues(hex)).toEqual([256, 254, 0]);
    });

    it('skips the redundant 0 variant when the literal is already 0 (no equivalent mutant)', () => {
        const path = firstPath('const x = 0;', p => p.isNumericLiteral());
        // Only n+1 and n-1; the `0` variant would equal the original.
        expect(mutatedValues(path)).toEqual([1, -1]);
    });

    it('yields nothing for a string literal', () => {
        const path = firstPath('const x = "hello";', p => p.isStringLiteral());
        expect([...numberLiteralValueMutator.mutate(path)]).toHaveLength(0);
    });

    it('yields nothing for a boolean literal', () => {
        const path = firstPath('const x = true;', p => p.isBooleanLiteral());
        expect([...numberLiteralValueMutator.mutate(path)]).toHaveLength(0);
    });

    it('yields nothing for an identifier', () => {
        const path = firstPath(
            'const x = y;',
            p => p.isIdentifier() && (p.node as { name?: string }).name === 'y',
        );
        expect([...numberLiteralValueMutator.mutate(path)]).toHaveLength(0);
    });

    it('does NOT match BigInt literals (a distinct BigIntLiteral node)', () => {
        const path = firstPath('const x = 9n;', p => p.isBigIntLiteral());
        expect([...numberLiteralValueMutator.mutate(path)]).toHaveLength(0);
    });
});
