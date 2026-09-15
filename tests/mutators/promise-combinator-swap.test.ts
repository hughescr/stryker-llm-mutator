import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import { type CallExpression, isIdentifier, isMemberExpression, type Node } from '@babel/types';
import { promiseCombinatorSwapMutator } from '../../src/mutators/promise-combinator-swap';
import type { NodePath } from '../../src/mutators/types';

const { parse, traverse } = babel as {
    parse(code: string, opts?: object): unknown;
    traverse(ast: unknown, v: { enter(path: NodePath): void }): void;
};
function mutate(code: string): Node[] {
    const ast = parse(code, {
        sourceType: 'module',
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
    return [...promiseCombinatorSwapMutator.mutate(found)];
}
function method(n: Node) {
    const c = (n as CallExpression).callee;
    return isMemberExpression(c) && isIdentifier(c.property) ? c.property.name : '';
}
describe('promiseCombinatorSwapMutator', () => {
    it('swaps unshadowed, discarded awaited global Promise calls', () =>
        expect(mutate('async function f(){ await Promise.all(xs); }').map(method).sort()).toEqual([
            'allSettled',
            'race',
        ]));
    it('keeps the small reverse table', () => {
        for (const name of ['allSettled', 'race', 'any']) {
            expect(mutate(`async function f(){ await Promise.${name}(xs); }`).map(method)).toEqual([
                'all',
            ]);
        }
    });
    it('skips consumed, chained, unawaited, computed, optional, and known equivalent calls', () => {
        for (const code of [
            'async function f(){const x=await Promise.all(xs)}',
            'async function f(){return await Promise.all(xs)}',
            'async function f(){g(await Promise.all(xs))}',
            'async function f(){await Promise.all(xs).then(g)}',
            'async function f(){Promise.all(xs)}',
            'async function f(){await Promise["all"](xs)}',
            'async function f(){await Promise?.all(xs)}',
            'async function f(){await Promise.all?.(xs)}',
            'async function f(){await Promise.all([])}',
            'async function f(){await Promise.race([x])}',
        ]) {
            expect(mutate(code)).toHaveLength(0);
        }
    });
    it('retains rejection-changing all-to-allSettled for a singleton', () =>
        expect(mutate('async function f(){await Promise.all([x])}').map(method)).toEqual([
            'allSettled',
        ]));
    it('skips parameter, local, and import bindings named Promise', () => {
        for (const code of [
            'async function f(Promise){await Promise.all(xs)}',
            'async function f(){const Promise=P;await Promise.all(xs)}',
            'import Promise from "p"; async function f(){await Promise.all(xs)}',
        ]) {
            expect(mutate(code)).toHaveLength(0);
        }
    });
    it('has observable completion-semantics behavior', async () => {
        let slowDone = false;
        const slow = new Promise<number>(resolve => {
            setTimeout(() => {
                slowDone = true;
                resolve(2);
            }, 5);
        });
        await Promise.race([Promise.resolve(1), slow]);
        expect(slowDone).toBe(false);
        await Promise.all([slow, Promise.resolve(3)]);
        expect(slowDone).toBe(true);
    });
});
