/*
 * The injected dynamic-LLM `NodeMutator` (functional-architecture §3.2 /
 * LLMMutator design spec). PURE, SYNCHRONOUS, bun-testable.
 *
 * Stryker's `NodeMutator.mutate(path)` returns a SYNCHRONOUS `Iterable<Node>` —
 * there is no place to await an LLM. So all LLM work is the async pre-pass, which
 * precomputes a `(absFileName, locKey) → ParsedEntry[]` map; this single injected
 * mutator does only a SYNC two-level map lookup inside `mutate(path)` and yields
 * the precomputed replacement node(s). One mutator serves ALL files: it learns
 * the current file from `path.hub.file.opts.filename` (which Stryker wires by
 * traversing the AST wrapped in a babel `File({ filename })`).
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
 *
 * NAME-TAG. A `NodeMutator` has exactly ONE `name`, and Stryker stamps it onto
 * EVERY yielded mutant — so the generic `'llm'` name appears in Stryker's own
 * report for all LLM mutants. The per-candidate `llm/<tag>` (on each
 * `ParsedEntry.mutatorName`, originating in propose.ts) is preserved in the map
 * and surfaced by OUR reporter's id→tag side-table, NOT by Stryker's blended
 * report. This is the documented M3/M4 tradeoff (one `'llm'` mutator + reporter
 * tagging); per-tag sub-mutators are the heavier upgrade if native tagging is
 * later required.
 */

import {
    isObjectProperty,
    objectExpression,
    objectProperty,
    validate,
    type Expression,
    type Node,
} from '@babel/types';

import {
    type BabelLoc,
    type LlmMutatorMap,
    locKeyFromBabelLoc,
    type ParsedEntry,
} from '../pipeline/llm-map';
import { parseReplacementFragment } from '../pipeline/parse-fragment';
import type { NodeMutator, NodePath } from './types';

/** The stable `name` Stryker stamps on every LLM mutant in its own report. */
export const LLM_MUTATOR_NAME = 'llm';

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
 * Build the single injected `LLMMutator` over a precomputed {@link LlmMutatorMap}.
 * The returned object is a valid Stryker `NodeMutator`: a `name` plus a
 * synchronous `*mutate(path)` generator. It mutates NOTHING and calls no LLM —
 * it only reads the live path and yields precomputed replacement nodes.
 *
 * The hot path bails early (yields nothing) for every node whose file/loc is not
 * targeted, which is the overwhelming majority across a whole-repo instrument:
 *   • no `hub.file.opts.filename` → no-match (degrades cleanly if Stryker stops
 *     wiring the babel `File`);
 *   • file not in the map → no-match;
 *   • `node.loc` absent → no-match;
 *   • loc not in the file's inner map → no-match.
 *
 * @param map The precomputed `(absFileName, locKey) → ParsedEntry[]` table.
 * @returns A Stryker `NodeMutator` named {@link LLM_MUTATOR_NAME}.
 */
export function createLlmMutator(map: LlmMutatorMap, log?: (line: string) => void): NodeMutator {
    return {
        name: LLM_MUTATOR_NAME,

        *mutate(path: NodePath): Iterable<Node> {
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
            const entries: ParsedEntry[] | undefined = byLoc.get(locKey);
            const drop = (entry: ParsedEntry, candidateLoc: string, reason: string): void => {
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

            if (path.isObjectExpression?.()) {
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

            const runtimePath = path as NodePath & {
                parentPath?: NodePath;
            };
            if (
                isObjectProperty(path.node) &&
                path.node.shorthand &&
                runtimePath.parentPath?.isObjectExpression()
            ) {
                return;
            }
            if (
                runtimePath.parentPath !== undefined &&
                runtimePath.parentPath !== null &&
                isObjectProperty(runtimePath.parentPath.node) &&
                runtimePath.parentPath.node.shorthand &&
                runtimePath.parentPath.parentPath?.isObjectExpression()
            ) {
                return;
            }
            if (entries === undefined) {
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
        },
    };
}

function placementError(path: NodePath, replacement: Node): string | undefined {
    const runtimePath = path as NodePath & {
        key: string | number;
        listKey?: string;
        parentPath?: {
            node: Record<string, unknown>;
            scope?: { getBinding(name: string): { kind: string } | undefined };
        };
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
        if (runtimePath.listKey !== undefined) {
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
