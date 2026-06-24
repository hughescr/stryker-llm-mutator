/*
 * Offline unit tests for the real Stryker Reporter plugin (`llm-mutator`).
 *
 * Asserts the plugin declaration (kind/name/factory), and the runtime behavior:
 * collect `MutantResult`s via `onMutantTested`, then at `onMutationTestReportReady`
 * render OUR survivor + summary via the injected logger — reading cost/map from the
 * runtime-state singleton the wrapper would have populated. Also asserts the
 * heuristics-only path (no map → no enrichment, $0.00 cost) and that the singleton
 * is reset afterward. No Stryker run, no network.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { PluginKind } from '@stryker-mutator/api/plugin';
import type { MutantResult } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import type { Node } from '@babel/types';

import {
    LLM_MUTATOR_REPORTER_NAME,
    llmMutatorReporterPlugin,
} from '../../src/report/reporter-plugin';
import {
    type LlmMutatorMap,
    locKeyFromBabelLoc,
    type ParsedEntry,
} from '../../src/pipeline/llm-map';
import { getRuntimeState, resetRuntimeState, setRunCost, setRunMap } from '../../src/runtime-state';

afterEach(() => {
    resetRuntimeState();
});

/** A logger stub that records every `info` line. */
function makeLogger(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    const noop = (): void => {};
    const logger = {
        isTraceEnabled: () => false,
        isDebugEnabled: () => false,
        isInfoEnabled: () => true,
        isWarnEnabled: () => false,
        isErrorEnabled: () => false,
        isFatalEnabled: () => false,
        trace: noop,
        debug: noop,
        info: (message: string) => {
            lines.push(message);
        },
        warn: noop,
        error: noop,
        fatal: noop,
    } as Logger;
    return { logger, lines };
}

/** Build a synthetic MutantResult (an `llm` survivor by default). */
function mutant(over: Partial<MutantResult> & Pick<MutantResult, 'id'>): MutantResult {
    return {
        fileName: '/abs/a.ts',
        mutatorName: 'llm',
        status: 'Survived',
        location: { start: { line: 2, column: 12 }, end: { line: 2, column: 22 } },
        replacement: 'hour > 12',
        ...over,
    } as MutantResult;
}

describe('llm-mutator reporter plugin — declaration', () => {
    it('is a Reporter plugin named llm-mutator with a factory', () => {
        expect(llmMutatorReporterPlugin.kind).toBe(PluginKind.Reporter);
        expect(llmMutatorReporterPlugin.name).toBe(LLM_MUTATOR_REPORTER_NAME);
        expect(LLM_MUTATOR_REPORTER_NAME).toBe('llm-mutator');
        expect(typeof llmMutatorReporterPlugin.factory).toBe('function');
        // The factory injects the logger token (the `inject` tuple typed-inject reads).
        const factory = llmMutatorReporterPlugin.factory as unknown as { inject: string[] };
        expect(factory.inject).toEqual(['logger']);
    });
});

describe('llm-mutator reporter plugin — behavior', () => {
    it('renders survivors + LLM cost + enrichment from runtime-state at report-ready', () => {
        // Stash cost + a one-span map (the wrapper would have done this).
        setRunCost({ totalUsd: 1.5, calls: 4 });
        const node = {} as Node;
        const e: ParsedEntry = {
            node,
            mutatorName: 'llm/boundary',
            replacement: 'hour > 12',
            original: 'hour >= 12',
            rationale: 'Off-by-one.',
        };
        const key = locKeyFromBabelLoc({
            start: { line: 2, column: 11 },
            end: { line: 2, column: 21 },
        });
        const map: LlmMutatorMap = new Map([['/abs/a.ts', new Map([[key, [e]]])]]);
        setRunMap(map);

        const { logger, lines } = makeLogger();
        const reporter = llmMutatorReporterPlugin.factory(logger);
        reporter.onMutantTested?.(mutant({ id: 'm1' }));
        reporter.onMutationTestReportReady?.({} as never, {} as never);

        const all = lines.join('\n');
        expect(all).toContain('SURVIVORS');
        expect(all).toContain('/abs/a.ts:2:12');
        // The precise llm/<tag> + original → replacement + rationale.
        expect(all).toContain('llm/boundary');
        expect(all).toContain('hour >= 12 -> hour > 12');
        expect(all).toContain('Off-by-one.');
        // The cost line from the snapshot.
        expect(all).toContain('Total LLM cost: $1.50 across 4 calls');
        // Singleton reset after report-ready.
        expect(getRuntimeState().map).toBeUndefined();
        expect(getRuntimeState().cost).toEqual({ totalUsd: 0, calls: 0 });
    });

    it('heuristics-only run: no map, $0.00 cost, no enrichment', () => {
        // No setRunMap / setRunCost — the default empty state (a heuristics-only run).
        const { logger, lines } = makeLogger();
        const reporter = llmMutatorReporterPlugin.factory(logger);
        reporter.onMutantTested?.(
            mutant({ id: 'h1', mutatorName: 'NumberLiteralValue', replacement: '6' }),
        );
        reporter.onMutantTested?.(mutant({ id: 'b1', mutatorName: 'ArithmeticOperator' })); // built-in → excluded
        reporter.onMutationTestReportReady?.({} as never, {} as never);

        const all = lines.join('\n');
        expect(all).toContain('SURVIVORS');
        expect(all).toContain('NumberLiteralValue');
        expect(all).toContain('Total LLM cost: $0.00 across 0 calls');
        // The built-in mutant is not counted as ours.
        expect(all).toContain('Injected mutants: 1 ');
    });
});
