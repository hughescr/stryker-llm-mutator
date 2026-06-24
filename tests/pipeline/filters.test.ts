import { describe, expect, it } from 'bun:test';

import type { Replacement, SourceRange } from '../../src/seam/types';

import {
    applyFilters,
    dedupKey,
    dedupReplacements,
    filterIdentical,
    filterUnparseable,
    isParseable,
} from '../../src/pipeline';

const RANGE: SourceRange = {
    start: { line: 0, column: 0 },
    end: { line: 0, column: 5 },
};

/** Build a Replacement with sensible defaults, overriding only what a test cares about. */
function rep(overrides: Partial<Replacement>): Replacement {
    return {
        fileName: 'src/a.ts',
        range: RANGE,
        original: 'a + b',
        replacement: 'a - b',
        mutatorName: 'llm/test',
        ...overrides,
    };
}

describe('isParseable', () => {
    it('accepts a bare expression', () => {
        expect(isParseable('a > b ? 1 : 0')).toBe(true);
    });

    it('accepts a statement-level replacement', () => {
        expect(isParseable('return x + 1;')).toBe(true);
    });

    it('accepts TypeScript syntax', () => {
        expect(isParseable('x as number')).toBe(true);
    });

    it('accepts JSX', () => {
        expect(isParseable('<div className="a">{x}</div>')).toBe(true);
    });

    it('rejects a truncated expression', () => {
        expect(isParseable('a +')).toBe(false);
    });

    it('rejects an unbalanced call', () => {
        expect(isParseable('foo(')).toBe(false);
    });

    it('rejects empty and whitespace-only text', () => {
        expect(isParseable('')).toBe(false);
        expect(isParseable('   \n\t')).toBe(false);
    });
});

describe('filterUnparseable', () => {
    it('drops replacements whose text does not parse, preserving order', () => {
        const input = [
            rep({ replacement: 'a - b' }),
            rep({ replacement: 'a +' }),
            rep({ replacement: 'return 1;' }),
        ];

        const out = filterUnparseable(input);

        expect(out.map(r => r.replacement)).toEqual(['a - b', 'return 1;']);
    });

    it('does not mutate its input', () => {
        const input = [rep({ replacement: 'bad +' })];
        const before = [...input];
        filterUnparseable(input);
        expect(input).toEqual(before);
    });
});

describe('filterIdentical', () => {
    it('drops replacements equal to the original', () => {
        const input = [
            rep({ original: 'a + b', replacement: 'a + b' }),
            rep({ original: 'a + b', replacement: 'a - b' }),
        ];

        const out = filterIdentical(input);

        expect(out).toHaveLength(1);
        expect(out[0]?.replacement).toBe('a - b');
    });

    it('keeps replacements that differ even by whitespace', () => {
        const input = [rep({ original: 'a+b', replacement: 'a + b' })];
        expect(filterIdentical(input)).toHaveLength(1);
    });
});

describe('dedupKey / dedupReplacements', () => {
    it('treats same fileName+range+replacement as identical, ignoring original/mutatorName', () => {
        const a = rep({ original: 'a + b', mutatorName: 'llm/x', rationale: 'r1' });
        const b = rep({ original: 'DIFFERENT', mutatorName: 'llm/y', rationale: 'r2' });
        expect(dedupKey(a)).toBe(dedupKey(b));
    });

    it('produces different keys for different replacement text', () => {
        expect(dedupKey(rep({ replacement: 'a - b' }))).not.toBe(
            dedupKey(rep({ replacement: 'a * b' })),
        );
    });

    it('produces different keys for different ranges', () => {
        const other: SourceRange = {
            start: { line: 1, column: 0 },
            end: { line: 1, column: 5 },
        };
        expect(dedupKey(rep({ range: RANGE }))).not.toBe(dedupKey(rep({ range: other })));
    });

    it('produces different keys for different fileNames', () => {
        expect(dedupKey(rep({ fileName: 'src/a.ts' }))).not.toBe(
            dedupKey(rep({ fileName: 'src/b.ts' })),
        );
    });

    it('collapses duplicates to the first occurrence, preserving order', () => {
        const input = [
            rep({ replacement: 'a - b', mutatorName: 'llm/first' }),
            rep({ replacement: 'a * b' }),
            rep({ replacement: 'a - b', mutatorName: 'llm/dup' }),
        ];

        const out = dedupReplacements(input);

        expect(out.map(r => r.replacement)).toEqual(['a - b', 'a * b']);
        expect(out[0]?.mutatorName).toBe('llm/first');
    });
});

describe('applyFilters', () => {
    it('removes identical, duplicate, and unparseable replacements together', () => {
        const input = [
            rep({ original: 'a + b', replacement: 'a + b' }), // identical -> drop
            rep({ replacement: 'a - b' }), // keep
            rep({ replacement: 'a - b' }), // dup of previous -> drop
            rep({ replacement: 'bad +' }), // unparseable -> drop
            rep({ replacement: 'a * b' }), // keep
        ];

        const out = applyFilters(input);

        expect(out.map(r => r.replacement)).toEqual(['a - b', 'a * b']);
    });

    it('returns an empty array when everything is filtered out', () => {
        const input = [
            rep({ original: 'a + b', replacement: 'a + b' }),
            rep({ replacement: 'still bad +' }),
        ];
        expect(applyFilters(input)).toEqual([]);
    });

    it('returns an empty array for empty input', () => {
        expect(applyFilters([])).toEqual([]);
    });

    it('does not mutate its input', () => {
        const input = [rep({ replacement: 'a - b' }), rep({ replacement: 'a - b' })];
        const before = input.map(r => ({ ...r }));
        applyFilters(input);
        expect(input).toEqual(before);
    });
});
