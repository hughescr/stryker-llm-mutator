import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    type CallExpression,
    isCallExpression,
    isIdentifier,
    isMemberExpression,
    type Node,
} from '@babel/types';
import { arrayMethodSwapMutator } from '../../src/mutators/array-method-swap';
import type { NodePath } from '../../src/mutators/types';

const { parse, traverse } = babel as {
    parse(code: string, opts?: object): unknown;
    traverse(ast: unknown, v: { enter(path: NodePath): void }): void;
};
function mutate(code: string): Node[] {
    const ast = parse(code, {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ['typescript'] },
    });
    let found: NodePath | undefined;
    traverse(ast, {
        enter(p) {
            if (!found && p.isCallExpression()) {
                found = p;
                p.stop();
            }
        },
    });
    if (!found) {
        return [];
    }
    return [...arrayMethodSwapMutator.mutate(found)];
}
function method(n: Node) {
    expect(isCallExpression(n)).toBe(true);
    const c = (n as CallExpression).callee;
    if (!isMemberExpression(c)) {
        throw new Error('member expected');
    }
    return isIdentifier(c.property) ? c.property.name : '';
}
describe('arrayMethodSwapMutator', () => {
    it('swaps push and unshift while preserving repeated, multiple, and spread args', () => {
        for (const [code, want, count] of [
            ['xs.push(x,x,...ys)', 'unshift', 3],
            ['xs.unshift(a,b)', 'push', 2],
        ] as const) {
            const out = mutate(code);
            expect(out).toHaveLength(1);
            expect(method(out[0]!)).toBe(want);
            expect((out[0] as CallExpression).arguments).toHaveLength(count);
        }
    });
    it('preserves call type arguments', () =>
        expect((mutate('xs.push<string>(x)')[0] as CallExpression).typeParameters).toBeDefined());
    it('skips zero args, fresh empty arrays, callback methods, computed, and optional calls', () => {
        for (const code of [
            'xs.push()',
            '[].push(x)',
            'xs.map(f)',
            'xs.filter(f)',
            'xs.forEach(f)',
            'xs["push"](x)',
            'xs?.push(x)',
            'xs.push?.(x)',
        ]) {
            expect(mutate(code)).toHaveLength(0);
        }
    });
    it('has observable end-order behavior with multiple values', () => {
        const a = [0];
        a.push(1, 2);
        const b = [0];
        b.unshift(1, 2);
        expect(a).toEqual([0, 1, 2]);
        expect(b).toEqual([1, 2, 0]);
    });
});
