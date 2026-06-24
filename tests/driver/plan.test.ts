/*
 * Offline unit tests for the pure run-plan assembly `buildRunPlan`
 * (functional-architecture §6). Covers the gate→selection→injected-mutators wiring,
 * the flag→Stryker-options mapping, and the `replace → augment` downgrade when
 * there is nothing of ours to inject (never clear built-ins to empty). No Stryker
 * import, no I/O.
 */

import { describe, expect, it } from 'bun:test';

import { llmMutatorConfigSchema, type LlmMutatorConfig } from '../../src/config';
import type { RunOptions } from '../../src/driver/cli-args';
import { buildRunPlan } from '../../src/driver/plan';
import { heuristicMutators } from '../../src/mutators/index';

/** A baseline RunOptions with augment/dry-run defaults; override per test. */
function options(partial: Partial<RunOptions> = {}): RunOptions {
    return {
        projectDir: '/proj',
        mode: 'augment',
        live: false,
        mutate: [],
        ...partial,
    };
}

function config(partial: Record<string, unknown> = {}): LlmMutatorConfig {
    return llmMutatorConfigSchema.parse(partial);
}

describe('buildRunPlan — mutator wiring', () => {
    it('injects all heuristics by default and carries the gate/selection', () => {
        const plan = buildRunPlan(options(), config(), undefined);
        expect(plan.gate.runHeuristics).toBe(true);
        // The default selection is the whole heuristic barrel (full P1–P4 catalog),
        // in barrel order — assert against the barrel so this self-updates.
        expect(plan.injectedMutators.map(m => m.name)).toEqual(heuristicMutators.map(m => m.name));
        expect(plan.injectedMutators).toHaveLength(14);
        expect(plan.selection.unimplemented).toEqual([]);
        expect(plan.mode).toBe('augment');
        expect(plan.live).toBe(false);
        expect(plan.projectDir).toBe('/proj');
    });

    it('injects only the allow-listed operators', () => {
        const plan = buildRunPlan(
            options(),
            config({ heuristics: { operators: ['BoundaryOffByOne'] } }),
            undefined,
        );
        expect(plan.injectedMutators.map(m => m.name)).toEqual(['BoundaryOffByOne']);
    });

    it('injects nothing when heuristics are disabled', () => {
        const plan = buildRunPlan(options(), config({ heuristics: { enabled: false } }), undefined);
        expect(plan.injectedMutators).toEqual([]);
        expect(plan.gate.bothOff).toBe(true);
        expect(plan.gate.warning).toBeDefined();
    });
});

describe('buildRunPlan — injection mode downgrade', () => {
    it('keeps replace mode when there ARE mutators to inject', () => {
        const plan = buildRunPlan(options({ mode: 'replace' }), config(), undefined);
        expect(plan.mode).toBe('replace');
        expect(plan.injectedMutators.length).toBeGreaterThan(0);
    });

    it('downgrades replace → augment when there is nothing of ours to inject', () => {
        // heuristics disabled → empty selection → replace would clear built-ins to
        // empty (Stryker mutates nothing), so it must fall back to augment.
        const plan = buildRunPlan(
            options({ mode: 'replace' }),
            config({ heuristics: { enabled: false } }),
            undefined,
        );
        expect(plan.injectedMutators).toEqual([]);
        expect(plan.mode).toBe('augment');
    });

    it('KEEPS replace mode when heuristics are off but dynamicLLM is on (the deferred LLMMutator counts)', () => {
        // Regression for the 265-vs-29 bug: `--ours-only` + dynamicLLM-on +
        // heuristics-off. At plan time injectedMutators is [] (the LLMMutator is
        // appended later by run.ts), but the plan KNOWS gate.runDynamicLLM, so it
        // must NOT downgrade — otherwise the 16 built-ins are kept and the run is
        // not ours-only. The plan's injectedMutators is still empty here (run.ts
        // pushes the LLMMutator), but the MODE must stay replace.
        const plan = buildRunPlan(
            options({ mode: 'replace' }),
            config({ heuristics: { enabled: false }, dynamicLLM: { enabled: true } }),
            undefined,
        );
        expect(plan.gate.runDynamicLLM).toBe(true);
        expect(plan.injectedMutators).toEqual([]);
        expect(plan.mode).toBe('replace');
    });

    it('downgrades replace → augment when BOTH switches are off (no empty-registry clear)', () => {
        // Both off → runDynamicLLM false AND empty selection → genuinely nothing of
        // ours → downgrade so stock Stryker runs its built-ins (the gate warns).
        const plan = buildRunPlan(
            options({ mode: 'replace' }),
            config({ heuristics: { enabled: false }, dynamicLLM: { enabled: false } }),
            undefined,
        );
        expect(plan.gate.bothOff).toBe(true);
        expect(plan.injectedMutators).toEqual([]);
        expect(plan.mode).toBe('augment');
    });

    it('keeps replace when heuristics are on AND dynamicLLM is on', () => {
        const plan = buildRunPlan(
            options({ mode: 'replace' }),
            config({ dynamicLLM: { enabled: true } }),
            undefined,
        );
        expect(plan.injectedMutators.length).toBeGreaterThan(0);
        expect(plan.gate.runDynamicLLM).toBe(true);
        expect(plan.mode).toBe('replace');
    });
});

describe('buildRunPlan — Stryker options mapping', () => {
    it('omits all optional keys when flags are unset (use the target config values)', () => {
        const plan = buildRunPlan(options(), config(), undefined);
        expect(plan.strykerOptions).toEqual({});
    });

    it('forwards the resolved config file path', () => {
        const plan = buildRunPlan(options(), config(), '/proj/stryker.config.mjs');
        expect(plan.strykerOptions.configFile).toBe('/proj/stryker.config.mjs');
    });

    it('maps every provided flag into partial Stryker options', () => {
        const plan = buildRunPlan(
            options({
                mutate: ['src/a.ts', 'src/b.ts'],
                concurrency: 4,
                reporters: ['clear-text'],
                incremental: false,
                tempDirName: '.tmp',
            }),
            config(),
            '/proj/stryker.config.mjs',
        );
        expect(plan.strykerOptions).toEqual({
            configFile: '/proj/stryker.config.mjs',
            mutate: ['src/a.ts', 'src/b.ts'],
            concurrency: 4,
            reporters: ['clear-text'],
            incremental: false,
            tempDirName: '.tmp',
        });
    });

    it('omits mutate when the --mutate list is empty', () => {
        const plan = buildRunPlan(options({ mutate: [] }), config(), undefined);
        expect(plan.strykerOptions.mutate).toBeUndefined();
    });
});

describe('buildRunPlan — dynamicLLM gating surfaced in the plan', () => {
    it('marks runDynamicLLM when the switch is on (the driver then gates creds/stub)', () => {
        const plan = buildRunPlan(options(), config({ dynamicLLM: { enabled: true } }), undefined);
        expect(plan.gate.runDynamicLLM).toBe(true);
    });
});
