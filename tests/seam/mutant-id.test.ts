/*
 * Unit tests for the deterministic mutant id (development-plan §4.2 / §7).
 * Verifies the id is a stable, salient-field-only hash: identical inputs ->
 * identical id; any change to fileName / range / replacement -> different id;
 * and id is independent of the non-salient fields (original, mutatorName,
 * rationale). Fully offline.
 */

import { describe, expect, it } from 'bun:test';

import { computeMutantId, type Replacement } from '../../src/seam/index';

const BASE: Replacement = {
    fileName: 'src/math.ts',
    range: { start: { line: 3, column: 4 }, end: { line: 3, column: 9 } },
    original: 'a + b',
    replacement: 'a - b',
    mutatorName: 'LLMArithmeticSwap',
    rationale: 'why',
};

describe('computeMutantId', () => {
    it('is a 64-char lowercase hex SHA-256 digest', () => {
        const id = computeMutantId(BASE);
        expect(id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is identical for identical salient inputs', () => {
        expect(computeMutantId(BASE)).toBe(computeMutantId({ ...BASE }));
    });

    it('ignores non-salient fields (original, mutatorName, rationale)', () => {
        const id = computeMutantId(BASE);
        // Build a full Replacement (a variable, not an inline literal, so excess
        // non-salient fields are allowed) differing ONLY in the ignored fields.
        const reshaped: Replacement = {
            ...BASE,
            original: 'different',
            mutatorName: 'Other',
            rationale: undefined,
        };
        expect(computeMutantId(reshaped)).toBe(id);
    });

    it('changes when fileName changes', () => {
        expect(computeMutantId({ ...BASE, fileName: 'src/other.ts' })).not.toBe(
            computeMutantId(BASE),
        );
    });

    it('changes when replacement changes', () => {
        expect(computeMutantId({ ...BASE, replacement: 'a * b' })).not.toBe(computeMutantId(BASE));
    });

    it('changes when the range changes', () => {
        const moved: Replacement = {
            ...BASE,
            range: { start: { line: 3, column: 4 }, end: { line: 3, column: 10 } },
        };
        expect(computeMutantId(moved)).not.toBe(computeMutantId(BASE));
    });

    it('does not collide between distinct field tuples via concatenation ambiguity', () => {
        const a = computeMutantId({ ...BASE, fileName: 'a b', replacement: 'c' });
        const b = computeMutantId({ ...BASE, fileName: 'a', replacement: 'b c' });
        expect(a).not.toBe(b);
    });
});
