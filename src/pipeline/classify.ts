/*
 * Deterministic LLM-mutant CLASSIFIER — the closed `Llm<Category>` taxonomy
 * every dynamic-LLM mutant is named by in Stryker's own report. PURE, OFFLINE,
 * bun-safe (`@babel/parser` only).
 *
 * WHY: Stryker's directive bookkeeper ignores mutants by `(line, mutator name)`
 * and mutators cannot set `ignoreReason` themselves. With every LLM mutant named
 * `llm`, a `// Stryker disable next-line llm` written for ONE vetted-equivalent
 * proposal also hid every OTHER proposal on that line (`c.unreadCount > 0` →
 * `>= 1` (equivalent) vs `!== 0` (real)). Naming each mutant by the KIND of
 * change lets a directive target one kind and leave the rest live.
 *
 * DETERMINISTIC AND CACHE-KEY NEUTRAL: the category is a pure function of the
 * parsed `(original, replacement)` pair — never of the model's free-text
 * `mutatorTag` (13,782 distinct spellings for the same few ideas in one real
 * cache). Nothing here touches the propose prompt, system prompt, schema or
 * cache key; classification happens when cached/fresh proposals are turned
 * into map entries, strictly AFTER the cache boundary.
 *
 * ALGORITHM (first match wins; every rule is total over two trees):
 *   1. `normalize`: strip TS wrappers (`as`, `satisfies`, `!`, `<T>`,
 *      instantiation) and parens, drop positional / type-only keys, fold a
 *      `PrivateName` into an `Identifier` named `#x`.
 *   2. Whole-tree counters compared SEPARATELY: `await` count differs →
 *      LlmAwait; `??` count OR optional-link count differs → LlmNullish (the two
 *      nullish counters are never summed, so `a?.b → a.b ?? 0` cannot cancel).
 *   3. Lock-step descent to the first divergence. At every PAIRED node, before
 *      its fields: a ConditionalExpression whose branches are exchanged →
 *      ternary-swap (at any depth); a Binary/Logical whose operands are
 *      exchanged → operand-swap; a Member↔OptionalMember or Call↔OptionalCall
 *      pair → optional-chain. Then a type mismatch, a list-length / list-reorder
 *      mismatch, or a differing scalar field (with the two NODES as the pair).
 *   4–7. Map the divergence kind + slot + node types onto a category (see the
 *      rule functions below). No divergence → LlmOther (shape-equal pair).
 */

import type { Node } from '@babel/types';

import { nodeShape, parseExpressionTolerant } from './fingerprint';

/** The closed taxonomy, in the order the mutators are registered. */
export const LLM_CATEGORIES = [
    'LlmComparison',
    'LlmArithmetic',
    'LlmLogical',
    'LlmNullish',
    'LlmNegate',
    'LlmAwait',
    'LlmTernary',
    'LlmMethod',
    'LlmArgument',
    'LlmProperty',
    'LlmIdentifier',
    'LlmNumber',
    'LlmString',
    'LlmConstant',
    'LlmStatement',
    'LlmOther',
] as const;

/** One of the {@link LLM_CATEGORIES}. */
export type LlmCategory = (typeof LLM_CATEGORIES)[number];

/** A normalized AST node: a plain record with a `type` string. */
type Rec = Record<string, unknown> & { type: string };

/** TS / grouping wrappers replaced by their `.expression` during normalization. */
const UNWRAP_TYPES: ReadonlySet<string> = new Set([
    'TSAsExpression',
    'TSSatisfiesExpression',
    'TSNonNullExpression',
    'TSTypeAssertion',
    'TSInstantiationExpression',
    'ParenthesizedExpression',
]);

/** Keys carrying position, comments or type-only data — dropped at every depth. */
const DROPPED_KEYS: ReadonlySet<string> = new Set([
    'loc',
    'start',
    'end',
    'range',
    'extra',
    'leadingComments',
    'trailingComments',
    'innerComments',
    'comments',
    'errors',
    'typeAnnotation',
    'typeParameters',
    'typeArguments',
    'returnType',
    'declare',
    'definite',
    'decorators',
    'accessibility',
    'override',
    'readonly',
    'predicate',
]);

/** Whether a value is a normalized node (an object carrying a `type` string). */
function isRec(value: unknown): value is Rec {
    return typeof value === 'object' && value !== null && typeof (value as Rec).type === 'string';
}

