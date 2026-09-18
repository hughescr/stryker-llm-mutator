/*
 * Offline unit tests for the injected dynamic-LLM `NodeMutator`s.
 *
 * The mutators are pure sync map lookups, so these tests need NO Stryker and NO
 * network. They hand them (a) a HAND-BUILT `(absFileName, locKey) → ParsedEntry[]`
 * map and (b) a minimal FAKE NodePath exposing only the two fields the mutator
 * reads — `path.node.loc` and `path.hub.file.opts.filename`. A bare
 * `babel.traverse` does NOT populate `hub` (only Stryker's `new File({filename})`
 * wrap does), so a real traverse cannot exercise the file-keying; the fake path
 * does.
 *
 * NAMING: `createLlmMutators(map)` returns one `NodeMutator` per registered name
 * — the legacy no-op `llm` wildcard plus one per `Llm<Category>` — and each
 * category mutator yields ONLY the entries of its own category, so a directive
 * naming one category leaves the others on the same span live.
 */

import { describe, expect, it } from 'bun:test';
import babel from '@babel/core';
import { isConditionalExpression, type Node } from '@babel/types';

import {
    buildLlmMutatorMap,
    type LlmMutatorMap,
    locKeyFromRange,
    locKeyFromBabelLoc,
    type ParsedEntry,
} from '../../src/pipeline/llm-map';
import { LLM_CATEGORIES, type LlmCategory } from '../../src/pipeline/classify';
import {
    createLlmMutators,
    isLlmMutatorName,
    LLM_MUTATOR_NAME,
    LLM_MUTATOR_NAMES,
} from '../../src/mutators/llm-mutator';
import { parseReplacementFragment } from '../../src/pipeline/parse-fragment';
import type { NodeMutator, NodePath } from '../../src/mutators/types';
import type { Replacement, SourceRange } from '../../src/seam/types';

/** The category the hand-built fixtures default to. */
const DEFAULT_CATEGORY: LlmCategory = 'LlmTernary';

/** A 0-based Stryker range spanning a single span on one line. */
function range(line: number, c0: number, c1: number): SourceRange {
    return { start: { line, column: c0 }, end: { line, column: c1 } };
}

/** Build a minimal fake NodePath the mutator can read (loc + hub filename). */
function fakePath(filename: string | undefined, loc: SourceRange | undefined): NodePath {
    const node = { type: 'NumericLiteral', loc: loc ?? null } as unknown as Node;
    const hub = filename === undefined ? undefined : { file: { opts: { filename } } };
    return { node, hub } as unknown as NodePath;
}

/** A fake path whose `node` has NO `loc` field at all. */
function fakePathNoLoc(filename: string): NodePath {
    const node = { type: 'NumericLiteral' } as unknown as Node;
    return { node, hub: { file: { opts: { filename } } } } as unknown as NodePath;
}

/** A babel-loc range (1-based line) used as the LIVE path's loc. */
function babelRange(line: number, c0: number, c1: number): SourceRange {
    return { start: { line, column: c0 }, end: { line, column: c1 } };
}

/** Hand-build a one-entry map directly (no Replacement plumbing). */
function singleEntryMap(absFile: string, locKey: string, entry: ParsedEntry): LlmMutatorMap {
    return new Map([[absFile, new Map([[locKey, [entry]]])]]);
}

function entryFor(
    replacement: string,
    mutatorName: string,
    category: LlmCategory = DEFAULT_CATEGORY,
): ParsedEntry {
    const node = parseReplacementFragment(replacement);
    if (node === undefined) {
        throw new Error(`fixture replacement did not parse: ${replacement}`);
    }
    return { node, mutatorName, category, replacement, original: 'orig' };
}

/** The category mutator named `category` out of `createLlmMutators(map)`. */
function mutatorFor(
    map: LlmMutatorMap,
    category: string = DEFAULT_CATEGORY,
    log?: (line: string) => void,
): NodeMutator {
    const found = createLlmMutators(map, log).find(m => m.name === category);
    if (found === undefined) {
        throw new Error(`no mutator named ${category}`);
    }
    return found;
}

const { parse, traverse } = babel as {
    parse: (code: string, opts?: object) => unknown;
    traverse: (ast: unknown, visitor: { enter(path: NodePath): void }) => void;
};

