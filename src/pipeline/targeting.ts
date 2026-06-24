/*
 * Gate-1 risk/EV targeting + Gate-2 complementarity hand-off
 * (functional-architecture §4 Gate 1 / Gate 2). PURE, OFFLINE, bun-testable.
 *
 * Given the source files Stryker will mutate, this module decides WHICH enclosing
 * functions are worth spending an LLM call on, and emits one {@link ProposeTarget}
 * per chosen function (the propose stage batches by function, not by span). It
 * makes NO LLM call and imports NO Stryker — it is a deterministic Babel
 * traversal scored by a fixed risk formula:
 *
 *   risk = w1·branchCount + w2·nestingDepth + w3·offByOneAffinity − w4·ignoredDensity
 *   EV   = risk · semanticRichness        (semanticRichness ≥ 1)
 *
 * computed per enclosing function over its subtree. Eligibility is the CUT
 * version (no oracle): `risk ≥ minRiskScore` AND coverage-eligible. With no
 * coverage probe in M3, "no coverage signal" is treated as ELIGIBLE and logged;
 * a `coverageLookup` injection point lets a later coverage map gate
 * `coveredBy ≥ 1`. Eligible functions are then passed through the Gate-2
 * complementarity predicate ({@link isLlmWorthy}) so single formulaic spans are
 * left to the cheaper heuristic mutators; only semantically-rich functions reach
 * the LLM. Survivors are EV-ranked, kept `topSpansPerFile` per file (we read
 * "span" at the function-batch granularity since Gate 3 batches by function), and
 * bounded by a global top-K from the call budget.
 *
 * TRAVERSAL: a tiny hand-rolled recursive walk over `@babel/types` nodes (parsed
 * by `@babel/parser`, the bun-safe parser `filters.ts` also uses). We avoid
 * `@babel/traverse` entirely — it ships no typings and would force an untyped
 * surface — so the whole module stays fully typed from `@babel/types` and runs
 * under `bun test`.
 *
 * POSITIONS: `@babel/parser` reports 1-based line / 0-based column; a
 * {@link ProposeTarget.range} is Stryker 0-based, so we subtract 1 from each line
 * (columns unchanged) when emitting — the inverse of the map-builder's `+1`.
 */

import { parse } from '@babel/parser';
import type { Node } from '@babel/types';

import type { LlmMutatorConfig } from '../config';
import type { ProposeTarget } from './propose';
import type { SourceRange } from '../seam/types';

/** Babel plugins enabling the TS + JSX superset the instrumenter also parses. */
const BABEL_PLUGINS = ['typescript', 'jsx'] as const;

/** Risk-formula weights (functional-architecture §4 Gate 1). Exported for tests. */
export const RISK_WEIGHTS = {
    /** w1 — per branch test node in the function subtree. */
    branch: 1.0,
    /** w2 — per unit of max nesting depth reached. */
    nesting: 0.5,
    /** w3 — per off-by-one-affinity construct (indexing/slice/boundary/comparison). */
    offByOne: 1.5,
    /** w4 — per `// Stryker disable`-covered node (author-vetted; deprioritize). */
    ignored: 2.0,
} as const;

/**
 * The semanticRichness BOOST added (to a base of 1) when a function shows ≥2
 * distinct operator kinds, object/array construction, or a multi-arg call — the
 * places single-token formulaic swaps under-cover.
 */
export const RICHNESS_BOOST = 1.0;

/**
 * Gate-2 threshold: a function is LLM-worthy when `semanticRichness >=
 * RICHNESS_THRESHOLD` (i.e. the boost is present). Formulaic-only functions fall
 * below it and are left to the heuristic mutators.
 */
export const RICHNESS_THRESHOLD = 1.0 + RICHNESS_BOOST;

/** One source file the pre-pass reads (absolute path + content). */
export interface SourceFileInput {
    /** Absolute path Stryker keys by (`path.hub.file.opts.filename`). */
    fileName: string;
    /** The file's full source text. */
    content: string;
}

/** A coverage lookup: how many tests cover the span, or `undefined` if unknown. */
export type CoverageLookup = (fileName: string, range: SourceRange) => number | undefined;