/** Deep-clone with wrappers unwrapped and positional / type-only keys removed. */
function normalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(normalize);
    }
    if (!isRec(value)) {
        return value;
    }
    if (UNWRAP_TYPES.has(value.type)) {
        return normalize(value.expression);
    }
    if (value.type === 'PrivateName') {
        const id = value.id as { name?: unknown } | undefined;
        return { type: 'Identifier', name: `#${String(id?.name ?? '')}` };
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (DROPPED_KEYS.has(key) || (key === 'optional' && value.type === 'Identifier')) {
            continue;
        }
        out[key] = normalize(child);
    }
    return out;
}

/** Shape memo: the canonical serialization of a normalized node, once per node. */
const shapes = new WeakMap<object, string>();

/** The canonical shape of a normalized node (memoized). */
function shape(node: unknown): string {
    if (typeof node !== 'object' || node === null) {
        return nodeShape(node);
    }
    let cached = shapes.get(node);
    if (cached === undefined) {
        cached = nodeShape(node);
        shapes.set(node, cached);
    }
    return cached;
}

/** The direct child nodes of a normalized node (arrays flattened, non-nodes skipped). */
function children(node: Rec): Rec[] {
    const out: Rec[] = [];
    for (const child of Object.values(node)) {
        if (Array.isArray(child)) {
            for (const item of child) {
                if (isRec(item)) {
                    out.push(item);
                }
            }
        } else if (isRec(child)) {
            out.push(child);
        }
    }
    return out;
}

/** Count the nodes of a tree matching `predicate`. */
function count(node: unknown, predicate: (node: Rec) => boolean): number {
    if (!isRec(node)) {
        return 0;
    }
    let total = predicate(node) ? 1 : 0;
    for (const child of children(node)) {
        total += count(child, predicate);
    }
    return total;
}

/** Whether `needle`'s shape equals the shape of some PROPER descendant of `haystack`. */
function contains(haystack: Rec, needle: Rec): boolean {
    const target = shape(needle);
    const stack = children(haystack);
    while (stack.length > 0) {
        const current = stack.pop() as Rec;
        if (shape(current) === target) {
            return true;
        }
        stack.push(...children(current));
    }
    return false;
}

const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
    '==',
    '===',
    '!=',
    '!==',
    '<',
    '<=',
    '>',
    '>=',
    'in',
    'instanceof',
]);

/** The category of a BinaryExpression operator: comparison or arithmetic/bitwise. */
function binaryClass(operator: unknown): LlmCategory {
    return COMPARISON_OPERATORS.has(String(operator)) ? 'LlmComparison' : 'LlmArithmetic';
}

/** Two BinaryExpression operators: both arithmetic → LlmArithmetic, else LlmComparison. */
function binaryPairClass(a: unknown, b: unknown): LlmCategory {
    return binaryClass(a) === 'LlmArithmetic' && binaryClass(b) === 'LlmArithmetic'
        ? 'LlmArithmetic'
        : 'LlmComparison';
}

/** A LogicalExpression: `??` → LlmNullish, `&&` / `||` → LlmLogical. */
function logicalClass(...operators: unknown[]): LlmCategory {
    return operators.some(operator => operator === '??') ? 'LlmNullish' : 'LlmLogical';
}

/** A UnaryExpression operator: `!` → LlmNegate, `- + ~` → LlmArithmetic, else LlmOther. */
function unaryClass(...operators: unknown[]): LlmCategory {
    if (operators.some(operator => operator === '!')) {
        return 'LlmNegate';
    }
    if (operators.some(operator => operator === '-' || operator === '+' || operator === '~')) {
        return 'LlmArithmetic';
    }
    return 'LlmOther';
}

const CALL_TYPES: ReadonlySet<string> = new Set([
    'CallExpression',
    'OptionalCallExpression',
    'NewExpression',
]);
const MEMBER_TYPES: ReadonlySet<string> = new Set(['MemberExpression', 'OptionalMemberExpression']);
const LIST_SLOTS: ReadonlySet<string> = new Set(['arguments', 'elements', 'properties', 'params']);
const ARGUMENT_TYPES: ReadonlySet<string> = new Set([
    'ArrayExpression',
    'ObjectExpression',
    'SpreadElement',
]);

