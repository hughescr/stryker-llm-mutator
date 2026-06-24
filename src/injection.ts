/*
 * The monkeypatch injection seam (development-plan §3.3, M0 proof).
 *
 * Stryker v9 has NO public "Mutator" plugin kind — the sixteen built-in mutators
 * are hardcoded into `@stryker-mutator/instrumenter` and there is no DI token to
 * register a new one. The verified-and-proven path (functional-architecture.md
 * §3) is to mutate the instrumenter's `allMutators` array IN PLACE:
 *
 *   • `mutators/mutate.js` exports `allMutators` as a plain, NON-frozen array.
 *   • `transformers/babel-transformer.js` reads it BY REFERENCE as the default
 *     value of its `mutators` parameter (`(..., mutators = allMutators) => ...`),
 *     then iterates `for (const mutator of mutators) for (const replacement of
 *     mutator.mutate(node))`.
 *   • Instrumentation runs IN-PROCESS in the main Stryker process. So mutating
 *     this one shared array instance — BEFORE Stryker calls `transformBabel` —
 *     changes exactly which mutators run, for free, with no plugin descriptor.
 *
 * WHY THE DEEP `dist/src/...` IMPORT: the instrumenter's `package.json`
 * `exports` map only exposes `.` and `./package.json`; `allMutators` is reached
 * via a direct relative filesystem path into `node_modules`, exactly as
 * `src/seam/instrument-worker.mjs` reaches `transformBabel`/`MutantCollector`.
 * Because ESM module instances are singletons per resolved path, the array we
 * import here is the SAME instance `babel-transformer.js` captured as its
 * default parameter — so pushing to it is observed by the next `transformBabel`
 * call (proven offline in `tests/injection/injection-proof.test.ts`).
 *
 * This module is intentionally PURE and SYNCHRONOUS: it only mutates an array.
 * It contains NO `stryker run`, NO child-process spawn, and NO network code —
 * those belong to the driver (`scripts/m0-isambard-proof.mjs`), not here, which
 * keeps the injection logic trivially unit-testable.
 */

import { allMutators } from '../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js';

import { heuristicMutators, type NodeMutator } from './mutators/index';

/**
 * A mutable mutator registry: the structural minimum {@link injectMutators}
 * mutates. Stryker's real `allMutators` (a `NodeMutator[]`) satisfies it.
 */
type MutatorRegistry = NodeMutator[];

/** Options controlling how {@link injectMutators} registers mutators. */
export interface InjectMutatorsOptions {
    /**
     * Registration mode.
     *   • `'augment'` (default) — KEEP Stryker's sixteen built-ins and ADD ours
     *     after them, so a run emits both built-in and heuristic mutants.
     *   • `'replace'` — CLEAR the built-ins first (`length = 0`) and register
     *     ONLY ours, so a run emits heuristic mutants exclusively. The M0
     *     isambard driver uses this to prove our mutant in isolation.
     */
    mode?: 'augment' | 'replace';
    /**
     * The registry array to mutate. Defaults to Stryker's real, deep-imported
     * `allMutators` — the normal production target. Overridable ONLY so an
     * out-of-process proof (the Node injection-proof worker) can pass the
     * `allMutators` instance IT imported, guaranteeing it mutates the exact array
     * its in-process instrumenter reads. Production callers never set this.
     */
    target?: MutatorRegistry;
}

/**
 * The outcome of an {@link injectMutators} call, for assertions and logging.
 * All counts are read from the live `allMutators` array after mutation.
 */
export interface InjectMutatorsResult {
    /** The mode that was applied. */
    mode: 'augment' | 'replace';
    /** `allMutators.length` BEFORE this call mutated it. */
    countBefore: number;
    /** `allMutators.length` AFTER this call mutated it. */
    countAfter: number;
    /** The `name`s of the mutators that were registered by this call. */
    injectedNames: readonly string[];
}

/**
 * Register heuristic mutators into Stryker's live `allMutators` registry by
 * mutating that shared array IN PLACE. Pure and synchronous: the only side
 * effect is the array mutation; the return value is a snapshot for assertions.
 *
 * In `'augment'` mode (the default) the given mutators are appended after the
 * built-ins. In `'replace'` mode the array is first emptied (preserving its
 * identity via `length = 0`, NOT reassignment — reassignment would break the
 * by-reference binding `babel-transformer.js` captured) and then filled with
 * only the given mutators.
 *
 * Idempotency note: this function does NOT de-duplicate. Calling it twice in
 * `'augment'` mode registers the heuristics twice. Callers that re-inject within
 * one process (e.g. tests) should restore the array between calls — see the
 * snapshot/restore pattern in the injection proof test.
 *
 * @param mutators The mutators to register. Defaults to {@link heuristicMutators}.
 * @param options Registration options; see {@link InjectMutatorsOptions}.
 * @returns A snapshot of what was injected and the before/after counts.
 */
export function injectMutators(
    mutators: readonly NodeMutator[] = heuristicMutators,
    options: InjectMutatorsOptions = {},
): InjectMutatorsResult {
    const mode = options.mode ?? 'augment';
    const registry = options.target ?? allMutators;
    const countBefore = registry.length;

    if (mode === 'replace') {
        // Empty the array IN PLACE — keep the same instance so the reference
        // `babel-transformer.js` holds as its default parameter still points at
        // the array we are filling.
        registry.length = 0;
    }

    registry.push(...mutators);

    return {
        mode,
        countBefore,
        countAfter: registry.length,
        injectedNames: mutators.map(mutator => mutator.name),
    };
}
