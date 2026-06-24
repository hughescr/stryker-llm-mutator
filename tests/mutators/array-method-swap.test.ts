/*
 * Offline unit tests for the ArrayMethodSwap heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert the method-name
 * swaps (map↔filter↔forEach, push↔unshift), that the receiver + args are reused
 * unchanged, that computed / non-member / unknown-method calls are skipped, and
 * that non-call nodes yield nothing. Pure AST — no network, no Stryker process.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    type CallExpression,
    type Identifier,
    isCallExpression,
    isIdentifier,
    isMemberExpression,
    type MemberExpression,
    type Node,
} from '@babel/types';

import { arrayMethodSwapMutator } from '../../src/mutators/array-method-swap';
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
    return [...arrayMethodSwapMutator.mutate(path)];
}

/** The swapped method name of a yielded `obj.<method>(…)` call. */
function methodName(node: Node): string {
    expect(isCallExpression(node)).toBe(true);
    const { callee } = node as CallExpression;
    expect(isMemberExpression(callee)).toBe(true);
    const prop = (callee as MemberExpression).property;
    expect(isIdentifier(prop)).toBe(true);
    return (prop as Identifier).name;
}

describe('arrayMethodSwapMutator', () => {
    it('has the Stryker-facing name "ArrayMethodSwap"', () => {
        expect(arrayMethodSwapMutator.name).toBe('ArrayMethodSwap');
    });

    it('swaps map to filter AND forEach', () => {
        const out = mutate('xs.map(f);');
        expect(out.map(methodName).sort()).toEqual(['filter', 'forEach']);
    });

    it('swaps filter to map AND forEach', () => {
        const out = mutate('xs.filter(f);');
        expect(out.map(methodName).sort()).toEqual(['forEach', 'map']);
    });

    it('swaps forEach to map AND filter', () => {
        const out = mutate('xs.forEach(f);');
        expect(out.map(methodName).sort()).toEqual(['filter', 'map']);
    });

    it('swaps push to unshift', () => {
        const out = mutate('xs.push(x);');
        expect(out.map(methodName)).toEqual(['unshift']);
    });

    it('swaps unshift to push', () => {
        const out = mutate('xs.unshift(x);');
        expect(out.map(methodName)).toEqual(['push']);
    });

    it('reuses the receiver object and arguments unchanged', () => {
        const path = firstPath('xs.map(f, g);', p => p.isCallExpression());
        const original = path.node as CallExpression;
        const originalObject = (original.callee as MemberExpression).object;
        const out = [...arrayMethodSwapMutator.mutate(path)];
        for (const node of out) {
            const call = node as CallExpression;
            // Same receiver object node reused.
            expect((call.callee as MemberExpression).object).toBe(originalObject);
            // Same arguments array reused (length preserved).
            expect(call.arguments).toHaveLength(2);
        }
    });

    it('rebuilds the callee as a NON-computed member', () => {
        const out = mutate('xs.map(f);');
        for (const node of out) {
            const callee = (node as CallExpression).callee as MemberExpression;
            expect(callee.computed).toBe(false);
        }
    });

    it('skips a computed call (`xs["map"](f)`)', () => {
        expect(mutate('xs["map"](f);')).toHaveLength(0);
    });

    it('skips an unknown method (`xs.reduce(f)`)', () => {
        expect(mutate('xs.reduce(f);')).toHaveLength(0);
    });

    it('skips a bare-identifier call (`map(f)` — no member callee)', () => {
        expect(mutate('map(f);')).toHaveLength(0);
    });

    it('yields nothing for a non-call node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...arrayMethodSwapMutator.mutate(path)]).toHaveLength(0);
    });
});
