/*
 * Offline unit tests for the legacy-`llm` directive alias (`src/directive-alias.ts`):
 * the PURE in-memory expansion of `// Stryker disable|restore [next-line] <names>`
 * lists that name `llm`, the PURE `excludedMutations` expansion, the prototype
 * wrapper installed on a FAKE bookkeeper class (wraps once, passes the original
 * node through untouched when no `llm` directive is present, a substitute object
 * otherwise), and the real-module installer (resolves the instrumenter's
 * `directive-bookkeeper.js`, idempotent, warns-and-returns-false when the seam is
 * missing). No Stryker run, no network.
 */

import { describe, expect, it } from 'bun:test';

import {
    type DirectiveBookkeeperClass,
    type DirectiveNode,
    expandExcludedMutations,
    expandLlmDirective,
    installLlmDirectiveAlias,
    installLlmDirectiveAliasIntoStryker,
    resolveDirectiveBookkeeperPath,
} from '../src/directive-alias';
import { LLM_CATEGORIES } from '../src/pipeline/classify';

const ALL = LLM_CATEGORIES.join(', ');

describe('expandLlmDirective (pure)', () => {
    it('appends every category after a bare `llm`', () => {
        expect(expandLlmDirective(' Stryker disable next-line llm')).toBe(
            ` Stryker disable next-line llm, ${ALL}`,
        );
    });

    it('keeps the `: reason` suffix verbatim', () => {
        expect(expandLlmDirective(' Stryker disable next-line llm: vetted equivalent')).toBe(
            ` Stryker disable next-line llm, ${ALL}: vetted equivalent`,
        );
    });

    it('keeps the existing list order and appends the categories once (either order)', () => {
        expect(expandLlmDirective(' Stryker disable next-line llm, NumberLiteralValue')).toBe(
            ` Stryker disable next-line llm, NumberLiteralValue, ${ALL}`,
        );
        expect(expandLlmDirective(' Stryker disable next-line NumberLiteralValue,llm')).toBe(
            ` Stryker disable next-line NumberLiteralValue, llm, ${ALL}`,
        );
        expect(
            expandLlmDirective(
                ' Stryker disable next-line ConditionalExpression,EqualityOperator,llm,BlockStatement',
            ),
        ).toBe(
            ` Stryker disable next-line ConditionalExpression, EqualityOperator, llm, BlockStatement, ${ALL}`,
        );
    });

    it('handles the region forms `disable llm` / `restore llm`', () => {
        expect(expandLlmDirective(' Stryker disable llm')).toBe(` Stryker disable llm, ${ALL}`);
        expect(expandLlmDirective(' Stryker restore llm')).toBe(` Stryker restore llm, ${ALL}`);
        expect(expandLlmDirective(' Stryker disable llm: region reason')).toBe(
            ` Stryker disable llm, ${ALL}: region reason`,
        );
    });

    it('matches `llm` case-insensitively (the bookkeeper lowercases names)', () => {
        expect(expandLlmDirective(' Stryker disable next-line LLM')).toBe(
            ` Stryker disable next-line LLM, ${ALL}`,
        );
    });

    it('does not duplicate a category already named', () => {
        const rest = LLM_CATEGORIES.filter(c => c !== 'LlmNumber').join(', ');
        expect(expandLlmDirective(' Stryker disable next-line llm, LlmNumber')).toBe(
            ` Stryker disable next-line llm, LlmNumber, ${rest}`,
        );
        expect(expandLlmDirective(' Stryker disable next-line llm, llmnumber')).toBe(
            ` Stryker disable next-line llm, llmnumber, ${rest}`,
        );
    });

    it('keeps the trailing space of a block-comment value', () => {
        expect(expandLlmDirective(' Stryker disable next-line llm ')).toBe(
            ` Stryker disable next-line llm, ${ALL} `,
        );
    });

    it('returns the value unchanged when no bare `llm` is named', () => {
        for (const value of [
            ' Stryker disable next-line all',
            ' Stryker disable next-line LlmComparison',
            ' Stryker disable next-line NumberLiteralValue',
            ' just a comment mentioning llm',
            ' Stryker disable-next-line llm',
            ' Stryker disable next-line all: llm noise',
            ' Stryker disable next-line llmish',
            '',
        ]) {
            expect(expandLlmDirective(value)).toBe(value);
        }
    });

    it('honours a custom category list', () => {
        expect(expandLlmDirective(' Stryker disable next-line llm', ['LlmA', 'LlmB'])).toBe(
            ' Stryker disable next-line llm, LlmA, LlmB',
        );
    });
});

describe('expandExcludedMutations (pure)', () => {
    it("appends every category when the list contains exactly 'llm'", () => {
        expect(expandExcludedMutations(['llm'])).toEqual(['llm', ...LLM_CATEGORIES]);
        expect(expandExcludedMutations(['StringLiteral', 'llm'])).toEqual([
            'StringLiteral',
            'llm',
            ...LLM_CATEGORIES,
        ]);
    });

    it('does not duplicate a category already present', () => {
        const out = expandExcludedMutations(['llm', 'LlmNumber']);
        expect(out.filter(n => n === 'LlmNumber')).toHaveLength(1);
        expect(out).toHaveLength(1 + LLM_CATEGORIES.length);
    });

    it("is case-sensitive like Stryker's own check and returns a copy otherwise", () => {
        const input = ['Llm', 'LLM', 'StringLiteral'];
        const out = expandExcludedMutations(input);
        expect(out).toEqual(input);
        expect(out).not.toBe(input);
        expect(expandExcludedMutations([])).toEqual([]);
    });
});

