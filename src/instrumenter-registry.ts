/*
 * The instrumenter `allMutators` REGISTRY RESOLVER (functional-architecture §3 /
 * M6 consumability). This is the ONE module that reaches Stryker's hardcoded
 * `allMutators` array — and it does so via REAL Node resolution so the array we
 * mutate is the SAME hoisted instance the consumer's `stryker run` instruments
 * with, NOT a copy.
 *
 * WHY NOT A STATIC DEEP IMPORT (the M0–M5 path, now removed):
 *   `src/injection.ts` used to `import { allMutators } from
 *   '../node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js'`.
 *   Two problems made that fail an INSTALLED + HOISTED consumer:
 *     (1) The relative `../node_modules/...` path only resolves when the importing
 *         module sits beside THIS repo's `node_modules`. Hoisted in a consumer's
 *         tree it points nowhere.
 *     (2) Worse: bun's bundler (no `--packages=external`) INLINED the whole
 *         instrumenter — including a PRIVATE copy of `allMutators` — into
 *         `dist/index.js`. Pushing to that copy never touched the live array
 *         Stryker reads, so injection SILENTLY no-op'd.
 *   Either way the consumer got zero of our mutants.
 *
 * THE FIX — resolve at runtime, keep the import opaque to the bundler:
 *   The instrumenter `package.json` `exports` map exposes ONLY `.`
 *   (→ dist/src/index.js) and `./package.json`; the internal `mutate.js` is NOT a
 *   public subpath, so we cannot `import('@stryker-mutator/instrumenter/...mutate.js')`
 *   directly. Instead we resolve the package's `package.json` (a permitted subpath),
 *   take its directory, and JOIN the internal `dist/src/mutators/mutate.js` path:
 *     • `createRequire(import.meta.url).resolve('@stryker-mutator/instrumenter/package.json')`
 *       finds the HOISTED instance (the same one Stryker's own `@stryker-mutator/core`
 *       resolves, since both go through normal Node resolution from the consumer's tree).
 *     • The instrumenter dist is ESM (`type: module`), so `mutate.js` must be LOADED
 *       via a dynamic `import()` of its `file://` URL — `require()` cannot load ESM.
 *   Because the dynamic-import specifier is a RUNTIME-COMPUTED string (a file URL
 *   built from the resolved path), bun's bundler cannot see a literal specifier to
 *   inline — so the instrumenter stays EXTERNAL automatically, fixing problem (2)
 *   without any `--packages=external` gymnastics on this module.
 *
 * TOP-LEVEL AWAIT — why the heuristics path stays synchronous:
 *   The dynamic `import()` is the only async step. We do it ONCE here at module
 *   load via ESM top-level await. Any module that statically imports `{ allMutators }`
 *   from this registry waits for that resolution as part of ITS OWN load. So by the
 *   time `withLlmMutators(...)` runs (during the consumer's `stryker.conf.mjs`
 *   evaluation — AFTER every static import in the package graph has settled),
 *   `allMutators` is already a settled binding. `injectMutators(...)` in the
 *   synchronous heuristics branch then touches a ready array with NO await: the
 *   heuristics path is synchronous from the caller's perspective. The dynamicLLM
 *   path is awaited explicitly by the consumer (`export default await ...`).
 *
 * SAME-INSTANCE GUARANTEE: ESM caches one module instance per RESOLVED path, so
 * re-importing this same file URL yields the same array object — the very instance
 * `babel-transformer.js` captured as its `mutators = allMutators` default. The
 * canary asserts this identity (resolution-parity) so a hoist/exports-map
 * regression fails loudly instead of silently no-op'ing.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { NodeMutator } from './mutators/index';

/**
 * Resolve the absolute path to the instrumenter's internal `mutate.js` via real
 * Node resolution against the HOISTED `@stryker-mutator/instrumenter` instance.
 * Exported so the canary can assert resolution-parity (this path === the path the
 * worker deep-imports) without duplicating the join logic.
 *
 * Resolves `@stryker-mutator/instrumenter/package.json` (a permitted `exports`
 * subpath) and joins the internal dist path — the package's `exports` map does NOT
 * expose `mutate.js` directly, so we cannot resolve it as a subpath.
 *
 * @returns The absolute filesystem path to `dist/src/mutators/mutate.js`.
 */
export function resolveMutatePath(): string {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve('@stryker-mutator/instrumenter/package.json');
    return join(dirname(pkgJsonPath), 'dist', 'src', 'mutators', 'mutate.js');
}

/** The shape of the instrumenter's `mutate.js` module — only `allMutators` is used. */
interface MutateModule {
    allMutators: NodeMutator[];
}

/**
 * Stryker's live, hardcoded `allMutators` registry — the exact array instance the
 * in-process instrumenter reads by reference. Resolved ONCE at module load via the
 * runtime-resolution + dynamic-import described in the module header (top-level
 * await), so consumers importing this binding get a settled array with no further
 * awaiting. `injectMutators` mutates THIS array in place.
 */
export const allMutators: NodeMutator[] = await (async (): Promise<NodeMutator[]> => {
    const mutatePath = resolveMutatePath();
    const mod = (await import(pathToFileURL(mutatePath).href)) as MutateModule;
    return mod.allMutators;
})();