/** Field comparison order per node type; unlisted types compare every kept key, sorted. */
const KEY_ORDER: Readonly<Record<string, readonly string[]>> = {
    BinaryExpression: ['operator', 'left', 'right'],
    LogicalExpression: ['operator', 'left', 'right'],
    AssignmentExpression: ['operator', 'left', 'right'],
    UnaryExpression: ['operator', 'argument'],
    UpdateExpression: ['operator', 'prefix', 'argument'],
    CallExpression: ['callee', 'arguments', 'optional'],
    OptionalCallExpression: ['callee', 'arguments', 'optional'],
    NewExpression: ['callee', 'arguments', 'optional'],
    MemberExpression: ['object', 'property', 'computed', 'optional'],
    OptionalMemberExpression: ['object', 'property', 'computed', 'optional'],
    ConditionalExpression: ['test', 'consequent', 'alternate'],
    IfStatement: ['test', 'consequent', 'alternate'],
    Identifier: ['name'],
    NumericLiteral: ['value'],
    StringLiteral: ['value'],
    BooleanLiteral: ['value'],
    BigIntLiteral: ['value'],
    RegExpLiteral: ['pattern', 'flags'],
    TemplateLiteral: ['quasis', 'expressions'],
    TemplateElement: ['value'],
    ArrayExpression: ['elements'],
    ObjectExpression: ['properties'],
    ObjectProperty: ['key', 'computed', 'shorthand', 'value'],
    SpreadElement: ['argument'],
    AwaitExpression: ['argument'],
    YieldExpression: ['argument'],
    ReturnStatement: ['argument'],
    ArrowFunctionExpression: ['params', 'async', 'body'],
    FunctionExpression: ['params', 'async', 'body'],
    BlockStatement: ['body'],
    ExpressionStatement: ['expression'],
    VariableDeclaration: ['kind', 'declarations'],
    VariableDeclarator: ['id', 'init'],
    ForStatement: ['init', 'test', 'update', 'body'],
    ForInStatement: ['left', 'right', 'body'],
    ForOfStatement: ['left', 'right', 'body'],
    WhileStatement: ['test', 'body'],
    DoWhileStatement: ['test', 'body'],
};

/** The keys to compare for a pair of same-type nodes. */
function keysFor(o: Rec, r: Rec): readonly string[] {
    const listed = KEY_ORDER[o.type];
    if (listed !== undefined) {
        return listed;
    }
    return [...new Set([...Object.keys(o), ...Object.keys(r)])]
        .filter(key => key !== 'type')
        .sort();
}

/** Where a node sits: its parent's type and the field it occupies. */
interface Slot {
    parentType: string | undefined;
    key: string;
}

/** The root slot (no parent). */
const ROOT: Slot = { parentType: undefined, key: '' };

/** The first structural difference between two normalized trees. */
type Divergence =
    | { kind: 'ternary-swap' }
    | { kind: 'operand-swap'; node: Rec }
    | { kind: 'optional-chain' }
    | { kind: 'list'; slot: Slot }
    | { kind: 'scalar'; o: Rec; r: Rec; field: string; chain: readonly Slot[] }
    | { kind: 'mismatch'; o: unknown; r: unknown; chain: readonly Slot[] };

/** Whether two arrays hold the same multiset of shapes in a different order. */
function isReorder(a: unknown[], b: unknown[]): boolean {
    const as = a.map(shape);
    const bs = b.map(shape);
    if (as.every((item, index) => item === bs[index])) {
        return false;
    }
    return as.toSorted().every((item, index) => item === bs.toSorted()[index]);
}

/** Step 3a: the paired-node pre-descent swap checks. */
function pairedSwap(o: Rec, r: Rec): Divergence | undefined {
    if (o.type === 'ConditionalExpression') {
        if (
            shape(o.test) === shape(r.test) &&
            shape(o.consequent) === shape(r.alternate) &&
            shape(o.alternate) === shape(r.consequent) &&
            shape(o.consequent) !== shape(o.alternate)
        ) {
            return { kind: 'ternary-swap' };
        }
    }
    if (
        (o.type === 'BinaryExpression' || o.type === 'LogicalExpression') &&
        o.operator === r.operator &&
        shape(o.left) === shape(r.right) &&
        shape(o.right) === shape(r.left) &&
        shape(o.left) !== shape(o.right)
    ) {
        return { kind: 'operand-swap', node: o };
    }
    return undefined;
}

/** Step 3b: a Member↔OptionalMember or Call↔OptionalCall pair. */
function isOptionalChainPair(o: Rec, r: Rec): boolean {
    const pair = new Set([o.type, r.type]);
    return (
        (pair.has('MemberExpression') && pair.has('OptionalMemberExpression')) ||
        (pair.has('CallExpression') && pair.has('OptionalCallExpression'))
    );
}

