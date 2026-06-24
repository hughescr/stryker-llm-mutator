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
 * The model is handed exactly the source text of the target span plus enough
 * file context to reason, and is asked to return candidates whose `original`
 * echoes the span text verbatim. We do NOT trust the model to invent source
 * positions: the resulting {@link Replacement.range} is always the caller-
 * supplied span (the unit we asked the model to mutate), keeping positions
 * precise and Babel-derived rather than string-searched (development-plan §4.2).
 */

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
 * A target span the propose stage operates on: the exact source text of a
 * function or sub-expression chosen by stage-1 risk targeting (or hand-picked
 * in the phase-2 vertical slice), plus the precise {@link SourceRange} that text
 * occupies in `fileName`. `range` is in Stryker's zero-based convention and is
 * passed straight through onto every produced {@link Replacement}.
 */
export interface ProposeTarget {
    /** Path of the file the span lives in. Flows onto `Replacement.fileName`. */
    fileName: string;
    /** The precise, 0-based span the candidates replace. Flows onto `Replacement.range`. */
    range: SourceRange;
    /** The exact source text currently occupying `range`. Flows onto `Replacement.original`. */
    spanText: string;
    /**
     * Optional surrounding file context (e.g. the enclosing function or whole
     * file) to help the model reason about behavior. Sent to the model for
     * grounding only; never used to derive positions.
     */
    context?: string;
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
 * One raw candidate as the model is asked to emit it. `original` MUST echo the
 * span text so we can sanity-check the model mutated what we asked; `replacement`
 * is the proposed new text; `mutatorTag` is a short kebab label; `rationale`
 * explains why the edit is an interesting, real-bug-like mutant.
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
                                'The exact source text of the target span, echoed verbatim from the SPAN block.',
                        },
                        replacement: {
                            type: 'string',
                            description:
                                'The proposed replacement source for the span. Must be syntactically valid and differ from original.',
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

/** The system prompt: fixed instructions independent of the specific span. */
const PROPOSE_SYSTEM = [
    'You are a mutation-testing assistant for JavaScript/TypeScript.',
    'You are given the exact source text of ONE span (a function or sub-expression) and surrounding context.',
    'Propose localized, behavior-changing mutations of THAT span only.',
    'Each mutation must:',
    '- change the runtime behavior in a way a good test should catch (not a no-op, not a formatting/comment change);',
    '- be a plausible real bug a developer might write (off-by-one, flipped condition, wrong operator, swapped argument, dropped guard, wrong boundary literal, etc.);',
    '- stay inside the span: replace the whole span text with a syntactically valid edited version;',
    '- echo the span text verbatim in "original" and put the edited span in "replacement".',
    'Do NOT propose semantically-equivalent rewrites. Do NOT change identifiers that are not part of the behavior.',
    'Return ONLY the structured object; no prose outside it.',
].join('\n');

/** Build the per-span user prompt embedding the span text and context. */
function buildProposePrompt(target: ProposeTarget, maxCandidates: number): string {
    const parts = [
        `Propose up to ${maxCandidates} distinct, behavior-changing mutations for the SPAN below.`,
        '',
        'SPAN (mutate exactly this text; echo it verbatim as "original"):',
        '```',
        target.spanText,
        '```',
    ];
    if (target.context !== undefined && target.context.length > 0) {
        parts.push(
            '',
            'CONTEXT (for understanding only; do NOT mutate outside the SPAN):',
            '```',
            target.context,
            '```',
        );
    }
    return parts.join('\n');
}

/**
 * Map one validated {@link RawCandidate} onto a seam-ready {@link Replacement}.
 * The `range` is the caller's span (never model-derived); `original` is the
 * caller's span text (authoritative), not the model's echo, so a sloppy echo
 * cannot corrupt the audit field or the later `replacement === original` filter.
 */
function toReplacement(target: ProposeTarget, candidate: RawCandidate): Replacement {
    const tag = candidate.mutatorTag.trim();
    const mutatorName =
        tag.length > 0 ? `${PROPOSE_MUTATOR_PREFIX}/${tag}` : PROPOSE_MUTATOR_PREFIX;
    return {
        fileName: target.fileName,
        range: target.range,
        original: target.spanText,
        replacement: candidate.replacement,
        mutatorName,
        rationale: candidate.rationale,
    };
}

/**
 * Ask the injected provider for behavior-changing mutation candidates for a
 * single span and return them as seam-ready {@link Replacement}s.
 *
 * This performs NO filtering beyond truncating to `maxCandidates` — parse-check,
 * `replacement === original` rejection, and dedup are the job of `./filters`,
 * which this stage's output feeds into. The provider has already validated the
 * response against the JSON schema, so `value.candidates` is trusted to be
 * structurally well-formed.
 *
 * Rejects (propagates the provider's `Error`) on transport/auth failure, abort,
 * or a terminal schema-validation failure — the provider contract guarantees it
 * only resolves with schema-valid output (development-plan §4.1).
 *
 * @param provider DI'd LLM provider (mock in tests; never imported concretely).
 * @param target   The span to mutate plus its precise seam range.
 * @param options  Budget cap, model/cache/abort forwarding.
 * @returns The proposed replacements, at most `maxCandidates` of them.
 */
export async function propose(
    provider: LLMProvider,
    target: ProposeTarget,
    options: ProposeOptions = {},
): Promise<Replacement[]> {
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
    return candidates.map(candidate => toReplacement(target, candidate));
}
