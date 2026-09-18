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
 * separated by a newline is joined); any other comment becomes ONE line feed
 * when it contained any ECMAScript line terminator — LF, CR, LS or PS, each a
 * newline for ASI (`return` + block comment holding one + `1` keeps a newline)
 * — or a single space when it contained none and both neighbours are
 * non-whitespace (so `return` + comment + `1` cannot fuse into `return1`), or
 * nothing at all otherwise. Code lines are never re-flowed and template /
 * string / regex contents are never touched, so a proposal's `original`
 * sub-expression still matches the real source verbatim wherever the source
 * line had no comment.
 *
 * When a slice parses under NO wrapper, `functionFingerprint` hashes a
 * FALLBACK text instead: comments removed by a small tolerant scanner (string /
 * template / regex aware, so `'//'` inside a literal is not a comment), runs of
 * spaces and tabs collapsed, lines trimmed — but NEWLINES KEPT, because with
 * nothing parsed a moved newline may be ASI-behavioural (`return\nx` is not
 * `return x`). It is expected to be rare and is reported through the optional
 * `log` sink each time it is used.
 */

import { createHash } from 'node:crypto';
import { parse, parseExpression, type ParserOptions } from '@babel/parser';
import type { Node } from '@babel/types';

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

/** An ECMAScript line terminator: LF, CR, LS or PS (each ends a line for ASI). */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/** Every line-terminator spelling, for normalizing to a bare LF. */
const LINE_TERMINATORS = /\r\n?|[\u2028\u2029]/g;

/**
 * A character after which a `/` starts a REGEX literal rather than a division:
 * an operator, an opener or a separator. An identifier, a literal or a closer
 * (`a`, `1`, `)`, `]`) before the `/` makes it a division.
 */
const REGEX_PRECEDER = /[(,=:[!&|?{};+\-*%<>~^]$/;

/** Keywords after which a `/` starts a regex (`return /x/`), not a division. */
const REGEX_KEYWORDS: ReadonlySet<string> = new Set([
    'return',
    'typeof',
    'case',
    'do',
    'else',
    'in',
    'of',
    'instanceof',
    'new',
    'delete',
    'void',
    'throw',
    'yield',
    'await',
]);

/** Whether a `/` at the current position (given the code emitted so far) opens a regex. */
function startsRegex(before: string): boolean {
    const trimmed = before.trimEnd();
    if (trimmed.length === 0 || REGEX_PRECEDER.test(trimmed)) {
        return true;
    }
    const word = /[$A-Z_a-z][\w$]*$/.exec(trimmed)?.[0];
    return word !== undefined && REGEX_KEYWORDS.has(word);
}

/**
 * The end offset (exclusive) of a `'`/`"` string starting at `start`: past its
 * closing quote, honouring backslash escapes; an unterminated string ends at
 * the line terminator (or the text end), as the tolerant scan requires.
 */
function scanQuoted(text: string, start: number): number {
    const quote = text.charAt(start);
    let i = start + 1;
    while (i < text.length) {
        const ch = text.charAt(i);
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === quote) {
            return i + 1;
        }
        if (LINE_TERMINATOR.test(ch)) {
            return i;
        }
        i += 1;
    }
    return text.length;
}

/**
 * The end offset (exclusive) of a regex literal starting at `start`: past its
 * closing `/` and flags, honouring escapes and `[…]` classes (where `/` is
 * literal); an unterminated regex ends at the line terminator or the text end.
 */
function scanRegex(text: string, start: number): number {
    let i = start + 1;
    let inClass = false;
    while (i < text.length) {
        const ch = text.charAt(i);
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (LINE_TERMINATOR.test(ch)) {
            return i;
        }
        if (ch === '[') {
            inClass = true;
        } else if (ch === ']') {
            inClass = false;
        } else if (ch === '/' && !inClass) {
            i += 1;
            while (i < text.length && /[a-z]/i.test(text.charAt(i))) {
                i += 1;
            }
            return i;
        }
        i += 1;
    }
    return text.length;
}

/**
 * Remove comments from text that does NOT parse, with a small hand scanner that
 * is string-, template- and regex-aware enough not to eat `'//'` inside a
 * string, a template (including code inside its `${…}`) or a regex. A line
 * comment goes; a block comment becomes a single LF when it held any line
 * terminator (ASI) else a single space. Tolerant by design: an unterminated
 * string / regex / comment ends at the next line terminator or the text end,
 * and a `/` after `)` is read as a division (the only truly ambiguous spot).
 */
function stripCommentsTolerant(text: string): string {
    let out = '';
    let i = 0;
    /** Open template `${` substitutions: the brace depth each one closes at. */
    const substitutions: number[] = [];
    let braces = 0;
    let inTemplate = false;
    while (i < text.length) {
        if (inTemplate) {
            // Template text runs to its closing backtick or the next `${`, both
            // of which return to code mode (a `${` opens a substitution).
            const { end, opensSubstitution } = scanTemplateText(text, i);
            if (opensSubstitution) {
                substitutions.push(braces);
                braces += 1;
            }
            out += text.slice(i, end);
            i = end;
            inTemplate = false;
            continue;
        }
        const comment = scanComment(text, i);
        if (comment !== undefined) {
            out += comment.replacement;
            i = comment.end;
            continue;
        }
        const ch = text.charAt(i);
        let end = i + 1;
        if (ch === '"' || ch === "'") {
            end = scanQuoted(text, i);
        } else if (ch === '/' && startsRegex(out)) {
            end = scanRegex(text, i);
        } else if (ch === '`') {
            inTemplate = true;
        } else if (ch === '{') {
            braces += 1;
        } else if (ch === '}') {
            braces -= 1;
            if (substitutions.at(-1) === braces) {
                substitutions.pop();
                inTemplate = true;
            }
        }
        out += text.slice(i, end);
        i = end;
    }
    return out;
}

/**
 * Scan template text from `start` (just past a backtick or a substitution's
 * closing `}`) to the end of its literal run: past the closing backtick, or
 * past a `${` (`opensSubstitution`). Backslash escapes are honoured; an
 * unterminated template runs to the text end.
 */
function scanTemplateText(
    text: string,
    start: number,
): { end: number; opensSubstitution: boolean } {
    let i = start;
    while (i < text.length) {
        const ch = text.charAt(i);
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === '`') {
            return { end: i + 1, opensSubstitution: false };
        }
        if (ch === '$' && text.charAt(i + 1) === '{') {
            return { end: i + 2, opensSubstitution: true };
        }
        i += 1;
    }
    return { end: text.length, opensSubstitution: false };
}

