import { describe, expect, it } from 'bun:test';
import { PluginKind } from '@stryker-mutator/api/plugin';

import {
    classifyMutation,
    classifyNodes,
    createLlmMutators,
    expandExcludedMutations,
    expandLlmDirective,
    installLlmDirectiveAlias,
    installLlmDirectiveAliasIntoStryker,
    isLlmMutatorName,
    LLM_CATEGORIES,
    LLM_MUTATOR_NAME,
    LLM_MUTATOR_NAMES,
    LLM_MUTATOR_REPORTER_NAME,
    resolveDirectiveBookkeeperPath,
    strykerPlugins,
    VERSION,
    withLlmMutators,
} from '../src/index';

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

    it('exports the category taxonomy, classifier, mutator names and directive alias', () => {
        expect(LLM_CATEGORIES).toHaveLength(16);
        expect(LLM_MUTATOR_NAMES).toEqual([LLM_MUTATOR_NAME, ...LLM_CATEGORIES]);
        expect(typeof classifyMutation).toBe('function');
        expect(typeof classifyNodes).toBe('function');
        expect(typeof createLlmMutators).toBe('function');
        expect(isLlmMutatorName('LlmComparison')).toBe(true);
        expect(typeof expandLlmDirective).toBe('function');
        expect(typeof expandExcludedMutations).toBe('function');
        expect(typeof installLlmDirectiveAlias).toBe('function');
        expect(typeof installLlmDirectiveAliasIntoStryker).toBe('function');
        expect(typeof resolveDirectiveBookkeeperPath).toBe('function');
    });
});
