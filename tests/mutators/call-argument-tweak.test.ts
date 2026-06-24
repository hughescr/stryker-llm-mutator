/*
 * Offline unit tests for the CallArgumentTweak heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert the two
 * sub-behaviors — ±1 on numeric args of gated length-ish methods, and swap of the
 * first two positional args — and that the gating / equivalence guards fire. Pure
 * AST — no network, no Stryker process.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    type CallExpression,
    type Identifier,
    isCallExpression,
    isIdentifier,
    isNumericLiteral,
    type Node,
    type NumericLiteral,
} from '@babel/types';

import { callArgumentTweakMutator } from '../../src/mutators/call-argument-tweak';
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

/** Collect the yielded replacement nodes for the first call expression in `code`. */
function mutate(code: string): Node[] {
    const path = firstPath(code, p => p.isCallExpression());
    return [...callArgumentTweakMutator.mutate(path)];
}

/** The numeric values of the args of a yielded CallExpression (numeric or NaN-as-marker). */
function argNumbers(node: Node): (number | string)[] {
    expect(isCallExpression(node)).toBe(true);
    return (node as CallExpression).arguments.map(a => {
        if (isNumericLiteral(a)) {
            return (a as NumericLiteral).value;
        }
        if (isIdentifier(a)) {
            return (a as Identifier).name;
        }
        return '?';
    });
}

describe('callArgumentTweakMutator', () => {
    it('has the Stryker-facing name "CallArgumentTweak"', () => {
        expect(callArgumentTweakMutator.name).toBe('CallArgumentTweak');
    });

    it('yields ±1 for each numeric arg of a gated method (`s.slice(0, 10)`)', () => {
        const out = mutate('const x = s.slice(0, 10);');
        // arg0=0 → +1/-1, arg1=10 → +1/-1; arg-swap of 0 and 10 → 1 more. 5 total.
        const argSets = out.map(argNumbers);
        expect(argSets).toContainEqual([1, 10]); // 0+1
        expect(argSets).toContainEqual([-1, 10]); // 0-1
        expect(argSets).toContainEqual([0, 11]); // 10+1
        expect(argSets).toContainEqual([0, 9]); // 10-1
        expect(argSets).toContainEqual([10, 0]); // arg-swap
        expect(out).toHaveLength(5);
    });

    it('reuses the ORIGINAL callee node object unchanged on every tweaked call', () => {
        const path = firstPath('const x = s.slice(0, 10);', p => p.isCallExpression());
        const originalCallee = (path.node as CallExpression).callee;
        const out = [...callArgumentTweakMutator.mutate(path)];
        expect(out.length).toBeGreaterThan(0);
        for (const node of out) {
            const call = node as CallExpression;
            expect(isCallExpression(call)).toBe(true);
            // The callee is the SAME node instance, reused (call shape preserved).
            expect(call.callee).toBe(originalCallee);
        }
    });

    it('does NOT ±1 a numeric arg of a non-gated method (`s.foo(10)`) — but still nothing to swap', () => {
        // foo is not length-ish, and only 1 arg, so no ±1 and no swap.
        expect(mutate('const x = s.foo(10);')).toHaveLength(0);
    });

    it('does NOT ±1 a numeric arg of a bare-identifier call (`fn(10)`)', () => {
        // bare callee (not a MemberExpression) → no method gate match; 1 arg → no swap.
        expect(mutate('const x = fn(10);')).toHaveLength(0);
    });

    it('skips ±1 on a computed-member call (`s["slice"](10)`) but still no swap (1 arg)', () => {
        expect(mutate('const x = s["slice"](10);')).toHaveLength(0);
    });

    it('swaps the first two positional args of any call (`fn(a, b)`)', () => {
        const out = mutate('const x = fn(a, b);');
        expect(out).toHaveLength(1);
        expect(argNumbers(out[0]!)).toEqual(['b', 'a']);
    });

    it('swaps only the first two, preserving the tail (`fn(a, b, c)`)', () => {
        const out = mutate('const x = fn(a, b, c);');
        expect(out).toHaveLength(1);
        expect(argNumbers(out[0]!)).toEqual(['b', 'a', 'c']);
    });

    it('skips arg-swap when fewer than 2 args (`fn(a)`)', () => {
        expect(mutate('const x = fn(a);')).toHaveLength(0);
    });

    it('skips arg-swap when the args are structurally equal (`fn(a, a)`)', () => {
        expect(mutate('const x = fn(a, a);')).toHaveLength(0);
    });

    it('skips arg-swap when the first arg is a spread (`fn(...a, b)`)', () => {
        expect(mutate('const x = fn(...a, b);')).toHaveLength(0);
    });

    it('skips arg-swap when the second arg is a spread (`fn(a, ...b)`)', () => {
        expect(mutate('const x = fn(a, ...b);')).toHaveLength(0);
    });

    it('does NOT ±1 a BigInt arg of a gated method (`s.repeat(3n)`) — BigIntLiteral excluded', () => {
        // 1 arg, BigInt → no ±1, no swap.
        expect(mutate('const x = s.repeat(3n);')).toHaveLength(0);
    });

    it('does the swap AND the ±1 together for a gated method with 2 numeric args (`s.substring(2, 5)`)', () => {
        const out = mutate('const x = s.substring(2, 5);');
        const argSets = out.map(argNumbers);
        expect(argSets).toContainEqual([3, 5]);
        expect(argSets).toContainEqual([1, 5]);
        expect(argSets).toContainEqual([2, 6]);
        expect(argSets).toContainEqual([2, 4]);
        expect(argSets).toContainEqual([5, 2]); // swap
        expect(out).toHaveLength(5);
    });

    it('yields nothing for a non-call node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...callArgumentTweakMutator.mutate(path)]).toHaveLength(0);
    });
});
