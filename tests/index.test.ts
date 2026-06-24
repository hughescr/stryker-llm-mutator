import { describe, expect, it } from 'bun:test';
import { PluginKind } from '@stryker-mutator/api/plugin';

import { LLM_MUTATOR_REPORTER_NAME, strykerPlugins, VERSION, withLlmMutators } from '../src/index';

describe('@hughescr/stryker-llm-mutator package barrel', () => {
    it('exposes a version marker', () => {
        expect(VERSION).toBe('0.1.0');
    });

    it('exports the real llm-mutator Reporter plugin in strykerPlugins', () => {
        expect(Array.isArray(strykerPlugins)).toBe(true);
        expect(strykerPlugins).toHaveLength(1);
        const plugin = strykerPlugins[0] as { kind: unknown; name: unknown };
        expect(plugin.kind).toBe(PluginKind.Reporter);
        expect(plugin.name).toBe(LLM_MUTATOR_REPORTER_NAME);
    });

    it('exports the withLlmMutators config wrapper (the primary integration path)', () => {
        expect(typeof withLlmMutators).toBe('function');
    });
});