/** A logger sink for targeting notes (coverage, Gate-2 skips). Defaults to no-op. */
export type TargetLogger = (line: string) => void;

/** Options for {@link buildProposeTargets}. */
export interface BuildProposeTargetsOptions {
    /** Injected coverage probe; absent ⇒ no coverage signal (treat as eligible). */
    coverageLookup?: CoverageLookup;
    /** Note sink for coverage + Gate-2 aggregates. */
    log?: TargetLogger;
}

/** Per-function scoring detail carried for logging + the diminishing-returns proxy. */
export interface TargetMeta {
    /** Absolute file the function lives in. */
    fileName: string;
    /** The function's 0-based Stryker range. */
    range: SourceRange;
    /** Computed risk (pre-semanticRichness). */
    risk: number;
    /** semanticRichness multiplier (≥1). */
    semanticRichness: number;
    /** EV = risk · semanticRichness. */
    ev: number;
    /** Number of eligible sub-spans found in the function. */
    eligibleSpanCount: number;
}

/** The result of {@link buildProposeTargets}: the targets plus their meta. */
export interface BuildProposeTargetsResult {
    /** EV-ranked ProposeTargets (one per chosen enclosing function). */
    targets: ProposeTarget[];
    /** Per-target scoring meta, index-aligned with {@link targets}. */
    meta: TargetMeta[];
}

/** The function node kinds that become an enclosing-function batch unit. */
const FUNCTION_TYPES = new Set([
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
]);

/** Branch-test node kinds counted by `branchCount`. */
const BRANCH_TYPES = new Set([
    'IfStatement',
    'ConditionalExpression',
    'SwitchCase',
    'ForStatement',
    'ForInStatement',
    'ForOfStatement',
    'WhileStatement',
    'DoWhileStatement',
]);

/** Node kinds that increase nesting depth on enter. */
const NESTING_TYPES = new Set([
    'BlockStatement',
    'IfStatement',
    'ForStatement',
    'ForInStatement',
    'ForOfStatement',
    'WhileStatement',
    'DoWhileStatement',
    'SwitchStatement',
]);

/** Off-by-one-affinity comparison operators. */
const COMPARISON_OPS = new Set(['<', '<=', '>', '>=']);

/** Off-by-one-affinity call callee method names (slice/substring/etc.). */
const OFF_BY_ONE_METHODS = new Set([
    'slice',
    'substring',
    'substr',
    'splice',
    'padStart',
    'padEnd',
    'repeat',
]);

/**
 * A Babel position is `{ line (1-based), column (0-based) }`; a node carries an
 * optional `loc`. We narrow to the slice we read.
 */
interface BabelLocSlice {
    start: { line: number; column: number };
    end: { line: number; column: number };
}

/** A node with the structural fields the traversal inspects. */
type AnyNode = Node & {
    loc?: BabelLocSlice | null;
    [key: string]: unknown;
};

/** Convert a 1-based Babel `loc` to a 0-based Stryker {@link SourceRange}. */
function toStrykerRange(loc: BabelLocSlice): SourceRange {
    return {
        start: { line: loc.start.line - 1, column: loc.start.column },
        end: { line: loc.end.line - 1, column: loc.end.column },
    };
}

/** True for an AST node object (has a string `type`). */
function isNode(value: unknown): value is AnyNode {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { type?: unknown }).type === 'string'
    );
}

/**
 * Yield each direct child node (or node in a child array) of `node`.
 * @yields each direct child AST node, skipping non-node fields (loc/type/extra).
 */
function* childNodes(node: AnyNode): Generator<AnyNode> {
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'type' || key === 'extra') {
            continue;
        }
        const value = node[key];
        if (Array.isArray(value)) {
            for (const item of value) {
                if (isNode(item)) {
                    yield item;
                }
            }
        } else if (isNode(value)) {
            yield value;
        }
    }
}

/** The per-function accumulators built during the subtree walk. */
interface FunctionScore {
    branchCount: number;
    maxDepth: number;
    offByOneAffinity: number;
    ignoredCount: number;
    distinctOperators: Set<string>;
    hasLiteralConstruction: boolean;
    hasMultiArgCall: boolean;
    statementCount: number;
    hasBranch: boolean;
    eligibleSpanCount: number;
}

