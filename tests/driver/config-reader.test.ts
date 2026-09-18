/*
 * Offline unit tests for the target-config reader (functional-architecture §6).
 * Exercises locating + loading fixture config files: missing block → defaults,
 * a populated block, .json vs .mjs (dynamic import default export), the
 * --config-file override, a no-config-file directory, the function-export error,
 * and the supported-filename list. No Stryker import, no network.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

describe('readTargetConfig — excludedMutations surfaced (Finding 1)', () => {
    /** Write a temp project with the given config file, run `fn`, clean up. */
    async function withProject<T>(
        fileName: string,
        content: string,
        fn: (projectDir: string) => Promise<T>,
    ): Promise<T> {
        const projectDir = await mkdtemp(path.join(tmpdir(), 'stryker-llm-excluded-'));
        try {
            await writeFile(path.join(projectDir, fileName), content, 'utf8');
            return await fn(projectDir);
        } finally {
            await rm(projectDir, { recursive: true, force: true });
        }
    }

    it('returns the list verbatim from a PLAIN stryker.config.json (no withLlmMutators)', async () => {
        await withProject(
            'stryker.config.json',
            JSON.stringify({
                mutate: ['src/**/*.ts'],
                excludedMutations: ['llm', 'StringLiteral'],
                llmMutator: { provider: 'mock', dynamicLLM: { enabled: true } },
            }),
            async projectDir => {
                const result = await readTargetConfig(projectDir);
                expect(result.excludedMutations).toEqual(['llm', 'StringLiteral']);
                expect(result.configFilePath).toBe(path.join(projectDir, 'stryker.config.json'));
                // llmMutator parsing is unchanged.
                expect(result.config.dynamicLLM.enabled).toBe(true);
                expect(result.config.provider).toBe('mock');
            },
        );
    });

    it('returns the list from a .mjs default export too', async () => {
        await withProject(
            'stryker.config.mjs',
            "export default { mutate: ['src/**/*.ts'], excludedMutations: ['llm'] };\n",
            async projectDir => {
                const result = await readTargetConfig(projectDir);
                expect(result.excludedMutations).toEqual(['llm']);
            },
        );
    });

    it('is undefined when the key is absent or not an array of strings', async () => {
        await withProject(
            'stryker.config.json',
            JSON.stringify({ mutate: ['src/**/*.ts'] }),
            async projectDir => {
                const result = await readTargetConfig(projectDir);
                expect(result.excludedMutations).toBeUndefined();
                expect('excludedMutations' in result).toBe(false);
            },
        );
        await withProject(
            'stryker.config.json',
            JSON.stringify({ excludedMutations: 'llm' }),
            async projectDir => {
                expect((await readTargetConfig(projectDir)).excludedMutations).toBeUndefined();
            },
        );
        await withProject(
            'stryker.config.json',
            JSON.stringify({ excludedMutations: ['llm', 3] }),
            async projectDir => {
                expect((await readTargetConfig(projectDir)).excludedMutations).toBeUndefined();
            },
        );
        // No config file at all → no key either.
        expect('excludedMutations' in (await readTargetConfig(dir('empty-dir')))).toBe(false);
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
