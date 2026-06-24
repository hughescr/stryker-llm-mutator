/*
 * Shared replacement-string → AST-node parser (functional-architecture §3 /
 * §4 Gate 4). PURE, OFFLINE, bun-safe.
 *
 * The out-of-band instrument worker (`src/seam/instrument-worker.mjs`) parses
 * each LLM replacement string into the single AST node Stryker's placers graft
 * in, by WRAPPING the fragment in parens (`(${code})`) and reading the resulting
 * expression. That wrap is what lets a bare object literal (`{ a: 1 }`) or a
 * sequence-shaped fragment parse as an EXPRESSION rather than a block. This
 * module is the canonical, single-source implementation of that logic so the
 * dynamic-LLM map-builder and the injected `LLMMutator` parse replacements the
 * SAME way the worker does — no drift between the two.
 *
 * WHY `@babel/parser` (not the worker's `@babel/core`): the worker runs in a
 * Node child process because `@babel/core`'s default-interop trips under Bun
 * (`generate.default` is undefined). The map-builder + `LLMMutator`, by
 * contrast, are PURE modules that must be exercised under `bun test`, so they
 * cannot import `@babel/core`. `@babel/parser`'s `parseExpression` runs cleanly
 * under Bun and — verified for conditional / binary / object / logical / call /
 * TS-cast fragments — yields the SAME expression node the worker's parens-wrap
 * produces. `@babel/parser` is already a direct dependency (it backs `filters.ts`
 * and Stryker's own instrumenter), so the version stays in lockstep.
 *
 * EXPRESSION-ONLY (deliberate): a statement-shaped fragment like `return x;`
 * does NOT parse as an expression — `parseExpression('(return x;)')` throws.
 * That mirrors the worker, which reads `.expression` off the parsed program and
 * would likewise fail on a statement. Such replacements are dropped-and-logged
 * by the map-builder (they would be rejected by Stryker's placers at an
 * expression position anyway). {@link parseReplacementFragment} therefore returns
 * `undefined` rather than throwing, so the caller can log the drop cleanly.
 */

import { parseExpression } from '@babel/parser';
import type { Node } from '@babel/types';

/** Babel plugins enabling the TS + JSX superset the instrumenter also parses. */
const BABEL_PLUGINS = ['typescript', 'jsx'] as const;

/**
 * Parse a replacement source fragment into a single expression AST node,
 * wrapping in parens exactly as `instrument-worker.mjs` `parseFragment` does so
 * object/sequence-shaped fragments parse as expressions. Returns the parsed
 * {@link Node} on success, or `undefined` when the fragment is not a valid
 * expression (e.g. a statement-shaped replacement, or syntactically invalid
 * text) — the caller decides whether to drop-and-log.
 *
 * Pure and offline: `@babel/parser` does no I/O and no network. A FRESH node is
 * produced on every call (the parser allocates a new tree), which is exactly the
 * distinct-node-identity-per-yield property the `LLMMutator` relies on (yielding
 * the same node object for two candidates collapses them in Stryker's placement
 * map).
 */
export function parseReplacementFragment(code: string): Node | undefined {
    try {
        return parseExpression(`(${code})`, { plugins: [...BABEL_PLUGINS], errorRecovery: false });
    } catch {
        return undefined;
    }
}
