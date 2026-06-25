/*
 * Pipeline stage 2 — Propose (development-plan §4.3, phase 2).
 *
 * Given a single target span inside a source file, ask an {@link LLMProvider}
 * for a batch of localized, behavior-changing mutation candidates and return
 * them as seam-ready {@link Replacement}s. This stage is the ONLY LLM-touching
 * code in this module; the cheap deterministic winnowing that follows lives in
 * `./filters` and never calls a model.
 *
 * Dependency-injection contract (load-bearing): the provider arrives as a
 * parameter typed only against the {@link LLMProvider} abstraction. This module
 * imports NO concrete provider — not the Agent SDK one, not the mock — so it is
 * trivially testable offline by passing a canned provider (development-plan
 * §4.1 mockability constraint). Callers never branch on whether the provider is
 * agentic or one-shot.
 *
 * The model is handed exactly the source text of the ENCLOSING FUNCTION (Gate 3
 * batches by function) plus enough context to reason, and is asked to identify
 * the SPECIFIC small sub-expression it mutates — echoing that sub-expression's
 * exact verbatim source as `original`. We do NOT trust the model to invent source
 * positions: the resulting {@link Replacement.range} is derived from OUR OWN parse
 * by locating + node-aligning that `original` substring inside the function
 * (`./range-align`). A candidate whose `original` cannot be located + aligned to a
 * real EXPRESSION node is DROPPED (Stryker's expression placer would reject a
 * mis-aligned range anyway — functional-architecture §4 Gate 4 / §5 constraint 3).
 */

import { type AlignDropReason, alignCandidateRange } from './range-align';
import type { DroppedReplacement } from './llm-map';
import type { JsonSchema, LLMProvider, ProviderResult } from '../llm/types';
import type { Replacement, SourceRange } from '../seam/types';

/**
 * The mutator-name prefix every stage-2 LLM proposal carries. A distinct,
 * non-built-in tag so reporting can separate LLM mutants from Stryker's 17
 * formulaic operators (development-plan §3.3 / §4.4). The model's per-candidate
 * tag is appended after a slash, e.g. `llm/negate-condition`.
 */
export const PROPOSE_MUTATOR_PREFIX = 'llm';

/**
 * A target the propose stage operates on: the exact source text of an ENCLOSING
 * FUNCTION chosen by stage-1 risk targeting (Gate 3 batches by function, ONE
 * provider.generate() per function), plus the function's 0-based {@link SourceRange}
 * in `fileName`. `range`/`spanText` describe the WHOLE function (what the model
 * reads); each candidate's TRUE per-edit range is derived later by locating +
 * node-aligning the candidate's sub-expression `original` inside the function.
 *
 * To node-align, propose needs the FULL file content and the function's ABSOLUTE
 * char offsets ({@link fileContent}/{@link spanStartOffset}/{@link spanEndOffset});
 * the targeting stage populates them (it already parses the file and knows each
 * function node's `start`/`end`). They are OPTIONAL for backward-compat — when
 * absent, propose falls back to `spanText` as the function source and offset 0,
 * which still aligns correctly for a single-function `spanText`.
 */
export interface ProposeTarget {
    /** Path of the file the span lives in. Flows onto `Replacement.fileName`. */
    fileName: string;
    /** The enclosing function's 0-based Stryker range (used only as a fallback). */
    range: SourceRange;
    /** The enclosing function's source text the model reads + mutates within. */
    spanText: string;
    /**
     * Optional surrounding file context (e.g. the enclosing function or whole
     * file) to help the model reason about behavior. Sent to the model for
     * grounding only; never used to derive positions.
     */
    context?: string;
    /**
     * The FULL file source — used to node-align each candidate's sub-expression.
     * Defaults to {@link spanText} (so a standalone single-function span aligns).
     */
    fileContent?: string;
    /**
     * The enclosing function's absolute char START offset in {@link fileContent}.
     * Defaults to 0 (the start of `spanText` when `fileContent` is omitted).
     */
    spanStartOffset?: number;
    /**
     * The enclosing function's absolute char END offset in {@link fileContent}
     * (exclusive). Defaults to the length of the resolved file source.
     */
    spanEndOffset?: number;
}

