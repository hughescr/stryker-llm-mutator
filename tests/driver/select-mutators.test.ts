/*
 * Offline unit tests for `selectHeuristicMutators` (functional-architecture §6).
 * Pure config → NodeMutator[] selection: disabled → [], empty allow-list → all,
 * allow-list filtering (with stable order), and unknown/unimplemented operator
 * handling. No Stryker import, no network.
 */

import { describe, expect, it } from 'bun:test';

import { llmMutatorConfigSchema, type LlmMutatorConfig } from '../../src/config';
import { selectHeuristicMutators } from '../../src/driver/select-mutators';
import { heuristicMutators } from '../../src/mutators/index';

/** Parse a partial `heuristics` block into the fully-defaulted config sub-block. */
function heuristics(partial: Record<string, unknown>): LlmMutatorConfig['heuristics'] {
    return llmMutatorConfigSchema.parse({ heuristics: partial }).heuristics;
}

const ALL_NAMES = heuristicMutators.map(m => m.name);

describe('selectHeuristicMutators', () => {
    it('returns [] when heuristics are disabled', () => {
        const result = selectHeuristicMutators(heuristics({ enabled: false }));
        expect(result.mutators).toEqual([]);
        expect(result.unimplemented).toEqual([]);
    });

    it('returns ALL registered heuristics for an empty allow-list', () => {
        const result = selectHeuristicMutators(heuristics({ operators: [] }));
        expect(result.mutators.map(m => m.name)).toEqual(ALL_NAMES);
        expect(result.mutators).toHaveLength(3);
        expect(result.unimplemented).toEqual([]);
    });

    it('ships the P1 trio as the registered set', () => {
        expect(ALL_NAMES).toEqual([
            'NumberLiteralValue',
            'BoundaryOffByOne',
            'FallbackOperandSubstitution',
        ]);
    });

    it('filters to only the named operators, preserving barrel order', () => {
        // Request them out of barrel order; selection must restore barrel order.
        const result = selectHeuristicMutators(
            heuristics({ operators: ['FallbackOperandSubstitution', 'NumberLiteralValue'] }),
        );
        expect(result.mutators.map(m => m.name)).toEqual([
            'NumberLiteralValue',
            'FallbackOperandSubstitution',
        ]);
        expect(result.unimplemented).toEqual([]);
    });

    it('selects a single operator when only one is named', () => {
        const result = selectHeuristicMutators(heuristics({ operators: ['BoundaryOffByOne'] }));
        expect(result.mutators.map(m => m.name)).toEqual(['BoundaryOffByOne']);
    });

    it('collects requested-but-unimplemented operators (a not-yet-shipped catalog entry)', () => {
        // `AwaitDrop` is a valid enum name but has no mutator yet (P2, not shipped).
        const result = selectHeuristicMutators(
            heuristics({ operators: ['NumberLiteralValue', 'AwaitDrop'] }),
        );
        expect(result.mutators.map(m => m.name)).toEqual(['NumberLiteralValue']);
        expect(result.unimplemented).toEqual(['AwaitDrop']);
    });

    it('returns no mutators (all unimplemented) when only unshipped operators are requested', () => {
        const result = selectHeuristicMutators(
            heuristics({ operators: ['AwaitDrop', 'ArrayMethodSwap'] }),
        );
        expect(result.mutators).toEqual([]);
        expect(result.unimplemented).toEqual(['AwaitDrop', 'ArrayMethodSwap']);
    });
});
