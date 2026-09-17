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
 *            SPELLING (`0xFF` vs `255`, `0x10n` vs `16n`, quote style, UNTAGGED
 *            template raw escapes), trailing commas, redundant parentheses.
 *   KEPT:    every identifier, every literal VALUE (numeric / string / bigint /
 *            regex pattern+flags / template cooked text), every operator, every
 *            node type and the tree shape — so `(a + b) * c` ≠ `a + b * c`
 *            (Babel encodes grouping in the tree, not in the parens) — and the
 *            RAW text of a TAGGED template (`String.raw`\n`` ≠ `String.raw`<LF>``:
 *            a tag function reads `strings.raw`, so raw spelling IS behavior
 *            there, and two invalid escapes that both cook to `null` must not
 *            collide either).
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
 * The same canonical serialization is exposed per NODE ({@link nodeShape}) and
 * per EXPRESSION TEXT ({@link expressionShape}) so `range-align.ts` can re-find a
 * cached candidate's sub-expression STRUCTURALLY when the source has since been
 * respelled (whitespace, quotes, parens, an inline comment) and the verbatim
 * substring no longer matches.
 *
 * `stripComments` reuses the same parse to drop every comment span from the text
 * the MODEL reads, so a comment edit cannot steer the proposals either. It is
 * SEMANTICS-PRESERVING: a comment that owns its whole line(s) is removed with
 * the line(s) (the preceding line terminator survives, so nothing that was
 * separated by a newline is joined); any other comment becomes the line
 * terminators it contained (an ASI-sensitive `return` + block comment holding a
 * newline + `1` keeps its newline), or a single space when it contained none and
 * both neighbours are non-whitespace (so `return` + comment + `1` cannot fuse
 * into `return1`), or nothing at
 * all otherwise. Code lines are never re-flowed and template / string / regex
 * contents are never touched, so a proposal's `original` sub-expression still
 * matches the real source verbatim wherever the source line had no comment.
 */

import { createHash } from 'node:crypto';
import { parse, parseExpression, type ParserOptions } from '@babel/parser';

import { BABEL_PLUGINS } from './babel-walk';

/**
 * AST keys carrying positional or formatting data (never semantics). Dropped
 * from the canonical serialization at EVERY depth. `extra` holds `raw` /
 * `rawValue` / `parenthesized` / `parenStart` / `trailingComma`. (`raw` under
 * `TemplateElement.value` is handled separately — see {@link childKeepsRaw}.)
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
 * The one recoverable parse error a function-slice wrapper is allowed to
 * record: a private name (`this.#x`) the bare `class {}` wrapper cannot
 * resolve. The method's real class declares it; the fingerprint only needs the
 * tree shape.
 */
const TOLERATED_REASON = 'InvalidPrivateFieldResolution';

/** The tolerated set for a function-slice parse: just {@link TOLERATED_REASON}. */
const TOLERATED_FUNCTION_REASONS: ReadonlySet<unknown> = new Set([TOLERATED_REASON]);

/**
 * The recoverable CONTEXT errors a bare sub-expression parse may record: each
 * is legal inside the enclosing function the expression was cut from (a method
 * body, a generator, a constructor) and only "wrong" because the expression is
 * parsed on its own. A real syntax error is never in this set.
 */
const TOLERATED_EXPRESSION_REASONS: ReadonlySet<unknown> = new Set([
    TOLERATED_REASON,
    'YieldNotInGeneratorFunction',
    'UnexpectedSuper',
    'UnexpectedNewTarget',
]);

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
 * other than those in `tolerated`; `undefined` otherwise (a thrown
 * unrecoverable error, or any other recovered error).
 */
function tryParse(parseRoute: () => ParsedWithErrors, tolerated: ReadonlySet<unknown>): unknown {
    let ast: ParsedWithErrors;
    try {
        ast = parseRoute();
    } catch {
        return undefined;
    }
    const errors = ast.errors ?? [];
    return errors.every(error => tolerated.has(error.reasonCode)) ? ast : undefined;
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
        const ast = tryParse(
            () => parseExpression(`${prefix}${text}${suffix}`, PARSE_OPTIONS),
            TOLERATED_FUNCTION_REASONS,
        );
        if (ast !== undefined) {
            return { ast, shift: prefix.length };
        }
    }
    const program = tryParse(() => parse(text, PARSE_OPTIONS), TOLERATED_FUNCTION_REASONS);
    return program === undefined ? undefined : { ast: program, shift: 0 };
}

/**
 * Whether `key` of a node of type `type` is serialized with template RAW text
 * kept, given whether the node itself is. Raw survives only along the path
 * `TaggedTemplateExpression.quasi` → `TemplateLiteral.quasis[]` →
 * `TemplateElement.value.raw`; the `${…}` expressions of a tagged template (and
 * every other child) reset to the raw-dropping default.
 */
function childKeepsRaw(type: unknown, key: string, keepRaw: boolean): boolean {
    if (type === 'TaggedTemplateExpression') {
        return key === 'quasi';
    }
    if (type === 'TemplateLiteral') {
        return keepRaw && key === 'quasis';
    }
    if (type === 'TemplateElement') {
        return keepRaw && key === 'value';
    }
    return false;
}

