/*
 * PURE run-plan assembly (functional-architecture §6). This is the decision core
 * of the driver, factored OUT of the side-effecting `runLlmMutation` so the
 * flag→options mapping, mutator selection, injection-mode decision, and
 * switch-interplay are all unit-testable under `bun test` WITHOUT importing
 * Stryker (which is Node-only — see `src/driver/run.ts`).
 *
 * `buildRunPlan(opts, config)` takes the parsed CLI {@link RunOptions} and the
 * already-read target {@link LlmMutatorConfig} and produces a {@link RunPlan}: the
 * gate decision, the heuristic selection, the FINAL injected mutator list, the
 * effective injection mode, and the partial Stryker options. It performs NO I/O —
 * no chdir, no config read, no `new Stryker()`. `run.ts` consumes the plan and
 * performs exactly those side effects.
 */

import type { LlmMutatorConfig } from '../config';
import { expandExcludedMutations } from '../directive-alias';
import type { NodeMutator } from '../mutators/index';
import type { RunOptions, InjectionMode } from './cli-args';
import { gateSwitches, type GatePlan } from './gate';
import { type HeuristicSelection, selectHeuristicMutators } from './select-mutators';

/**
 * Partial Stryker options the driver assembles from CLI flags + the resolved
 * config file. Deliberately a structural subset (only the keys we set) so this
 * module need not import Stryker's `PartialStrykerOptions` type. `run.ts` widens
 * it to the real type at the `new Stryker(...)` call site.
 */
export interface PartialStrykerOptions {
    /** Forwarded `--config-file` (the resolved path), so Stryker loads the same file. */
    configFile?: string;
    /** `mutate` globs (from `--mutate`, else the target config's own value via omission). */
    mutate?: string[];
    /** `--concurrency`. */
    concurrency?: number;
    /** `--reporters`. */
    reporters?: string[];
    /** `--incremental` / `--no-incremental`. */
    incremental?: boolean;
    /** `--temp-dir`. */
    tempDirName?: string;
    /**
     * The target's `excludedMutations` with a bare `llm` expanded to every
     * `Llm<Category>` name. Set ONLY on a dynamic-LLM run whose target list names
     * `llm` (Stryker matches this list case-sensitively by exact name, so the
     * plugin must expand it before Stryker sees it); omitted otherwise so Stryker
     * uses the config file's own value untouched.
     */
    excludedMutations?: string[];
}

/** The complete, pure plan `run.ts` executes. */
export interface RunPlan {
    /** Absolute-or-relative project dir to chdir into (from {@link RunOptions}). */
    projectDir: string;
    /** Whether to actually invoke Stryker (`--live`) or just print the plan (`--dry-run`). */
    live: boolean;
    /** The switch-gating decision (both-off warn, dynamicLLM gating). */
    gate: GatePlan;
    /** The heuristic selection (mutators + any unimplemented requests) for logging. */
    selection: HeuristicSelection;
    /**
     * The FINAL mutators to inject. At plan time this is the heuristic selection;
     * the 17 dynamic-LLM mutators (`llm` wildcard + 16 categories) are appended by
     * `run.ts` AFTER `buildLlmMutator`, so they never reach this list at plan time.
     */
    injectedMutators: NodeMutator[];
    /**
     * The injection mode actually applied. `replace` (`--ours-only`) is DOWNGRADED
     * to `augment` when there is nothing of ours to inject — counting the deferred
     * dynamic-LLM mutators `run.ts` appends after this plan is built — so we never
     * clear Stryker's built-ins to an empty registry (which would mutate nothing).
     */
    mode: InjectionMode;
    /** The partial Stryker options assembled from the flags + resolved config file. */
    strykerOptions: PartialStrykerOptions;
}

/**
 * Assemble Stryker's partial options from the parsed flags and the resolved
 * config-file path. Only keys the user actually set are included; everything else
 * is omitted so Stryker falls back to the target config's own values.
 */
