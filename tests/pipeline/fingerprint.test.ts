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
        // a broken body still takes the text-hash fallback (comment-sensitive).
        const broken = `async #build(now) { return this.#backend.load(now; }`;
        expect(functionFingerprint(broken)).not.toBe(functionFingerprint(`${broken} // x`));
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

    it('falls back to a whitespace-collapsed text hash when the text does not parse', () => {
        const broken = `function f( { return ; ]`;
        const brokenReflowed = `function   f(   {\n\treturn ;   ]`;
        expect(functionFingerprint(broken)).toMatch(/^[0-9a-f]{64}$/);
        expect(functionFingerprint(broken)).toBe(functionFingerprint(brokenReflowed));
        // The fallback is NOT comment-insensitive (nothing parsed) — the comment
        // is part of the collapsed text.
        expect(functionFingerprint(broken)).not.toBe(functionFingerprint(`${broken} // x`));
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

    it('collapses a run of 3+ blank lines (left by whole-line comments) to one', () => {
        const input = `function f() {
    // one
    // two
    // three
    return 1;
}`;
        expect(stripComments(input)).toBe(`function f() {\n\n    return 1;\n}`);
    });

    it('keeps a run of 2 blank lines untouched', () => {
        const input = `function f() {\n\n\n    return 1;\n}`;
        expect(stripComments(input)).toBe(input);
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
