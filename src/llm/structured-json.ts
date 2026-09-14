/*
 * Shared structured-JSON helpers — the PURE, OFFLINE parse/validate/prompt-build
 * core that every prompt-mode provider reuses.
 *
 * The Anthropic Agent SDK provider's `'prompt'` output mode (and, in turn, the
 * OpenAI-compatible provider) does NOT rely on a backend's structured-output
 * enforcement — it asks the model for raw JSON in the prompt, then PARSES and
 * VALIDATES the returned text LOCALLY. That parse/validate/prompt-build logic is
 * transport-agnostic, has no network or provider dependency, and is the part
 * most worth unit-testing in isolation, so it lives HERE rather than inside any
 * one provider. {@link extractJsonObject} pulls the first balanced JSON object
 * out of arbitrary model text, {@link validateAgainstSchema} checks (and lightly
 * repairs) it against a small generic schema shape, and
 * {@link buildPromptModePrompt} assembles the "emit raw JSON conforming to this
 * schema" user prompt. {@link AgentProviderError} is the terminal error these
 * helpers raise on an unrecoverable parse failure.
 *
 * This module imports ONLY the stable {@link JsonSchema} contract from `./types`
 * — no provider, no Agent SDK, nothing node-only — so it stays trivially
 * testable offline and reusable by any provider. The Anthropic provider IMPORTS
 * and RE-EXPORTS these helpers so its existing public surface (and tests) are
 * unchanged.
 */

import type { JsonSchema } from './types';

/**
 * Error thrown when the Agent SDK terminates without producing a schema-valid
 * object (any `SDKResultError` subtype, most importantly
 * `error_max_structured_output_retries`, or a `success` result that carries no
 * `structured_output`). Carries the terminal `subtype` and the accrued
 * `total_cost_usd` so a caller can still account for spend on a failed call.
 *
 * In the `'prompt'` output mode the `subtype` is the synthetic marker
 * `prompt_parse_failed` when, after one retry, the model's raw text still could
 * not be parsed + validated into a schema-conforming object.
 */
export class AgentProviderError extends Error {
    /** The terminal SDK result subtype, or a synthetic marker when none applies. */
    readonly subtype: string;
    /** Cost in USD accrued before the terminal failure, for cost accounting. */
    readonly costUsd: number;

    constructor(message: string, subtype: string, costUsd: number) {
        super(message);
        this.name = 'AgentProviderError';
        this.subtype = subtype;
        this.costUsd = costUsd;
    }
}

/**
 * The directive appended to the user prompt in `'prompt'` output mode, ahead of
 * the stringified schema. Tells the model to emit ONLY a single raw JSON object
 * (no prose, no markdown fences) so {@link extractJsonObject} can parse it.
 */
const PROMPT_MODE_DIRECTIVE =
    'Output ONLY a single raw JSON object conforming to this JSON Schema — no prose, no explanation, no markdown code fences:';

/**
 * Build the `'prompt'`-mode user prompt: the caller's `basePrompt`, then the
 * raw-JSON directive, then the stringified `schema`. PURE and OFFLINE so the
 * exact wording is unit-testable without `query()`. The system prompt is left
 * untouched (the caller's `request.system` still rides as `systemPrompt`).
 */
export function buildPromptModePrompt(basePrompt: string, schema: JsonSchema): string {
    return `${basePrompt}\n\n${PROMPT_MODE_DIRECTIVE}\n${JSON.stringify(schema)}`;
}

/** Opening/closing markdown code-fence pattern stripped before JSON extraction. */
const FENCE_OPEN = /^\s*```(?:json)?\s*\n?/i;
const FENCE_CLOSE = /\n?\s*```\s*$/i;

/**
 * Extract the first balanced top-level JSON OBJECT from arbitrary model text and
 * `JSON.parse` it. PURE and OFFLINE so the fenced / unfenced / prose-wrapped /
 * malformed cases are unit-testable without `query()`:
 * - strips a leading ```json / ``` fence and its trailing ``` when present;
 * - scans for the first `{`, then walks forward tracking brace depth (ignoring
 *   braces inside JSON strings, honoring `\`-escapes) to find the MATCHING `}`;
 * - `JSON.parse`s exactly that `{...}` slice.
 *
 * Throws {@link AgentProviderError} (`prompt_parse_failed`) when there is no
 * balanced object or the slice does not parse — the `'prompt'` path treats that
 * as a parse failure and retries / surfaces it.
 */
