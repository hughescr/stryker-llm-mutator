/*
 * The `mutate`-glob SOURCE READER (functional-architecture §4 targeting) — the
 * single implementation shared by the `stryker-llm` CLI driver (`run.ts`) and the
 * `withLlmMutators(...)` config-wrapper (`with-llm-mutators.ts`). Both run the
 * dynamic-LLM pre-pass over the SAME files Stryker will mutate, so they must read
 * that file set identically; factoring it here keeps one glob implementation
 * rather than two that could drift.
 *
 * Node-only in the sense that it touches the filesystem, but it imports NEITHER
 * Stryker nor any network module — it is a thin wrapper over `node:fs/promises`
 * `glob` + `readFile`, so it is safe to import from the Node-only `stryker run`
 * process (the wrapper) and from the `stryker-llm` bin alike. Bun also implements
 * this `node:fs/promises` `glob`, so the same code runs under both runtimes.
 *
 * It yields absolute fileNames + content (the shape the pure pre-pass + map
 * builder key on — see the locKey contract in `src/pipeline/llm-map.ts`).
 */

import { glob, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { SourceFileInput } from '../pipeline/targeting';

/** The default `mutate` glob when the target config sets none. */
export const DEFAULT_MUTATE_PATTERNS: readonly string[] = ['src/**/*.ts'];

/**
 * Read the source files Stryker will mutate (the `mutate` glob set), so the
 * dynamic-LLM pre-pass can target them. Resolves each match against `projectDir`
 * to the ABSOLUTE fileName the pre-pass + reporter key on.
 *
 * Uses Node 26's `glob` from `node:fs/promises` (an async iterator). It yields
 * paths RELATIVE to its `cwd` option, so each match is resolved against
 * `projectDir`. Negated `!`-patterns are not handled (matching the prior Bun
 * behaviour): each pattern is treated positively. An absent/empty `patterns`
 * falls back to {@link DEFAULT_MUTATE_PATTERNS}.
 *
 * @param projectDir The project root the globs and absolute fileNames resolve against.
 * @param patterns The `mutate` globs (the resolved Stryker `mutate` value), or empty for the default.
 * @returns Absolute-path source files (`{ fileName, content }`), de-duplicated.
 */
export async function readMutateSources(
    projectDir: string,
    patterns: readonly string[] | undefined,
): Promise<SourceFileInput[]> {
    const root = resolve(projectDir);
    const effective =
        patterns !== undefined && patterns.length > 0 ? patterns : DEFAULT_MUTATE_PATTERNS;

    const seen = new Set<string>();
    const files: SourceFileInput[] = [];
    for (const pattern of effective) {
        // oxlint-disable-next-line no-await-in-loop -- sequential glob scans accumulate into one set; the volume is small (one or a few patterns).
        for await (const match of glob(pattern, { cwd: root })) {
            // Node yields cwd-relative paths; resolve to the absolute fileName.
            const absolute = resolve(root, match);
            if (seen.has(absolute)) {
                continue;
            }
            seen.add(absolute);
            // oxlint-disable-next-line no-await-in-loop -- reading discovered files; bounded by the mutate glob set.
            const content = await readFile(absolute, 'utf8');
            files.push({ fileName: absolute, content });
        }
    }
    return files;
}
