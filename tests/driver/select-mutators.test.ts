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
        expect(result.mutators).toHaveLength(14);
        expect(result.unimplemented).toEqual([]);
    });

    it('ships the full P1–P4 catalog as the registered set, in priority order', () => {
        expect(ALL_NAMES).toEqual([
            // P1
            'NumberLiteralValue',
            'BoundaryOffByOne',
            'FallbackOperandSubstitution',
            // P2
            'ComparisonBoundaryShift',
            'CallArgumentTweak',
            'AwaitDrop',
            // P3
            'EarlyReturnInjection',
            'SpreadOperandDrop',
            'ArrayMethodSwap',
            'PromiseCombinatorSwap',
            // P4
            'DefaultParamValueTweak',
            'OptionalChainForce',
            'StringMethodArgSwap',
            'TernaryBranchSwap',
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

    it('selects multiple operators across priorities, preserving barrel order', () => {
        const result = selectHeuristicMutators(
            heuristics({ operators: ['AwaitDrop', 'NumberLiteralValue', 'TernaryBranchSwap'] }),
        );
        expect(result.mutators.map(m => m.name)).toEqual([
            'NumberLiteralValue',
            'AwaitDrop',
            'TernaryBranchSwap',
        ]);
        expect(result.unimplemented).toEqual([]);
    });

    it('collects a requested-but-unregistered operator into `unimplemented`', () => {
        // Every enum name in the full P1–P4 catalog is now registered, so a config
        // can no longer name a valid-but-unshipped operator. The `unimplemented`
        // path remains live for forward-compat (a future enum entry added before
        // its mutator), so we exercise it by forcing a name that is not in the
        // registry. The selection still returns the implemented ones in order.
        const result = selectHeuristicMutators({
            enabled: true,
            operators: ['NumberLiteralValue', 'NotAShippedOperator'],
            skipUncovered: true,
        } as unknown as LlmMutatorConfig['heuristics']);
        expect(result.mutators.map(m => m.name)).toEqual(['NumberLiteralValue']);
        // `unimplemented` is typed as HeuristicOperatorName[]; the forced unknown
        // name is not a member of that union, so compare on the string values.
        expect(result.unimplemented.map(String)).toEqual(['NotAShippedOperator']);
    });

    it('returns no mutators (all unregistered) when only unknown operators are requested', () => {
        const result = selectHeuristicMutators({
            enabled: true,
            operators: ['NotAShippedOperator', 'AlsoNotShipped'],
            skipUncovered: true,
        } as unknown as LlmMutatorConfig['heuristics']);
        expect(result.mutators).toEqual([]);
        expect(result.unimplemented.map(String)).toEqual(['NotAShippedOperator', 'AlsoNotShipped']);
    });
});
