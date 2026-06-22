import type { KnipConfig } from 'knip';

const config: KnipConfig = {
    $schema: 'https://unpkg.com/knip@6/schema.json',
    // src/index.ts is the plugin entry point; tests are also entry points.
    // *.conf.mjs / *.config.* cover stryker.conf.mjs and dts-bundle-generator etc.
    // oxlint custom JS plugins are loaded by the oxlint binary, not imported by
    // our source, so they are entry points too (and not dead code).
    entry: [
        'src/index.ts',
        '*.conf.mjs',
        '*.config.ts',
        '*.config.json',
        'tests/**/*.ts',
        'oxlint-plugins/**/*.ts',
    ],
    project: ['src/**/*.ts'],
    ignoreDependencies: [
        // Knip's Stryker plugin maps `testRunner: 'bun'` to this package name,
        // but we use @hughescr/stryker-bun-runner (referenced in the plugins
        // array) instead. There is no @stryker-mutator/bun-runner dependency.
        '@stryker-mutator/bun-runner',
    ],
    ignoreUnresolved: [
        // Provided by @types/bun; referenced as a `types` entry in tsconfig.json.
        'bun-types',
    ],
    bun: true,
};

export default config;
