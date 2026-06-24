/*
 * Offline unit tests for the EarlyReturnInjection heuristic mutator (the only
 * statement-shaped operator). Driven exactly as Stryker's `transformBabel` does:
 * parse a snippet, `traverse` to obtain a real `NodePath` (which DOES populate
 * `parentPath`), call `*mutate(path)`. We assert the two yielded BlockStatement
 * variants (leading `return;` / `return undefined;`), the function-body-only
 * parent guard, the empty-body skip, and the expression-bodied-arrow non-match.
 *
 * PLACEMENT through the REAL instrumenter is verified separately by
 * tests/injection/early-return-placement-proof.test.ts (the statement-shaped
 * canary); these are the pure-AST behavioral tests.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import {
    type BlockStatement,
    type Identifier,
    isBlockStatement,
    isExpressionStatement,
    isIdentifier,
    isReturnStatement,
    type Node,
    type ReturnStatement,
} from '@babel/types';

import { earlyReturnInjectionMutator } from '../../src/mutators/early-return-injection';
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

/**
 * Parse `code`, find the FIRST function-body block (a BlockStatement whose parent
 * is a function), and collect the yielded replacement nodes. This mirrors the
 * mutator's own match so the test exercises a real function-body path with a
 * populated `parentPath`.
 */
function mutateFnBody(code: string): Node[] {
    const path = firstPath(
        code,
        p =>
            p.isBlockStatement() &&
            !!p.parentPath &&
            (p.parentPath.isFunctionDeclaration() ||
                p.parentPath.isFunctionExpression() ||
                p.parentPath.isArrowFunctionExpression() ||
                p.parentPath.isObjectMethod() ||
                p.parentPath.isClassMethod()),
    );
    return [...earlyReturnInjectionMutator.mutate(path)];
}

/** The leading statement of a yielded BlockStatement. */
function head(node: Node): Node {
    expect(isBlockStatement(node)).toBe(true);
    return (node as BlockStatement).body[0]!;
}

describe('earlyReturnInjectionMutator', () => {
    it('has the Stryker-facing name "EarlyReturnInjection"', () => {
        expect(earlyReturnInjectionMutator.name).toBe('EarlyReturnInjection');
    });

    it('prepends `return;` and `return undefined;` to a FunctionDeclaration body', () => {
        const out = mutateFnBody('function f(x) { const y = x + 1; return y; }');
        expect(out).toHaveLength(2);

        // First: bare `return;`.
        const r0 = head(out[0]!) as ReturnStatement;
        expect(isReturnStatement(r0)).toBe(true);
        expect(r0.argument).toBeNull();

        // Second: `return undefined;`.
        const r1 = head(out[1]!) as ReturnStatement;
        expect(isReturnStatement(r1)).toBe(true);
        expect(isIdentifier(r1.argument) && (r1.argument as Identifier).name === 'undefined').toBe(
            true,
        );

        // The original body statements are preserved AFTER the injected return.
        expect((out[0] as BlockStatement).body).toHaveLength(3); // return; + 2 originals
    });

    it('matches a FunctionExpression body', () => {
        const out = mutateFnBody('const f = function (x) { doThing(x); };');
        expect(out).toHaveLength(2);
    });

    it('matches an ArrowFunctionExpression with a BLOCK body', () => {
        const out = mutateFnBody('const f = (x) => { doThing(x); };');
        expect(out).toHaveLength(2);
    });

    it('matches an ObjectMethod body', () => {
        const out = mutateFnBody('const o = { m(x) { doThing(x); } };');
        expect(out).toHaveLength(2);
    });

    it('matches a ClassMethod body', () => {
        const out = mutateFnBody('class C { m(x) { doThing(x); } }');
        expect(out).toHaveLength(2);
    });

    it('does NOT match an expression-bodied arrow (no BlockStatement child)', () => {
        // `x => x + 1` has an expression body — there is no function-body block.
        const ast = parse('const f = (x) => x + 1;', { configFile: false, babelrc: false });
        let sawFnBodyBlock = false;
        traverse(ast, {
            enter(path: NodePath) {
                if (
                    path.isBlockStatement() &&
                    !!path.parentPath &&
                    path.parentPath.isArrowFunctionExpression()
                ) {
                    sawFnBodyBlock = true;
                }
            },
        });
        expect(sawFnBodyBlock).toBe(false);
    });

    it('does NOT match a non-function block (the body of an `if`)', () => {
        // The if-consequent block's parent is the IfStatement, not a function, so
        // the parentPath guard rejects it. We locate it as a BlockStatement whose
        // sole statement is `doThing();` (the if body, NOT the outer function body
        // which also contains the IfStatement).
        const path = firstPath(
            'function f() { if (c) { doThing(); } }',
            p =>
                p.isBlockStatement() &&
                (p.node as BlockStatement).body.length === 1 &&
                isExpressionStatement((p.node as BlockStatement).body[0] as Node),
        );
        expect([...earlyReturnInjectionMutator.mutate(path)]).toHaveLength(0);
    });

    it('skips an EMPTY function body (`function f() {}`)', () => {
        const out = mutateFnBody('function f() {}');
        expect(out).toHaveLength(0);
    });

    it('degrades to a clean no-match when parentPath is absent (synthetic path)', () => {
        // Build a fake BlockStatement path with NO parentPath — the optional-field
        // degradation path. Should yield nothing rather than throw.
        const fake = {
            node: { type: 'BlockStatement', body: [{ type: 'EmptyStatement' }] },
            isBlockStatement: () => true,
            isFunctionDeclaration: () => false,
            isFunctionExpression: () => false,
            isArrowFunctionExpression: () => false,
            isObjectMethod: () => false,
            isClassMethod: () => false,
            stop: () => {},
        } as unknown as NodePath;
        expect([...earlyReturnInjectionMutator.mutate(fake)]).toHaveLength(0);
    });

    it('yields nothing for a non-block node (a numeric literal)', () => {
        const path = firstPath('const x = 42;', p => p.isNumericLiteral());
        expect([...earlyReturnInjectionMutator.mutate(path)]).toHaveLength(0);
    });
});
