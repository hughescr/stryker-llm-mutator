/*
 * Barrel for the stage-2 pipeline: the LLM `propose` stage and the cheap,
 * no-LLM deterministic `filters` that winnow its output. See
 * `docs/development-plan.md` §4.3 (stage 2) and phases 2–3.
 */

export {
    propose,
    PROPOSE_MUTATOR_PREFIX,
    type ProposeOptions,
    type ProposeTarget,
} from './propose';

export {
    applyFilters,
    dedupKey,
    dedupReplacements,
    filterIdentical,
    filterUnparseable,
    isParseable,
} from './filters';
