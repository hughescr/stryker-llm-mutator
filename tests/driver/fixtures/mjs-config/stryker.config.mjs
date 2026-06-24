// Fixture: an .mjs Stryker config whose default export carries an `llmMutator`
// block enabling dynamicLLM. Used by config-reader.test.ts to exercise the
// dynamic-import path (default export → options object).
const config = {
    mutate: ['src/**/*.ts'],
    testRunner: 'bun',
    llmMutator: {
        provider: 'mock',
        dynamicLLM: {
            enabled: true,
            budget: { maxCostUsd: 3 },
        },
    },
};

export default config;
