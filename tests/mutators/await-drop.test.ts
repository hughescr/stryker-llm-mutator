/*
 * Offline unit tests for the AwaitDrop heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert the single yielded
 * node is the bare argument expression (the `await` dropped), and that
 * non-await nodes yield nothing. Pure AST — no network, no Stryker process.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    type CallExpression,
    type Identifier,
    isCallExpression,
    isIdentifier,
    type Node,
} from '@babel/types';

import { awaitDropMutator } from '../../src/mutators/await-drop';
import type { NodePath } from '../../src/mutators/types';

const { parse, traverse } = babel as {
    parse: (code: string, opts?: object) => unknown;
    traverse: (ast: unknown, visitor: { enter(path: NodePath): void }) => void;
};

/** Parse `code` (as a module, for top-level await) and return the FIRST matching path. */
function firstPath(code: string, predicate: (path: NodePath) => boolean): NodePath {
    const ast = parse(code, { configFile: false, babelrc: false, sourceType: 'module' });
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

/** Collect the yielded replacement nodes for the first await expression in `code`. */
function mutate(code: string): Node[] {
    const path = firstPath(code, p => p.isAwaitExpression());
    return [...awaitDropMutator.mutate(path)];
}

describe('awaitDropMutator', () => {
    it('has the Stryker-facing name "AwaitDrop"', () => {
        expect(awaitDropMutator.name).toBe('AwaitDrop');
    });

    it('drops the await, yielding the bare call argument (`await g(1)` → `g(1)`)', () => {
        const out = mutate('async function f() { return await g(1); }');
        expect(out).toHaveLength(1);
        const call = out[0] as CallExpression;
        expect(isCallExpression(call)).toBe(true);
        expect(isIdentifier(call.callee) && (call.callee as Identifier).name === 'g').toBe(true);
    });

    it('yields the ORIGINAL argument node instance (reused, not rebuilt)', () => {
        const path = firstPath('async function f() { return await g(1); }', p =>
            p.isAwaitExpression(),
        );
        const original = (path.node as { argument: Node }).argument;
        const out = [...awaitDropMutator.mutate(path)];
        expect(out[0]).toBe(original);
    });

    it('drops the await on an identifier operand (`await p` → `p`)', () => {
        const out = mutate('async function f() { return await p; }');
        expect(out).toHaveLength(1);
        expect(isIdentifier(out[0]!) && (out[0] as Identifier).name === 'p').toBe(true);
    });

    it('handles top-level await in a module (`await load()` → `load()`)', () => {
        const out = mutate('export const x = await load();');
        expect(out).toHaveLength(1);
        expect(isCallExpression(out[0]!)).toBe(true);
    });

    it('does NOT match `for await … of` (a ForOfStatement with an await flag)', () => {
        // There is no AwaitExpression node here, so firstPath would throw; assert
        // the traversal finds no AwaitExpression at all.
        const ast = parse('async function f() { for await (const x of xs) {} }', {
            configFile: false,
            babelrc: false,
            sourceType: 'module',
        });
        let sawAwaitExpr = false;
        traverse(ast, {
            enter(path: NodePath) {
                if (path.isAwaitExpression()) {
                    sawAwaitExpr = true;
                }
            },
        });
        expect(sawAwaitExpr).toBe(false);
    });

    it('yields nothing for a non-await node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...awaitDropMutator.mutate(path)]).toHaveLength(0);
    });

    it('yields nothing for a plain call expression (no await)', () => {
        const path = firstPath('const x = g(1);', p => p.isCallExpression());
        expect([...awaitDropMutator.mutate(path)]).toHaveLength(0);
    });
});