/**
 * When a comment starts at `start`, its end offset (exclusive) and what stands
 * in for it: nothing for a line comment (its terminator is kept), one LF for a
 * block comment holding any line terminator, else one space. An unterminated
 * block comment runs to the text end. `undefined` when no comment starts here.
 */
function scanComment(
    text: string,
    start: number,
): { end: number; replacement: string } | undefined {
    if (text.charAt(start) !== '/') {
        return undefined;
    }
    const next = text.charAt(start + 1);
    if (next === '/') {
        const terminator = text.slice(start).search(LINE_TERMINATOR);
        return { end: terminator === -1 ? text.length : start + terminator, replacement: '' };
    }
    if (next === '*') {
        const close = text.indexOf('*/', start + 2);
        const bodyEnd = close === -1 ? text.length : close;
        return {
            end: close === -1 ? text.length : close + 2,
            replacement: LINE_TERMINATOR.test(text.slice(start + 2, bodyEnd)) ? '\n' : ' ',
        };
    }
    return undefined;
}

/**
 * The text a non-parsing function slice is hashed by: comments removed by the
 * tolerant scanner, line terminators normalized to LF, runs of spaces / tabs
 * collapsed to one space, each line trimmed and blank lines dropped. Newlines
 * SURVIVE, so `return\nx` (ASI: `return; x`) and `return x` stay distinct.
 */
function fallbackText(text: string): string {
    return stripCommentsTolerant(text.replaceAll(LINE_TERMINATORS, '\n'))
        .replaceAll(/[\t ]+/g, ' ')
        .replaceAll(/ ?\n ?/g, '\n')
        .replaceAll(/\n+/g, '\n')
        .trim();
}

/** Cap on how much of an unparsed slice the fallback log line echoes. */
const FALLBACK_SNIPPET_LENGTH = 60;

/**
 * The structural fingerprint of one function's source text: hex SHA-256 of the
 * canonical AST serialization (see the module header for what is ignored and
 * what is kept). When the text does not parse under any wrapper, falls back to
 * the SHA-256 of its {@link fallbackText} — comment-insensitive and stable
 * across re-indentation and space/tab runs, but newline-preserving (nothing
 * was parsed, so ASI could make a moved newline behavioural). The fallback
 * should be rare (a probe over a real cache saw none in 1,107 functions); pass
 * `log` to have each use reported.
 */
export function functionFingerprint(text: string, log?: (line: string) => void): string {
    const parsed = parseFunctionText(text);
    if (parsed === undefined) {
        const head = text.replaceAll(/\s+/g, ' ').trim();
        const snippet =
            head.length > FALLBACK_SNIPPET_LENGTH
                ? `${head.slice(0, FALLBACK_SNIPPET_LENGTH)}…`
                : head;
        log?.(
            'stryker-llm: fingerprint fallback — function text did not parse under any ' +
                `wrapper; keyed by comment-stripped text instead: \`${snippet}\``,
        );
        return sha256(fallbackText(text));
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
    const ast = parseExpressionTolerant(text);
    return ast === undefined ? undefined : canonicalize(ast);
}

/**
 * Parse ONE sub-expression's source text with the pipeline's plugin set,
 * tolerating only the context errors a bare sub-expression cannot avoid
 * (`this.#x`, `super.x`, `yield x`, `new.target`) — the exact parse route
 * {@link expressionShape} takes before canonicalizing. Returns the expression
 * node, or `undefined` on a real syntax error. Shared with the mutant
 * classifier (`classify.ts`) so a cached candidate's `original` is parsed the
 * same way there as it is for shape matching.
 */
export function parseExpressionTolerant(text: string): Node | undefined {
    const ast = tryParse(() => parseExpression(text, PARSE_OPTIONS), TOLERATED_EXPRESSION_REASONS);
    return ast === undefined ? undefined : (ast as Node);
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
 *   - otherwise it becomes ONE line feed when it contained any line terminator
 *     (LF, CR, LS or PS — each is a newline for ASI), or a single space when it
 *     had none and sits between two non-blank characters, or nothing when a
 *     neighbour is already blank / an edge.
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
    // Any ECMAScript line terminator inside the comment (LF, CR, LS, PS) ends
    // a line for ASI; one LF stands in for all of them.
    if (LINE_TERMINATOR.test(text.slice(start, end))) {
        return { start, end, replacement: '\n' };
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
