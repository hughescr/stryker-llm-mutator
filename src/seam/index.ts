/*
 * Public surface of the Stryker out-of-band seam (development-plan §3.3 / §4.2).
 *
 * The seam turns a vetted `{ fileName, range, replacement }` table into scored
 * mutation results using Stryker's OWN instrumenter (so the switch-embedded
 * source and the mutant manifest stay coupled, §3.1) and a thin runner that
 * activates each mutant via `__STRYKER_ACTIVE_MUTANT__`. Downstream code should
 * import from this barrel rather than the individual modules.
 */

export type {
    MutantRunResult,
    MutantRunStatus,
    Position,
    Replacement,
    SeamMutant,
    SourceRange,
} from './types';

export { computeMutantId } from './mutant-id';
export { instrument } from './instrument';
export type { InstrumentResult, SourceFile } from './instrument';
export { runMutants } from './runner';
export type { RunMutantsOptions } from './runner';