/**
 * Canonical serialization: object keys in sorted order, arrays in order,
 * positional/formatting keys dropped, primitives JSON-encoded. Not JSON (no
 * need to parse it back) — just a deterministic string to hash.
 *
 * Two value normalizations: a `BigIntLiteral.value` is rewritten to its
 * canonical decimal digits (Babel keeps the source spelling — `0x10` — minus
 * separators, so `0x10n` and `16n` would otherwise differ); and
 * `TemplateElement.value.raw` is kept only under a TAGGED template (`keepRaw`),
 * dropped everywhere else so an untagged template's escape spelling is ignored.
 */
function canonicalize(value: unknown, keepRaw = false): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(item => canonicalize(item, keepRaw)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const { type } = record;
    const keys = Object.keys(record)
        .filter(key => !DROPPED_KEYS.has(key) && (key !== 'raw' || keepRaw))
        .sort();
    const parts = keys.map(key => {
        const child = record[key];
        if (type === 'BigIntLiteral' && key === 'value') {
            return `value:${canonicalBigInt(child)}`;
        }
        return `${key}:${canonicalize(child, childKeepsRaw(type, key, keepRaw))}`;
    });
    return `{${parts.join(',')}}`;
}

/**
 * The canonical decimal digits of a `BigIntLiteral.value`. Babel 7 stores the
 * source spelling minus numeric separators as a string (`"0x10"`; Babel 8 will
 * store a `bigint`) and the parser has already validated the literal, so
 * `BigInt()` — which accepts every JS integer prefix — always converts it.
 */
function canonicalBigInt(value: unknown): string {
    return BigInt(String(value).replaceAll('_', '')).toString(10);
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

/**
 * The canonical structural serialization of ONE already-parsed AST node — the
 * same string {@link functionFingerprint} hashes, unhashed. Two nodes with equal
 * shapes are the same expression up to comments, whitespace, literal spelling
 * and redundant parens. Used by `range-align.ts` to compare candidate nodes of
 * the CURRENT source against a cached candidate's {@link expressionShape}.
 */
export function nodeShape(node: unknown): string {
    return canonicalize(node);
}

/**
 * The canonical structural serialization of a sub-expression's SOURCE TEXT (a
 * cached candidate's `original`), or `undefined` when the text is not a single
 * expression. Parsed with the pipeline's plugin set; the context errors a bare
 * sub-expression cannot avoid (`this.#x`, `super.x`, `yield x`, `new.target`)
 * are tolerated because the expression was cut from a function where they are
 * legal — a real syntax error still yields `undefined`.
 */
export function expressionShape(text: string): string | undefined {
    const ast = tryParse(() => parseExpression(text, PARSE_OPTIONS), TOLERATED_EXPRESSION_REASONS);
    return ast === undefined ? undefined : canonicalize(ast);
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

/** Whitespace other than a line feed (what may surround a whole-line comment on its lines). */
const INLINE_BLANK = /^[^\S\n]*$/;

/** One splice to apply to the text: replace `[start, end)` with `replacement`. */
interface Splice extends CommentSpan {
    replacement: string;
}

/**
 * Decide how ONE comment leaves the text (see the module header):
 *   - it owns its whole line(s) (only blanks before it on its first line, only
 *     blanks after it up to the line feed that ends its last line) → the lines
 *     go, line feed included; the line feed BEFORE it survives untouched;
 *   - otherwise it becomes exactly the line feeds it contained (`\r\n` → `\n`),
 *     or a single space when it had none and sits between two non-blank
 *     characters, or nothing when a neighbour is already blank / an edge.
 * All decisions are made against the ORIGINAL text, so they are independent of
 * the order the splices are applied in.
 */
function spliceFor(text: string, { start, end }: CommentSpan): Splice {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineFeed = text.indexOf('\n', end);
    const lineEnd = lineFeed === -1 ? text.length : lineFeed;
    const ownsLines =
        INLINE_BLANK.test(text.slice(lineStart, start)) &&
        INLINE_BLANK.test(text.slice(end, lineEnd));
    if (ownsLines) {
        return { start: lineStart, end: lineFeed === -1 ? lineEnd : lineEnd + 1, replacement: '' };
    }
    const lineFeeds = text.slice(start, end).replaceAll(/[^\n]/g, '');
    if (lineFeeds.length > 0) {
        return { start, end, replacement: lineFeeds };
    }
    // `charAt` is '' at either edge of the text, which reads as "not a token".
    const fused = /\S/.test(text.charAt(start - 1)) && /\S/.test(text.charAt(end));
    return { start, end, replacement: fused ? ' ' : '' };
}

/**
 * Remove every comment from a function's source text WITHOUT changing what the
 * text means (line terminators and token separation survive; see the module
 * header) and without touching any code line: a comment owning its whole
 * line(s) disappears with them, an inline one leaves the line feeds it held (or
 * one space if two tokens would otherwise fuse). Returns the text unchanged
 * when it does not parse.
 */
export function stripComments(text: string): string {
    const parsed = parseFunctionText(text);
    if (parsed === undefined) {
        return text;
    }
    const splices = commentSpans(parsed).map(span => spliceFor(text, span));
    // `@babel/parser` emits comments in source order and a whole-line splice
    // never overlaps another comment (a second comment on the line would have
    // broken its blank-only prefix / suffix); apply from the end so earlier
    // offsets stay valid.
    let out = text;
    for (const { start, end, replacement } of splices.toReversed()) {
        out = out.slice(0, start) + replacement + out.slice(end);
    }
    return out;
}
