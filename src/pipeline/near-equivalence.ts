/*
 * Gate-4 CONSERVATIVE near-equivalence filter (functional-architecture §4 Gate 4).
 * PURE, OFFLINE, bun-testable.
 *
 * `applyFilters` already drops `replacement === original` (exact string) no-ops.
 * This pass goes one conservative step further: it drops a replacement when —
 * after a STRICTLY LIMITED normalization — the replacement is provably the SAME
 * as the original. The normalization ignores ONLY:
 *   • whitespace,
 *   • redundant wrapping parens, and
 *   • a redundant runtime-identity TS cast (`x as T` / `<T>x` → `x`).
 * NOTHING ELSE.
 *
 * It must NOT drop literal-format changes (`0x10` vs `16`, `1e3` vs `1000`,
 * `'a'` vs `"a"`), operator swaps, or argument reorders — those can be
 * semantically meaningful and are the whole point of the tool. Bias: when in
 * doubt, KEEP. Every drop is LOGGED (the doc's "log every drop").
 *
 * HOW (why AST comparison is the conservative choice): we parse both `original`
 * and `replacement` with `@babel/parser` (default options DO NOT emit
 * `ParenthesizedExpression` nodes, so redundant parens and all whitespace
 * vanish from the tree for free) and compare a CANONICAL form that strips
 * position/comment/`extra` fields and unwraps TS cast expressions to their
 * operand. Because `extra.raw`/`extra.rawValue` ARE stripped, a literal-format
 * change would still differ in the literal's `value`/`pattern`/`bigint` field —
 * so `0x10` (value 16) vs `16` (value 16) WOULD canonicalize equal. To honor the
 * "do not drop literal-format changes" rule we therefore do NOT strip `extra`
 * for literal nodes; we keep `extra.raw` so a format-only change stays DISTINCT.
 * The result: parens + whitespace + no-op casts are ignored; literal format,
 * operators, and argument order are preserved.
 */

import { parse, parseExpression } from '@babel/parser';
import type { Node } from '@babel/types';

import type { Replacement } from '../seam/types';

/** Babel plugins enabling the TS + JSX superset the instrumenter also parses. */
const BABEL_PLUGINS = ['typescript', 'jsx'] as const;

/** A logger sink for dropped near-equivalents. Defaults to a no-op. */
export type DropLogger = (line: string) => void;

/** Options for {@link filterNearEquivalent}. */
export interface FilterNearEquivalentOptions {
    /** Called once per dropped replacement with a human-readable line. */
    log?: DropLogger;
}

/**
 * Parse `code` into a single AST node for comparison, trying the same ladder as
 * `isParseable` (expression, then program, then function-body), returning
 * `undefined` if none parse. We compare whatever single node the FIRST
 * successful attempt yields; if the two sides parse at DIFFERENT levels we treat
 * them as not-equivalent (KEEP) rather than risk a false drop.
 */
function parseForCompare(code: string): { node: Node; level: number } | undefined {
    try {
        return { node: parseExpression(code, { plugins: [...BABEL_PLUGINS] }), level: 0 };
    } catch {
        // not an expression
    }
    try {
        const program = parse(code, { sourceType: 'module', plugins: [...BABEL_PLUGINS] });
        return { node: program.program as unknown as Node, level: 1 };
    } catch {
        // not a program
    }
    try {
        const wrapped = parse(`function __probe__(){\n${code}\n}`, {
            sourceType: 'module',
            plugins: [...BABEL_PLUGINS],
        });
        return { node: wrapped.program as unknown as Node, level: 2 };
    } catch {
        return undefined;
    }
}

/**
 * TS cast/assertion wrapper node types whose RUNTIME value is exactly their
 * operand, so unwrapping them is a runtime-identity normalization. NOTE: the
 * angle-bracket `<T>x` assertion (`TSTypeAssertion`) is listed for completeness
 * but is unreachable here because the `jsx` parser plugin claims `<T>` as a JSX
 * element — so an angle-bracket cast is conservatively KEPT (never false-dropped),
 * which is the correct conservative behavior. The `as` and `satisfies` forms are
 * the ones that actually normalize.
 */
