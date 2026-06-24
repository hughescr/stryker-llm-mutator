/*
 * Offline unit tests for the shared replacement-fragment parser.
 *
 * Asserts the parens-wrap parses the expression shapes the worker handles
 * (conditional / binary / object / logical / call / TS-cast) into the right node
 * kind, returns a FRESH node per call (distinct identity), and returns
 * `undefined` (not throw) for statement-shaped / invalid fragments so the
 * map-builder can drop-and-log. No network, no Stryker — pure AST.
 */

import { describe, expect, it } from 'bun:test';
import {
    isBinaryExpression,
    isCallExpression,
    isConditionalExpression,
    isLogicalExpression,
    isObjectExpression,
    isTSAsExpression,
} from '@babel/types';

import { parseReplacementFragment } from '../../src/pipeline/parse-fragment';

describe('parseReplacementFragment', () => {
    it('parses a conditional expression', () => {
        const node = parseReplacementFragment('a > b ? 1 : 0');
        expect(node).toBeDefined();
        expect(isConditionalExpression(node!)).toBe(true);
    });

    it('parses a binary expression', () => {
        expect(isBinaryExpression(parseReplacementFragment('i + 1')!)).toBe(true);
    });

    it('parses a bare object literal (the parens-wrap is what makes this an expression)', () => {
        expect(isObjectExpression(parseReplacementFragment('{ a: 1, b: 2 }')!)).toBe(true);
    });

    it('parses a logical (nullish) expression', () => {
        expect(isLogicalExpression(parseReplacementFragment('x ?? y')!)).toBe(true);
    });

    it('parses a multi-arg call expression', () => {
        expect(isCallExpression(parseReplacementFragment('foo(a, b)')!)).toBe(true);
    });

    it('parses a TypeScript "as" cast', () => {
        expect(isTSAsExpression(parseReplacementFragment('x as T')!)).toBe(true);
    });

    it('returns a FRESH node per call (distinct identity)', () => {
        const a = parseReplacementFragment('i + 1');
        const b = parseReplacementFragment('i + 1');
        expect(a).not.toBe(b);
    });

    it('returns undefined (not throw) for a statement-shaped fragment', () => {
        expect(parseReplacementFragment('return x;')).toBeUndefined();
    });

    it('returns undefined (not throw) for syntactically invalid text', () => {
        expect(parseReplacementFragment('a +')).toBeUndefined();
    });
});