function pathFor(code: string, predicate: (path: NodePath) => boolean, filename: string): NodePath {
    const ast = parse(code, { configFile: false, babelrc: false });
    let found: NodePath | undefined;
    traverse(ast, {
        enter(path: NodePath) {
            if (!found && predicate(path)) {
                Object.assign(path as object, { hub: { file: { opts: { filename } } } });
                found = path;
                path.stop();
            }
        },
    });
    if (!found) {
        throw new Error(`No matching path in ${code}`);
    }
    return found;
}

describe('LLM_MUTATOR_NAMES / isLlmMutatorName', () => {
    it('is the legacy wildcard followed by every category, in taxonomy order (17 names)', () => {
        expect(LLM_MUTATOR_NAME).toBe('llm');
        expect(LLM_MUTATOR_NAMES).toEqual([LLM_MUTATOR_NAME, ...LLM_CATEGORIES]);
        expect(LLM_MUTATOR_NAMES).toHaveLength(17);
    });

    it('matches exactly (case-sensitive) the registered names and nothing else', () => {
        expect(isLlmMutatorName('llm')).toBe(true);
        expect(isLlmMutatorName('LlmComparison')).toBe(true);
        expect(isLlmMutatorName('LlmOther')).toBe(true);
        expect(isLlmMutatorName('Llm')).toBe(false);
        expect(isLlmMutatorName('llm/off-by-one')).toBe(false);
        expect(isLlmMutatorName('NumberLiteralValue')).toBe(false);
        expect(isLlmMutatorName('llmcomparison')).toBe(false);
    });
});

