/*
 * Offline unit tests for the FallbackOperandSubstitution heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert each yielded node
 * is a LogicalExpression of the SAME operator and left operand with the right
 * operand swapped for one of `undefined` / `null` / `0` / `''`, that `&&` is
 * skipped, that the equivalent-skip guards fire, and that non-matching nodes
 * yield nothing. Pure AST — no network, no Stryker process.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    type Identifier,
    isIdentifier,
    isLogicalExpression,
    isNullLiteral,
    isNumericLiteral,
    isStringLiteral,
    type LogicalExpression,
    type Node,
    type NumericLiteral,
    type StringLiteral,
} from '@babel/types';

import { fallbackOperandSubstitutionMutator } from '../../src/mutators/fallback-operand-substitution';
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

/** Collect the yielded replacement nodes for the logical expression in `code`. */
function mutate(code: string): Node[] {
    const path = firstPath(code, p => p.isLogicalExpression());
    return [...fallbackOperandSubstitutionMutator.mutate(path)];
}

/** Describe the kind of empty value a yielded LogicalExpression's right operand is. */
function rightKind(node: Node): string {
    expect(isLogicalExpression(node)).toBe(true);
    const { right } = node as LogicalExpression;
    if (isIdentifier(right) && (right as Identifier).name === 'undefined') {
        return 'undefined';
    }
    if (isNullLiteral(right)) {
        return 'null';
    }
    if (isNumericLiteral(right) && (right as NumericLiteral).value === 0) {
        return '0';
    }
    if (isStringLiteral(right) && (right as StringLiteral).value === '') {
        return "''";
    }
    return 'other';
}

describe('fallbackOperandSubstitutionMutator', () => {
    it('has the Stryker-facing name "FallbackOperandSubstitution"', () => {
        expect(fallbackOperandSubstitutionMutator.name).toBe('FallbackOperandSubstitution');
    });

    it('yields undefined / null / 0 / "" (in order) for a `??` fallback', () => {
        const out = mutate('const x = a ?? duration;');
        expect(out).toHaveLength(4);
        expect(out.map(rightKind)).toEqual(['undefined', 'null', '0', "''"]);
        // Operator and left operand preserved on each replacement.
        for (const node of out) {
            const logical = node as LogicalExpression;
            expect(logical.operator).toBe('??');
            expect(isIdentifier(logical.left) && (logical.left as Identifier).name === 'a').toBe(
                true,
            );
        }
    });

    it('also fires on `||` with the same four replacements', () => {
        const out = mutate("const x = name || 'anon';");
        expect(out).toHaveLength(4);
        expect((out[0] as LogicalExpression).operator).toBe('||');
        expect(out.map(rightKind)).toEqual(['undefined', 'null', '0', "''"]);
    });

    it('skips `&&` entirely', () => {
        expect(mutate('const x = a && b;')).toHaveLength(0);
    });

    it('skips the `undefined` variant when the fallback is already `undefined`', () => {
        const out = mutate('const x = a ?? undefined;');
        // 3 remain: null / 0 / ''.
        expect(out.map(rightKind)).toEqual(['null', '0', "''"]);
    });

    it('skips the `null` variant when the fallback is already `null`', () => {
        const out = mutate('const x = a ?? null;');
        expect(out.map(rightKind)).toEqual(['undefined', '0', "''"]);
    });

    it('skips the `0` variant when the fallback is already `0`', () => {
        const out = mutate('const x = a ?? 0;');
        expect(out.map(rightKind)).toEqual(['undefined', 'null', "''"]);
    });

    it("skips the `''` variant when the fallback is already the empty string", () => {
        const out = mutate("const x = a ?? '';");
        expect(out.map(rightKind)).toEqual(['undefined', 'null', '0']);
    });

    it('does NOT skip a non-empty string fallback', () => {
        const out = mutate("const x = a ?? 'fallback';");
        expect(out).toHaveLength(4);
    });

    it('does NOT skip a non-zero numeric fallback', () => {
        const out = mutate('const x = a ?? 5;');
        expect(out).toHaveLength(4);
    });

    it('does NOT skip a non-undefined identifier fallback', () => {
        const out = mutate('const x = a ?? fallbackVar;');
        expect(out).toHaveLength(4);
    });

    it('reuses the left operand even when it is a complex expression (`a.b.c ?? d`)', () => {
        const out = mutate('const x = a.b.c ?? d;');
        expect(out).toHaveLength(4);
        // Left operand is preserved structurally (a MemberExpression, not mutated).
        expect(isLogicalExpression(out[0])).toBe(true);
    });

    it('yields nothing for a non-logical node (a binary expression `a + b`)', () => {
        const path = firstPath('const x = a + b;', p => p.isBinaryExpression());
        expect([...fallbackOperandSubstitutionMutator.mutate(path)]).toHaveLength(0);
    });

    it('yields nothing for a numeric literal', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...fallbackOperandSubstitutionMutator.mutate(path)]).toHaveLength(0);
    });
});
