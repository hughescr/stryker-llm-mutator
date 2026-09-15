/*
 * Offline unit tests for the DefaultParamValueTweak heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert the numeric / bool
 * / string default tweaks, the already-0 and already-empty skips, the
 * non-tweakable-default skip, BigInt exclusion, destructuring-default match, and
 * that non-AssignmentPattern nodes yield nothing. Pure AST.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    type BooleanLiteral,
    isBooleanLiteral,
    isNumericLiteral,
    isStringLiteral,
    type Node,
    type NumericLiteral,
    type StringLiteral,
} from '@babel/types';

import { defaultParamValueTweakMutator } from '../../src/mutators/default-param-value-tweak';
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

/** Collect the literal replacements for the first default-value literal in `code`. */
function mutate(code: string): Node[] {
    const path = firstPath(
        code,
        p => p.isNumericLiteral() || p.isBooleanLiteral() || p.isStringLiteral(),
    );
    return [...defaultParamValueTweakMutator.mutate(path)];
}

/** Describe a yielded replacement literal. */
function rightValue(node: Node): number | boolean | string {
    if (isNumericLiteral(node)) {
        return (node as NumericLiteral).value;
    }
    if (isBooleanLiteral(node)) {
        return (node as BooleanLiteral).value;
    }
    if (isStringLiteral(node)) {
        return JSON.stringify((node as StringLiteral).value);
    }
    return 'other';
}

describe('defaultParamValueTweakMutator', () => {
    it('has the Stryker-facing name "DefaultParamValueTweak"', () => {
        expect(defaultParamValueTweakMutator.name).toBe('DefaultParamValueTweak');
    });

    it('tweaks a numeric default to +1, -1, and 0 (`function f(a = 5)`)', () => {
        const out = mutate('function f(a = 5) {}');
        expect(out.map(rightValue)).toEqual([6, 4, 0]);
    });

    it('skips the 0 variant when the numeric default is already 0 (`a = 0`)', () => {
        const out = mutate('function f(a = 0) {}');
        expect(out.map(rightValue)).toEqual([1, -1]);
    });

    it('targets only the AssignmentPattern right literal, not the enclosing binding', () => {
        const assignment = firstPath('function f(a = 5) {}', p => p.isAssignmentPattern());
        expect([...defaultParamValueTweakMutator.mutate(assignment)]).toHaveLength(0);
    });

    it('flips a boolean default (`function f(a = true)` → `a = false`)', () => {
        const out = mutate('function f(a = true) {}');
        expect(out).toHaveLength(1);
        expect(rightValue(out[0]!)).toBe(false);
    });

    it('flips a false default to true', () => {
        const out = mutate('function f(a = false) {}');
        expect(out.map(rightValue)).toEqual([true]);
    });

    it('empties a non-empty string default (`a = "x"` → `a = ""`)', () => {
        const out = mutate('function f(a = "x") {}');
        expect(out.map(rightValue)).toEqual(['""']);
    });

    it('skips a default that is already the empty string (`a = ""`)', () => {
        expect(mutate('function f(a = "") {}')).toHaveLength(0);
    });

    it('skips a non-literal default (`a = compute()`)', () => {
        const path = firstPath('function f(a = compute()) {}', p => p.isAssignmentPattern());
        expect([...defaultParamValueTweakMutator.mutate(path)]).toHaveLength(0);
    });

    it('skips an identifier default (`a = DEFAULT`)', () => {
        const path = firstPath('function f(a = DEFAULT) {}', p => p.isAssignmentPattern());
        expect([...defaultParamValueTweakMutator.mutate(path)]).toHaveLength(0);
    });

    it('does NOT tweak a BigInt default (`a = 5n` — BigIntLiteral, not NumericLiteral)', () => {
        const path = firstPath('function f(a = 5n) {}', p => p.isBigIntLiteral());
        expect([...defaultParamValueTweakMutator.mutate(path)]).toHaveLength(0);
    });

    it('matches a destructuring default (`{ a = 5 } = {}`)', () => {
        // Two AssignmentPatterns exist: the outer `{ a = 5 } = {}` (right is `{}`,
        // not tweakable) and the inner `a = 5` (numeric). Target the inner one
        // directly — its `right` is the NumericLiteral 5.
        const path = firstPath('function f({ a = 5 } = {}) {}', p => p.isNumericLiteral());
        const out = [...defaultParamValueTweakMutator.mutate(path)];
        expect(out.map(rightValue)).toEqual([6, 4, 0]);
    });

    it('does not tweak the OUTER destructuring pattern whose default is `{}`', () => {
        // `{ a = 5 } = {}` outer: right is an ObjectExpression, not a literal → skip.
        const path = firstPath('function f({ a = 5 } = {}) {}', p => p.isAssignmentPattern());
        expect([...defaultParamValueTweakMutator.mutate(path)]).toHaveLength(0);
    });

    it('yields nothing for a non-AssignmentPattern node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...defaultParamValueTweakMutator.mutate(path)]).toHaveLength(0);
    });
});
