/*
 * Heuristic NodeMutator: OptionalChainForce (functional-architecture §5, P4).
 *
 * Forcing optional chaining (`a.b` → `a?.b`) suppresses the TypeError a plain
 * member access would throw when the object is null/undefined. That changes
 * THROW behavior: a test that relies on an access throwing on a nullish object —
 * or that asserts a value is always present — can be broken by silently returning
 * `undefined` instead. Stryker's built-ins have an `OptionalChaining` mutator that
 * REMOVES optionality; none ADDS it. This operator is the complementary probe.
 *
 * AUTHORING IDIOM — identical to the P1 trio, but emitting a DIFFERENT node type:
 * Babel models `a?.b` as an `OptionalMemberExpression` (a distinct node with
 * `optional: true`), NOT a `MemberExpression` with a flag. So the replacement is
 * built with the `optionalMemberExpression(object, property, computed, optional)`
 * factory — merely setting `node.optional` would NOT produce the optional form.
 *
 * MATCH: `path.isMemberExpression()`. This narrows to PLAIN (non-optional) member
 * expressions only: `a?.b` parses to an `OptionalMemberExpression`, which
 * `isMemberExpression()` does NOT match, so already-optional members are excluded
 * automatically (no explicit `node.optional` check needed). Plain members in read
 * positions are mutated. Terminal assignment, update, loop, and pattern targets
 * are skipped; an inner receiver in one of those writes is lifted to the enclosing
 * write before optionality is introduced.
 *
 * REPLACEMENT (always exactly one, always a real change):
 *   • `a.b`     → `a?.b`
 *   • `a[i]`    → `a?.[i]`  (computed preserved)
 *   • `this.x`  → `this?.x`
 * The original `object`, `property`, and `computed` flag are reused; only
 * optionality is forced on.
 *
 * LEGALITY: Stryker replaces a read-position `MemberExpression` with an
 * `OptionalMemberExpression`. Stryker's `expression-mutant-placer` treats an
 * `OptionalMemberExpression` as a member expression
 * (`isMemberExpression = path.isMemberExpression() || path.isOptionalMemberExpression()`),
 * so it is placeable in the same position. For nested write receivers, the complete
 * write expression is rebuilt so the optional chain remains a legal read. Direct
 * tagged-template tags are skipped because Bun rejects an optional template tag.
 *
 * EDGE CASES:
 *   • Already-optional members (`a?.b`, an `OptionalMemberExpression`) are not
 *     matched by `isMemberExpression()` — skipped automatically.
 *   • Private-field members (`a.#x`, where `property` is a `PrivateName`) are
 *     skipped: `@babel/types`' `optionalMemberExpression` factory accepts only an
 *     `Expression` property, and a `PrivateName` is not one. This is a rare member
 *     shape and forcing optionality on it adds little signal, so a clean skip is
 *     the right call rather than an unsafe cast.
 *   • Forcing `?.` may be an equivalent mutant when the object is provably
 *     non-nullish — accepted noise, human-audit per §5.
 *   • On a non-nullable typed object the mutated source may be a TS type/lint
 *     concern but instruments fine; if it type-errors it scores as `error`
 *     (honest), not a placement failure.
 */

import {
    cloneNode,
    isPrivateName,
    optionalMemberExpression,
    parenthesizedExpression,
    type Expression,
    type Node,
} from '@babel/types';

import type { NodeMutator } from './types';

type RuntimePath = {
    readonly node: Node;
    readonly hub?: { readonly file?: { readonly opts?: { readonly filename?: string } } };
    readonly parentPath?: RuntimePath | null;
    readonly key?: string | number;
    readonly listKey?: string | null;
    isAssignmentExpression(): boolean;
    isUpdateExpression(): boolean;
    isForInStatement(): boolean;
    isForOfStatement(): boolean;
    isObjectProperty(): boolean;
    isObjectPattern(): boolean;
    isArrayPattern(): boolean;
    isRestElement(): boolean;
    isAssignmentPattern(): boolean;
    isTSAsExpression(): boolean;
    isTSTypeAssertion(): boolean;
    isTSNonNullExpression(): boolean;
    isParenthesizedExpression(): boolean;
    isMemberExpression(): boolean;
    isTaggedTemplateExpression(): boolean;
    get(name: string): RuntimePath;
    traverse(visitor: { MemberExpression(path: RuntimePath): void }): void;
    findParent(predicate: (path: RuntimePath) => boolean): RuntimePath | undefined;
};

function isWriteTarget(path: RuntimePath): boolean {
    let current = path;
    while (current.parentPath !== undefined && current.parentPath !== null) {
        const parent = current.parentPath;
        if (
            (parent.isAssignmentExpression() && current.key === 'left') ||
            (parent.isUpdateExpression() && current.key === 'argument') ||
            ((parent.isForInStatement() || parent.isForOfStatement()) && current.key === 'left')
        ) {
            return true;
        }
        if (
            (parent.isObjectProperty() &&
                current.key === 'value' &&
                parent.parentPath?.isObjectPattern()) ||
            (parent.isArrayPattern() && current.listKey === 'elements') ||
            (parent.isObjectPattern() && current.listKey === 'properties') ||
            (parent.isRestElement() && current.key === 'argument') ||
            (parent.isAssignmentPattern() && current.key === 'left') ||
            ((parent.isTSAsExpression() ||
                parent.isTSTypeAssertion() ||
                parent.isTSNonNullExpression() ||
                parent.isParenthesizedExpression()) &&
                current.key === 'expression')
        ) {
            current = parent;
            continue;
        }
        return false;
    }
    return false;
}

