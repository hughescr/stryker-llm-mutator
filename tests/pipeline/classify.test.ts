/*
 * Offline unit tests for the deterministic LLM-mutant classifier
 * (`src/pipeline/classify.ts`): the closed `Llm<Category>` taxonomy, the
 * table-driven `(original, replacement) → category` mapping over real cached
 * pairs, the headline same-span collisions (distinct kinds get distinct names;
 * same kinds may share), the separate-nullish-counter and paired-ternary rules,
 * and the invariants the directive bookkeeper relies on (letters only, unique
 * after lowercasing, no clash with a built-in or heuristic name). Pure, no
 * Stryker, no network.
 */

/* oxlint-disable no-template-curly-in-string -- the table rows are SOURCE-TEXT fixtures, some of them template literals */

import { describe, expect, it } from 'bun:test';

import {
    classifyMutation,
    classifyNodes,
    LLM_CATEGORIES,
    type LlmCategory,
} from '../../src/pipeline/classify';
import { parseExpressionTolerant } from '../../src/pipeline/fingerprint';
import { heuristicMutators } from '../../src/mutators/index';

/** Stryker 9.6 / 10.0 built-in mutator names (instrumenter `allMutators`). */
const BUILT_IN_NAMES = [
    'ArithmeticOperator',
    'ArrayDeclaration',
    'ArrowFunction',
    'BlockStatement',
    'BooleanLiteral',
    'ConditionalExpression',
    'EqualityOperator',
    'LogicalOperator',
    'MethodExpression',
    'ObjectLiteral',
    'StringLiteral',
    'UnaryOperator',
    'UpdateOperator',
    'Regex',
    'OptionalChaining',
    'AssignmentOperator',
];

/** `[original, replacement, expected]` rows, grouped by the expected category. */
type Row = [original: string, replacement: string, expected: LlmCategory];

