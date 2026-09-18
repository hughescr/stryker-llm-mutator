/*
 * The injected dynamic-LLM `NodeMutator`s (functional-architecture §3.2 /
 * LLMMutator design spec). PURE, SYNCHRONOUS, bun-testable.
 *
 * Stryker's `NodeMutator.mutate(path)` returns a SYNCHRONOUS `Iterable<Node>` —
 * there is no place to await an LLM. So all LLM work is the async pre-pass, which
 * precomputes a `(absFileName, locKey) → ParsedEntry[]` map; the injected
 * mutators do only a SYNC two-level map lookup inside `mutate(path)` and yield
 * the precomputed replacement node(s). They serve ALL files: each learns the
 * current file from `path.hub.file.opts.filename` (which Stryker wires by
 * traversing the AST wrapped in a babel `File({ filename })`).
 *
 * ONE MUTATOR PER NAME (the naming fix). A `NodeMutator` has exactly ONE `name`,
 * Stryker stamps it onto every yielded mutant, and its directive bookkeeper
 * ignores mutants by `(line, name)` only — so with a single `llm` mutator a
 * `// Stryker disable next-line llm` written for one vetted-equivalent proposal
 * also hid every other proposal on that line. Now {@link createLlmMutators}
 * returns one mutator per registered name: the legacy no-op `llm` (so legacy
 * directives and `excludedMutations` still name a registered mutator and the
 * bookkeeper's "Unused directive" warning never fires) plus one per
 * `Llm<Category>`, each yielding ONLY the map entries of its own category. The
 * category is stamped on each entry at map-build time from the parsed
 * `(original, replacement)` pair (`pipeline/classify.ts`). Legacy plain `llm`
 * directives keep working through the bookkeeper alias in `directive-alias.ts`.
 * The names are STATIC (`LLM_MUTATOR_NAMES`) and registered up front, regardless
 * of the map contents. The per-candidate free-text `llm/<tag>` still lives on
 * `ParsedEntry.mutatorName` for the reporter's side-table, never in Stryker's own
 * report.
 *
 * KEYING (the silent-fail surface). The map was built with the worker's `+1`
 * Stryker-0-based→Babel-1-based line conversion ({@link locKeyFromRange}); here
 * we read the LIVE babel `path.node.loc` (already 1-based line) and form the key
 * with NO offset ({@link locKeyFromBabelLoc}). The two halves are defined
 * together in `llm-map.ts` so they cannot drift.
 *
 * FRESH NODE PER YIELD (the §3.1 silent-overwrite). Stryker co-locates multiple
 * mutants on one node keyed by the YIELDED node object; yielding the SAME node
 * object for two candidates collapses them. So we RE-PARSE each entry's
 * `replacement` per yield via {@link parseReplacementFragment} (a fresh tree each
 * time), exactly as the worker re-parses per entry. The pre-parsed `entry.node`
 * is used only as the build-time parse check / fallback.
 */

import {
    isObjectProperty,
    objectExpression,
    objectProperty,
    validate,
    type Expression,
    type Node,
} from '@babel/types';

import { LLM_CATEGORIES, type LlmCategory } from '../pipeline/classify';
import {
    type BabelLoc,
    type LlmMutatorMap,
    locKeyFromBabelLoc,
    type ParsedEntry,
} from '../pipeline/llm-map';
import { parseReplacementFragment } from '../pipeline/parse-fragment';
import type { NodeMutator, NodePath } from './types';

/**
 * The legacy wildcard name. Still registered (as a no-op mutator) so a plain
 * `// Stryker disable next-line llm` or `excludedMutations: ['llm']` names a
 * known mutator; the directive alias expands it to every category.
 */
export const LLM_MUTATOR_NAME = 'llm';

/**
 * Every name the dynamic-LLM path registers with Stryker, in registration
 * order: the legacy wildcard first, then the 16 categories. STATIC — pushed
 * before any instrumentation regardless of the map contents.
 */
export const LLM_MUTATOR_NAMES: readonly string[] = [LLM_MUTATOR_NAME, ...LLM_CATEGORIES];

/** The registered names as a set for O(1) exact, case-sensitive membership. */
const LLM_MUTATOR_NAME_SET: ReadonlySet<string> = new Set(LLM_MUTATOR_NAMES);