function liftRootForReceiver(path: RuntimePath): RuntimePath | undefined {
    let terminal = path;
    const climbs = (): boolean =>
        Boolean(terminal.parentPath?.isMemberExpression() && terminal.key === 'object') ||
        Boolean(
            (terminal.parentPath?.isTSNonNullExpression() ||
                terminal.parentPath?.isTSAsExpression() ||
                terminal.parentPath?.isTSTypeAssertion() ||
                terminal.parentPath?.isParenthesizedExpression()) &&
            terminal.key === 'expression',
        );
    if (!climbs()) {
        return undefined;
    }
    while (climbs()) {
        terminal = terminal.parentPath!;
    }
    if (!isWriteTarget(terminal)) {
        return undefined;
    }
    return terminal.findParent(
        parent =>
            parent.isAssignmentExpression() ||
            parent.isUpdateExpression() ||
            parent.isForInStatement() ||
            parent.isForOfStatement(),
    );
}

function liftOptionalReceiver(path: RuntimePath, root: RuntimePath): Node {
    const member = path.node as Extract<Node, { type: 'MemberExpression' }>;
    let replacement: Node = optionalMemberExpression(
        cloneNode(member.object, true),
        cloneNode(member.property, true) as Expression,
        Boolean(member.computed),
        true,
    );
    let current = path;
    while (current !== root) {
        const parent = current.parentPath;
        if (parent === undefined || parent === null) {
            throw new Error('Missing parent while lifting optional receiver');
        }
        const cloned = cloneNode(parent.node, true) as unknown as Record<string, unknown>;
        if (current.listKey !== undefined && current.listKey !== null) {
            const list = cloned[current.listKey] as Node[];
            list[current.key as number] = replacement;
        } else {
            cloned[String(current.key)] = replacement;
        }
        replacement =
            (parent.isTSNonNullExpression() ||
                parent.isTSAsExpression() ||
                parent.isTSTypeAssertion()) &&
            parent.parentPath?.isMemberExpression() &&
            parent.key === 'object'
                ? parenthesizedExpression(cloned as unknown as Expression)
                : (cloned as unknown as Node);
        current = parent;
    }
    return replacement;
}

const skippedOptionalTagSites = new Set<string>();

/**
 * The `OptionalChainForce` heuristic mutator. For every plain (non-optional)
 * `MemberExpression`, yields the optional-chained form (an
 * `OptionalMemberExpression` with `optional: true`), preserving the object,
 * property, and computed flag. Yields nothing for already-optional members or any
 * non-member node, so it is safe to register globally.
 */
export const optionalChainForceMutator: NodeMutator = {
    name: 'OptionalChainForce',

    *mutate(path) {
        const runtimePath = path as unknown as RuntimePath;
        if (
            runtimePath.isTaggedTemplateExpression() &&
            runtimePath.get('tag').isMemberExpression()
        ) {
            const tag = runtimePath.get('tag');
            const member = tag.node as Extract<Node, { type: 'MemberExpression' }>;
            if (!isPrivateName(member.property)) {
                const fileName = runtimePath.hub?.file?.opts?.filename ?? 'unknown';
                const loc = member.loc;
                const site = `${fileName}:${String(loc?.start.line ?? 0)}:${String(loc?.start.column ?? 0)}`;
                if (!skippedOptionalTagSites.has(site)) {
                    skippedOptionalTagSites.add(site);
                    // eslint-disable-next-line no-console -- Stryker has no logger at this mutator seam.
                    console.warn(
                        `stryker-llm: skipped unplaceable OptionalChainForce tagged-template site ${site} (Bun rejects optional member as template tag)`,
                    );
                }
            }
            return;
        }
        if (
            runtimePath.isUpdateExpression() ||
            runtimePath.isAssignmentExpression() ||
            runtimePath.isForInStatement() ||
            runtimePath.isForOfStatement()
        ) {
            const lifted: Node[] = [];
            const target = runtimePath.get(runtimePath.isUpdateExpression() ? 'argument' : 'left');
            const lift = (receiver: RuntimePath): void => {
                const member = receiver.node as Extract<Node, { type: 'MemberExpression' }>;
                if (
                    !isPrivateName(member.property) &&
                    liftRootForReceiver(receiver) === runtimePath
                ) {
                    lifted.push(liftOptionalReceiver(receiver, runtimePath));
                }
            };
            if (target.isMemberExpression()) {
                lift(target);
            }
            target.traverse({
                MemberExpression(receiver) {
                    lift(receiver);
                },
            });
            yield* lifted;
            return;
        }
        if (!path.isMemberExpression()) {
            return;
        }

        const { object, property, computed } = path.node;
        // A PrivateName property (`a.#x`) is not an Expression and the
        // optionalMemberExpression factory cannot build it — skip cleanly.
        if (isPrivateName(property)) {
            return;
        }

        if (isWriteTarget(runtimePath)) {
            return;
        }
        if (runtimePath.parentPath?.isTaggedTemplateExpression() && runtimePath.key === 'tag') {
            return;
        }
        if (liftRootForReceiver(runtimePath) !== undefined) {
            return;
        }

        yield optionalMemberExpression(object, property as Expression, Boolean(computed), true);
    },
};
