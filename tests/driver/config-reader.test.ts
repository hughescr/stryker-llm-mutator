/*
 * Offline unit tests for the target-config reader (functional-architecture §6).
 * Exercises locating + loading fixture config files: missing block → defaults,
 * a populated block, .json vs .mjs (dynamic import default export), the
 * --config-file override, a no-config-file directory, the function-export error,
 * and the supported-filename list. No Stryker import, no network.
 */

import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import {
    readTargetConfig,
    resolveConfigFilePath,
    SUPPORTED_CONFIG_FILE_NAMES,
} from '../../src/driver/config-reader';

const FIXTURES = path.join(import.meta.dir, 'fixtures');
const dir = (name: string): string => path.join(FIXTURES, name);

describe('SUPPORTED_CONFIG_FILE_NAMES', () => {
    it('mirrors Stryker: {prefix} x {.conf,.config} x {json,js,mjs,cjs} = 16 names', () => {
        expect(SUPPORTED_CONFIG_FILE_NAMES).toHaveLength(16);
        expect(SUPPORTED_CONFIG_FILE_NAMES).toContain('stryker.config.json');
        expect(SUPPORTED_CONFIG_FILE_NAMES).toContain('stryker.config.mjs');
        expect(SUPPORTED_CONFIG_FILE_NAMES).toContain('.stryker.conf.cjs');
    });
});

describe('resolveConfigFilePath', () => {
    it('finds a default-named config file in the project dir', async () => {
        const resolved = await resolveConfigFilePath(dir('json-config'));
        expect(resolved).toBe(path.join(dir('json-config'), 'stryker.config.json'));
    });

    it('returns undefined when no config file exists', async () => {
        expect(await resolveConfigFilePath(dir('empty-dir'))).toBeUndefined();
    });

    it('honors an explicit override (relative to projectDir)', async () => {
        const resolved = await resolveConfigFilePath(dir('override'), 'custom-stryker.json');
        expect(resolved).toBe(path.join(dir('override'), 'custom-stryker.json'));
    });

    it('honors an absolute override path', async () => {
        const abs = path.join(dir('override'), 'custom-stryker.json');
        expect(await resolveConfigFilePath(dir('override'), abs)).toBe(abs);
    });

    it('throws when an override path does not exist', async () => {
        await expect(resolveConfigFilePath(dir('override'), 'missing.json')).rejects.toThrow();
    });
});

describe('readTargetConfig — JSON config', () => {
    it('reads + parses the llmMutator block from a .json config', async () => {
        const { config, configFilePath } = await readTargetConfig(dir('json-config'));
        expect(configFilePath).toBe(path.join(dir('json-config'), 'stryker.config.json'));
        expect(config.provider).toBe('mock');
        expect(config.heuristics.operators).toEqual(['NumberLiteralValue']);
        // Defaults still filled for unspecified fields.
        expect(config.heuristics.enabled).toBe(true);
        expect(config.dynamicLLM.enabled).toBe(false);
    });
});

describe('readTargetConfig — MJS config', () => {
    it('reads + parses the llmMutator block from a .mjs default export', async () => {
        const { config, configFilePath } = await readTargetConfig(dir('mjs-config'));
        expect(configFilePath).toBe(path.join(dir('mjs-config'), 'stryker.config.mjs'));
        expect(config.dynamicLLM.enabled).toBe(true);
        expect(config.dynamicLLM.budget.maxCostUsd).toBe(3);
    });
});

describe('readTargetConfig — missing block / missing file', () => {
    it('returns all-defaults when the config has no llmMutator block', async () => {
        const { config } = await readTargetConfig(dir('no-llmmutator'));
        expect(config.heuristics.enabled).toBe(true);
        expect(config.dynamicLLM.enabled).toBe(false);
    });

    it('returns all-defaults with no configFilePath when no config file exists', async () => {
        const { config, configFilePath } = await readTargetConfig(dir('empty-dir'));
        expect(configFilePath).toBeUndefined();
        expect(config.heuristics.enabled).toBe(true);
    });
});

describe('readTargetConfig — override', () => {
    it('reads the overridden file and applies its block', async () => {
        const { config, configFilePath } = await readTargetConfig(
            dir('override'),
            'custom-stryker.json',
        );
        expect(configFilePath).toBe(path.join(dir('override'), 'custom-stryker.json'));
        expect(config.heuristics.enabled).toBe(false);
    });
});

describe('readTargetConfig — error surfaces', () => {
    it('throws a clear error for a function-exporting config', async () => {
        await expect(readTargetConfig(dir('bad-mjs'))).rejects.toThrow(/function/);
    });

    it('throws when a .json config is not an object (e.g. a bare number)', async () => {
        await expect(readTargetConfig(dir('json-array'))).rejects.toThrow(/JSON object/);
    });

    it('throws when a .mjs config has no default-exported options object', async () => {
        await expect(readTargetConfig(dir('mjs-no-default'))).rejects.toThrow(
            /no default-exported options object/,
        );
    });
});
