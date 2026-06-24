/*
 * Target-config reader (functional-architecture §6 — "reading from the target").
 *
 * The driver must know the `llmMutator` block BEFORE the run, to decide which
 * mutators to inject, so it cannot defer entirely to Stryker. This module locates
 * and loads the target's stryker config FILE, extracts `options.llmMutator ?? {}`,
 * and parses it with `llmMutatorConfigSchema` (which fills every default — an
 * absent block parses to heuristics-on / dynamicLLM-off, exactly §6).
 *
 * We do NOT use Stryker's `ConfigReader` directly: it needs typed-inject DI
 * wiring (a logger + `OptionsValidator` via `static inject`), which is heavier and
 * couples us to Stryker internals. A plain config-file import is simpler and is
 * all the driver needs pre-run. Stryker still loads its own FULL config during
 * `runMutationTest()` via the same `configFile` we forward — and Stryker core only
 * `log.warn`s on the unknown `llmMutator` key (never fatal), so ONE
 * `stryker.config.*` serves both `stryker run` and `stryker-llm run`.
 *
 * Because `.strict()` is on the `llmMutator` object and we parse ONLY that
 * sub-object (never the whole `StrykerOptions`), unknown top-level Stryker keys
 * are irrelevant here.
 *
 * Config-file format coverage mirrors Stryker's `SUPPORTED_CONFIG_FILE_NAMES`:
 *   • `.mjs` / `.js` / `.cjs` → dynamic `import()`, taking the `default` export
 *     (Stryker rejects function exports; we read the object directly).
 *   • `.json` → `JSON.parse(await readFile(...))`.
 * An explicit `--config-file <path>` override is honored verbatim; otherwise the
 * supported candidate names are probed in order within `projectDir`.
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { llmMutatorConfigSchema, type LlmMutatorConfig } from '../config';

/** Async existence check via `fs/promises.access` (no sync fs — see `no-sync`). */
async function exists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Stryker's supported config file names, in probe order, mirroring
 * `@stryker-mutator/core`'s `SUPPORTED_CONFIG_FILE_NAMES`
 * (`{'',  '.'} × {.conf, .config} × {json, js, mjs, cjs}`). Kept as a local
 * constant rather than deep-imported so the reader does not pull Stryker core
 * (which is Node-only and would break `bun test`).
 */
export const SUPPORTED_CONFIG_FILE_NAMES: readonly string[] = (() => {
    const names: string[] = [];
    for (const prefix of ['', '.']) {
        for (const suffix of ['.conf', '.config']) {
            for (const ext of ['json', 'js', 'mjs', 'cjs']) {
                names.push(`${prefix}stryker${suffix}.${ext}`);
            }
        }
    }
    return names;
})();

/** The outcome of {@link readTargetConfig}: the parsed config + its source file. */
export interface ReadTargetConfigResult {
    /** The fully-defaulted, parsed `llmMutator` block. */
    config: LlmMutatorConfig;
    /**
     * The absolute path to the config file that was read, or `undefined` when no
     * config file was found (then `config` is the all-defaults parse of `{}`).
     * The driver forwards this to Stryker as `configFile`.
     */
    configFilePath?: string;
}

/**
 * Locate the target stryker config file within `projectDir`, honoring an explicit
 * override. Returns the absolute path, or `undefined` if none exists.
 *
 * @param projectDir The project root to probe.
 * @param configFileOverride An explicit `--config-file` path (relative paths
 *   resolve against `projectDir`).
 */
export async function resolveConfigFilePath(
    projectDir: string,
    configFileOverride?: string,
): Promise<string | undefined> {
    if (configFileOverride !== undefined) {
        const resolved = path.isAbsolute(configFileOverride)
            ? configFileOverride
            : path.resolve(projectDir, configFileOverride);
        if (!(await exists(resolved))) {
            throw new Error(`Config file not found: ${resolved}`);
        }
        return resolved;
    }

    // Probe all candidates in PARALLEL, then pick the first existing one by the
    // supported-name precedence order (Stryker's own order). Parallel existence
    // checks avoid a sequential await-in-loop while preserving deterministic
    // precedence (the lowest matching index wins).
    const candidates = SUPPORTED_CONFIG_FILE_NAMES.map(name => path.resolve(projectDir, name));
    const present = await Promise.all(candidates.map(exists));
    const firstIndex = present.indexOf(true);
    return firstIndex === -1 ? undefined : candidates[firstIndex];
}

/**
 * Load the raw options object from a resolved config file. `.json` is parsed from
 * disk; `.js`/`.mjs`/`.cjs` are dynamically imported and the `default` export is
 * taken (Stryker no longer supports function-exporting configs, so the default
 * must be the options object). A cache-busting query is appended to the import URL
 * so repeated reads within one process (e.g. tests) re-evaluate the module.
 */
async function loadRawOptions(configFilePath: string): Promise<Record<string, unknown>> {
    const ext = path.extname(configFilePath).toLowerCase();

    if (ext === '.json') {
        const text = await readFile(configFilePath, 'utf8');
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null) {
            throw new Error(`Config file ${configFilePath} did not contain a JSON object.`);
        }
        return parsed as Record<string, unknown>;
    }

    // .js / .mjs / .cjs — dynamic import, default export.
    const url = `${pathToFileURL(configFilePath).href}?t=${String(Date.now())}`;
    const mod = (await import(url)) as { default?: unknown };
    const options = mod.default;
    if (typeof options === 'function') {
        throw new Error(
            `Config file ${configFilePath} exports a function, which is not supported. ` +
                'Export an options object as the default export instead.',
        );
    }
    if (typeof options !== 'object' || options === null) {
        throw new Error(`Config file ${configFilePath} has no default-exported options object.`);
    }
    return options as Record<string, unknown>;
}

/**
 * Read and parse the target's `llmMutator` config block.
 *
 * Locates the config file (or uses the override), loads its options object,
 * extracts `options.llmMutator ?? {}`, and parses it with
 * `llmMutatorConfigSchema`. When NO config file is found, returns the all-defaults
 * parse of `{}` (heuristics-on / dynamicLLM-off) with no `configFilePath`.
 *
 * @param projectDir The project root.
 * @param configFileOverride An explicit `--config-file` path (optional).
 * @returns The parsed config and the resolved config file path (if any).
 */
export async function readTargetConfig(
    projectDir: string,
    configFileOverride?: string,
): Promise<ReadTargetConfigResult> {
    const configFilePath = await resolveConfigFilePath(projectDir, configFileOverride);

    if (configFilePath === undefined) {
        return { config: llmMutatorConfigSchema.parse({}) };
    }

    const rawOptions = await loadRawOptions(configFilePath);
    const llmMutatorRaw = rawOptions.llmMutator ?? {};
    const config = llmMutatorConfigSchema.parse(llmMutatorRaw);
    return { config, configFilePath };
}
