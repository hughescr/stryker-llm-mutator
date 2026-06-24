/*
 * Offline unit tests for the OptionalChainForce heuristic mutator.
 *
 * Driven exactly as Stryker's `transformBabel` does: parse a snippet, `traverse`
 * to obtain a real `NodePath`, call `*mutate(path)`. We assert the replacement is
 * an OptionalMemberExpression (optional: true) preserving object/property/computed,
 * across standalone / chained / callee / computed / this-member forms, that
 * already-optional members are not matched, and that non-member nodes yield
 * nothing. Pure AST — no network, no Stryker process.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    type Identifier,
    isIdentifier,
    isOptionalMemberExpression,
    type Node,
    type OptionalMemberExpression,
} from '@babel/types';

import { optionalChainForceMutator } from '../../src/mutators/optional-chain-force';
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

/** Collect the yielded replacement nodes for the first (plain) member in `code`. */
function mutate(code: string): Node[] {
    const path = firstPath(code, p => p.isMemberExpression());
    return [...optionalChainForceMutator.mutate(path)];
}

/** The single yielded OptionalMemberExpression (asserting type + optionality). */
function optionalMember(code: string): OptionalMemberExpression {
    const out = mutate(code);
    expect(out).toHaveLength(1);
    expect(isOptionalMemberExpression(out[0]!)).toBe(true);
    const member = out[0] as OptionalMemberExpression;
    expect(member.optional).toBe(true);
    return member;
}

describe('optionalChainForceMutator', () => {
    it('has the Stryker-facing name "OptionalChainForce"', () => {
        expect(optionalChainForceMutator.name).toBe('OptionalChainForce');
    });

    it('forces `a.b` → `a?.b` (non-computed)', () => {
        const member = optionalMember('const x = a.b;');
        expect(member.computed).toBe(false);
        expect(isIdentifier(member.property) && (member.property as Identifier).name === 'b').toBe(
            true,
        );
        expect(isIdentifier(member.object) && (member.object as Identifier).name === 'a').toBe(
            true,
        );
    });

    it('forces `a[i]` → `a?.[i]` (computed preserved)', () => {
        const member = optionalMember('const x = a[i];');
        expect(member.computed).toBe(true);
        expect(isIdentifier(member.property) && (member.property as Identifier).name === 'i').toBe(
            true,
        );
    });

    it('forces `this.x` → `this?.x`', () => {
        const member = optionalMember('const x = this.x;');
        expect(member.computed).toBe(false);
        expect(member.object.type).toBe('ThisExpression');
    });

    it('forces the OUTER member of a chain (`a.b.c`, first match is `a.b.c`)', () => {
        // Depth-first enter visits the OUTER member `a.b.c` first.
        const member = optionalMember('const x = a.b.c;');
        expect(member.computed).toBe(false);
        expect(isIdentifier(member.property) && (member.property as Identifier).name === 'c').toBe(
            true,
        );
    });

    it('forces a callee member (`a.b()` → `a?.b`)', () => {
        const member = optionalMember('a.b();');
        expect(isIdentifier(member.property) && (member.property as Identifier).name === 'b').toBe(
            true,
        );
    });

    it('does NOT match an already-optional member (`a?.b` is an OptionalMemberExpression)', () => {
        const ast = parse('const x = a?.b;', { configFile: false, babelrc: false });
        let sawPlainMember = false;
        traverse(ast, {
            enter(path: NodePath) {
                if (path.isMemberExpression()) {
                    sawPlainMember = true;
                }
            },
        });
        expect(sawPlainMember).toBe(false);
    });

    it('skips a private-field member (`this.#x` — property is a PrivateName)', () => {
        // `optionalMemberExpression` cannot build a PrivateName property, so the
        // operator skips it cleanly rather than emitting an invalid node.
        const out = mutate('class C { #x = 1; m() { return this.#x; } }');
        expect(out).toHaveLength(0);
    });

    it('yields nothing for a non-member node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...optionalChainForceMutator.mutate(path)]).toHaveLength(0);
    });

    it('yields nothing for an identifier', () => {
        const path = firstPath(
            'const x = y;',
            p => p.isIdentifier() && (p.node as { name?: string }).name === 'y',
        );
        expect([...optionalChainForceMutator.mutate(path)]).toHaveLength(0);
    });
});
