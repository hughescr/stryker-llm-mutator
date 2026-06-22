import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isCI = Boolean(process.env.GITHUB_SHA);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
    // Tests run under Bun via the @hughescr/stryker-bun-runner plugin (Stryker
    // has no built-in Bun test runner). See openQuestions in the scaffold notes.
    testRunner:  'bun',
    bun:         { timeout: 60_000 },
    checkers:    ['typescript'],
    incremental: !isCI,
    plugins:     [
        '@hughescr/stryker-bun-runner',
        path.resolve(__dirname, 'dist/index.js'),
        '@stryker-mutator/typescript-checker',
    ],
    mutate:           ['src/**/*.ts'],
    ignorePatterns:   ['**', '!src/**/*.ts', '!tests/**/*.ts', '!bunfig.toml', '!tsconfig.json', '!*.mjs'],
    thresholds:       { high: 100, low: 100, 'break': 100 },
    coverageAnalysis: 'perTest',
    concurrency:      isCI ? 4 : 12,
    disableBail:      true,
    reporters:        isCI ? ['clear-text', 'progress', 'dashboard'] : ['progress', 'json', 'html'],
    tempDirName:      '.stryker-tmp',
};

export default config;
