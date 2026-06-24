/*
 * Barrel for the heuristic NodeMutators (development-plan §3.1.3, M0 proof).
 *
 * Heuristic mutators are deterministic, network-free AST mutators authored in
 * Stryker's own built-in idiom. They fill gaps the sixteen built-ins leave open
 * (the first being `NumberLiteralValue` — numeric-literal value mutation) and
 * are registered into Stryker's instrumenter via the monkeypatch seam in
 * `src/injection.ts`. The LLM-driven mutators are a separate, later path; these
 * heuristics are pure code with no provider dependency.
 */

import type { NodeMutator } from './types';
import { boundaryOffByOneMutator } from './boundary-off-by-one';
import { fallbackOperandSubstitutionMutator } from './fallback-operand-substitution';
import { numberLiteralValueMutator } from './number-literal-value';

export type { NodeMutator, NodePath } from './types';
export { boundaryOffByOneMutator } from './boundary-off-by-one';
export { fallbackOperandSubstitutionMutator } from './fallback-operand-substitution';
export { numberLiteralValueMutator } from './number-literal-value';

// The injected dynamic-LLM NodeMutator (M3): a sync map lookup over the pre-pass
// precomputed map. NOT part of `heuristicMutators` (it is built per-run from the
// LLM map, not a fixed singleton); the driver pushes it alongside the heuristics.
export { createLlmMutator, LLM_MUTATOR_NAME } from './llm-mutator';

/**
 * Every heuristic mutator this package ships, in a stable order. This is the
 * default set `src/injection.ts` registers into Stryker's `allMutators`, and the
 * order the driver's `selectHeuristicMutators` preserves. M1 ships the P1 trio
 * (`NumberLiteralValue`, `BoundaryOffByOne`, `FallbackOperandSubstitution`);
 * later milestones append P2–P4.
 */
export const heuristicMutators: readonly NodeMutator[] = [
    numberLiteralValueMutator,
    boundaryOffByOneMutator,
    fallbackOperandSubstitutionMutator,
];
