/*
 * Barrel for the M4 reporter (functional-architecture §6 Reporting).
 *
 * The reporter is a PURE formatter over Stryker's `MutantResult[]` + the LLM cost
 * snapshot: it renders OUR survivor view + cost summary on top of Stryker's
 * standard report and builds the optional filtered `reports/mutation-llm.json`
 * artifact. No Stryker import (type-only), no network — fully bun-testable.
 */

export {
    type FilteredMutant,
    type FilteredReport,
    type FormatReportOptions,
    formatReport,
    isOurMutant,
    LLM_PREFIX,
    type MutantEnrichment,
    type ReportOutput,
} from './reporter';