/**
 * Options for {@link propose}. All optional — the common call is
 * `propose(provider, target)`.
 */
export interface ProposeOptions {
    /**
     * Upper bound on how many candidates to request from the model for this
     * span. Maps to the stage-2 `maxCandidatesPerFile` budget cap at the call
     * site (development-plan §4.3). The returned array is truncated to this
     * length defensively even if the model over-produces. Default 8.
     */
    maxCandidates?: number;
    /** Optional model override forwarded verbatim to the provider. */
    model?: string;
    /** Optional content-addressed cache-key hint forwarded to the provider. */
    cacheKey?: string;
    /** Optional cooperative cancellation signal forwarded to the provider. */
    signal?: AbortSignal;
}

/** The default candidate count requested per span when none is given. */
const DEFAULT_MAX_CANDIDATES = 8;

/**
 * One raw candidate as the model is asked to emit it. `original` is now the EXACT
 * verbatim source of the SMALL sub-expression the model chose to mutate (it MUST
 * appear verbatim in the function text so we can locate + node-align it);
 * `replacement` is the edited sub-expression; `mutatorTag` is a short kebab label;
 * `rationale` explains why the edit is an interesting, real-bug-like mutant.
 */
interface RawCandidate {
    original: string;
    replacement: string;
    mutatorTag: string;
    rationale: string;
}

/** The structured-output envelope the model returns: a list of candidates. */
interface ProposeResponse {
    candidates: RawCandidate[];
}

/**
 * Build the JSON schema describing the {@link ProposeResponse} envelope. Kept as
 * a function (not a const) so each call gets a fresh object the provider may
 * mutate/annotate without cross-call aliasing.
 */
function buildProposeSchema(maxCandidates: number): JsonSchema {
    return {
        type: 'object',
        additionalProperties: false,
        required: ['candidates'],
        properties: {
            candidates: {
                type: 'array',
                minItems: 0,
                maxItems: maxCandidates,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['original', 'replacement', 'mutatorTag', 'rationale'],
                    properties: {
                        original: {
                            type: 'string',
                            description:
                                'The EXACT verbatim source of a SMALL, self-contained sub-expression you chose to mutate. It MUST appear verbatim (character-for-character) somewhere inside the FUNCTION block, and must be a single complete expression (e.g. "hour >= 12", "a ?? b", "items[i + 1]") — NOT the whole function and NOT a statement.',
                        },
                        replacement: {
                            type: 'string',
                            description:
                                'The edited sub-expression that replaces "original" in place. Must be a syntactically valid expression, differ from original, and be valid where "original" sits.',
                        },
                        mutatorTag: {
                            type: 'string',
                            description:
                                'Short kebab-case label for the kind of mutation, e.g. "negate-condition" or "off-by-one".',
                        },
                        rationale: {
                            type: 'string',
                            description:
                                'One sentence on why this is a plausible, behavior-changing, real-bug-like mutation.',
                        },
                    },
                },
            },
        },
    };
}

/** The system prompt: fixed instructions independent of the specific function. */
const PROPOSE_SYSTEM = [
    'You are a mutation-testing assistant for JavaScript/TypeScript.',
    'You are given the exact source text of ONE function and surrounding context.',
    'Propose localized, behavior-changing mutations, each targeting a SMALL, SELF-CONTAINED sub-expression WITHIN the function.',
    'For EACH mutation:',
    '- pick a single small sub-expression inside the function (e.g. "hour >= 12", "a ?? b", "len - 1", "items[i + 1]") — NOT the whole function, NOT a statement;',
    '- put that sub-expression\'s EXACT verbatim source (character-for-character, as it appears in the function) in "original" — it MUST appear verbatim in the function text;',
    '- put the edited sub-expression in "replacement", keeping it a syntactically valid expression that is valid IN PLACE where "original" sits;',
    '- ensure both "original" and "replacement" are syntactically valid in place, and that the change alters runtime behavior a good test should catch;',
    '- prefer plausible real bugs (off-by-one, flipped condition, wrong operator, swapped argument, dropped guard, wrong boundary literal, etc.).',
    'Do NOT propose semantically-equivalent rewrites. Do NOT change identifiers that are not part of the behavior. Do NOT echo the whole function.',
    'Return ONLY the structured object; no prose outside it.',
].join('\n');

