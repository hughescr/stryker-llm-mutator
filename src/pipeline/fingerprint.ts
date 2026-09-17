/*
 * Structural function fingerprint + comment stripper for the LLM response
 * cache key (functional-architecture §4 Gate 4 caching / §7 reproducibility).
 * PURE, OFFLINE, bun-safe — `@babel/parser` only.
 *
 * WHY: the cache used to be keyed by the VERBATIM function text embedded in the
 * prompt, so adding a `// Stryker disable` comment (or any comment), reformatting,
 * or respelling a literal invalidated the entry and bought a FRESH set of
 * proposals — a new mutant set for code whose behavior had not changed. The
 * fingerprint is the SHA-256 of a canonical AST serialization with every
 * positional + formatting artefact removed, so the key survives exactly the edits
 * that cannot change what a good mutation of the function looks like:
 *
 *   IGNORED: comments (anywhere), whitespace / newlines / indentation, literal
 *            SPELLING (`0xFF` vs `255`, quote style, template raw escapes),
 *            trailing commas, redundant parentheses.
 *   KEPT:    every identifier, every literal VALUE (numeric / string / bigint /
 *            regex pattern+flags / template cooked text), every operator, every
 *            node type and the tree shape — so `(a + b) * c` ≠ `a + b * c`
 *            (Babel encodes grouping in the tree, not in the parens).
 *
 * The function text handed to the pipeline is the exact `[start, end)` slice of
 * an enclosing-function node (`targeting.ts`), which is NOT always a standalone
 * program: an `ObjectMethod` (`foo(a) { … }`) or a `ClassMethod` with TS
 * modifiers (`private static foo() { … }`) only parses inside its container. We
 * therefore try a fixed cascade of wrappers — bare expression, object literal,
 * class body — with the same `@babel/parser` + plugin set the rest of the
 * pipeline uses, and take the first that parses. A given token stream always
 * takes the same route, so the digest is stable. Each suffix starts on a fresh
 * line so a trailing `// line comment` cannot swallow it. The parse runs with
 * `errorRecovery` ONLY so that a method body reading a private field of its
 * class (`this.#backend`) — which Babel otherwise rejects as unresolved inside a
 * bare `class {}` wrapper — still yields its AST; every other recorded error
 * still rejects that wrapper.
 *
 * `stripComments` reuses the same parse to drop every comment span from the text
 * the MODEL reads, so a comment edit cannot steer the proposals either. All
 * other whitespace is preserved so a proposal's `original` sub-expression still
 * matches the real source verbatim (the node-alignment contract in
 * `range-align.ts`); only runs of 3+ blank lines (what whole-line comments
 * leave behind) collapse to one.
 */

import { createHash } from 'node:crypto';
import { parse, parseExpression, type ParserOptions } from '@babel/parser';

import { BABEL_PLUGINS } from './babel-walk';

/**
 * AST keys carrying positional or formatting data (never semantics). Dropped
 * from the canonical serialization at EVERY depth. `extra` holds `raw` /
 * `rawValue` / `parenthesized` / `parenStart` / `trailingComma`; `raw` also
 * appears under `TemplateElement.value` (its `cooked` sibling is kept).
 */
const DROPPED_KEYS = new Set([
    'loc',
    'start',
    'end',
    'range',
    'comments',
    'leadingComments',
    'trailingComments',
    'innerComments',
    'tokens',
    'errors',
    'extra',
    'raw',
]);

/**
 * The wrappers tried, in order, to parse a function's source slice: a bare
 * expression (function declarations / expressions / arrows), an object literal
 * (`ObjectMethod`), and a class body (`ClassMethod`, incl. TS modifiers). Each
 * carries the prefix length so comment offsets can be mapped back onto the text.
 * A slice none of these fit (e.g. a multi-statement CONTEXT block) is last tried
 * as a whole module program.
 */
const WRAPPERS: ReadonlyArray<{ prefix: string; suffix: string }> = [
    { prefix: '(', suffix: '\n)' },
    { prefix: '({', suffix: '\n})' },
    // `extends Object` so a constructor slice calling `super(…)` parses too.
    { prefix: '(class extends Object {', suffix: '\n})' },
];

/** The parser options shared by every route: TS+JSX, module mode, recoverable errors kept. */
const PARSE_OPTIONS: ParserOptions = {
    plugins: [...BABEL_PLUGINS],
    // Module mode so `import.meta` inside a function body parses.
    sourceType: 'module',
    errorRecovery: true,
};