const TABLE: Row[] = [
    // LlmComparison
    ["request.action === 'create'", "request.action !== 'create'", 'LlmComparison'],
    ['toolUses.length > 0', 'toolUses.length !== 0', 'LlmComparison'],
    ['c.unreadCount > 0', 'c.unreadCount >= 1', 'LlmComparison'],
    ['a < b', 'b < a', 'LlmComparison'],
    ['x', 'x > 0', 'LlmComparison'],
    // LlmArithmetic
    ['currentPercent + stepPercent', 'currentPercent - stepPercent', 'LlmArithmetic'],
    ['chunks.length', 'chunks.length - 1', 'LlmArithmetic'],
    ['attempt++', 'attempt--', 'LlmArithmetic'],
    ['a & b', 'a | b', 'LlmArithmetic'],
    ['x', '-x', 'LlmArithmetic'],
    ['total += n', 'total -= n', 'LlmArithmetic'],
    ['nextIndex++', 'nextIndex', 'LlmArithmetic'],
    // LlmLogical
    [
        "inboxMcpServer && specialMode === 'catchup'",
        "inboxMcpServer || specialMode === 'catchup'",
        'LlmLogical',
    ],
    ['results.length === 0', '!results || results.length === 0', 'LlmLogical'],
    ['posts.length === 0', 'posts.length || 0', 'LlmLogical'],
    ['a?.b', 'x && a?.b', 'LlmLogical'],
    ['a && b', 'b && a', 'LlmLogical'],
    ['f(a)', 'f(a || {})', 'LlmLogical'],
    // LlmNullish
    ['perchContext', "perchContext ?? 'default'", 'LlmNullish'],
    ['metadata?.discordUserId', 'metadata.discordUserId', 'LlmNullish'],
    ['a ?? b', 'a || b', 'LlmNullish'],
    ['a?.b', 'a.b ?? 0', 'LlmNullish'],
    ['a?.b.c', 'a.b?.c', 'LlmNullish'],
    ['f?.()', 'f()', 'LlmNullish'],
    ['x', '(x ?? y)', 'LlmNullish'],
    ['a ?? b', 'b ?? a', 'LlmNullish'],
    ['x', 'x ?? (y && z)', 'LlmNullish'],
    // LlmNegate
    ['hasText', '!hasText', 'LlmNegate'],
    ['request.personId', '!request.personId', 'LlmNegate'],
    ['!x?.y()', 'x?.y()', 'LlmNegate'],
    ['!a', '-a', 'LlmNegate'],
    ['x', '!y', 'LlmNegate'],
    // LlmAwait
    ['await client.channels.fetch(id)', 'client.channels.fetch(id)', 'LlmAwait'],
    ['x', 'await x', 'LlmAwait'],
    ['await f(x)', 'f(x)', 'LlmAwait'],
    // LlmTernary
    [
        "hasText ? 'Claude LLM responding' : 'Claude LLM thinking'",
        "hasText ? 'Claude LLM thinking' : 'Claude LLM responding'",
        'LlmTernary',
    ],
    [
        'err instanceof Error ? err.message : String(err)',
        'err instanceof Error ? String(err) : err.message',
        'LlmTernary',
    ],
    ['flag ? left.id : right.id', 'flag ? right.id : left.id', 'LlmTernary'],
    ['f(c ? a : b)', 'f(c ? b : a)', 'LlmTernary'],
    ['x', 'c ? x : y', 'LlmTernary'],
    ['g(c ? a : b, 1)', 'g(z, 1)', 'LlmArgument'],
    ['y', 'c ? a : b', 'LlmTernary'],
    // NOT a ternary swap — classified by its own kind
    ['a ? 1 : 2', 'a ? 1 : 3', 'LlmNumber'],
    ['flag ? left.id : right.id', 'flag ? other.id : right.id', 'LlmIdentifier'],
    ['c ? a : a', 'c ? a : a', 'LlmOther'],
    // LlmMethod
    ['chunks.entries()', 'chunks.values()', 'LlmMethod'],
    ['Math.max(min, stepped)', 'Math.min(min, stepped)', 'LlmMethod'],
    ['contact.identifiers', 'contact.identifiers.slice()', 'LlmMethod'],
    ['x', 'x.trim()', 'LlmMethod'],
    ['f(a)', 'g(a)', 'LlmMethod'],
    ['a.b(c)', 'a[k](c)', 'LlmMethod'],
    ['new Foo(a)', 'new Bar(a)', 'LlmMethod'],
    ['x', 'new Foo(x)', 'LlmMethod'],
    ['this.getNowMs()', 'Date.now()', 'LlmMethod'],
    ['path.isAbsolute(p)', 'false', 'LlmMethod'],
    // LlmArgument
    [
        'setupChannelEventHandlers(client, channelRegistry)',
        'setupChannelEventHandlers(channelRegistry, client)',
        'LlmArgument',
    ],
    ["{ priority: 'other' }", "{ priority: 'other', timeout: 0 }", 'LlmArgument'],
    ['timeHeader(config.timezone)', 'timeHeader(endsAt)', 'LlmArgument'],
    ['f(a, b)', 'f(a)', 'LlmArgument'],
    ['[a, b]', '[b, a]', 'LlmArgument'],
    ['x', '[x]', 'LlmArgument'],
    ['x', '{ x }', 'LlmArgument'],
    ['{ a: 1 }', '{ b: 1 }', 'LlmArgument'],
    ['{ a }', '{ a: a }', 'LlmArgument'],
    ['{ a: 1 }', '{ [a]: 1 }', 'LlmArgument'],
    ['(a, b) => a', '(a) => a', 'LlmArgument'],
    // LlmProperty
    ['ButtonStyle.Success', 'ButtonStyle.Danger', 'LlmProperty'],
    ['toolUse.name', 'toolUse.id', 'LlmProperty'],
    ['task.metadata.completedAt', 'task.metadata', 'LlmProperty'],
    ['a.b', 'a', 'LlmProperty'],
    ['a', 'a.b', 'LlmProperty'],
    ['a.b', 'a[b]', 'LlmProperty'],
    ['a.b', 'a[0]', 'LlmProperty'],
    ['a.b', 'c', 'LlmProperty'],
    // LlmIdentifier
    ['endsAt', 'now', 'LlmIdentifier'],
    ['nonImageAttachments', 'allAttachments', 'LlmIdentifier'],
    ['a.b', 'c.b', 'LlmIdentifier'],
    ['x + 1', 'y + 1', 'LlmIdentifier'],
    // LlmNumber
    ['0', '1', 'LlmNumber'],
    ['toolUses.length > 0', 'toolUses.length > 1', 'LlmNumber'],
    ['AMBER', '0xFF0000', 'LlmNumber'],
    ['300', '301', 'LlmNumber'],
    ['10n', '11n', 'LlmNumber'],
    ['x', '1', 'LlmNumber'],
    // LlmString
    ["'Approve'", "'Reject'", 'LlmString'],
    ['`contact-approve:${uuid}`', '`contact-reject:${uuid}`', 'LlmString'],
    ['/^a/', '/^b/', 'LlmString'],
    ['/a/i', '/a/g', 'LlmString'],
    ["'Contact Create Request'", "'Contact Update Request'", 'LlmString'],
    ['x', "'x'", 'LlmString'],
    ['`a${b}`', '`a${b}${c}`', 'LlmString'],
    ['x', '`${x}`', 'LlmString'],
    // LlmConstant
    ['true', 'false', 'LlmConstant'],
    ['x', 'undefined', 'LlmConstant'],
    ['botStateManager', 'undefined', 'LlmConstant'],
    ['{ inline: true }', '{ inline: false }', 'LlmConstant'],
    ['x', 'null', 'LlmConstant'],
    ['undefined', 'x', 'LlmConstant'],
    // LlmStatement
    ["() => { release('timeout'); }", "() => { release('timeout'); return; }", 'LlmStatement'],
    ['x => { return x.id; }', 'x => { x.id; }', 'LlmStatement'],
    ['() => { a = 1; f(); }', '() => { f(); }', 'LlmStatement'],
    ['x', 'x = 1', 'LlmStatement'],
    ['() => { let a = 1, b = 2; }', '() => { let a = 1; }', 'LlmStatement'],
    // LlmOther
    ['typeof x', 'void x', 'LlmOther'],
    ['a + 1', '(a + /*c*/ 1)', 'LlmOther'],
    ['x as T', 'x', 'LlmOther'],
    ['x!', 'x', 'LlmOther'],
    ['a +', 'a', 'LlmOther'],
    ['a', 'a +', 'LlmOther'],
    ['function () {}', 'x', 'LlmOther'],
];

