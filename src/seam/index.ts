/*
 * Public surface of the Stryker out-of-band seam (development-plan §3.3 / §4.2).
 *
 * The seam turns a vetted `{ fileName, range, replacement }` table into scored
 * mutation results using Stryker's OWN instrumenter (so the switch-embedded
 * source and the mutant manifest stay coupled, §3.1) and a thin runner that
 * activates each mutant via `__STRYKER_ACTIVE_MUTANT__`. The seam is an INTERNAL
 * contingency (§3.5) — NOT on the package's public surface — so this barrel only
 * re-exports the symbols its own offline tests consume; the rest are reached from
 * `./types`, `./instrument`, and `./runner` directly.
 */

export type { Replacement } from './types';

export { computeMutantId } from './mutant-id';
export { instrument } from './instrument';
export type { SourceFile } from './instrument';
export { runMutants } from './runner';
