/*
 * Offline unit tests for the runtime-state singleton (M6 wrapper→reporter hand-off).
 *
 * Asserts the empty initial shape, that setRunCost/setRunMap mutate the SAME shared
 * record (not a copy), and that resetRuntimeState clears both cost and map. No
 * Stryker, no network.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { getRuntimeState, resetRuntimeState, setRunCost, setRunMap } from '../src/runtime-state';
import type { LlmMutatorMap } from '../src/pipeline/llm-map';

afterEach(() => {
    // Always leave the singleton clean so test order does not matter.
    resetRuntimeState();
});

describe('runtime-state singleton', () => {
    it('starts (or resets) to an empty cost + absent map', () => {
        resetRuntimeState();
        const state = getRuntimeState();
        expect(state.cost).toEqual({ totalUsd: 0, calls: 0 });
        expect(state.map).toBeUndefined();
    });

    it('setRunCost mutates the SAME shared record getRuntimeState returns', () => {
        const before = getRuntimeState();
        setRunCost({ totalUsd: 1.23, calls: 7 });
        // getRuntimeState returns the live record, so the prior reference sees it too.
        expect(getRuntimeState().cost).toEqual({ totalUsd: 1.23, calls: 7 });
        expect(before.cost).toEqual({ totalUsd: 1.23, calls: 7 });
    });

    it('setRunMap stashes the precomputed map for the reporter', () => {
        const map: LlmMutatorMap = new Map([['/abs/a.ts', new Map()]]);
        setRunMap(map);
        expect(getRuntimeState().map).toBe(map);
    });

    it('resetRuntimeState clears both cost and map', () => {
        setRunCost({ totalUsd: 9.99, calls: 3 });
        setRunMap(new Map());
        resetRuntimeState();
        const state = getRuntimeState();
        expect(state.cost).toEqual({ totalUsd: 0, calls: 0 });
        expect(state.map).toBeUndefined();
    });
});