describe('LLM_CATEGORIES — taxonomy invariants', () => {
    it('has 16 closed names, each `Llm` + one capitalised word (letters only, directive-writable)', () => {
        expect(LLM_CATEGORIES).toHaveLength(16);
        for (const name of LLM_CATEGORIES) {
            expect(name).toMatch(/^Llm[A-Z][a-z]+$/);
        }
        expect(LLM_CATEGORIES).toContain('LlmOther');
    });

    it('is unique after lowercasing and none lowercases to the legacy `llm`', () => {
        const lower = LLM_CATEGORIES.map(n => n.toLowerCase());
        expect(new Set(lower).size).toBe(LLM_CATEGORIES.length);
        expect(lower).not.toContain('llm');
    });

    it('collides with no Stryker built-in and no heuristic name (case-insensitive)', () => {
        const taken = new Set(
            [...BUILT_IN_NAMES, ...heuristicMutators.map(m => m.name)].map(n => n.toLowerCase()),
        );
        for (const name of LLM_CATEGORIES) {
            expect(taken.has(name.toLowerCase())).toBe(false);
        }
    });
});

describe('classifyMutation — table over real cached pairs', () => {
    for (const [original, replacement, expected] of TABLE) {
        it(`${JSON.stringify(original)} → ${JSON.stringify(replacement)} is ${expected}`, () => {
            expect(classifyMutation(original, replacement)).toBe(expected);
        });
    }

    it('covers every category at least once (the table is the spec)', () => {
        const seen = new Set(TABLE.map(([, , expected]) => expected));
        for (const name of LLM_CATEGORIES) {
            expect(seen.has(name)).toBe(true);
        }
    });
});