/** A set of source-offset ranges covered by a `// Stryker disable` comment. */
type DisabledRanges = Array<{ start: number; end: number }>;

/** Walk a function subtree, accumulating the risk/richness signals. */
function scoreFunction(fnNode: AnyNode, disabled: DisabledRanges): FunctionScore {
    const score: FunctionScore = {
        branchCount: 0,
        maxDepth: 0,
        offByOneAffinity: 0,
        ignoredCount: 0,
        distinctOperators: new Set(),
        hasLiteralConstruction: false,
        hasMultiArgCall: false,
        statementCount: 0,
        hasBranch: false,
        eligibleSpanCount: 0,
    };

    const walk = (node: AnyNode, depth: number): void => {
        const { type } = node;

        if (BRANCH_TYPES.has(type)) {
            score.branchCount += 1;
            score.hasBranch = true;
        }
        if (type.endsWith('Statement')) {
            score.statementCount += 1;
        }

        const nextDepth = NESTING_TYPES.has(type) ? depth + 1 : depth;
        if (nextDepth > score.maxDepth) {
            score.maxDepth = nextDepth;
        }

        scoreNodeKind(node, score);

        if (isDisabled(node, disabled)) {
            score.ignoredCount += 1;
        }

        // Don't descend into NESTED functions — each function is its own batch
        // unit (but the OUTER walk visits them separately via the top traversal).
        for (const child of childNodes(node)) {
            if (FUNCTION_TYPES.has(child.type) && child !== fnNode) {
                continue;
            }
            walk(child, nextDepth);
        }
    };

    // Start the walk at the function's body so the function node itself is not
    // double-counted, but seed depth at 0.
    walk(fnNode, 0);
    return score;
}

/** Score one node's contribution to off-by-one affinity / richness. */
function scoreNodeKind(node: AnyNode, score: FunctionScore): void {
    switch (node.type) {
        case 'BinaryExpression':
        case 'LogicalExpression':
            scoreOperatorNode(node, score);
            return;
        case 'MemberExpression':
            if (node.computed === true) {
                score.offByOneAffinity += 1;
                score.eligibleSpanCount += 1;
            }
            return;
        case 'NumericLiteral':
            if (node.value === 0 || node.value === 1 || node.value === -1) {
                score.offByOneAffinity += 1;
            }
            return;
        case 'CallExpression':
            scoreCallNode(node, score);
            return;
        case 'ObjectExpression':
        case 'ArrayExpression':
            score.hasLiteralConstruction = true;
            return;
        case 'ConditionalExpression':
            score.eligibleSpanCount += 1;
            return;
        default:
            return;
    }
}

/** Score a Binary/Logical operator node (distinct-operator + comparison affinity). */
function scoreOperatorNode(node: AnyNode, score: FunctionScore): void {
    const op = node.operator;
    if (typeof op === 'string') {
        score.distinctOperators.add(op);
        if (COMPARISON_OPS.has(op)) {
            score.offByOneAffinity += 1;
        }
    }
    score.eligibleSpanCount += 1;
}

/** Score a CallExpression node (multi-arg richness + off-by-one method affinity). */
function scoreCallNode(node: AnyNode, score: FunctionScore): void {
    const args = node.arguments;
    const argc = Array.isArray(args) ? args.length : 0;
    if (argc >= 2) {
        score.hasMultiArgCall = true;
    }
    if (argc >= 1) {
        score.eligibleSpanCount += 1;
    }
    if (isOffByOneMethodCall(node.callee)) {
        score.offByOneAffinity += 1;
    }
}

/** True when a call's callee is a `.slice`/`.substring`/… off-by-one method. */
function isOffByOneMethodCall(callee: unknown): boolean {
    if (!isNode(callee) || callee.type !== 'MemberExpression') {
        return false;
    }
    const property = callee.property;
    return (
        isNode(property) &&
        property.type === 'Identifier' &&
        typeof property.name === 'string' &&
        OFF_BY_ONE_METHODS.has(property.name)
    );
}

