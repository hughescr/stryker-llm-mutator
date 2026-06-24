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
import { numberLiteralValueMutator } from './number-literal-value';

export type { NodeMutator } from './types';
export { numberLiteralValueMutator } from './number-literal-value';

/**
 * Every heuristic mutator this package ships, in a stable order. This is the
 * default set `src/injection.ts` registers into Stryker's `allMutators`. For
 * the M0 proof it holds exactly one entry; later milestones append more.
 */
export const heuristicMutators: readonly NodeMutator[] = [numberLiteralValueMutator];