/** A fake bookkeeper class recording what its original method received. */
function fakeBookkeeper(): {
    Class: DirectiveBookkeeperClass;
    received: DirectiveNode[];
} {
    const received: DirectiveNode[] = [];
    class Fake {
        processStrykerDirectives(node: DirectiveNode): void {
            received.push(node);
        }
    }
    return { Class: Fake as unknown as DirectiveBookkeeperClass, received };
}

describe('installLlmDirectiveAlias (fake class)', () => {
    it('wraps the prototype method once; a second install is a no-op', () => {
        const { Class } = fakeBookkeeper();
        const original = Class.prototype.processStrykerDirectives;
        expect(installLlmDirectiveAlias(Class)).toBe('installed');
        const wrapped = Class.prototype.processStrykerDirectives;
        expect(wrapped).not.toBe(original);
        expect(installLlmDirectiveAlias(Class)).toBe('already-installed');
        expect(Class.prototype.processStrykerDirectives).toBe(wrapped);
    });

    it('passes the ORIGINAL node object through when no llm directive is present', () => {
        const { Class, received } = fakeBookkeeper();
        installLlmDirectiveAlias(Class);
        const instance = new (Class as unknown as new () => {
            processStrykerDirectives(node: DirectiveNode): void;
        })();
        const plain: DirectiveNode = { loc: { start: { line: 1 } }, leadingComments: null };
        const other: DirectiveNode = {
            loc: { start: { line: 2 } },
            leadingComments: [{ value: ' Stryker disable next-line all' }, { value: ' llm here' }],
        };
        const none: DirectiveNode = { loc: { start: { line: 3 } } };
        instance.processStrykerDirectives(plain);
        instance.processStrykerDirectives(other);
        instance.processStrykerDirectives(none);
        expect(received[0]).toBe(plain);
        expect(received[1]).toBe(other);
        expect(received[2]).toBe(none);
    });

    it('passes a SUBSTITUTE with expanded comment values, leaving the original untouched', () => {
        const { Class, received } = fakeBookkeeper();
        installLlmDirectiveAlias(Class);
        const instance = new (Class as unknown as new () => {
            processStrykerDirectives(node: DirectiveNode): void;
        })();
        const comment = {
            type: 'CommentLine',
            value: ' Stryker disable next-line llm: why',
            loc: 1,
        };
        const node: DirectiveNode = { loc: { start: { line: 7 } }, leadingComments: [comment] };
        instance.processStrykerDirectives(node);
        const substitute = received[0]!;
        expect(substitute).not.toBe(node);
        expect(substitute.loc).toBe(node.loc);
        const first = substitute.leadingComments?.[0] as
            | { value: string; type?: string; loc?: unknown }
            | undefined;
        expect(first?.value).toBe(` Stryker disable next-line llm, ${ALL}: why`);
        // Other comment fields are preserved on the substitute.
        expect(first?.type).toBe('CommentLine');
        expect(first?.loc).toBe(1);
        // The real node/comment objects are never modified.
        expect(node.leadingComments?.[0]).toBe(comment);
        expect(comment.value).toBe(' Stryker disable next-line llm: why');
    });

    it('preserves `this` for the original method', () => {
        class Fake {
            seen = 0;
            processStrykerDirectives(): void {
                this.seen += 1;
            }
        }
        installLlmDirectiveAlias(Fake as unknown as DirectiveBookkeeperClass);
        const instance = new Fake() as Fake & {
            processStrykerDirectives(node: DirectiveNode): void;
        };
        instance.processStrykerDirectives({ leadingComments: null });
        instance.processStrykerDirectives({ leadingComments: [{ value: ' Stryker disable llm' }] });
        expect(instance.seen).toBe(2);
    });
});

describe('installLlmDirectiveAliasIntoStryker (real module)', () => {
    it("resolves the instrumenter's directive-bookkeeper.js next to mutate.js", () => {
        const path = resolveDirectiveBookkeeperPath();
        expect(path).toMatch(
            /@stryker-mutator\/instrumenter\/dist\/src\/transformers\/directive-bookkeeper\.js$/,
        );
    });

    it('installs against the real class and is idempotent (returns true both times)', async () => {
        const lines: string[] = [];
        expect(await installLlmDirectiveAliasIntoStryker(line => lines.push(line))).toBe(true);
        expect(await installLlmDirectiveAliasIntoStryker(line => lines.push(line))).toBe(true);
        expect(lines.some(l => l.includes('WARNING'))).toBe(false);
    });

    it('returns false and logs a loud warning when the seam is missing (never throws)', async () => {
        const lines: string[] = [];
        const result = await installLlmDirectiveAliasIntoStryker(line => lines.push(line), {
            resolvePath: () => '/definitely/not/here/directive-bookkeeper.js',
        });
        expect(result).toBe(false);
        expect(
            lines.some(l => l.includes('WARNING') && l.includes('directive alias not installed')),
        ).toBe(true);
        const noMethod = await installLlmDirectiveAliasIntoStryker(line => lines.push(line), {
            resolvePath: () =>
                new URL('../src/pipeline/parse-fragment.ts', import.meta.url).pathname,
        });
        expect(noMethod).toBe(false);
    });
});