/**
 * The one recoverable parse error a wrapper is allowed to record: a private
 * name (`this.#x`) the bare `class {}` wrapper cannot resolve. The method's
 * real class declares it; the fingerprint only needs the tree shape.
 */
const TOLERATED_REASON = 'InvalidPrivateFieldResolution';

/** A recorded (recoverable) parse error, narrowed to the field we inspect. */
interface RecoveredError {
    reasonCode?: unknown;
}

/** The slice of a Babel parse result we inspect: its recorded errors. */
interface ParsedWithErrors {
    errors?: RecoveredError[] | null;
}

/**
 * Run one parse route. Returns the AST when it parsed with no recorded error
 * other than {@link TOLERATED_REASON}; `undefined` otherwise (a thrown
 * unrecoverable error, or any other recovered error).
 */
function tryParse(parseRoute: () => ParsedWithErrors): unknown {
    let ast: ParsedWithErrors;
    try {
        ast = parseRoute();
    } catch {
        return undefined;
    }
    const errors = ast.errors ?? [];
    return errors.every(error => error.reasonCode === TOLERATED_REASON) ? ast : undefined;
}

/** A parsed function slice: the AST plus the wrapper prefix length to subtract from offsets. */
interface ParsedFunctionText {
    ast: unknown;
    shift: number;
}

/**
 * Parse a function's source slice via the wrapper cascade. Returns `undefined`
 * when no wrapper yields a valid parse (the caller falls back to text hashing).
 */
function parseFunctionText(text: string): ParsedFunctionText | undefined {
    for (const { prefix, suffix } of WRAPPERS) {
        const ast = tryParse(() => parseExpression(`${prefix}${text}${suffix}`, PARSE_OPTIONS));
        if (ast !== undefined) {
            return { ast, shift: prefix.length };
        }
    }
    const program = tryParse(() => parse(text, PARSE_OPTIONS));
    return program === undefined ? undefined : { ast: program, shift: 0 };
}

/**
 * Canonical serialization: object keys in sorted order, arrays in order,
 * positional/formatting keys dropped, primitives JSON-encoded. Not JSON (no
 * need to parse it back) — just a deterministic string to hash.
 */
function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
        .filter(key => !DROPPED_KEYS.has(key))
        .sort();
    return `{${keys.map(key => `${key}:${canonicalize(record[key])}`).join(',')}}`;
}

/** Hex SHA-256 of a string. */
function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

/**
 * The structural fingerprint of one function's source text: hex SHA-256 of the
 * canonical AST serialization (see the module header for what is ignored and
 * what is kept). When the text does not parse under any wrapper, falls back to
 * the SHA-256 of the whitespace-collapsed text — still stable across
 * reformatting, but comment-sensitive (nothing was parsed).
 */
export function functionFingerprint(text: string): string {
    const parsed = parseFunctionText(text);
    if (parsed === undefined) {
        return sha256(text.replace(/\s+/g, ' ').trim());
    }
    return sha256(canonicalize(parsed.ast));
}

/** A comment's `[start, end)` offsets in the ORIGINAL (unwrapped) text. */
interface CommentSpan {
    start: number;
    end: number;
}

/** Read the comment offsets off a parsed slice, shifted back onto the original text. */
function commentSpans(parsed: ParsedFunctionText): CommentSpan[] {
    const comments = (parsed.ast as { comments?: unknown }).comments;
    if (!Array.isArray(comments)) {
        return [];
    }
    const spans: CommentSpan[] = [];
    for (const comment of comments) {
        const { start, end } = comment as { start?: unknown; end?: unknown };
        if (typeof start === 'number' && typeof end === 'number') {
            spans.push({ start: start - parsed.shift, end: end - parsed.shift });
        }
    }
    return spans;
}

/**
 * Remove every comment from a function's source text, preserving all other
 * whitespace byte-for-byte (so sub-expression substrings still match the real
 * source) and collapsing any run of 3+ blank lines to a single blank line.
 * Returns the text unchanged when it does not parse.
 */
export function stripComments(text: string): string {
    const parsed = parseFunctionText(text);
    if (parsed === undefined) {
        return text;
    }
    const spans = commentSpans(parsed);
    if (spans.length === 0) {
        return text;
    }
    // `@babel/parser` emits comments in source order; splice each span out from
    // the end so earlier offsets stay valid.
    let out = text;
    for (const { start, end } of spans.toReversed()) {
        out = out.slice(0, start) + out.slice(end);
    }
    return out.replace(/\n(?:[ \t]*\n){3,}/g, '\n\n');
}
