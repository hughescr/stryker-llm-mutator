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
// P1 (M1)
import { boundaryOffByOneMutator } from './boundary-off-by-one';
import { fallbackOperandSubstitutionMutator } from './fallback-operand-substitution';
import { numberLiteralValueMutator } from './number-literal-value';
// P2 (M5)
import { awaitDropMutator } from './await-drop';
import { callArgumentTweakMutator } from './call-argument-tweak';
import { comparisonBoundaryShiftMutator } from './comparison-boundary-shift';
// P3 (M5)
import { arrayMethodSwapMutator } from './array-method-swap';
import { earlyReturnInjectionMutator } from './early-return-injection';
import { promiseCombinatorSwapMutator } from './promise-combinator-swap';
import { spreadOperandDropMutator } from './spread-operand-drop';
// P4 (M5)
import { defaultParamValueTweakMutator } from './default-param-value-tweak';
import { optionalChainForceMutator } from './optional-chain-force';
import { stringMethodArgSwapMutator } from './string-method-arg-swap';
import { ternaryBranchSwapMutator } from './ternary-branch-swap';

export type { NodeMutator, NodePath } from './types';
// P1 (M1)
export { boundaryOffByOneMutator } from './boundary-off-by-one';
export { fallbackOperandSubstitutionMutator } from './fallback-operand-substitution';
export { numberLiteralValueMutator } from './number-literal-value';
// P2 (M5)
export { awaitDropMutator } from './await-drop';
export { callArgumentTweakMutator } from './call-argument-tweak';
export { comparisonBoundaryShiftMutator } from './comparison-boundary-shift';
// P3 (M5)
export { arrayMethodSwapMutator } from './array-method-swap';
export { earlyReturnInjectionMutator } from './early-return-injection';
export { promiseCombinatorSwapMutator } from './promise-combinator-swap';
export { spreadOperandDropMutator } from './spread-operand-drop';
// P4 (M5)
export { defaultParamValueTweakMutator } from './default-param-value-tweak';
export { optionalChainForceMutator } from './optional-chain-force';
export { stringMethodArgSwapMutator } from './string-method-arg-swap';
export { ternaryBranchSwapMutator } from './ternary-branch-swap';

// The injected dynamic-LLM NodeMutator (M3): a sync map lookup over the pre-pass
// precomputed map. NOT part of `heuristicMutators` (it is built per-run from the
// LLM map, not a fixed singleton); the driver pushes it alongside the heuristics.
export { createLlmMutator, LLM_MUTATOR_NAME } from './llm-mutator';

/**
 * Every heuristic mutator this package ships, in a stable order (P1 → P2 → P3 →
 * P4, matching the {@link HeuristicOperator} catalog order). This is the default
 * set `src/injection.ts` registers into Stryker's `allMutators`, and the order the
 * driver's `selectHeuristicMutators` preserves. M1 shipped the P1 trio; M5
 * appended P2–P4. Every operator is verified to place cleanly through the REAL
 * `@stryker-mutator/instrumenter` — the 12 expression-shaped operators by the
 * unit-test idiom + the M0 injection canary, and the single statement-shaped
 * operator `EarlyReturnInjection` by its dedicated
 * `tests/injection/early-return-placement-proof.test.ts` canary (§5 constraint 3).
 */
export const heuristicMutators: readonly NodeMutator[] = [
    // P1
    numberLiteralValueMutator,
    boundaryOffByOneMutator,
    fallbackOperandSubstitutionMutator,
    // P2
    comparisonBoundaryShiftMutator,
    callArgumentTweakMutator,
    awaitDropMutator,
    // P3
    earlyReturnInjectionMutator,
    spreadOperandDropMutator,
    arrayMethodSwapMutator,
    promiseCombinatorSwapMutator,
    // P4
    defaultParamValueTweakMutator,
    optionalChainForceMutator,
    stringMethodArgSwapMutator,
    ternaryBranchSwapMutator,
];