function buildStrykerOptions(
    opts: RunOptions,
    configFilePath: string | undefined,
    gate: GatePlan,
    targetExcludedMutations: readonly string[] | undefined,
): PartialStrykerOptions {
    // [Finding 1] Stryker checks `excludedMutations` by exact, case-sensitive
    // name, so a target list naming the legacy `llm` would silently stop
    // excluding the `Llm<Category>` mutants. Expand it — only on a dynamic-LLM
    // run, and only when `llm` is actually listed — and pass it as an override;
    // otherwise omit the key so Stryker reads the file's own value untouched.
    const expandExcluded =
        gate.runDynamicLLM &&
        targetExcludedMutations !== undefined &&
        targetExcludedMutations.includes('llm');
    return {
        ...(configFilePath === undefined ? {} : { configFile: configFilePath }),
        // Empty `--mutate` means "use the target config's own mutate" → omit the key.
        ...(opts.mutate.length === 0 ? {} : { mutate: opts.mutate }),
        ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
        ...(opts.reporters === undefined ? {} : { reporters: opts.reporters }),
        ...(opts.incremental === undefined ? {} : { incremental: opts.incremental }),
        ...(opts.tempDirName === undefined ? {} : { tempDirName: opts.tempDirName }),
        ...(expandExcluded
            ? { excludedMutations: expandExcludedMutations(targetExcludedMutations) }
            : {}),
    };
}

/**
 * Build the complete {@link RunPlan} from parsed options + the read config.
 * PURE — see the module header.
 *
 * @param opts The parsed CLI run options.
 * @param config The already-read, fully-defaulted target config.
 * @param configFilePath The resolved config-file path to forward to Stryker (or
 *   `undefined` when no config file was found).
 * @param targetExcludedMutations The target config's own `excludedMutations`
 *   list (from `readTargetConfig`), or `undefined` when it has none. A bare
 *   `llm` in it is expanded to every `Llm<Category>` on a dynamic-LLM run.
 */
export function buildRunPlan(
    opts: RunOptions,
    config: LlmMutatorConfig,
    configFilePath: string | undefined,
    targetExcludedMutations?: readonly string[],
): RunPlan {
    const gate = gateSwitches(config);
    const selection = selectHeuristicMutators(config.heuristics);

    // At plan time the injected set is exactly the heuristic selection. `run.ts`
    // appends the 17 synchronous LLM mutators (llm wildcard + 16 categories)
    // AFTER this plan returns, whenever `gate.runDynamicLLM` is true (the M3
    // pre-pass builds them). The plan therefore does NOT yet contain them — but
    // the downgrade predicate below must account for them, or `--ours-only` +
    // dynamicLLM-on (heuristics-off) would see an empty list at plan time,
    // wrongly downgrade to `augment`, and keep Stryker's 16 built-ins instead of
    // running ours-only (the 265-vs-29 bug).
    const injectedMutators = gate.runHeuristics ? selection.mutators : [];

    // `run.ts` will push the LLM mutators when dynamicLLM is gated on.
    const willInjectLlm = gate.runDynamicLLM;
    // "Will we inject anything of ours?" — heuristics now OR the deferred LLM mutator.
    const willInjectAnything = injectedMutators.length > 0 || willInjectLlm;

    // Never clear built-ins to empty: downgrade `replace` → `augment` ONLY when we
    // have nothing of ours to inject (counting the deferred LLM mutators), so stock
    // Stryker still mutates with its built-ins. With dynamicLLM on, `replace` is
    // preserved so the run is genuinely ours-only (the LLM mutators alone).
    const mode: InjectionMode =
        opts.mode === 'replace' && !willInjectAnything ? 'augment' : opts.mode;

    return {
        projectDir: opts.projectDir,
        live: opts.live,
        gate,
        selection,
        injectedMutators,
        mode,
        strykerOptions: buildStrykerOptions(opts, configFilePath, gate, targetExcludedMutations),
    };
}
