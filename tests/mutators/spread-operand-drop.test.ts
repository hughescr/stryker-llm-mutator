/*
 * Offline unit tests for the SpreadOperandDrop heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert that each object
 * spread is dropped (one mutant per spread, the others preserved), that
 * spread-free objects and array/call spreads are not matched, and that non-object
 * nodes yield nothing. Pure AST — no network, no Stryker process.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    isObjectExpression,
    isObjectProperty,
    isSpreadElement,
    type Node,
    type ObjectExpression,
} from '@babel/types';

import { spreadOperandDropMutator } from '../../src/mutators/spread-operand-drop';
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

/** Collect the yielded replacement nodes for the first object expression in `code`. */
function mutate(code: string): Node[] {
    const path = firstPath(code, p => p.isObjectExpression());
    return [...spreadOperandDropMutator.mutate(path)];
}

/** Count spreads vs non-spread properties of a yielded ObjectExpression. */
function shape(node: Node): { spreads: number; props: number } {
    expect(isObjectExpression(node)).toBe(true);
    const { properties } = node as ObjectExpression;
    return {
        spreads: properties.filter(p => isSpreadElement(p)).length,
        props: properties.filter(p => isObjectProperty(p)).length,
    };
}

describe('spreadOperandDropMutator', () => {
    it('has the Stryker-facing name "SpreadOperandDrop"', () => {
        expect(spreadOperandDropMutator.name).toBe('SpreadOperandDrop');
    });

    it('drops the single object spread (`{ ...a, b: 1 }` → `{ b: 1 }`)', () => {
        const out = mutate('const x = { ...a, b: 1 };');
        expect(out).toHaveLength(1);
        expect(shape(out[0]!)).toEqual({ spreads: 0, props: 1 });
    });

    it('yields one mutant per spread, dropping exactly one each (`{ ...a, ...b, c: 1 }`)', () => {
        const out = mutate('const x = { ...a, ...b, c: 1 };');
        expect(out).toHaveLength(2);
        // Each variant has exactly one spread remaining and the `c: 1` prop kept.
        for (const node of out) {
            expect(shape(node)).toEqual({ spreads: 1, props: 1 });
        }
    });

    it('drops an only-spread object to empty (`{ ...a }` → `{}`)', () => {
        const out = mutate('const x = { ...a };');
        expect(out).toHaveLength(1);
        expect(shape(out[0]!)).toEqual({ spreads: 0, props: 0 });
    });

    it('yields nothing for a spread-free object (`{ a: 1, b: 2 }`)', () => {
        expect(mutate('const x = { a: 1, b: 2 };')).toHaveLength(0);
    });

    it('does NOT match an array spread (`[...a]` is a SpreadElement in an ArrayExpression)', () => {
        // No ObjectExpression here; assert the traversal finds none.
        const ast = parse('const x = [...a, 1];', { configFile: false, babelrc: false });
        let sawObject = false;
        traverse(ast, {
            enter(path: NodePath) {
                if (path.isObjectExpression()) {
                    sawObject = true;
                }
            },
        });
        expect(sawObject).toBe(false);
    });

    it('does NOT match a call-arg spread (`fn(...a, b)`)', () => {
        const ast = parse('fn(...a, b);', { configFile: false, babelrc: false });
        let sawObject = false;
        traverse(ast, {
            enter(path: NodePath) {
                if (path.isObjectExpression()) {
                    sawObject = true;
                }
            },
        });
        expect(sawObject).toBe(false);
    });

    it('yields nothing for a non-object node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...spreadOperandDropMutator.mutate(path)]).toHaveLength(0);
    });
});
