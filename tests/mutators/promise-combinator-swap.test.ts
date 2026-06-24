/*
 * Offline unit tests for the PromiseCombinatorSwap heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert the combinator
 * swaps (all→{allSettled,race}, allSettled→{all}, race→{all}, any→{all}), that the
 * `Promise` receiver + args are reused, that non-`Promise` objects / computed
 * access / unknown combinators are skipped, and that non-call nodes yield nothing.
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

import { promiseCombinatorSwapMutator } from '../../src/mutators/promise-combinator-swap';
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
    return [...promiseCombinatorSwapMutator.mutate(path)];
}

/** The swapped combinator name of a yielded `Promise.<name>(…)` call. */
function combinatorName(node: Node): string {
    expect(isCallExpression(node)).toBe(true);
    const { callee } = node as CallExpression;
    expect(isMemberExpression(callee)).toBe(true);
    const member = callee as MemberExpression;
    expect(isIdentifier(member.object) && (member.object as Identifier).name === 'Promise').toBe(
        true,
    );
    return (member.property as Identifier).name;
}

describe('promiseCombinatorSwapMutator', () => {
    it('has the Stryker-facing name "PromiseCombinatorSwap"', () => {
        expect(promiseCombinatorSwapMutator.name).toBe('PromiseCombinatorSwap');
    });

    it('swaps Promise.all to allSettled AND race', () => {
        const out = mutate('Promise.all(xs);');
        expect(out.map(combinatorName).sort()).toEqual(['allSettled', 'race']);
    });

    it('swaps Promise.allSettled to all', () => {
        const out = mutate('Promise.allSettled(xs);');
        expect(out.map(combinatorName)).toEqual(['all']);
    });

    it('swaps Promise.race to all', () => {
        const out = mutate('Promise.race(xs);');
        expect(out.map(combinatorName)).toEqual(['all']);
    });

    it('swaps Promise.any to all', () => {
        const out = mutate('Promise.any(xs);');
        expect(out.map(combinatorName)).toEqual(['all']);
    });

    it('reuses the Promise receiver and arguments unchanged', () => {
        const path = firstPath('Promise.all(xs);', p => p.isCallExpression());
        const original = path.node as CallExpression;
        const originalObject = (original.callee as MemberExpression).object;
        const out = [...promiseCombinatorSwapMutator.mutate(path)];
        for (const node of out) {
            const call = node as CallExpression;
            expect((call.callee as MemberExpression).object).toBe(originalObject);
            expect(call.arguments).toHaveLength(1);
            expect((call.callee as MemberExpression).computed).toBe(false);
        }
    });

    it('skips a non-Promise object (`P.all(xs)`)', () => {
        expect(mutate('P.all(xs);')).toHaveLength(0);
    });

    it('skips an unknown Promise method (`Promise.resolve(x)`)', () => {
        expect(mutate('Promise.resolve(x);')).toHaveLength(0);
    });

    it('skips computed access (`Promise["all"](xs)`)', () => {
        expect(mutate('Promise["all"](xs);')).toHaveLength(0);
    });

    it('yields nothing for a non-call node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...promiseCombinatorSwapMutator.mutate(path)]).toHaveLength(0);
    });
});