/** Build the per-function user prompt embedding the function text and context. */
function buildProposePrompt(target: ProposeTarget, maxCandidates: number): string {
    const parts = [
        `Propose up to ${maxCandidates} distinct, behavior-changing mutations, each on a small sub-expression WITHIN the FUNCTION below.`,
        '',
        'FUNCTION (mutate sub-expressions inside this; "original" must be a verbatim substring of it):',
        '```',
        target.spanText,
        '```',
    ];
    if (
        target.context !== undefined &&
        target.context.length > 0 &&
        target.context !== target.spanText
    ) {
        parts.push(
            '',
            'CONTEXT (for understanding only; do NOT mutate outside the FUNCTION):',
            '```',
            target.context,
            '```',
        );
    }
    return parts.join('\n');
}

/** The seam-ready replacements + the candidates dropped during node-alignment. */
export interface ProposeResult {
    /** Node-aligned, seam-ready replacements (each range = a real EXPRESSION node). */
    replacements: Replacement[];
    /** Candidates dropped because their `original` could not be node-aligned. */
    dropped: DroppedReplacement[];
    /**
     * Per-TYPED-reason tally of the node-alignment drops in {@link dropped}. The
     * typed {@link AlignDropReason} is lost once each drop is flattened into the
     * human-readable `reason` string, so it is preserved here for the pre-pass's
     * per-function drop summary (which buckets by category WITHOUT string-parsing
     * the reason text). Only reasons that actually occurred carry a key.
     */
    dropCounts: Partial<Record<AlignDropReason, number>>;
}

/** Cap on how much of a candidate's sub-expression we echo into a drop `reason`. */
const SNIPPET_MAX_LENGTH = 60;

/**
 * Truncate a candidate's sub-expression for inclusion in a drop `reason`, so a
 * pathological whole-function `original` cannot blow up a report line. Collapses
 * to a single line and appends an ellipsis when clipped.
 */
function clipSnippet(original: string): string {
    const oneLine = original.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= SNIPPET_MAX_LENGTH) {
        return oneLine;
    }
    return `${oneLine.slice(0, SNIPPET_MAX_LENGTH)}…`;
}

/**
 * Build a human-readable, self-contained drop `reason` for one align-drop reason,
 * interpolating the candidate's ACTUAL (clipped) sub-expression. Stored on
 * {@link DroppedReplacement.reason} so the JSON report carries the full detail.
 * No "node-alignment drop" prefix — the pre-pass's per-function summary already
 * frames these as drops.
 */
function alignDropReasonText(reason: AlignDropReason, original: string): string {
    const snippet = clipSnippet(original);
    switch (reason) {
        case 'not-found':
            return `original \`${snippet}\` not found verbatim in the enclosing function`;
        case 'ambiguous':
            return `original \`${snippet}\` appears more than once in the function (ambiguous)`;
        case 'non-node-aligned':
            return `original \`${snippet}\` crosses node boundaries (no single AST node)`;
        case 'not-an-expression':
            return `original \`${snippet}\` aligns to a statement, not an expression`;
    }
}

/**
 * Resolve the file source + function offsets a target uses for node-alignment.
 * When the targeting stage supplied `fileContent`/`spanStartOffset`/
 * `spanEndOffset` they are used verbatim; otherwise we fall back to treating
 * `spanText` as a standalone file starting at offset 0 (the backward-compat path
 * for hand-built targets and existing tests).
 */
function resolveAlignInputs(target: ProposeTarget): {
    fileContent: string;
    start: number;
    end: number;
} {
    const fileContent = target.fileContent ?? target.spanText;
    const start = target.spanStartOffset ?? 0;
    const end = target.spanEndOffset ?? fileContent.length;
    return { fileContent, start, end };
}

