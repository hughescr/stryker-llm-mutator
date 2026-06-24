/*
 * Shared contract: the Stryker out-of-band seam.
 *
 * These types describe the vetted replacement table the pipeline hands to the
 * seam, and the scored results the seam hands back. The seam itself (see
 * `docs/development-plan.md` §3.3 / §4.2) calls
 * `createInstrumenter().instrument()` directly so that Stryker's own collector +
 * placers emit BOTH coupled artifacts in lockstep — the
 * `stryMutAct_9fa48(id) ? mutated : original` switch in source AND the matching
 * `Mutant` record in the manifest (§3.1). This module is interfaces only; it
 * imports no sibling implementation.
 *
 * Field names and the position/location shapes here are kept in lockstep with
 * `@stryker-mutator/api` via type-only imports, so an `instrument()` shape bump
 * surfaces as a compile error rather than a silent off-by-one at the seam.
 */

import type { Location as StrykerLocation } from '@stryker-mutator/api/core';

/**
 * A start/end span in source code, re-exported from Stryker's own
 * {@link StrykerLocation} (`{ start, end }`, both Stryker `Position`s). `start` is
 * inclusive; `end` is exclusive of the final character in the same way Stryker's
 * own `Location` is, so a replacement covers `[start, end)`.
 *
 * INDEXING CONVENTION (load-bearing — get this wrong and mutants silently
 * vanish): Stryker positions are **zero-based** — the first character of a file
 * is `{ line: 0, column: 0 }`. Babel, which Stryker's instrumenter is built on,
 * reports `line` 1-based and `column` 0-based, so producers of a `SourceRange`
 * MUST normalize Babel's `line` by subtracting 1 before populating these fields.
 * Whatever a producer does, the values stored here are in Stryker's native
 * zero-based convention and are passed to the instrumenter verbatim.
 */
export type SourceRange = StrykerLocation;

/**
 * One LLM-vetted edit: replace the source spanned by `range` in `fileName` with
 * `replacement`. This is the unit the pipeline produces (development-plan §4.2)
 * and the input the seam expresses to `instrument()`. `original` is carried for
 * auditing / the `replacement === original` reject filter (§4.3 stage 2); it is
 * the exact source text currently occupying `range`.
 */
export interface Replacement {
    /** Absolute or project-relative path of the file to mutate. Matches `Mutant.fileName`. */
    fileName: string;
    /**
     * The 0-based, Stryker-convention span this edit replaces. Precise Babel
     * positions (normalized — see {@link SourceRange}), NEVER a string search, to
     * avoid scope-breaking edits that masquerade as "killed" (development-plan §4.2).
     */
    range: SourceRange;
    /** The exact source text currently occupying `range`, before mutation. */
    original: string;
    /** The replacement source text. Matches `Mutant.replacement`. */
    replacement: string;
    /**
     * The mutator tag for this edit. LLM mutants carry a distinct, non-built-in
     * name so reporting can tell them apart from Stryker's 17 formulaic
     * operators (development-plan §3.3 / §4.4). Populates `Mutant.mutatorName`.
     */
    mutatorName: string;
    /**
     * Optional human-readable justification from the proposing stage for why
     * this edit is an interesting, real-bug-like mutant. Carried through for
     * reporting and human audit; never affects scoring.
     */
    rationale?: string;
}

/**
 * A {@link Replacement} plus a **deterministic** `id`, derived from a hash of
 * `{ fileName, range, replacement }` so a given proposal yields a stable id
 * across runs — a prerequisite for the content-addressed cache and for warm-run
 * reproducibility (development-plan §4.2 / §7). This `id` is the same id Stryker
 * activates via `__STRYKER_ACTIVE_MUTANT__=<id>` and that appears in the
 * instrument manifest's `Mutant.id`.
 */
export interface SeamMutant extends Replacement {
    /** Deterministic mutant id = hash({ fileName, range, replacement }). Stable across runs. */
    id: string;
}

/**
 * The terminal status of a single mutant after the runner has executed the test
 * suite against it. Mirrors the meaningful subset of Stryker's `MutantStatus`
 * the seam itself can determine: a mutant is `killed` when a test failed,
 * `survived` when none did, `timeout` when execution exceeded the limit, and
 * `error` when the mutant run itself failed (e.g. a compile/import error rather
 * than a test outcome). Equivalent/ignored/no-coverage dispositions are decided
 * upstream by the pipeline filters, not by the seam.
 */
export type MutantRunStatus = 'killed' | 'survived' | 'timeout' | 'error';

/**
 * The scored outcome for one {@link SeamMutant}, keyed by its deterministic
 * `id`. This is what the seam returns per mutant (alongside the instrument
 * manifest) for reporting (development-plan §4.2).
 */
export interface MutantRunResult {
    /** The deterministic id of the {@link SeamMutant} this result is for. Matches `SeamMutant.id`. */
    id: string;
    /** The terminal disposition of the mutant after the test run. */
    status: MutantRunStatus;
    /**
     * Optional detail: for `killed`, the killing test / reason; for `error`, the
     * failure message; otherwise human-readable context. Free-form, for
     * reporting and debugging only.
     */
    detail?: string;
}