describe('classifyMutation — same-span collisions', () => {
    it('the two headline equivalent/real pairs share a name only because they are the same kind', () => {
        expect(classifyMutation('c.unreadCount > 0', 'c.unreadCount >= 1')).toBe('LlmComparison');
        expect(classifyMutation('c.unreadCount > 0', 'c.unreadCount !== 0')).toBe('LlmComparison');
        expect(classifyMutation('posts.length === 0', '!posts || posts.length === 0')).toBe(
            'LlmLogical',
        );
        expect(classifyMutation('posts.length === 0', 'posts.length || 0')).toBe('LlmLogical');
    });

    it('four clearly different kinds on one span get four different names', () => {
        const names = new Set([
            classifyMutation('x', '!x'),
            classifyMutation('x', 'x ?? y'),
            classifyMutation('x', 'x.trim()'),
            classifyMutation('x', 'undefined'),
        ]);
        expect(names).toEqual(new Set(['LlmNegate', 'LlmNullish', 'LlmMethod', 'LlmConstant']));
    });

    it('[Finding 2] a nested branch swap and a single identifier edit on the same span differ', () => {
        const span = 'flag ? left.id : right.id';
        expect(classifyMutation(span, 'flag ? right.id : left.id')).toBe('LlmTernary');
        expect(classifyMutation(span, 'flag ? other.id : right.id')).toBe('LlmIdentifier');
    });

    it('[Finding 3] the nullish cancellation and a guard on the same span differ', () => {
        expect(classifyMutation('a?.b', 'a.b ?? 0')).toBe('LlmNullish');
        expect(classifyMutation('a?.b', 'x && a?.b')).toBe('LlmLogical');
    });
});

describe('classifyMutation — totality, determinism, TS casts', () => {
    it('is deterministic (same inputs twice → same output)', () => {
        for (const [original, replacement] of TABLE) {
            expect(classifyMutation(original, replacement)).toBe(
                classifyMutation(original, replacement),
            );
        }
    });

    it('never throws on garbage input', () => {
        expect(classifyMutation('', '')).toBe('LlmOther');
        expect(classifyMutation('{{{', ')))')).toBe('LlmOther');
        expect(classifyMutation('return x;', 'x')).toBe('LlmOther');
    });

    it('ignores TS casts / assertions on either side', () => {
        expect(classifyMutation('x as T', 'x')).toBe('LlmOther');
        expect(classifyMutation('x as T', 'x + 1')).toBe('LlmArithmetic');
        expect(classifyMutation('(x satisfies T)!', '<T>x')).toBe('LlmOther');
        expect(classifyMutation('f<T>(a)', 'f(a)')).toBe('LlmOther');
    });

    it('[Finding 3] whenever the optional-chain counts differ the result is LlmNullish regardless of ??', () => {
        const pairs: Array<[string, string]> = [
            ['a?.b', 'a.b ?? 0'],
            ['a?.b ?? 1', 'a.b'],
            ['f?.(x) ?? y', 'f(x) ?? y'],
            ['a?.b?.c', 'a?.b.c'],
        ];
        for (const [original, replacement] of pairs) {
            expect(classifyMutation(original, replacement)).toBe('LlmNullish');
        }
    });

    it('[Finding 3] no LogicalExpression divergence involving ?? on either side is LlmLogical', () => {
        const pairs: Array<[string, string]> = [
            ['a ?? b', 'a || b'],
            ['a || b', 'a ?? b'],
            ['a && b', 'a ?? b'],
            ['x', 'x ?? y'],
            ['x ?? y', 'x'],
        ];
        for (const [original, replacement] of pairs) {
            const category = classifyMutation(original, replacement);
            expect(category).not.toBe('LlmLogical');
            expect(category).toBe('LlmNullish');
        }
    });
});

describe('classifyNodes', () => {
    it('classifies already-parsed nodes the same way classifyMutation does', () => {
        const original = parseExpressionTolerant('hour >= 12');
        const replacement = parseExpressionTolerant('hour > 12');
        expect(original).toBeDefined();
        expect(replacement).toBeDefined();
        expect(classifyNodes(original!, replacement!)).toBe('LlmComparison');
        expect(classifyMutation('hour >= 12', 'hour > 12')).toBe('LlmComparison');
    });

    it('tolerates the context errors a cut sub-expression cannot avoid', () => {
        expect(classifyMutation('this.#x', 'this.#y')).toBe('LlmProperty');
        expect(classifyMutation('super.x', 'super.y')).toBe('LlmProperty');
        expect(classifyMutation('yield x', 'yield y')).toBe('LlmIdentifier');
        expect(classifyMutation('new.target', 'x')).toBe('LlmOther');
    });
});