/**
 * True when a node's source offsets fall inside a `// Stryker disable` range.
 * A node missing `start`/`end` (never the case for `@babel/parser` output, but
 * the babel types allow `null`) coerces to `-1`/`Infinity`, which can never be
 * contained by a finite directive range — so it correctly reports `false`
 * without a separate guard branch.
 */
function isDisabled(node: AnyNode, disabled: DisabledRanges): boolean {
    const start = (node as { start?: number | null }).start ?? -1;
    const end = (node as { end?: number | null }).end ?? Number.POSITIVE_INFINITY;
    return disabled.some(range => start >= range.start && end <= range.end);
}

/**
 * Find the source-offset ranges of `// Stryker disable` directives. A line/block
 * comment containing `Stryker disable` disables from the comment to end-of-file
 * (Stryker's bookkeeper is line-scoped, but for the ignoredDensity DEPRIORITIZE
 * signal a coarse "from here on" is a safe over-count — it only lowers risk).
 */
function findDisabledRanges(comments: AnyNode[], sourceLength: number): DisabledRanges {
    const ranges: DisabledRanges = [];
    for (const comment of comments) {
        const value = (comment as { value?: string }).value;
        const start = (comment as { start?: number }).start;
        if (
            typeof value === 'string' &&
            value.includes('Stryker disable') &&
            typeof start === 'number'
        ) {
            ranges.push({ start, end: sourceLength });
        }
    }
    return ranges;
}

/** Compute risk from a function's accumulated signals (never below 0). */
function computeRisk(score: FunctionScore): number {
    const raw =
        RISK_WEIGHTS.branch * score.branchCount +
        RISK_WEIGHTS.nesting * score.maxDepth +
        RISK_WEIGHTS.offByOne * score.offByOneAffinity -
        RISK_WEIGHTS.ignored * score.ignoredCount;
    return Math.max(0, raw);
}

/** Compute semanticRichness (1 + boost when the richness signals are present). */
function computeRichness(score: FunctionScore): number {
    const rich =
        score.distinctOperators.size >= 2 || score.hasLiteralConstruction || score.hasMultiArgCall;
    return rich ? 1 + RICHNESS_BOOST : 1;
}

/**
 * Gate-2 complementarity predicate: a function is LLM-worthy when it is
 * semantically rich (≥2 distinct operators, object/array construction, or a
 * multi-arg call), OR it is recognizable business logic (a multi-statement body
 * with a branch). Formulaic-only functions are left to the heuristic mutators.
 */
export function isLlmWorthy(semanticRichness: number, score: FunctionScore): boolean {
    if (semanticRichness >= RICHNESS_THRESHOLD) {
        return true;
    }
    return score.statementCount > 1 && score.hasBranch;
}

/** A scored enclosing-function candidate before EV ranking + budget cut. */
interface FunctionCandidate {
    fileName: string;
    range: SourceRange;
    functionText: string;
    risk: number;
    semanticRichness: number;
    ev: number;
    eligibleSpanCount: number;
}

/**
 * Extract the exact source text a node covers, by its source offsets. `start`/
 * `end` are always numbers for `@babel/parser` output; a `null` (allowed by the
 * babel types) coerces to `0`, yielding an empty slice rather than throwing.
 */
function sliceByOffsets(content: string, node: AnyNode): string {
    const start = (node as { start?: number | null }).start ?? 0;
    const end = (node as { end?: number | null }).end ?? 0;
    return content.slice(start, end);
}

/** Collect every enclosing-function node in a parsed file (top-down order). */
function collectFunctions(root: AnyNode): AnyNode[] {
    const found: AnyNode[] = [];
    const visit = (node: AnyNode): void => {
        if (FUNCTION_TYPES.has(node.type)) {
            found.push(node);
        }
        for (const child of childNodes(node)) {
            visit(child);
        }
    };
    visit(root);
    return found;
}

