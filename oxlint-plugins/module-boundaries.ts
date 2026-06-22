/**
 * oxlint JS plugin: module-boundaries (STUB — NOT FUNCTIONAL)
 *
 * Intended port of @hughescr/eslint-plugin-module-boundaries (v1.0.0). All three
 * upstream rules are TYPE-AWARE: they call `context.sourceCode.parserServices
 * .program` to obtain the TypeScript Program and use `ts.resolveModuleName` +
 * `ts.getJSDocTags` to resolve re-export sources across files and inspect
 * `@internal` JSDoc tags.
 *
 * oxlint's custom-JS-plugin API exposes ESTree visitors + scope analysis ONLY.
 * Its `context.sourceCode.parserServices` is explicitly EMPTY
 * ("Oxlint does not offer any parser services" — oxlint/plugins-dev typings).
 * There is NO TypeScript Program / TypeChecker / esTreeNodeToTSNodeMap. The
 * separate type-aware path (oxlint-tsgolint) powers native Rust rules only and
 * does NOT feed type info into JS plugins.
 *
 * Therefore these rules CANNOT be ported as-written. They are intentionally left
 * as commented stubs rather than silently dropped, so the gap is visible. See
 * docs/oxlint-coverage.md for the honest mapping. If type-aware boundary
 * enforcement is later required, run @hughescr/eslint-plugin-module-boundaries as
 * a separate (ESLint) pass — that contradicts the project's full-oxlint decision,
 * so it is documented, not wired in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Original: @hughescr/eslint-plugin-module-boundaries
 *   https://github.com/hughescr/eslint-plugin-module-boundaries
 *   Copyright (c) 2026 Craig Hughes — BSD-3-Clause.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LOST RULES (no oxlint JS-plugin equivalent — require TS parserServices):
 *   - no-internal-in-barrel        : resolve re-export sources + inspect @internal JSDoc
 *   - no-star-export-from-non-barrel: resolve `export *` target to check it is an index.ts barrel
 *   - no-cross-module-internal     : picomatch module assignment + resolveModuleName + @internal JSDoc
 *
 * A weaker purely-syntactic approximation of no-star-export-from-non-barrel
 * (compare the basename of the literal import path string) is theoretically
 * possible but loses correctness for re-exports that resolve through path
 * mappings / package boundaries, so it is deliberately NOT shipped here.
 *
 * This file is NOT registered in .oxlintrc.json jsPlugins — it exists only to
 * document the gap and to host a future implementation if oxlint ever exposes
 * type information to JS plugins.
 */

import type { Plugin } from 'oxlint/plugins-dev';

// Intentionally empty: the three module-boundaries rules cannot be implemented
// without a TypeScript Program, which oxlint JS plugins do not provide.
const plugin: Plugin = {
    meta: { name: 'module-boundaries' },
    rules: {
        // TODO(type-aware): port once/if oxlint exposes parserServices.program to
        // JS plugins. Until then these remain LOST — see docs/oxlint-coverage.md.
        //
        // 'no-internal-in-barrel':          ...,  // needs ts.resolveModuleName + ts.getJSDocTags
        // 'no-star-export-from-non-barrel': ...,  // needs ts.resolveModuleName (resolve to index.ts)
        // 'no-cross-module-internal':       ...,  // needs picomatch + resolveModuleName + @internal JSDoc
    },
};

export default plugin;