/** Whether `name` is one of {@link LLM_MUTATOR_NAMES} (exact, case-sensitive). */
export function isLlmMutatorName(name: string): boolean {
    return LLM_MUTATOR_NAME_SET.has(name);
}

/**
 * A babel `node.loc` carries `start`/`end` positions plus an optional
 * `filename`/`identifierName`; we only need the line/column slice, so narrow to
 * {@link BabelLoc}. The `@babel/types` `Node.loc` is `SourceLocation | null`.
 */
function readLoc(node: Node): BabelLoc | undefined {
    const loc = node.loc;
    if (loc === null || loc === undefined) {
        return undefined;
    }
    return loc;
}

/**
 * Build the injected LLM `NodeMutator`s over a precomputed {@link LlmMutatorMap}:
 * exactly {@link LLM_MUTATOR_NAMES} in order — the no-op `llm` wildcard, then
 * one mutator per category whose `mutate(path)` yields only the entries of that
 * category. Each is a valid Stryker `NodeMutator`: a `name` plus a synchronous
 * `*mutate(path)` generator. They mutate NOTHING and call no LLM — they only
 * read the live path and yield precomputed replacement nodes.
 *
 * The hot path bails early (yields nothing) for every node whose file/loc is not
 * targeted, which is the overwhelming majority across a whole-repo instrument:
 *   • no `hub.file.opts.filename` → no-match (degrades cleanly if Stryker stops
 *     wiring the babel `File`);
 *   • file not in the map → no-match;
 *   • `node.loc` absent → no-match;
 *   • loc not in the file's inner map → no-match.
 * So the per-node cost of the 16 category mutators is one `hub` read + one
 * `Map.get` each.
 *
 * @param map The precomputed `(absFileName, locKey) → ParsedEntry[]` table.
 * @param log Optional sink for unplaceable-candidate drop notes.
 * @returns The 17 Stryker `NodeMutator`s named {@link LLM_MUTATOR_NAMES}.
 */
export function createLlmMutators(
    map: LlmMutatorMap,
    log?: (line: string) => void,
): readonly NodeMutator[] {
    const legacy: NodeMutator = {
        name: LLM_MUTATOR_NAME,
        // The wildcard yields nothing: it exists only as a registered name.
        *mutate(): Iterable<Node> {},
    };
    const categories: NodeMutator[] = LLM_CATEGORIES.map(category => ({
        name: category,
        *mutate(path: NodePath): Iterable<Node> {
            yield* yieldEntries(path, map, category, log);
        },
    }));
    return [legacy, ...categories];
}

/** A drop-note emitter bound to one file. */
type DropNote = (entry: ParsedEntry, candidateLoc: string, reason: string) => void;

/** Build the drop-note emitter for `fileName` over the optional `log` sink. */
function dropNote(fileName: string, log: ((line: string) => void) | undefined): DropNote {
    return (entry, candidateLoc, reason) => {
        log?.(
            `stryker-llm: dropped unplaceable candidate ${JSON.stringify({
                fileName,
                loc: candidateLoc,
                original: entry.original,
                replacement: entry.replacement,
                reason,
            })}`,
        );
    };
}

/**
 * The shared generator body: yield the `category` entries at the live path
 * (the shorthand-object lift first, then the node's own span).
 *
 * @yields A fresh replacement node per matching entry.
 */
function* yieldEntries(
    path: NodePath,
    map: LlmMutatorMap,
    category: LlmCategory,
    log: ((line: string) => void) | undefined,
): Iterable<Node> {
    const fileName = path.hub?.file?.opts?.filename;
    if (fileName === undefined) {
        return;
    }
    const byLoc = map.get(fileName);
    if (byLoc === undefined) {
        return;
    }
    const loc = readLoc(path.node);
    if (loc === undefined) {
        return;
    }
    const locKey = locKeyFromBabelLoc(loc);
    const entries = byLoc.get(locKey)?.filter(e => e.category === category);
    const drop = dropNote(fileName, log);

    if (path.isObjectExpression?.()) {
        yield* yieldShorthandLifts(path, byLoc, category, drop);
    }

    if (entries === undefined || isInsideShorthandProperty(path)) {
        return;
    }
    for (const entry of entries) {
        // Re-parse per yield so each mutant gets a DISTINCT node identity
        // (yielding entry.node twice would collapse two candidates in
        // Stryker's placement map). The map-builder already proved this
        // string parses, so the re-parse succeeds in practice; the
        // `entry.node` fallback guards the impossible-in-practice failure
        // so a built candidate is never silently dropped at mutate time.
        const replacement = reparse(entry);
        const reason = placementError(path, replacement);
        if (reason === undefined) {
            yield replacement;
        } else {
            drop(entry, locKey, reason);
        }
    }
}

