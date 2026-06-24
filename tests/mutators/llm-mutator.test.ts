/*
 * Offline unit tests for the injected dynamic-LLM `NodeMutator`.
 *
 * The mutator is a pure sync map lookup, so these tests need NO Stryker and NO
 * network. They hand it (a) a HAND-BUILT `(absFileName, locKey) → ParsedEntry[]`
 * map and (b) a minimal FAKE NodePath exposing only the two fields the mutator
 * reads — `path.node.loc` and `path.hub.file.opts.filename`. A bare
 * `babel.traverse` does NOT populate `hub` (only Stryker's `new File({filename})`
 * wrap does), so a real traverse cannot exercise the file-keying; the fake path
 * does, which is the whole point of the single-mutator design.
 */

import { describe, expect, it } from 'bun:test';
import { isConditionalExpression, type Node } from '@babel/types';

import {
    buildLlmMutatorMap,
    type LlmMutatorMap,
    locKeyFromRange,
    type ParsedEntry,
} from '../../src/pipeline/llm-map';
import { createLlmMutator, LLM_MUTATOR_NAME } from '../../src/mutators/llm-mutator';
import { parseReplacementFragment } from '../../src/pipeline/parse-fragment';
import type { NodePath } from '../../src/mutators/types';
import type { Replacement, SourceRange } from '../../src/seam/types';

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

function entryFor(replacement: string, mutatorName: string): ParsedEntry {
    const node = parseReplacementFragment(replacement);
    if (node === undefined) {
        throw new Error(`fixture replacement did not parse: ${replacement}`);
    }
    return { node, mutatorName, replacement, original: 'orig' };
}

describe('createLlmMutator', () => {
    it('has the Stryker-facing name "llm"', () => {
        expect(createLlmMutator(new Map()).name).toBe(LLM_MUTATOR_NAME);
        expect(LLM_MUTATOR_NAME).toBe('llm');
    });

    it('HIT: yields the entry node when (filename, loc) match, and a FRESH node per iteration', () => {
        const abs = '/abs/foo.ts';
        // Stryker 0-based line 0 → babel-1-based key line 1.
        const key = locKeyFromRange(range(0, 4, 9));
        const map = singleEntryMap(abs, key, entryFor('a > b ? 1 : 0', 'llm/flip'));
        const mutator = createLlmMutator(map);

        const path = fakePath(abs, babelRange(1, 4, 9));
        const first = [...mutator.mutate(path)];
        expect(first).toHaveLength(1);
        expect(isConditionalExpression(first[0]!)).toBe(true);

        // Distinct node identity across two iterations (the §3.1 anti-collapse rule).
        const second = [...mutator.mutate(path)];
        expect(second[0]).not.toBe(first[0]);
    });

    it('MISS (wrong loc): same file, non-matching loc yields nothing', () => {
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const map = singleEntryMap(abs, key, entryFor('a > b ? 1 : 0', 'llm/flip'));
        const mutator = createLlmMutator(map);

        // Live loc at babel line 2 — no key for it.
        expect([...mutator.mutate(fakePath(abs, babelRange(2, 4, 9)))]).toHaveLength(0);
    });

    it('MISS (wrong file): matching loc but a DIFFERENT file yields nothing', () => {
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const map = singleEntryMap(abs, key, entryFor('a > b ? 1 : 0', 'llm/flip'));
        const mutator = createLlmMutator(map);

        expect([...mutator.mutate(fakePath('/abs/OTHER.ts', babelRange(1, 4, 9)))]).toHaveLength(0);
    });

    it('MULTI-CANDIDATE: a loc with 2+ entries yields 2+ distinct nodes in stored order', () => {
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const e1 = entryFor('a > b ? 1 : 0', 'llm/flip');
        const e2 = entryFor('a < b ? 1 : 0', 'llm/swap');
        const map: LlmMutatorMap = new Map([[abs, new Map([[key, [e1, e2]]])]]);
        const mutator = createLlmMutator(map);

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
        const mutator = createLlmMutator(map);

        expect([...mutator.mutate(fakePathNoLoc(abs))]).toHaveLength(0);
    });

    it('NO HUB: a path without hub.file.opts.filename yields nothing (no throw)', () => {
        const abs = '/abs/foo.ts';
        const key = locKeyFromRange(range(0, 4, 9));
        const map = singleEntryMap(abs, key, entryFor('a > b ? 1 : 0', 'llm/flip'));
        const mutator = createLlmMutator(map);

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
        const mutator = createLlmMutator(map);

        // Babel line 2 (== Stryker 1 + 1) HITS.
        expect([...mutator.mutate(fakePath(abs, babelRange(2, 0, 5)))]).toHaveLength(1);
        // Babel line 1 MISSES (proves the +1 conversion is applied, not the raw value).
        expect([...mutator.mutate(fakePath(abs, babelRange(1, 0, 5)))]).toHaveLength(0);
    });
});