/** Lock-step descent (step 3): find the first divergence, or `undefined` when shape-equal. */
function findDivergence(o: unknown, r: unknown, chain: readonly Slot[]): Divergence | undefined {
    if (!isRec(o) || !isRec(r)) {
        if (isRec(o) || isRec(r)) {
            return { kind: 'mismatch', o, r, chain };
        }
        return undefined; // two non-node leaves are handled by the scalar rule above them
    }
    if (o.type === r.type) {
        const swap = pairedSwap(o, r);
        if (swap !== undefined) {
            return swap;
        }
    } else if (isOptionalChainPair(o, r)) {
        return { kind: 'optional-chain' };
    } else {
        return { kind: 'mismatch', o, r, chain };
    }
    if (shape(o) === shape(r)) {
        return undefined;
    }
    for (const key of keysFor(o, r)) {
        const found = findFieldDivergence(o, r, key, chain);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
}

/** The divergence inside ONE field of a same-type pair, or `undefined` when equal. */
function findFieldDivergence(
    o: Rec,
    r: Rec,
    key: string,
    chain: readonly Slot[],
): Divergence | undefined {
    const ov = o[key];
    const rv = r[key];
    const slot: Slot = { parentType: o.type, key };
    const next = [...chain, slot];
    if (Array.isArray(ov) && Array.isArray(rv)) {
        if (ov.length !== rv.length || (LIST_SLOTS.has(key) && isReorder(ov, rv))) {
            return { kind: 'list', slot };
        }
        return ov
            .map((item, index) => findDivergence(item, rv[index], next))
            .find(found => found !== undefined);
    }
    if (isRec(ov) || isRec(rv)) {
        return findDivergence(ov, rv, next);
    }
    return shape(ov) === shape(rv) ? undefined : { kind: 'scalar', o, r, field: key, chain };
}

/** Whether the slot names a call's callee. */
function isCalleeSlot(slot: Slot | undefined): boolean {
    return slot !== undefined && slot.key === 'callee' && CALL_TYPES.has(slot.parentType ?? '');
}

/** Whether the slot names a member expression's property. */
function isPropertySlot(slot: Slot | undefined): boolean {
    return slot !== undefined && slot.key === 'property' && MEMBER_TYPES.has(slot.parentType ?? '');
}

/** Step 4: a list-length or list-reorder divergence, by the list's slot. */
function classifyList(slot: Slot): LlmCategory {
    if (LIST_SLOTS.has(slot.key)) {
        return 'LlmArgument';
    }
    if (slot.key === 'quasis' || slot.key === 'expressions') {
        return 'LlmString';
    }
    if (slot.key === 'body' || slot.key === 'declarations') {
        return 'LlmStatement';
    }
    return 'LlmOther';
}

/** Step 6 for an `Identifier.name` change: decided by where the identifier sits. */
function classifyIdentifier(o: Rec, r: Rec, chain: readonly Slot[]): LlmCategory {
    const slot = chain.at(-1);
    const parentSlot = chain.at(-2);
    if (isPropertySlot(slot)) {
        return isCalleeSlot(parentSlot) ? 'LlmMethod' : 'LlmProperty';
    }
    if (isCalleeSlot(slot)) {
        return 'LlmMethod';
    }
    if (slot?.parentType === 'ObjectProperty' && slot.key === 'key') {
        return 'LlmArgument';
    }
    if (o.name === 'undefined' || r.name === 'undefined') {
        return 'LlmConstant';
    }
    return 'LlmIdentifier';
}

/** Step 6, the fixed part: a differing scalar field on a node of this type. */
const SCALAR_BY_TYPE: Readonly<Record<string, LlmCategory>> = {
    UpdateExpression: 'LlmArithmetic',
    AssignmentExpression: 'LlmArithmetic',
    NumericLiteral: 'LlmNumber',
    BigIntLiteral: 'LlmNumber',
    StringLiteral: 'LlmString',
    TemplateElement: 'LlmString',
    RegExpLiteral: 'LlmString',
    BooleanLiteral: 'LlmConstant',
    MemberExpression: 'LlmProperty',
    ObjectProperty: 'LlmArgument',
};

/** Step 6: a differing scalar field on two same-type nodes. */
function classifyScalar(o: Rec, r: Rec, field: string, chain: readonly Slot[]): LlmCategory {
    switch (o.type) {
        case 'BinaryExpression':
            return binaryPairClass(o.operator, r.operator);
        case 'LogicalExpression':
            return logicalClass(o.operator, r.operator);
        case 'OptionalMemberExpression':
        case 'OptionalCallExpression':
            return field === 'optional' ? 'LlmNullish' : 'LlmProperty';
        case 'UnaryExpression':
            return unaryClass(o.operator, r.operator);
        case 'Identifier':
            return classifyIdentifier(o, r, chain);
        default:
            return SCALAR_BY_TYPE[o.type] ?? 'LlmOther';
    }
}

/** Step 7b, the fixed part: the category a wrapper of this type implies. */
const WRAPPER_BY_TYPE: Readonly<Record<string, LlmCategory>> = {
    CallExpression: 'LlmMethod',
    OptionalCallExpression: 'LlmMethod',
    NewExpression: 'LlmMethod',
    MemberExpression: 'LlmProperty',
    OptionalMemberExpression: 'LlmProperty',
    ConditionalExpression: 'LlmTernary',
    ArrayExpression: 'LlmArgument',
    ObjectExpression: 'LlmArgument',
    SpreadElement: 'LlmArgument',
    TemplateLiteral: 'LlmString',
    AssignmentExpression: 'LlmStatement',
    AwaitExpression: 'LlmAwait',
    UpdateExpression: 'LlmArithmetic',
};

/** Step 7b: classify by the type of the WRAPPING node (the side that contains the other). */
function classifyWrapper(wrapper: Rec): LlmCategory {
    switch (wrapper.type) {
        case 'LogicalExpression':
            return logicalClass(wrapper.operator);
        case 'BinaryExpression':
            return binaryClass(wrapper.operator);
        case 'UnaryExpression':
            return wrapper.operator === '!' ? 'LlmNegate' : 'LlmArithmetic';
        default:
            return WRAPPER_BY_TYPE[wrapper.type] ?? 'LlmOther';
    }
}

/**
 * Whether the node at `chain` is the RECEIVER of a call: the slot is
 * `Member*.object` and the member chain it sits in occupies a callee slot
 * (`this.getNowMs() → Date.now()` replaces the callee's receiver outright).
 */
function isCalleeReceiver(chain: readonly Slot[]): boolean {
    let index = chain.length - 1;
    const slot = chain[index];
    if (slot === undefined || slot.key !== 'object' || !MEMBER_TYPES.has(slot.parentType ?? '')) {
        return false;
    }
    while (
        index >= 0 &&
        chain[index]?.key === 'object' &&
        MEMBER_TYPES.has(chain[index]?.parentType ?? '')
    ) {
        index -= 1;
    }
    return isCalleeSlot(chain[index]);
}

/** Whether a node is a literal of the given class (7c), `undefined` when it is none. */
function literalClass(node: Rec | undefined): LlmCategory | undefined {
    if (node === undefined) {
        return undefined;
    }
    switch (node.type) {
        case 'NumericLiteral':
        case 'BigIntLiteral':
            return 'LlmNumber';
        case 'BooleanLiteral':
        case 'NullLiteral':
            return 'LlmConstant';
        case 'Identifier':
            return node.name === 'undefined' ? 'LlmConstant' : undefined;
        case 'StringLiteral':
        case 'TemplateLiteral':
        case 'RegExpLiteral':
            return 'LlmString';
        default:
            return undefined;
    }
}

/**
 * Step 7c precedence: the first rule whose predicate matches EITHER side wins.
 * A rule may derive the category from the matching node (a binary operator's
 * class, a literal's kind).
 */
const UNRELATED_RULES: ReadonlyArray<{
    matches: (node: Rec) => boolean;
    category: (node: Rec) => LlmCategory;
}> = [
    { matches: n => n.type === 'ConditionalExpression', category: () => 'LlmTernary' },
    {
        matches: n => n.type === 'UnaryExpression' && n.operator === '!',
        category: () => 'LlmNegate',
    },
    { matches: n => n.type === 'LogicalExpression', category: n => logicalClass(n.operator) },
    { matches: n => n.type === 'BinaryExpression', category: n => binaryClass(n.operator) },
    { matches: n => CALL_TYPES.has(n.type), category: () => 'LlmMethod' },
    { matches: n => literalClass(n) !== undefined, category: n => literalClass(n) ?? 'LlmOther' },
    { matches: n => MEMBER_TYPES.has(n.type), category: () => 'LlmProperty' },
    { matches: n => ARGUMENT_TYPES.has(n.type), category: () => 'LlmArgument' },
    { matches: n => n.type === 'UpdateExpression', category: () => 'LlmArithmetic' },
    {
        matches: n =>
            n.type === 'AssignmentExpression' ||
            n.type.endsWith('Statement') ||
            n.type.endsWith('Declaration'),
        category: () => 'LlmStatement',
    },
];

/** Step 7c: no containment — decide by either side's kind, in fixed precedence. */
function classifyUnrelated(
    o: Rec | undefined,
    r: Rec | undefined,
    slot: Slot | undefined,
): LlmCategory {
    if (slot?.key === 'arguments') {
        return 'LlmArgument';
    }
    const sides = [o, r].filter((side): side is Rec => side !== undefined);
    for (const rule of UNRELATED_RULES) {
        const match = sides.find(rule.matches);
        if (match !== undefined) {
            return rule.category(match);
        }
    }
    return 'LlmOther';
}

/** Step 7: a type mismatch (or a null-vs-node) at `chain`. */
function classifyMismatch(o: unknown, r: unknown, chain: readonly Slot[]): LlmCategory {
    const slot = chain.at(-1);
    const parentSlot = chain.at(-2);
    // 7a: the callee itself, a member property that forms a callee, or the
    // receiver of a callee; else a member property (`a.b → a[0]`).
    if (
        isCalleeSlot(slot) ||
        (isPropertySlot(slot) && isCalleeSlot(parentSlot)) ||
        isCalleeReceiver(chain)
    ) {
        return 'LlmMethod';
    }
    if (isPropertySlot(slot)) {
        return 'LlmProperty';
    }
    const on = isRec(o) ? o : undefined;
    const rn = isRec(r) ? r : undefined;
    // 7b: wrap / unwrap — classify by the side that contains the other.
    if (on !== undefined && rn !== undefined) {
        if (contains(rn, on)) {
            return classifyWrapper(rn);
        }
        if (contains(on, rn)) {
            return classifyWrapper(on);
        }
    }
    // 7c: unrelated shapes.
    return classifyUnrelated(on, rn, slot);
}

/**
 * Classify a mutation from its two ALREADY-PARSED expression nodes. Total and
 * pure over the ASTs: identical inputs always yield the same name. The nodes
 * are never mutated (they are deep-cloned by `normalize`).
 */
export function classifyNodes(original: Node, replacement: Node): LlmCategory {
    const o = normalize(original);
    const r = normalize(replacement);
    if (!isRec(o) || !isRec(r)) {
        return 'LlmOther';
    }
    // Step 2: whole-tree counters, compared separately (never summed).
    if (
        count(o, n => n.type === 'AwaitExpression') !== count(r, n => n.type === 'AwaitExpression')
    ) {
        return 'LlmAwait';
    }
    const nullish = (n: Rec): boolean => n.type === 'LogicalExpression' && n.operator === '??';
    const optional = (n: Rec): boolean =>
        (n.type === 'OptionalMemberExpression' || n.type === 'OptionalCallExpression') &&
        n.optional === true;
    if (count(o, nullish) !== count(r, nullish) || count(o, optional) !== count(r, optional)) {
        return 'LlmNullish';
    }
    // Step 3: the first divergence.
    const divergence = findDivergence(o, r, [ROOT]);
    if (divergence === undefined) {
        return 'LlmOther';
    }
    switch (divergence.kind) {
        case 'ternary-swap':
            return 'LlmTernary';
        case 'operand-swap':
            return divergence.node.type === 'LogicalExpression'
                ? logicalClass(divergence.node.operator)
                : binaryClass(divergence.node.operator);
        case 'optional-chain':
            return 'LlmNullish';
        case 'list':
            return classifyList(divergence.slot);
        case 'scalar':
            return classifyScalar(divergence.o, divergence.r, divergence.field, divergence.chain);
        case 'mismatch':
            return classifyMismatch(divergence.o, divergence.r, divergence.chain);
        default:
            return 'LlmOther';
    }
}

/**
 * Classify a mutation from its two SOURCE TEXTS. Both are parsed with the
 * tolerant sub-expression route the pipeline already uses for shape matching;
 * a side that does not parse yields `LlmOther`. Total: never throws.
 */
export function classifyMutation(original: string, replacement: string): LlmCategory {
    const o = parseExpressionTolerant(original);
    const r = parseExpressionTolerant(replacement);
    if (o === undefined || r === undefined) {
        return 'LlmOther';
    }
    return classifyNodes(o, r);
}