/**
 * Whether `path` is a shorthand ObjectProperty (or its key/value identifier)
 * inside an ObjectExpression — those spans are served by the lift above at
 * the enclosing object, never replaced in place.
 */
function isInsideShorthandProperty(path: NodePath): boolean {
    const runtimePath = path as NodePath & { parentPath?: NodePath | null };
    const parent = runtimePath.parentPath;
    if (isObjectProperty(path.node) && path.node.shorthand && parent?.isObjectExpression()) {
        return true;
    }
    if (parent === undefined || parent === null) {
        return false;
    }
    const grandParent = (parent as NodePath & { parentPath?: NodePath | null }).parentPath;
    return (
        isObjectProperty(parent.node) &&
        parent.node.shorthand &&
        grandParent?.isObjectExpression() === true
    );
}

/**
 * The shorthand-object lift: a candidate keyed on a shorthand property KEY
 * (`{ signal }` → `signal: null`) cannot replace the key identifier itself, so
 * it is yielded as the whole enclosing ObjectExpression with that property
 * expanded to `key: <fragment>`. Only entries of `category` are lifted.
 *
 * @yields A fresh ObjectExpression per matching entry.
 */
function* yieldShorthandLifts(
    path: NodePath,
    byLoc: ReadonlyMap<string, ParsedEntry[]>,
    category: LlmCategory,
    drop: DropNote,
): Iterable<Node> {
    if (!path.isObjectExpression?.()) {
        return;
    }
    for (const [index, property] of path.node.properties.entries()) {
        if (!isObjectProperty(property) || !property.shorthand) {
            continue;
        }
        const keyLoc = readLoc(property.key);
        if (keyLoc === undefined) {
            continue;
        }
        const key = locKeyFromBabelLoc(keyLoc);
        for (const entry of byLoc.get(key) ?? []) {
            if (entry.category !== category) {
                continue;
            }
            const replacement = reparse(entry);
            try {
                const expanded = objectProperty(
                    property.key,
                    replacement as Expression,
                    false,
                    false,
                );
                yield objectExpression(
                    path.node.properties.map((current, currentIndex) =>
                        currentIndex === index ? expanded : current,
                    ),
                );
            } catch (error) {
                if (error instanceof TypeError) {
                    drop(entry, key, error.message);
                } else {
                    throw error;
                }
            }
        }
    }
}

function placementError(path: NodePath, replacement: Node): string | undefined {
    const runtimePath = path as NodePath & {
        key: string | number;
        listKey?: string | null;
        parentPath?: {
            node: Record<string, unknown>;
            scope?: { getBinding(name: string): { kind: string } | undefined };
        } | null;
        scope?: { getBinding(name: string): { kind: string } | undefined };
    };
    if (replacement.type === 'AssignmentExpression' && replacement.left.type === 'Identifier') {
        const binding = runtimePath.scope?.getBinding(replacement.left.name);
        if (binding?.kind === 'const' || binding?.kind === 'module') {
            return `Assignment to immutable binding ${replacement.left.name}`;
        }
    }
    const parent = runtimePath.parentPath;
    if (parent === undefined || parent === null) {
        return undefined;
    }
    try {
        if (runtimePath.listKey !== undefined && runtimePath.listKey !== null) {
            const original = parent.node[runtimePath.listKey];
            if (!Array.isArray(original)) {
                return `Expected parent list ${runtimePath.listKey}`;
            }
            const list = [...original];
            list[runtimePath.key as number] = replacement;
            validate(parent.node, runtimePath.listKey, list);
        } else {
            validate(parent.node, String(runtimePath.key), replacement);
        }
    } catch (error) {
        if (error instanceof TypeError) {
            return error.message;
        }
        throw error;
    }
    return undefined;
}

/**
 * Re-parse an entry's replacement into a fresh node for distinct identity per
 * yield, falling back to the pre-parsed `entry.node` if a re-parse ever fails.
 */
function reparse(entry: ParsedEntry): Node {
    return parseReplacementFragment(entry.replacement) ?? entry.node;
}
