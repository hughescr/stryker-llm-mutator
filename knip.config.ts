import type { KnipConfig } from 'knip';

const config: KnipConfig = {
    $schema: 'https://unpkg.com/knip@6/schema.json',
    // src/index.ts is the plugin entry point; tests are also entry points.
    // *.conf.mjs / *.config.ts cover stryker.conf.mjs and knip.config.ts.
    // oxlint custom JS plugins are loaded by the oxlint binary, not imported by
    // our source, so they are entry points too (and not dead code).
    // demo/end-to-end.ts is a runnable example invoked directly with `bun run`.
    // src/seam/instrument-worker.mjs is SPAWNED as a Node child process by
    // src/seam/instrument.ts (never statically imported), so it is an entry too.
    // scripts/*.mjs are runnable drivers invoked directly with `node` (e.g. the
    // M0 live isambard proof), never imported — entry points, not dead code.
    entry: [
        'src/index.ts',
        '*.conf.mjs',
        '*.config.ts',
        'tests/**/*.ts',
        'oxlint-plugins/**/*.ts',
        'demo/**/*.ts',
        'scripts/**/*.mjs',
        'src/seam/instrument-worker.mjs',
    ],
    project: ['src/**/*.{ts,mjs}', 'scripts/**/*.mjs'],
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
