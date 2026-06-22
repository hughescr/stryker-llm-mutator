/*
 * Package: @hughescr/stryker-llm-mutator
 *
 * PLACEHOLDER ENTRY POINT.
 *
 * This package will eventually use a lightweight LLM (default model
 * `claude-haiku-4-5`) to identify mutation locations and rewrite them, producing
 * a wider variety of mutants than Stryker's built-in formulaic mutators.
 *
 * Stryker v9 has no public "Mutator" plugin kind — the mutators are hardcoded in
 * the instrumenter — so the eventual integration will wrap/augment the instrument
 * step rather than register a new mutator plugin. See README.md for the design
 * direction. Nothing here is wired up yet; this file only exists so that
 * `bun build`, `tsc --noEmit`, and `oxlint` have a valid entry point.
 */

/** Package version marker. Replace with real plugin declarations when implemented. */
export const VERSION = '0.1.0';

/**
 * Placeholder for the eventual Stryker plugin declaration array. Stryker loads a
 * plugin module's `strykerPlugins` export; it is intentionally empty for now.
 */
export const strykerPlugins: readonly unknown[] = [];
