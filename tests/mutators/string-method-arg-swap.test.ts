/*
 * Offline unit tests for the StringMethodArgSwap heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert the predicate
 * method swaps (includes↔startsWith↔endsWith), receiver/args reuse, the
 * computed / non-member / unknown-method skips, and non-call non-match. Pure AST.
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

import { stringMethodArgSwapMutator } from '../../src/mutators/string-method-arg-swap';
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
    return [...stringMethodArgSwapMutator.mutate(path)];
}

/** The swapped method name of a yielded `s.<method>(…)` call. */
function methodName(node: Node): string {
    expect(isCallExpression(node)).toBe(true);
    const { callee } = node as CallExpression;
    expect(isMemberExpression(callee)).toBe(true);
    const prop = (callee as MemberExpression).property;
    expect(isIdentifier(prop)).toBe(true);
    return (prop as Identifier).name;
}

describe('stringMethodArgSwapMutator', () => {
    it('has the Stryker-facing name "StringMethodArgSwap"', () => {
        expect(stringMethodArgSwapMutator.name).toBe('StringMethodArgSwap');
    });

    it('swaps includes to startsWith AND endsWith', () => {
        const out = mutate("s.includes('x');");
        expect(out.map(methodName).sort()).toEqual(['endsWith', 'startsWith']);
    });

    it('swaps startsWith to endsWith AND includes', () => {
        const out = mutate("s.startsWith('x');");
        expect(out.map(methodName).sort()).toEqual(['endsWith', 'includes']);
    });

    it('swaps endsWith to startsWith AND includes', () => {
        const out = mutate("s.endsWith('x');");
        expect(out.map(methodName).sort()).toEqual(['includes', 'startsWith']);
    });

    it('reuses the receiver and arguments unchanged', () => {
        const path = firstPath("s.includes('x', 2);", p => p.isCallExpression());
        const original = path.node as CallExpression;
        const originalObject = (original.callee as MemberExpression).object;
        const out = [...stringMethodArgSwapMutator.mutate(path)];
        for (const node of out) {
            const call = node as CallExpression;
            expect((call.callee as MemberExpression).object).toBe(originalObject);
            expect(call.arguments).toHaveLength(2);
            expect((call.callee as MemberExpression).computed).toBe(false);
        }
    });

    it('skips a computed call (`s["includes"](x)`)', () => {
        expect(mutate('s["includes"](x);')).toHaveLength(0);
    });

    it('skips an unknown method (`s.indexOf(x)` — out of scope)', () => {
        expect(mutate('s.indexOf(x);')).toHaveLength(0);
    });

    it('skips a bare-identifier call (`includes(x)`)', () => {
        expect(mutate('includes(x);')).toHaveLength(0);
    });

    it('yields nothing for a non-call node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...stringMethodArgSwapMutator.mutate(path)]).toHaveLength(0);
    });
});