const TS_CAST_TYPES = new Set(['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression']);

/** Literal node types whose `extra.raw` we KEEP so a format change stays distinct. */
const LITERAL_TYPES = new Set([
    'NumericLiteral',
    'StringLiteral',
    'BigIntLiteral',
    'DecimalLiteral',
]);

/**
 * Produce a canonical, comparable representation of an AST node:
 *   • strip `start`/`end`/`loc`/`range`/`comments`/`leadingComments`/
 *     `trailingComments`/`innerComments` (position + comments never affect
 *     runtime behavior),
 *   • UNWRAP TS cast expressions to their operand (runtime identity),
 *   • for literal nodes, KEEP `extra.raw` (so `0x10` ≠ `16` stays a real change);
 *     for all other nodes, DROP `extra` (it only carries source-text trivia),
 *   • recurse into child nodes and arrays.
 *
 * The output is a plain JSON-serializable structure; two nodes are
 * near-equivalent iff their canonical forms `JSON.stringify` equal.
 */
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    const node = value as Record<string, unknown> & { type?: string };

    // Unwrap a runtime-identity TS cast to its operand before anything else.
    if (typeof node.type === 'string' && TS_CAST_TYPES.has(node.type)) {
        return canonicalize(node.expression);
    }

    const out: Record<string, unknown> = {};
    const keepExtra = typeof node.type === 'string' && LITERAL_TYPES.has(node.type);
    for (const key of Object.keys(node).sort()) {
        if (isTriviaKey(key) || (key === 'extra' && !keepExtra)) {
            continue;
        }
        out[key] = canonicalize(node[key]);
    }
    return out;
}

/** Source-trivia keys (position + comments + parse errors) stripped from the canon. */
const TRIVIA_KEYS = new Set([
    'start',
    'end',
    'loc',
    'range',
    'comments',
    'errors',
    'leadingComments',
    'trailingComments',
    'innerComments',
]);

/** True when `key` is a position/comment/error field that never affects behavior. */
function isTriviaKey(key: string): boolean {
    return TRIVIA_KEYS.has(key);
}

/**
 * True when `replacement` is conservatively near-equivalent to `original`: both
 * parse at the SAME level and their canonical forms are identical. Returns
 * `false` (KEEP) whenever either fails to parse or they parse at different
 * levels — never risk a false drop.
 */
export function isNearEquivalent(original: string, replacement: string): boolean {
    const a = parseForCompare(original);
    const b = parseForCompare(replacement);
    if (a === undefined || b === undefined || a.level !== b.level) {
        return false;
    }
    return JSON.stringify(canonicalize(a.node)) === JSON.stringify(canonicalize(b.node));
}

/**
 * Drop replacements that are conservatively near-equivalent to their `original`,
 * logging every drop with `file:line original -> replacement (reason)`. Pure:
 * returns a new array preserving the order of survivors; the input is never
 * mutated.
 *
 * @param replacements The post-`applyFilters` survivors.
 * @param options Optional drop logger.
 * @returns The survivors that are NOT near-equivalent to their original.
 */
export function filterNearEquivalent(
    replacements: readonly Replacement[],
    options: FilterNearEquivalentOptions = {},
): Replacement[] {
    const log = options.log;
    const survivors: Replacement[] = [];
    for (const r of replacements) {
        if (isNearEquivalent(r.original, r.replacement)) {
            if (log !== undefined) {
                const line = r.range.start.line;
                log(
                    `near-equivalent drop ${r.fileName}:${String(line)} ` +
                        `${r.original} -> ${r.replacement} ` +
                        '(canonical AST identical after whitespace/paren/identity-cast normalization)',
                );
            }
            continue;
        }
        survivors.push(r);
    }
    return survivors;
}
