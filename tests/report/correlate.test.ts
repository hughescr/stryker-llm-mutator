/*
 * Offline unit tests for the shared id→enrichment correlator (used by both the
 * `stryker-llm` CLI driver and the real Reporter plugin).
 *
 * Builds a synthetic LlmMutatorMap + synthetic `MutantResult[]` and asserts:
 *   • only `llm` mutants are correlated (heuristic / built-in are skipped);
 *   • the babel-column conversion (MutantResult 1-based col → map's 0-based col);
 *   • the FIRST entry wins for a multi-candidate span;
 *   • the `llm/<tag>` is split off the entry's mutatorName;
 *   • a result with no matching file or loc yields no enrichment.
 * No Stryker, no network.
 */

import { describe, expect, it } from 'bun:test';
import type { MutantResult } from '@stryker-mutator/api/core';
import type { Node } from '@babel/types';

import { correlateEnrichment } from '../../src/report/correlate';
import {
    type LlmMutatorMap,
    locKeyFromBabelLoc,
    type ParsedEntry,
} from '../../src/pipeline/llm-map';

/** A throwaway babel node — correlate never reads `.node`, only the metadata. */
const FAKE_NODE = {} as Node;

/** Build a synthetic MutantResult with sensible defaults (an `llm` survivor). */
function mutant(over: Partial<MutantResult> & Pick<MutantResult, 'id'>): MutantResult {
    return {
        fileName: '/abs/a.ts',
        mutatorName: 'llm',
        status: 'Survived',
        // 1-based line AND 1-based column (Stryker schema location).
        location: { start: { line: 2, column: 12 }, end: { line: 2, column: 22 } },
        replacement: 'hour > 12',
        ...over,
    } as MutantResult;
}

/** Build a ParsedEntry carrying the enrichment metadata. */
function entry(over: Partial<ParsedEntry>): ParsedEntry {
    return {
        node: FAKE_NODE,
        mutatorName: 'llm/boundary',
        replacement: 'hour > 12',
        original: 'hour >= 12',
        rationale: 'Off-by-one on the afternoon boundary.',
        ...over,
    };
}

/**
 * Build a one-span map for `/abs/a.ts`. The MutantResult location above is 1-based
 * col 12→22; the map key is babel 0-based col, so 11→21.
 */
function mapFor(entries: ParsedEntry[]): LlmMutatorMap {
    const key = locKeyFromBabelLoc({
        start: { line: 2, column: 11 },
        end: { line: 2, column: 21 },
    });
    return new Map([['/abs/a.ts', new Map([[key, entries]])]]);
}

describe('correlateEnrichment', () => {
    it('correlates an llm mutant to its map entry (tag/original/rationale)', () => {
        const map = mapFor([entry({})]);
        const enrichment = correlateEnrichment([mutant({ id: 'm1' })], map);
        expect(enrichment.get('m1')).toEqual({
            original: 'hour >= 12',
            tag: 'boundary',
            rationale: 'Off-by-one on the afternoon boundary.',
        });
    });

    it('skips non-llm mutants (heuristic / built-in)', () => {
        const map = mapFor([entry({})]);
        const enrichment = correlateEnrichment(
            [
                mutant({ id: 'h1', mutatorName: 'NumberLiteralValue' }),
                mutant({ id: 'b1', mutatorName: 'ArithmeticOperator' }),
            ],
            map,
        );
        expect(enrichment.size).toBe(0);
    });

    it('attaches the FIRST entry for a multi-candidate span', () => {
        const map = mapFor([
            entry({ mutatorName: 'llm/first', original: 'A' }),
            entry({ mutatorName: 'llm/second', original: 'B' }),
        ]);
        const enrichment = correlateEnrichment([mutant({ id: 'm1' })], map);
        expect(enrichment.get('m1')?.tag).toBe('first');
        expect(enrichment.get('m1')?.original).toBe('A');
    });

    it('omits the tag when the entry mutatorName has no llm/ prefix', () => {
        const map = mapFor([entry({ mutatorName: 'plain' })]);
        const enrichment = correlateEnrichment([mutant({ id: 'm1' })], map);
        expect(enrichment.get('m1')?.tag).toBeUndefined();
        expect(enrichment.get('m1')?.original).toBe('hour >= 12');
    });

    it('yields no enrichment for an unknown file or unmatched loc', () => {
        const map = mapFor([entry({})]);
        const noFile = correlateEnrichment([mutant({ id: 'x', fileName: '/abs/other.ts' })], map);
        expect(noFile.size).toBe(0);
        const noLoc = correlateEnrichment(
            [
                mutant({
                    id: 'y',
                    location: { start: { line: 99, column: 0 }, end: { line: 99, column: 1 } },
                }),
            ],
            map,
        );
        expect(noLoc.size).toBe(0);
    });

    it('handles an entry with absent original/rationale (omits those keys)', () => {
        const map = mapFor([entry({ original: '', rationale: undefined, mutatorName: 'llm/x' })]);
        const enrichment = correlateEnrichment([mutant({ id: 'm1' })], map);
        const e = enrichment.get('m1');
        expect(e?.tag).toBe('x');
        // original was '' (falsy but defined) — carried through as-is.
        expect(e?.original).toBe('');
        expect(e?.rationale).toBeUndefined();
    });
});
