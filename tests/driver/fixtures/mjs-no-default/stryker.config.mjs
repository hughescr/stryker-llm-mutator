// Fixture: a config module with only a NAMED export and no default export.
// config-reader.test.ts asserts readTargetConfig surfaces a clear error.
export const notTheDefault = { mutate: ['src/**/*.ts'] };