/** Build the candidates for one file. */
function candidatesForFile(
    file: SourceFileInput,
    config: LlmMutatorConfig,
    options: BuildProposeTargetsOptions,
): FunctionCandidate[] {
    const ast = parse(file.content, {
        sourceType: 'module',
        plugins: [...BABEL_PLUGINS],
        errorRecovery: false,
    });
    const program = ast.program as unknown as AnyNode;
    const comments = (ast.comments ?? []) as unknown as AnyNode[];
    const disabled = findDisabledRanges(comments, file.content.length);

    const { minRiskScore, requireCoverage, topSpansPerFile } = config.dynamicLLM.targeting;
    const candidates: FunctionCandidate[] = [];

    for (const fnNode of collectFunctions(program)) {
        if (fnNode.loc === null || fnNode.loc === undefined) {
            continue;
        }
        const range = toStrykerRange(fnNode.loc);
        const score = scoreFunction(fnNode, disabled);
        const risk = computeRisk(score);
        if (risk < minRiskScore) {
            continue;
        }
        if (!isCoverageEligible(file.fileName, range, requireCoverage, options)) {
            continue;
        }
        const semanticRichness = computeRichness(score);
        if (!isLlmWorthy(semanticRichness, score)) {
            continue;
        }
        candidates.push({
            fileName: file.fileName,
            range,
            functionText: sliceByOffsets(file.content, fnNode),
            risk,
            semanticRichness,
            ev: risk * semanticRichness,
            eligibleSpanCount: score.eligibleSpanCount,
        });
    }

    // Keep the top `topSpansPerFile` highest-EV functions in this file.
    candidates.sort((a, b) => b.ev - a.ev);
    return candidates.slice(0, topSpansPerFile);
}

/** Coverage eligibility with the M3 "no signal ⇒ eligible (and log once)" rule. */
function isCoverageEligible(
    fileName: string,
    range: SourceRange,
    requireCoverage: boolean,
    options: BuildProposeTargetsOptions,
): boolean {
    const lookup = options.coverageLookup;
    if (lookup === undefined) {
        return true; // no coverage probe in M3 — treat as eligible.
    }
    const covered = lookup(fileName, range);
    if (covered === undefined) {
        return true; // signal absent for this span — treat as eligible.
    }
    if (!requireCoverage) {
        return true; // coverage not required — eligible regardless.
    }
    return covered >= 1;
}

/**
 * Build the EV-ranked {@link ProposeTarget}s from the source files Stryker will
 * mutate. One target per chosen enclosing function (Gate 3 batches by function).
 *
 * @param files The absolute-path source files (the mutate glob set), already read.
 * @param config The parsed config (reads `dynamicLLM.targeting` + `budget`).
 * @param options Optional coverage probe + note logger.
 * @returns EV-ranked targets and their index-aligned scoring meta.
 */
export function buildProposeTargets(
    files: readonly SourceFileInput[],
    config: LlmMutatorConfig,
    options: BuildProposeTargetsOptions = {},
): BuildProposeTargetsResult {
    const log = options.log;
    if (options.coverageLookup === undefined && log !== undefined) {
        log(
            'note: no coverage signal available; treating all risk-eligible spans as ' +
                'covered (requireCoverage honored after first Stryker run)',
        );
    }

    const all: FunctionCandidate[] = [];
    for (const file of files) {
        all.push(...candidatesForFile(file, config, options));
    }

    // Global EV ranking, then bound by the call budget (top-K).
    all.sort((a, b) => b.ev - a.ev);
    const topK = config.dynamicLLM.budget.maxLlmCallsPerRun;
    const chosen = all.slice(0, topK);

    if (log !== undefined) {
        log(`Gate1/2: ${String(chosen.length)} function target(s) selected for the LLM pre-pass`);
    }

    const targets: ProposeTarget[] = chosen.map(candidate => ({
        fileName: candidate.fileName,
        range: candidate.range,
        spanText: candidate.functionText,
        context: candidate.functionText,
    }));
    const meta: TargetMeta[] = chosen.map(candidate => ({
        fileName: candidate.fileName,
        range: candidate.range,
        risk: candidate.risk,
        semanticRichness: candidate.semanticRichness,
        ev: candidate.ev,
        eligibleSpanCount: candidate.eligibleSpanCount,
    }));

    return { targets, meta };
}
