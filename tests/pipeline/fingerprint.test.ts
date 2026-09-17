/*
 * Offline unit tests for the structural function fingerprint + comment stripper
 * that key the LLM response cache. Pure Babel — no LLM, no Stryker, no network.
 *
 * The fingerprint must be INVARIANT under comments, whitespace, literal spelling
 * (`0xFF` vs `255`, quote style), trailing commas and redundant parentheses, and
 * must CHANGE under any identifier / literal-value / operator / structure edit.
 */

import { describe, expect, it } from 'bun:test';

import { functionFingerprint, stripComments } from '../../src/pipeline/fingerprint';

const BASE = `function clamp(value, max) {
    if (value > max) {
        return max;
    }
    return value;
}`;

describe('functionFingerprint — invariants (same fingerprint)', () => {
    it('is a 64-char hex SHA-256 digest', () => {
        expect(functionFingerprint(BASE)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('ignores comments added anywhere (line, block, doc, inside an expression, Stryker directives)', () => {
        const commented = `function clamp(value, max) {
    // Stryker disable next-line all
    /* a leading block comment */
    if (value /* inline */ > max) { // trailing
        /**
         * doc-ish
         */
        return max;
    }
    return value; // done
}`;
        expect(functionFingerprint(commented)).toBe(functionFingerprint(BASE));
    });

    it('ignores whitespace, newline and indentation changes', () => {
        const reflowed = `function clamp(value,max){if(value>max){return max;}\n\n\n\treturn value;}`;
        expect(functionFingerprint(reflowed)).toBe(functionFingerprint(BASE));
    });

    it('ignores literal spelling: 0xFF vs 255 and single vs double quotes', () => {
        const hexSingle = `function f() { return { n: 0xFF, s: 'hi' }; }`;
        const decDouble = `function f() { return { n: 255, s: "hi" }; }`;
        expect(functionFingerprint(hexSingle)).toBe(functionFingerprint(decDouble));
    });

    it('ignores a trailing comma and redundant parentheses that keep the tree shape', () => {
        const plain = `function f(a, b) { return g(a, b); }`;
        const decorated = `function f(a, b,) { return (g((a), (b),)); }`;
        expect(functionFingerprint(plain)).toBe(functionFingerprint(decorated));
    });

    it('ignores template-literal raw spelling when the cooked value is identical', () => {
        const escaped = 'function f() { return `a\\u0041`; }';
        const literal = 'function f() { return `aA`; }';
        expect(functionFingerprint(escaped)).toBe(functionFingerprint(literal));
    });

    it('ignores BigInt literal spelling (hex / binary / octal / separators) when the value is identical', () => {
        const spellings = [
            'function f() { return 0x10n; }',
            'function f() { return 16n; }',
            'function f() { return 0b10000n; }',
            'function f() { return 0o20n; }',
            'function f() { return 1_6n; }',
        ];
        const digests = new Set(spellings.map(spelling => functionFingerprint(spelling)));
        expect(digests.size).toBe(1);
        expect(functionFingerprint('function f() { return 17n; }')).not.toBe(
            functionFingerprint('function f() { return 16n; }'),
        );
    });

    it('is deterministic across calls', () => {
        expect(functionFingerprint(BASE)).toBe(functionFingerprint(BASE));
    });
});

describe('functionFingerprint — sensitivity (different fingerprint)', () => {
    it('changes when an identifier changes', () => {
        expect(functionFingerprint(BASE.replace('value > max', 'value > min'))).not.toBe(
            functionFingerprint(BASE),
        );
    });

    it('changes when a literal VALUE changes', () => {
        const a = `function f() { return 255; }`;
        const b = `function f() { return 256; }`;
        expect(functionFingerprint(a)).not.toBe(functionFingerprint(b));
    });

    it('changes when a string literal VALUE changes', () => {
        const a = `function f() { return 'hi'; }`;
        const b = `function f() { return 'ho'; }`;
        expect(functionFingerprint(a)).not.toBe(functionFingerprint(b));
    });

    it('changes when a regex pattern or flags change', () => {
        const a = `function f(s) { return /ab/g.test(s); }`;
        const b = `function f(s) { return /ab/i.test(s); }`;
        const c = `function f(s) { return /ac/g.test(s); }`;
        expect(functionFingerprint(a)).not.toBe(functionFingerprint(b));
        expect(functionFingerprint(a)).not.toBe(functionFingerprint(c));
    });

    it('changes when an operator changes', () => {
        expect(functionFingerprint(BASE.replace('value > max', 'value >= max'))).not.toBe(
            functionFingerprint(BASE),
        );
    });

    it('changes when the structure changes (a dropped branch)', () => {
        const noBranch = `function clamp(value, max) {
    return value;
}`;
        expect(functionFingerprint(noBranch)).not.toBe(functionFingerprint(BASE));
    });

    it('distinguishes (a + b) * c from a + b * c (grouping is tree shape, not parens)', () => {
        const grouped = `function f(a, b, c) { return (a + b) * c; }`;
        const flat = `function f(a, b, c) { return a + b * c; }`;
        expect(functionFingerprint(grouped)).not.toBe(functionFingerprint(flat));
    });

    it('keeps a TAGGED template raw spelling (the tag can read strings.raw)', () => {
        // `String.raw` returns "\\n" (two chars) for the escape and "\n" (one
        // char) for the literal newline — different behavior, different digest.
        const escaped = 'function f() { return String.raw`\\n`; }';
        const newline = 'function f() { return String.raw`\n`; }';
        expect(functionFingerprint(escaped)).not.toBe(functionFingerprint(newline));
    });

    it('distinguishes tagged templates whose invalid escapes both cook to null', () => {
        const u = 'function f() { return tag`\\u`; }';
        const x = 'function f() { return tag`\\x`; }';
        expect(functionFingerprint(u)).not.toBe(functionFingerprint(x));
    });

    it('still ignores raw spelling for an UNTAGGED template nested inside a tagged one', () => {
        // The `${…}` is source text under test, not an interpolation here.
        const hole = (inner: string): string => `function f() { return tag\`$\{${inner}}\`; }`;
        const escaped = hole('`a\\u0041`');
        const literal = hole('`aA`');
        expect(functionFingerprint(escaped)).toBe(functionFingerprint(literal));
    });
});

describe('functionFingerprint — function shapes', () => {
    it('fingerprints an arrow function', () => {
        const a = `(x) => x + 1`;
        const b = `x => x + 1 // same`;
        expect(functionFingerprint(a)).toBe(functionFingerprint(b));
        expect(functionFingerprint(a)).not.toBe(functionFingerprint(`(x) => x + 2`));
    });

    it('fingerprints an anonymous function expression', () => {
        const a = `function (x) { return x + 1; }`;
        const b = `function(x){return x+1}`;
        expect(functionFingerprint(a)).toBe(functionFingerprint(b));
    });

    it('fingerprints an object method (not parseable standalone)', () => {
        const a = `add(a, b) { return a + b; }`;
        const b = `add(a, b) {\n    // sum\n    return a + b;\n}`;
        expect(functionFingerprint(a)).toBe(functionFingerprint(b));
        expect(functionFingerprint(a)).not.toBe(functionFingerprint(`add(a, b) { return a - b; }`));
    });

    it('fingerprints a class method with TS modifiers (not parseable as an object method)', () => {
        const a = `private static add(a: number, b: number): number { return a + b; }`;
        const b = `private static add(a: number, b: number): number {\n    return a + b; /* c */\n}`;
        expect(functionFingerprint(a)).toBe(functionFingerprint(b));
        expect(functionFingerprint(a)).not.toBe(
            functionFingerprint(
                `public static add(a: number, b: number): number { return a + b; }`,
            ),
        );
    });

    it('fingerprints a class method that reads private fields of its (absent) class', () => {
        const a = `async #build(now: Date): Promise<string> { return this.#backend.load(now); }`;
        const b = `async #build(now: Date): Promise<string> {\n    // fetch\n    return this.#backend.load(now);\n}`;
        expect(functionFingerprint(a)).toBe(functionFingerprint(b));
        expect(functionFingerprint(a)).not.toBe(
            functionFingerprint(
                `async #build(now: Date): Promise<string> { return this.#store.load(now); }`,
            ),
        );
        // The private-name tolerance does not mask a REAL syntax error elsewhere:
        // a broken body still takes the text-hash fallback (reported via `log`).
        const broken = `async #build(now) { return this.#backend.load(now; }`;
        const lines: string[] = [];
        functionFingerprint(broken, line => lines.push(line));
        expect(lines).toHaveLength(1);
        expect(functionFingerprint(broken)).not.toBe(functionFingerprint(a));
    });

    it('fingerprints a subclass constructor calling super() and a body using import.meta', () => {
        const ctor = `constructor(message: string, cause?: unknown) {\n    super(message, { cause });\n}`;
        expect(functionFingerprint(ctor)).toBe(
            functionFingerprint(
                `constructor(message: string, cause?: unknown) { super(message, { cause }); }`,
            ),
        );
        const meta = `function here() {\n    return import.meta.dir; // dir\n}`;
        expect(functionFingerprint(meta)).toBe(
            functionFingerprint(`function here() { return import.meta.dir; }`),
        );
    });

    it('falls back to a text hash when the text does not parse: spaces/tabs collapse, indentation is ignored', () => {
        const broken = `function f( { return ; ]`;
        const brokenReflowed = `function   f(   {\treturn ;   ]`;
        expect(functionFingerprint(broken)).toMatch(/^[0-9a-f]{64}$/);
        expect(functionFingerprint(broken)).toBe(functionFingerprint(brokenReflowed));
        // Re-indentation and trailing blanks do not change the fallback digest.
        const twoLines = `function f( {\n    return ; ]`;
        expect(functionFingerprint(twoLines)).toBe(
            functionFingerprint(`function f( {\n\t\treturn ; ]   `),
        );
        expect(functionFingerprint(twoLines)).toBe(
            functionFingerprint(`function f( {\r\n        return ; ]`),
        );
    });

    it('fallback: preserves newlines, so ASI-different text stays distinct', () => {
        // `return\nx` and `return x` differ in behavior; the unparsed fallback
        // must not merge them by collapsing the newline into a space.
        const withNewline = `function f( { return\nx ; ]`;
        const oneLine = `function f( { return x ; ]`;
        expect(functionFingerprint(withNewline)).not.toBe(functionFingerprint(oneLine));
        // Parseable proof of the same property (the AST route already keeps them apart).
        expect(functionFingerprint(`function f(x) { return\nx }`)).not.toBe(
            functionFingerprint(`function f(x) { return x }`),
        );
    });

    it('fallback: ignores comments (line, block, multi-line block) in unparsed text', () => {
        const broken = `function f( { return ; ]`;
        expect(functionFingerprint(`${broken} // x`)).toBe(functionFingerprint(broken));
        expect(functionFingerprint(`function f( { /* c */ return ; ]`)).toBe(
            functionFingerprint(broken),
        );
        expect(functionFingerprint(`function f( {\n  // own line\n  return ; ]`)).toBe(
            functionFingerprint(`function f( {\n  return ; ]`),
        );
        // A block comment holding a newline still separates its neighbours by a
        // line terminator (ASI), so it is not the same as an inline one.
        expect(functionFingerprint(`function f( { return/*\n*/x ; ]`)).toBe(
            functionFingerprint(`function f( { return\nx ; ]`),
        );
        expect(functionFingerprint(`function f( { return/* */x ; ]`)).not.toBe(
            functionFingerprint(`function f( { return\nx ; ]`),
        );
    });

    it('fallback: does not mistake `//` or `/*` inside a string, template or regex for a comment', () => {
        // If the scanner ate `//x"; ]` as a comment these two would collide.
        expect(functionFingerprint(`function f( { return "http://x"; ]`)).not.toBe(
            functionFingerprint(`function f( { return "http://y"; ]`),
        );
        expect(functionFingerprint(`function f( { return 'a/*b'; ]`)).not.toBe(
            functionFingerprint(`function f( { return 'a/*c'; ]`),
        );
        expect(functionFingerprint('function f( { return `//x`; ]')).not.toBe(
            functionFingerprint('function f( { return `//y`; ]'),
        );
        // The `${…}` is source text under test, not an interpolation here.
        const hole = (tail: string): string => `function f( { return \`$\{a}//${tail}\`; ]`;
        expect(functionFingerprint(hole('x'))).not.toBe(functionFingerprint(hole('y')));
        expect(functionFingerprint(`function f( { return /[//]/.test(s); ]`)).not.toBe(
            functionFingerprint(`function f( { return /[//]/.test(t); ]`),
        );
        // An escaped quote does not end the string early.
        expect(functionFingerprint(`function f( { return "a\\"//b"; ]`)).not.toBe(
            functionFingerprint(`function f( { return "a\\"//c"; ]`),
        );
        // Division is not a regex: the comment after it IS stripped.
        expect(functionFingerprint(`function f( { return a / b; // c\n ]`)).toBe(
            functionFingerprint(`function f( { return a / b; \n ]`),
        );
    });

    it('fallback: reports itself through the optional log sink (only when used)', () => {
        const lines: string[] = [];
        functionFingerprint(`function f( { return ; ]`, line => lines.push(line));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('fingerprint fallback');
        functionFingerprint(BASE, line => lines.push(line));
        expect(lines).toHaveLength(1);
    });
});

describe('stripComments', () => {
    it('removes line, block and doc comments while preserving other whitespace', () => {
        const input = `function f(a) {
    // leading line comment
    /* block */
    /**
     * doc
     */
    return a + 1; // trailing
}`;
        const stripped = stripComments(input);
        expect(stripped).not.toContain('//');
        expect(stripped).not.toContain('/*');
        // The code line keeps its exact indentation + inner spacing.
        expect(stripped).toContain('\n    return a + 1; \n');
    });

    it('removes a comment inside an expression, leaving the surrounding whitespace', () => {
        const input = `function f(a, b) { return a + /* mid */ b; }`;
        expect(stripComments(input)).toBe(`function f(a, b) { return a +  b; }`);
    });

    it('removes whole-line comments together with their line (no blank-line residue)', () => {
        const input = `function f() {
    // one
    // two
    // three
    return 1;
}`;
        expect(stripComments(input)).toBe(`function f() {\n    return 1;\n}`);
    });

    it('removes a whole-line multi-line block comment together with its lines', () => {
        const input = `function f() {\n    /**\n     * doc\n     */\n    return 1;\n}`;
        expect(stripComments(input)).toBe(`function f() {\n    return 1;\n}`);
        // A leading whole-line comment with nothing before it goes the same way.
        expect(stripComments(`/* head */\nfunction g() { return 2; }`)).toBe(
            `function g() { return 2; }`,
        );
    });

    it('keeps blank-line runs untouched (no global collapse)', () => {
        const input = `function f() {\n\n\n    return 1;\n}`;
        expect(stripComments(input)).toBe(input);
        // Even when the function also carries a comment elsewhere.
        const withComment = `function f() {\n\n\n\n    return 1; // c\n}`;
        expect(stripComments(withComment)).toBe(`function f() {\n\n\n\n    return 1; \n}`);
    });

    it('keeps tokens separated when a comment is the only thing between them', () => {
        expect(stripComments('function f(){return/*comment*/1}')).toBe('function f(){return 1}');
        // Identifier / number neighbours: one space, never fused into `ab` / `x1`.
        expect(stripComments('function f(a){return typeof/*x*/a}')).toBe(
            'function f(a){return typeof a}',
        );
        expect(stripComments('function f(x){return x/*x*/in/*y*/1}')).toBe(
            'function f(x){return x in 1}',
        );
    });

    it('leaves nothing behind when a neighbour is already blank or an edge', () => {
        expect(stripComments('function f(a, b){return a /*x*/ + b}')).toBe(
            'function f(a, b){return a  + b}',
        );
        expect(stripComments('function f(){return 1;}/* tail */')).toBe('function f(){return 1;}');
        expect(stripComments('/* head */function f(){return 1;}')).toBe('function f(){return 1;}');
    });

    it('replaces a block comment holding ANY line terminator with a single newline (ASI-sensitive)', () => {
        // `return/*\ncomment*/ 1` returns undefined via ASI; the stripped text
        // must keep a newline after `return` so it still does — for every
        // ECMAScript line terminator, not only LF, and exactly one of them.
        expect(stripComments('function f(){return/*\ncomment*/ 1}')).toBe(
            'function f(){return\n 1}',
        );
        expect(stripComments('function f(){return/*\r\nx\r\ny*/ 1}')).toBe(
            'function f(){return\n 1}',
        );
        expect(stripComments('function f(){return/*\rx*/ 1}')).toBe('function f(){return\n 1}');
        expect(stripComments('function f(){return/*\u2028x*/ 1}')).toBe('function f(){return\n 1}');
        expect(stripComments('function f(){return/*\u2029x*/ 1}')).toBe('function f(){return\n 1}');
    });

    it('never touches the contents of a multi-line template literal', () => {
        const input = 'function f() {\n    // c\n    return `a\n\n\n\nb`;\n}';
        expect(stripComments(input)).toBe('function f() {\n    return `a\n\n\n\nb`;\n}');
    });

    it('returns comment-free text unchanged', () => {
        const input = `function f(a) {\n    return a * 2;\n}`;
        expect(stripComments(input)).toBe(input);
    });

    it('strips comments from an object method and a class method too', () => {
        expect(stripComments(`add(a, b) { return a + b; /* c */ }`)).toBe(
            `add(a, b) { return a + b;  }`,
        );
        expect(stripComments(`private add(a: number): number { return a; // c\n}`)).toBe(
            `private add(a: number): number { return a; \n}`,
        );
    });

    it('strips comments from a multi-statement module slice (a CONTEXT block)', () => {
        const input = `import { x } from './x'; // dep\nconst LIMIT = 3; /* cap */\nexport function f() { return x + LIMIT; }`;
        expect(stripComments(input)).toBe(
            `import { x } from './x'; \nconst LIMIT = 3; \nexport function f() { return x + LIMIT; }`,
        );
    });

    it('returns the text unchanged when it does not parse', () => {
        const broken = `function f( { return ; ] // not really a comment we can find`;
        expect(stripComments(broken)).toBe(broken);
    });

    it('does not mistake a comment-looking string for a comment', () => {
        const input = `function f() { return "http://x // not a comment"; }`;
        expect(stripComments(input)).toBe(input);
    });
});