export function extractJsonObject(text: string): unknown {
    const unfenced = text.replace(FENCE_OPEN, '').replace(FENCE_CLOSE, '');
    const start = unfenced.indexOf('{');
    if (start === -1) {
        throw new AgentProviderError(
            'AnthropicAgentProvider: prompt-mode output contained no JSON object.',
            'prompt_parse_failed',
            0,
        );
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < unfenced.length; i++) {
        const ch = unfenced[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            if (inString) {
                escaped = true;
            }
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (ch === '{') {
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }

    if (end === -1) {
        throw new AgentProviderError(
            'AnthropicAgentProvider: prompt-mode output had no balanced top-level JSON object.',
            'prompt_parse_failed',
            0,
        );
    }

    const slice = unfenced.slice(start, end + 1);
    try {
        return JSON.parse(slice);
    } catch (error) {
        throw new AgentProviderError(
            `AnthropicAgentProvider: prompt-mode JSON did not parse: ${
                error instanceof Error ? error.message : String(error)
            }`,
            'prompt_parse_failed',
            0,
        );
    }
}

/** A schema fragment as our small validator reads it (object/array/string shapes). */
interface SchemaShape {
    type?: unknown;
    required?: unknown;
    properties?: Record<string, SchemaShape>;
    items?: SchemaShape;
}

/** True when `value` is a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when every name in `required` is a present key on the object `value`. */
function hasRequiredKeys(value: Record<string, unknown>, required: unknown): boolean {
    if (!Array.isArray(required)) {
        return true;
    }
    return required.every(key => typeof key === 'string' && key in value);
}

/**
 * Validate that one ARRAY ITEM conforms to its `items` sub-schema: it must be an
 * object that carries every `required` string key (and where that key's declared
 * type is `'string'`, the value must actually be a string). Deliberately shallow
 * — enough for our propose-style item shape, schema-driven rather than hardcoded.
 */
function itemConforms(item: unknown, itemSchema: SchemaShape | undefined): boolean {
    if (itemSchema === undefined || itemSchema.type !== 'object') {
        return true;
    }
    if (!isPlainObject(item)) {
        return false;
    }
    if (!hasRequiredKeys(item, itemSchema.required)) {
        return false;
    }
    const props = itemSchema.properties;
    if (props === undefined || !Array.isArray(itemSchema.required)) {
        return true;
    }
    for (const key of itemSchema.required) {
        if (typeof key !== 'string') {
            continue;
        }
        if (props[key]?.type === 'string' && typeof item[key] !== 'string') {
            return false;
        }
    }
    return true;
}

/**
 * Validate (and lightly REPAIR) a parsed prompt-mode value against `schema` with
 * a SMALL generic validator sufficient for our schema shape: a top-level object
 * with `required` keys + `properties`, where an array property's `items` is an
 * object with `required` (string) fields. PURE and OFFLINE so the valid /
 * missing-required-key / array-item-filtering cases are unit-testable.
 *
 * Behavior:
 * - the TOP-LEVEL value must be an object carrying every top-level `required`
 *   key; an array-typed required property must actually be an array. If either
 *   fails this is a hard FAILURE (returns `undefined`) — the `'prompt'` path
 *   treats it like a parse failure and retries / surfaces it.
 * - within a required ARRAY property, items that fail their `items` sub-schema
 *   are DROPPED (filtered out) rather than failing the whole value, mirroring the
 *   downstream tolerance for a few malformed candidates.
 *
 * @returns the validated (and item-filtered) value, or `undefined` if the
 *   top-level value is invalid.
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema): unknown {
    const shape = schema as SchemaShape;
    if (shape.type !== 'object') {
        // No object contract to enforce: accept any successfully-parsed value.
        return value;
    }
    if (!isPlainObject(value) || !hasRequiredKeys(value, shape.required)) {
        return undefined;
    }

    const props = shape.properties;
    if (props === undefined) {
        return value;
    }

    const out: Record<string, unknown> = { ...value };
    const required = Array.isArray(shape.required) ? shape.required : [];
    for (const [key, propSchema] of Object.entries(props)) {
        if (propSchema.type !== 'array') {
            continue;
        }
        if (Array.isArray(out[key])) {
            // Drop array items that fail their `items` sub-schema; keep the rest.
            out[key] = (out[key] as unknown[]).filter(item => itemConforms(item, propSchema.items));
        } else if (required.includes(key)) {
            // A required array property that is missing or not an array is a hard
            // failure (treated as a parse failure by the prompt path); a
            // non-required malformed array property is left untouched.
            return undefined;
        }
    }
    return out;
}
