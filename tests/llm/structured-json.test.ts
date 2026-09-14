/*
 * OFFLINE tests for the shared structured-JSON helpers.
 *
 * These cover the PURE, provider-agnostic parse/validate/prompt-build core that
 * was extracted from the Anthropic Agent SDK provider into `src/llm/structured-json`
 * so the OpenAI-compatible provider can reuse it without pulling the Agent SDK.
 * They NEVER touch the network — exactly the fenced / unfenced / prose-wrapped /
 * malformed / schema-shape cases the prompt path relies on. The Anthropic
 * provider re-exports these same helpers, and its own test file exercises them
 * through that re-export; this file pins the canonical module directly.
 */

import { describe, expect, it } from 'bun:test';

import {
    AgentProviderError,
    buildPromptModePrompt,
    extractJsonObject,
    validateAgainstSchema,
} from '../../src/llm/structured-json';
import type { JsonSchema } from '../../src/llm/types';

describe('buildPromptModePrompt', () => {
    const schema: JsonSchema = {
        type: 'object',
        required: ['x'],
        properties: { x: { type: 'number' } },
    };

    it('appends the raw-JSON directive and the stringified schema after the base prompt', () => {
        const out = buildPromptModePrompt('Do the thing.', schema);
        expect(out.startsWith('Do the thing.')).toBe(true);
        expect(out).toContain('Output ONLY a single raw JSON object');
        expect(out).toContain('no markdown code fences');
        expect(out).toContain(JSON.stringify(schema));
    });

    it('leaves the schema JSON intact so the model sees the exact contract', () => {
        const out = buildPromptModePrompt('p', schema);
        // The schema appears verbatim as JSON, parseable back out of the prompt.
        const tail = out.slice(out.indexOf('{'));
        expect(JSON.parse(tail)).toEqual(schema);
    });
});

describe('extractJsonObject', () => {
    it('parses an unfenced bare JSON object', () => {
        expect(extractJsonObject('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' });
    });

    it('strips a ```json fence and parses the object inside', () => {
        const text = '```json\n{"candidates":[{"original":"a"}]}\n```';
        expect(extractJsonObject(text)).toEqual({ candidates: [{ original: 'a' }] });
    });

    it('strips a bare ``` fence (no language tag)', () => {
        expect(extractJsonObject('```\n{"ok":true}\n```')).toEqual({ ok: true });
    });

    it('extracts the first balanced object from prose-wrapped text', () => {
        const text = 'Sure! Here is the result:\n{"x": {"y": 2}}\nLet me know if you need more.';
        expect(extractJsonObject(text)).toEqual({ x: { y: 2 } });
    });

    it('honors braces inside JSON strings when balancing', () => {
        expect(extractJsonObject('{"s":"a } b { c"}')).toEqual({ s: 'a } b { c' });
    });

    it('throws prompt_parse_failed when there is no object at all', () => {
        try {
            extractJsonObject('no json here, just prose');
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(AgentProviderError);
            expect((err as AgentProviderError).subtype).toBe('prompt_parse_failed');
        }
    });

    it('throws prompt_parse_failed when the braces never balance', () => {
        expect(() => extractJsonObject('{"a": 1, "b": ')).toThrow(AgentProviderError);
    });

    it('throws prompt_parse_failed when the slice is malformed JSON', () => {
        // Balanced braces but not valid JSON (single quotes / bare keys).
        expect(() => extractJsonObject("{a: 'b'}")).toThrow(/did not parse/);
    });
});

describe('validateAgainstSchema', () => {
    const schema: JsonSchema = {
        type: 'object',
        required: ['candidates'],
        properties: {
            candidates: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['original', 'replacement'],
                    properties: {
                        original: { type: 'string' },
                        replacement: { type: 'string' },
                    },
                },
            },
        },
    };

    it('returns a valid object unchanged', () => {
        const value = { candidates: [{ original: 'a', replacement: 'b' }] };
        expect(validateAgainstSchema(value, schema)).toEqual(value);
    });

    it('returns undefined when a required top-level key is missing', () => {
        expect(validateAgainstSchema({ other: 1 }, schema)).toBeUndefined();
    });

    it('returns undefined when the value is not an object', () => {
        expect(validateAgainstSchema([1, 2, 3], schema)).toBeUndefined();
        expect(validateAgainstSchema('nope', schema)).toBeUndefined();
        expect(validateAgainstSchema(null, schema)).toBeUndefined();
    });

    it('returns undefined when a required array property is present but not an array', () => {
        expect(validateAgainstSchema({ candidates: 'not-an-array' }, schema)).toBeUndefined();
    });

    it('drops array items that fail the item sub-schema, keeping valid ones', () => {
        const value = {
            candidates: [
                { original: 'a', replacement: 'b' }, // valid
                { original: 'c' }, // missing required replacement -> dropped
                { original: 1, replacement: 'd' }, // original not a string -> dropped
                'garbage', // not an object -> dropped
            ],
        };
        const out = validateAgainstSchema(value, schema) as { candidates: unknown[] };
        expect(out.candidates).toEqual([{ original: 'a', replacement: 'b' }]);
    });

    it('accepts any parsed value when the schema declares no object contract', () => {
        const loose: JsonSchema = { type: 'string' };
        expect(validateAgainstSchema('hello', loose)).toBe('hello');
    });

    it('passes through extra (non-array) properties without altering them', () => {
        const value = { candidates: [], note: 'kept' };
        expect(validateAgainstSchema(value, schema)).toEqual({ candidates: [], note: 'kept' });
    });
});

describe('AgentProviderError', () => {
    it('carries subtype and costUsd', () => {
        const err = new AgentProviderError('msg', 'some_subtype', 1.23);
        expect(err.name).toBe('AgentProviderError');
        expect(err.subtype).toBe('some_subtype');
        expect(err.costUsd).toBe(1.23);
        expect(err).toBeInstanceOf(Error);
    });
});
