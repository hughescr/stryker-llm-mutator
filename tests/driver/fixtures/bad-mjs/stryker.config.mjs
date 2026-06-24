// Fixture: a config that exports a FUNCTION (no longer supported by Stryker).
// config-reader.test.ts asserts readTargetConfig surfaces a clear error rather
// than crashing.
export default function config() {
    return { mutate: ['src/**/*.ts'] };
}
