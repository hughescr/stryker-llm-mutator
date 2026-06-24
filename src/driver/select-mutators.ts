/*
 * Heuristic mutator SELECTION (functional-architecture §6 — the `heuristics`
 * switch) — a PURE function, fully unit-testable under `bun test` with NO Stryker
 * import. It turns the parsed `heuristics` config block into the concrete
 * `NodeMutator[]` the driver injects into Stryker's `allMutators`.
 *
 * Rules (§6):
 *   • `enabled === false` → return `[]` (heuristics off; the driver then runs
 *     stock Stryker — see `gateSwitches`).
 *   • `operators` is empty `[]` → return ALL registered heuristic mutators (the
 *     "[] = all enabled" rule), in the barrel's stable order.
 *   • otherwise → return only the registered mutators whose `name` is in the
 *     allow-list, preserving the barrel order.
 *
 * The registry is keyed by `mutator.name`, built from the `heuristicMutators`
 * barrel, so it extends automatically as P2–P4 operators land. An operator named
 * in the config enum but NOT YET implemented is simply absent from the registry
 * (Phase-A reality): it is collected into `unimplemented` so the caller can log a
 * single debug line rather than silently dropping it. The dynamic-LLM
 * `LLMMutator` is NOT produced here — it has a separate, stubbed path
 * (`src/driver/gate.ts`).
 */

import type { HeuristicOperatorName, LlmMutatorConfig } from '../config';
import { heuristicMutators, type NodeMutator } from '../mutators/index';

/** The parsed `heuristics` sub-block of {@link LlmMutatorConfig}. */
export type HeuristicsConfig = LlmMutatorConfig['heuristics'];

/**
 * The outcome of {@link selectHeuristicMutators}: the chosen mutators plus the
 * names of any requested-but-unimplemented operators (for a debug log). Returned
 * as a record (not a bare array) so the caller can surface the gap without the
 * selection function performing logging side effects itself.
 */
export interface HeuristicSelection {
    /** The mutators to inject, in stable barrel order. */
    mutators: NodeMutator[];
    /**
     * Operator names that were explicitly requested in `operators` but are not in
     * the live registry yet (a not-yet-shipped catalog entry). Empty when the
     * allow-list is empty or every requested name resolved.
     */
    unimplemented: HeuristicOperatorName[];
}

/**
 * Build the name → mutator registry from the shipped `heuristicMutators` barrel.
 * Keyed by `mutator.name` (which matches the {@link HeuristicOperatorName}
 * catalog), so it grows automatically with the barrel.
 */
function buildRegistry(): Map<string, NodeMutator> {
    const registry = new Map<string, NodeMutator>();
    for (const mutator of heuristicMutators) {
        registry.set(mutator.name, mutator);
    }
    return registry;
}

/**
 * Select the heuristic mutators to inject for a given `heuristics` config block.
 * PURE — no side effects, no Stryker import. See the module header for the rules.
 *
 * @param cfg The parsed `heuristics` sub-block (`enabled`, `operators`, …).
 * @returns The chosen mutators (stable order) plus any unimplemented requests.
 */
export function selectHeuristicMutators(cfg: HeuristicsConfig): HeuristicSelection {
    if (!cfg.enabled) {
        return { mutators: [], unimplemented: [] };
    }

    // Empty allow-list = all registered heuristics, in barrel order.
    if (cfg.operators.length === 0) {
        return { mutators: [...heuristicMutators], unimplemented: [] };
    }

    const registry = buildRegistry();
    const requested = new Set<string>(cfg.operators);
    const unimplemented: HeuristicOperatorName[] = [];

    // Resolve allow-list entries against the registry, noting any that are absent.
    for (const name of cfg.operators) {
        if (!registry.has(name)) {
            unimplemented.push(name);
        }
    }

    // Preserve the barrel's stable order: filter the barrel by the request set.
    const mutators = heuristicMutators.filter(mutator => requested.has(mutator.name));

    return { mutators, unimplemented };
}