/**
 * Map one validated {@link RawCandidate} onto a seam-ready {@link Replacement} by
 * NODE-ALIGNING its sub-expression `original` (never model-derived coordinates).
 * On a successful alignment the `range` is the aligned EXPRESSION node's range and
 * `original` is the verbatim sub-expression; on failure the candidate is dropped
 * with a typed reason (the four §4 Gate 4 conditions). Returns the `Replacement`
 * or the `DroppedReplacement` describing the drop.
 */
function toReplacement(
    target: ProposeTarget,
    candidate: RawCandidate,
): Replacement | { drop: DroppedReplacement; category: AlignDropReason } {
    const tag = candidate.mutatorTag.trim();
    const mutatorName =
        tag.length > 0 ? `${PROPOSE_MUTATOR_PREFIX}/${tag}` : PROPOSE_MUTATOR_PREFIX;

    const { fileContent, start, end } = resolveAlignInputs(target);
    const aligned = alignCandidateRange(fileContent, start, end, candidate.original);
    if ('dropped' in aligned) {
        return {
            category: aligned.reason,
            drop: {
                fileName: target.fileName,
                range: target.range,
                replacement: candidate.replacement,
                reason: alignDropReasonText(aligned.reason, candidate.original),
            },
        };
    }
    return {
        fileName: target.fileName,
        range: aligned.range,
        original: aligned.original,
        replacement: candidate.replacement,
        mutatorName,
        rationale: candidate.rationale,
    };
}

/**
 * Ask the injected provider for behavior-changing mutation candidates for one
 * ENCLOSING FUNCTION and return them as NODE-ALIGNED, seam-ready
 * {@link Replacement}s plus the candidates dropped during alignment.
 *
 * Each candidate's sub-expression `original` is located + node-aligned inside the
 * function (`./range-align`) so its `range` equals a REAL EXPRESSION node — the
 * invariant the map-builder + `LLMMutator` + Stryker's expression placer require.
 * Candidates that fail alignment (not-found / ambiguous / non-node-aligned /
 * not-an-expression) are returned in `dropped` (NOT emitted). Beyond alignment
 * this performs NO filtering except truncating to `maxCandidates` — parse-check,
 * `replacement === original` rejection, dedup, and near-equivalence are the job of
 * `./filters` + `./near-equivalence`, which this stage's output feeds into. The
 * provider has already validated the response against the JSON schema.
 *
 * Rejects (propagates the provider's `Error`) on transport/auth failure, abort,
 * or a terminal schema-validation failure — the provider contract guarantees it
 * only resolves with schema-valid output (development-plan §4.1).
 *
 * @param provider DI'd LLM provider (mock in tests; never imported concretely).
 * @param target   The enclosing function to mutate within, plus alignment inputs.
 * @param options  Budget cap, model/cache/abort forwarding.
 * @returns The node-aligned replacements (≤ `maxCandidates`) and the align-drops.
 */
export async function propose(
    provider: LLMProvider,
    target: ProposeTarget,
    options: ProposeOptions = {},
): Promise<ProposeResult> {
    const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    const schema = buildProposeSchema(maxCandidates);
    const prompt = buildProposePrompt(target, maxCandidates);

    const result: ProviderResult<ProposeResponse> = await provider.generate<ProposeResponse>({
        prompt,
        schema,
        system: PROPOSE_SYSTEM,
        model: options.model,
        cacheKey: options.cacheKey,
        signal: options.signal,
    });

    const candidates = result.value.candidates.slice(0, maxCandidates);
    const replacements: Replacement[] = [];
    const dropped: DroppedReplacement[] = [];
    const dropCounts: Partial<Record<AlignDropReason, number>> = {};
    for (const candidate of candidates) {
        const mapped = toReplacement(target, candidate);
        if ('drop' in mapped) {
            dropped.push(mapped.drop);
            dropCounts[mapped.category] = (dropCounts[mapped.category] ?? 0) + 1;
        } else {
            replacements.push(mapped);
        }
    }
    return { replacements, dropped, dropCounts };
}
