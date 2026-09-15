import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import { type CallExpression, isCallExpression, isIdentifier, type Node } from '@babel/types';
import { callArgumentTweakMutator } from '../../src/mutators/call-argument-tweak';
import type { NodePath } from '../../src/mutators/types';

const { parse, traverse } = babel as {
    parse(code: string, opts?: object): unknown;
    traverse(ast: unknown, visitor: { enter(path: NodePath): void }): void;
};
function mutate(code: string): Node[] {
    const ast = parse(code, {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ['typescript'] },
    });
    let found: NodePath | undefined;
    traverse(ast, {
        enter(path) {
            if (!found && path.isCallExpression()) {
                found = path;
                path.stop();
            }
        },
    });
    if (!found) {
        return [];
    }
    return [...callArgumentTweakMutator.mutate(found)];
}
function names(node: Node): string[] {
    expect(isCallExpression(node)).toBe(true);
    return (node as CallExpression).arguments.map(a => (isIdentifier(a) ? a.name : '?'));
}
describe('callArgumentTweakMutator', () => {
    it('swaps exactly two distinct positional slice bounds', () =>
        expect(names(mutate('x.slice(start,end)')[0]!)).toEqual(['end', 'start']));
    it('preserves call type arguments', () =>
        expect(
            (mutate('x.slice<number>(start,end)')[0] as CallExpression).typeParameters,
        ).toBeDefined());
    it('skips equal, spread, wrong-arity, arbitrary, computed, optional, and direct literal calls', () => {
        for (const code of [
            'x.slice(a,a)',
            'x.slice(...a,b)',
            'x.slice(a)',
            'x.slice(a,b,c)',
            'fn(a,b)',
            'x.substring(a,b)',
            'x["slice"](a,b)',
            'x?.slice(a,b)',
            'x.slice?.(a,b)',
            '[].slice(a,b)',
            '"".slice(a,b)',
        ]) {
            expect(mutate(code)).toHaveLength(0);
        }
    });
    it('retains non-empty literal receivers and witnesses changed slice output', () => {
        expect(mutate('"abc".slice(0,2)')).toHaveLength(1);
        expect('abc'.slice(0, 2)).toBe('ab');
        expect('abc'.slice(2, 0)).toBe('');
    });
});