describe('createLlmMutators', () => {
    it('returns exactly LLM_MUTATOR_NAMES in order, regardless of the map contents', () => {
        expect(createLlmMutators(new Map()).map(m => m.name)).toEqual([...LLM_MUTATOR_NAMES]);
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const map = singleEntryMap(abs, key, entryFor('a > b ? 1 : 0', 'llm/flip'));
        expect(createLlmMutators(map).map(m => m.name)).toEqual([...LLM_MUTATOR_NAMES]);
    });

    it('the legacy `llm` mutator yields nothing for any path (a registered no-op)', () => {
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const map = singleEntryMap(abs, key, entryFor('a > b ? 1 : 0', 'llm/flip'));
        const legacy = mutatorFor(map, LLM_MUTATOR_NAME);
        expect([...legacy.mutate(fakePath(abs, babelRange(1, 4, 9)))]).toHaveLength(0);
        expect([...legacy.mutate(fakePathNoLoc(abs))]).toHaveLength(0);
    });

    it('HIT: yields the entry node when (filename, loc) match, and a FRESH node per iteration', () => {
        const abs = '/abs/foo.ts';
        // Stryker 0-based line 0 → babel-1-based key line 1.
        const key = locKeyFromRange(range(0, 4, 9));
        const map = singleEntryMap(abs, key, entryFor('a > b ? 1 : 0', 'llm/flip'));
        const mutator = mutatorFor(map);

        const path = fakePath(abs, babelRange(1, 4, 9));
        const first = [...mutator.mutate(path)];
        expect(first).toHaveLength(1);
        expect(isConditionalExpression(first[0]!)).toBe(true);

        // Distinct node identity across two iterations (the §3.1 anti-collapse rule).
        const second = [...mutator.mutate(path)];
        expect(second[0]).not.toBe(first[0]);
    });

    it('CATEGORY FILTER: each category mutator yields only its own entries at a shared span', () => {
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const e1 = entryFor('a > b ? 1 : 0', 'llm/flip', 'LlmTernary');
        const e2 = entryFor('a < b ? 1 : 0', 'llm/swap', 'LlmComparison');
        const map: LlmMutatorMap = new Map([[abs, new Map([[key, [e1, e2]]])]]);
        const path = fakePath(abs, babelRange(1, 4, 9));

        const byName = new Map(createLlmMutators(map).map(m => [m.name, [...m.mutate(path)]]));
        expect(byName.get('LlmTernary')).toHaveLength(1);
        expect(byName.get('LlmComparison')).toHaveLength(1);
        expect(byName.get('LlmTernary')![0]).not.toBe(byName.get('LlmComparison')![0]);
        for (const name of LLM_MUTATOR_NAMES) {
            if (name !== 'LlmTernary' && name !== 'LlmComparison') {
                expect(byName.get(name)).toHaveLength(0);
            }
        }
    });

    it('MISS (wrong loc): same file, non-matching loc yields nothing', () => {
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const map = singleEntryMap(abs, key, entryFor('a > b ? 1 : 0', 'llm/flip'));
        const mutator = mutatorFor(map);

        // Live loc at babel line 2 — no key for it.
        expect([...mutator.mutate(fakePath(abs, babelRange(2, 4, 9)))]).toHaveLength(0);
    });

    it('MISS (wrong file): matching loc but a DIFFERENT file yields nothing', () => {
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const map = singleEntryMap(abs, key, entryFor('a > b ? 1 : 0', 'llm/flip'));
        const mutator = mutatorFor(map);

        expect([...mutator.mutate(fakePath('/abs/OTHER.ts', babelRange(1, 4, 9)))]).toHaveLength(0);
    });

    it('MULTI-CANDIDATE: a loc with 2+ same-category entries yields 2+ distinct nodes in stored order', () => {
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const e1 = entryFor('a > b ? 1 : 0', 'llm/flip');
        const e2 = entryFor('a < b ? 1 : 0', 'llm/swap');
        const map: LlmMutatorMap = new Map([[abs, new Map([[key, [e1, e2]]])]]);
        const mutator = mutatorFor(map);

        const yielded = [...mutator.mutate(fakePath(abs, babelRange(1, 4, 9)))];
        expect(yielded).toHaveLength(2);
        expect(yielded[0]).not.toBe(yielded[1]);
        expect(isConditionalExpression(yielded[0]!)).toBe(true);
        expect(isConditionalExpression(yielded[1]!)).toBe(true);
    });

    it('NO LOC: a node without loc yields nothing (no throw)', () => {
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const map = singleEntryMap(abs, key, entryFor('a > b ? 1 : 0', 'llm/flip'));
        const mutator = mutatorFor(map);

        expect([...mutator.mutate(fakePathNoLoc(abs))]).toHaveLength(0);
    });

    it('NO HUB: a path without hub.file.opts.filename yields nothing (no throw)', () => {
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const map = singleEntryMap(abs, key, entryFor('a > b ? 1 : 0', 'llm/flip'));
        const mutator = mutatorFor(map);

        expect([...mutator.mutate(fakePath(undefined, babelRange(1, 4, 9)))]).toHaveLength(0);
    });

    it('+1 KEYING: a Stryker-0-based-line-1 replacement matches a babel-line-2 path, and MISSES babel line 1', () => {
        const abs = '/abs/foo.ts';
        const replacement: Replacement = {
            fileName: abs,
            range: range(1, 0, 5), // Stryker 0-based line 1.
            original: 'x + 1',
            replacement: 'x - 1',
            mutatorName: 'llm/off-by-one',
        };
        const { map } = buildLlmMutatorMap([replacement]);
        // `x + 1 → x - 1` classifies as LlmArithmetic; that mutator serves it.
        const mutator = mutatorFor(map, 'LlmArithmetic');

        // Babel line 2 (== Stryker 1 + 1) HITS.
        expect([...mutator.mutate(fakePath(abs, babelRange(2, 0, 5)))]).toHaveLength(1);
        // Babel line 1 MISSES (proves the +1 conversion is applied, not the raw value).
        expect([...mutator.mutate(fakePath(abs, babelRange(1, 0, 5)))]).toHaveLength(0);
        // No other category mutator serves it.
        expect([
            ...mutatorFor(map, 'LlmNumber').mutate(fakePath(abs, babelRange(2, 0, 5))),
        ]).toHaveLength(0);
    });

    it('lifts a shorthand object candidate at the property-key location (own category only)', () => {
        const file = '/abs/shorthand.ts';
        const path = pathFor('const output = { signal };', p => p.isObjectExpression(), file);
        const property = (path.node as { properties: Node[] }).properties[0]! as { key: Node };
        const key = locKeyFromBabelLoc(property.key.loc!);
        const map = singleEntryMap(file, key, entryFor('null', 'llm/shorthand', 'LlmConstant'));
        const out = [...mutatorFor(map, 'LlmConstant').mutate(path)];
        expect(out).toHaveLength(1);
        expect((out[0] as { properties: Node[] }).properties[0]!.type).toBe('ObjectProperty');
        expect(
            (out[0] as { properties: Array<{ shorthand?: boolean }> }).properties[0]!.shorthand,
        ).toBe(false);
        // The shorthand branch filters by category too.
        expect([...mutatorFor(map, 'LlmIdentifier').mutate(path)]).toHaveLength(0);
    });

    it('drops a const-binding assignment candidate and reports the reason', () => {
        const file = '/abs/const.ts';
        const path = pathFor(
            'const locked = 1; locked;',
            p =>
                p.isIdentifier() &&
                (p.node as { name?: string }).name === 'locked' &&
                p.parentPath?.node.type === 'ExpressionStatement',
            file,
        );
        const key = locKeyFromBabelLoc(path.node.loc!);
        const notes: string[] = [];
        const map = singleEntryMap(file, key, entryFor('locked = 2', 'llm/const'));
        expect([
            ...mutatorFor(map, DEFAULT_CATEGORY, line => notes.push(line)).mutate(path),
        ]).toHaveLength(0);
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain('immutable binding locked');
    });

    it('keeps writable lets and property writes, but drops imported bindings', () => {
        const file = '/abs/writes.ts';
        const cases = [
            { code: 'let value = 1; value;', name: 'value', replacement: 'value = 2', expected: 1 },
            {
                code: 'const holder = {}; holder.timer;',
                name: 'timer',
                replacement: 'holder.timer = 2',
                expected: 1,
            },
            {
                code: 'import { value } from "pkg"; value;',
                name: 'value',
                replacement: 'value = 2',
                expected: 0,
            },
        ];
        for (const fixture of cases) {
            const path = pathFor(
                fixture.code,
                p =>
                    fixture.name === 'timer'
                        ? p.node.type === 'MemberExpression'
                        : p.isIdentifier() &&
                          (p.node as { name?: string }).name === fixture.name &&
                          p.parentPath?.node.type === 'ExpressionStatement',
                file,
            );
            const map = singleEntryMap(
                file,
                locKeyFromBabelLoc(path.node.loc!),
                entryFor(fixture.replacement, 'llm/write'),
            );
            expect([...mutatorFor(map).mutate(path)]).toHaveLength(fixture.expected);
        }
    });

    it('drops a candidate invalid in its assignment parent field', () => {
        const file = '/abs/placement.ts';
        const path = pathFor('entry.timer = 1;', p => p.node.type === 'MemberExpression', file);
        const notes: string[] = [];
        const map = singleEntryMap(
            file,
            locKeyFromBabelLoc(path.node.loc!),
            entryFor('({ replacement: 1 })', 'llm/invalid-place'),
        );
        expect([
            ...mutatorFor(map, DEFAULT_CATEGORY, line => notes.push(line)).mutate(path),
        ]).toHaveLength(0);
        expect(notes).toHaveLength(1);
    });

    it('treats Babel 8 null listKey as an ordinary parent field', () => {
        const file = '/abs/babel8-object-value.ts';
        const path = pathFor(
            'const result = { signal: signal };',
            p =>
                p.isIdentifier() &&
                (p.node as { name?: string }).name === 'signal' &&
                p.parentPath?.node.type === 'ObjectProperty' &&
                (p as unknown as { key?: string }).key === 'value',
            file,
        );
        const babel8Path = Object.create(path) as NodePath;
        Object.defineProperty(babel8Path, 'listKey', { value: null });
        const map = singleEntryMap(
            file,
            locKeyFromBabelLoc(path.node.loc!),
            entryFor('null', 'llm/babel8-object-value'),
        );
        expect([...mutatorFor(map).mutate(babel8Path)]).toHaveLength(1);
    });

    it('preserves undefined scalar and string listKey placement paths', () => {
        const file = '/abs/list-key.ts';
        const scalar = pathFor(
            'const result = { signal: signal };',
            p =>
                p.isIdentifier() &&
                (p.node as { name?: string }).name === 'signal' &&
                (p as unknown as { key?: string }).key === 'value',
            file,
        );
        const array = pathFor(
            'const values = [signal];',
            p => p.isIdentifier() && (p.node as { name?: string }).name === 'signal',
            file,
        );
        for (const [path, listKey] of [
            [scalar, undefined],
            [array, 'elements'],
        ] as const) {
            const shaped = Object.create(path) as NodePath;
            Object.defineProperty(shaped, 'listKey', { value: listKey });
            const map = singleEntryMap(
                file,
                locKeyFromBabelLoc(path.node.loc!),
                entryFor('null', 'llm/list-key'),
            );
            expect([...mutatorFor(map).mutate(shaped)]).toHaveLength(1);
        }
    });
});
