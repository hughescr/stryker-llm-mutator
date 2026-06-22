# oxlint coverage of the `@hughescr` ESLint ruleset

This project uses **full oxlint** (`oxlint@1.71.0`) as its only linter — no ESLint.
Historically the `@hughescr` projects linted with `@hughescr/eslint-config-default`,
which composes ~14 ESLint plugins plus two custom `@hughescr` plugins. oxlint is a
Rust linter that is **not type-aware inside custom JS plugins**, so an exact 1:1
port is impossible. This document is the honest mapping of every `@hughescr` rule
group to one of:

- **native** — oxlint has a built-in (Rust) equivalent; configured in `.oxlintrc.json`.
- **ported** — reimplemented as an oxlint custom JS plugin in `oxlint-plugins/`.
- **LOST** — no oxlint equivalent; cannot be ported. Documented, not silently dropped.

> Verified against `oxlint@1.71.0` by extracting the registered rule list from the
> native binding and by running the config against fixtures. Rules that oxlint
> rejects as unknown were removed from `.oxlintrc.json` (oxlint hard-errors on
> unknown rule names, so the config is self-validating).

## Native plugins enabled

`typescript`, `unicorn`, `oxc`, `import`, `promise`, `node`, `jsdoc`, `jest`
(unicorn / typescript / oxc are on by default; the rest are opt-in). The `eslint`
core namespace is always active.

## Mapping

### Custom `@hughescr` rules

| Rule | Status | Notes |
|------|--------|-------|
| `@hughescr/test-hygiene/no-mock-module-in-test-body` | **ported** | `oxlint-plugins/test-hygiene.ts` → `test-hygiene/no-mock-module-in-test-body`. Pure-AST; same `setupFiles` option, message, logic. Verified firing. |
| `@hughescr/test-hygiene/require-fake-timers-cleanup` | **ported** | Same id/logic; recursive describe/hook/test walk. |
| `@hughescr/test-hygiene/require-mock-cleanup` | **ported** | Same id/logic; generic ESTree walker. Verified firing. |
| `@hughescr/test-hygiene/require-mock-reset` | **ported** | Same id; `mocks` (required) + `setupModules` options preserved. |
| `@hughescr/module-boundaries/no-internal-in-barrel` | **LOST** | Type-aware: needs `ts.Program` + `ts.resolveModuleName` + `ts.getJSDocTags`. oxlint JS plugins expose **no** parserServices/type-checker. Stub left in `oxlint-plugins/module-boundaries.ts`. |
| `@hughescr/module-boundaries/no-star-export-from-non-barrel` | **LOST** | Type-aware (resolve `export *` target to an `index.ts`). A basename-of-literal approximation is possible but loses correctness, so not shipped. Stub + TODO. |
| `@hughescr/module-boundaries/no-cross-module-internal` | **LOST** | Type-aware; also off-by-default upstream. Stub + TODO. |

### Composed ESLint plugins

| ESLint plugin group | Status | Notes |
|---------------------|--------|-------|
| `@eslint/js` (eslint:recommended) | **native (partial)** | Core rules ported individually (`no-throw-literal`, `eqeqeq`, `complexity`, `curly`, `no-shadow`, `prefer-const`, `object-shorthand`, etc.). A few core rules don't exist in oxlint and were dropped: `no-unreachable-loop`, `no-loop-func`, `no-redeclare`(builtinGlobals form), `accessor-pairs`, `strict`, `require-atomic-updates`, `no-use-before-define`, `no-warning-comments`, `no-useless-return`(exists), `default-param-last`(exists). |
| `typescript-eslint` recommendedTypeChecked + stylisticTypeChecked | **LOST (type-aware)** + native (non-type-aware subset) | All `*TypeChecked` and auto-promoted extension rules need type info → unavailable to the config without `oxlint-tsgolint`. Non-type-aware TS rules ARE enabled natively: `no-explicit-any`, `consistent-type-imports`, `no-non-null-assertion`, `ban-ts-comment`, `no-inferrable-types`, `no-empty-object-type`, `no-unnecessary-type-constraint`, `no-duplicate-enum-values`, `prefer-as-const`. Type-aware rules (`no-unnecessary-condition`, `switch-exhaustiveness-check`, `return-await`, `no-confusing-void-expression`, `no-misused-spread`, `no-floating-promises`, all `no-unsafe-*`) require `oxlint-tsgolint` (alpha) + `--type-aware`; not enabled in this scaffold. |
| `eslint-plugin-import-x` | **native (mostly)** | oxlint `import/`: `no-duplicates`, `no-self-import`, `no-cycle`, `newline-after-import`, `no-mutable-exports`, `no-empty-named-blocks`, `no-anonymous-default-export` ported. **Dropped (no oxlint rule):** `no-useless-path-segments`, `order` (oxlint has no `import/order`), `no-extraneous-dependencies`, `consistent-type-specifier-style`. |
| `eslint-plugin-unicorn` | **native (large subset)** | recommended + overrides ported: `no-null` off, `filename-case` (kebab+pascal), `catch-error-name` (ignore e/err/error), `no-useless-undefined` off, `prefer-at` off, `no-useless-error-capture-stack-trace` off, `no-abusive-eslint-disable` warn. **Dropped:** `prevent-abbreviations` (not implemented in oxlint — was `off` upstream anyway, so no behavior change). |
| `eslint-plugin-promise` | **native (mostly)** | `always-return`, `catch-or-return`, `param-names` ported. **Dropped:** `prefer-catch` (no oxlint rule). |
| `eslint-plugin-n` (node) | **native (subset)** | `callback-return`, `handle-callback-err`, `no-path-concat`, `no-sync` ported. **Dropped:** `no-callback-literal` (no oxlint rule). `no-unsupported-features/*` were already off (Bun). |
| `eslint-plugin-regexp` | **LOST** | oxlint has **no** `regexp/` plugin namespace. The ~18 `regexp/*` overrides (`prefer-d`, `prefer-w`, `match-any`, `no-dupe-characters-character-class`, etc.) have no equivalent. A few overlap with eslint-core regex rules oxlint does have (`no-control-regex`, `no-invalid-regexp`, `no-misleading-character-class`) but the dedicated regexp set is gone. |
| `@eslint-community/eslint-comments` | **LOST (mostly)** + option | No `eslint-comments/` plugin in oxlint. Unused-disable detection is provided by oxlint's `options.reportUnusedDisableDirectives` / `--report-unused-disable-directives` instead (not a rule). `no-abusive-eslint-disable` (unicorn) covers part of `no-unlimited-disable`. `disable-enable-pair`, `require-description`, `no-use`, `no-aggregating-enable` are LOST. |
| `@stylistic/*` (formatting) | **LOST** | oxlint defers formatting to a formatter (oxfmt, alpha). None of the ~30 `@stylistic/*` formatting rules (indent=4, quotes=single, semi, comma-dangle, key-spacing align, keyword-spacing overrides, etc.) are available. Mirror the template repo's formatting approach instead; do **not** adopt oxfmt yet. |
| `eslint-plugin-sonarjs` | **LOST** | No `sonarjs` plugin. `cognitive-complexity` has no oxlint analogue (oxlint's eslint-core `complexity` is enabled as a partial substitute). Use `jscpd` separately for duplicate detection. `no-collapsible-if`, `prefer-immediate-return` LOST. |
| `eslint-plugin-lodash` | **LOST** | No `lodash` plugin in oxlint. (lodash-specific; acceptable gap.) |
| `eslint-plugin-lodash-es` | **LOST** | No equivalent. `no-restricted-imports` of bare `lodash` is preserved as a partial substitute. |
| `eslint-plugin-package-json` | **LOST** | oxlint does not lint `package.json`. Use a separate tool (e.g. `sort-package-json`) if desired. |

## Test-file override layer

Upstream `testOverrides` disables ~14 rules in `*.{test,spec}.*` files. Mirrored
in `.oxlintrc.json` `overrides` for the rules that exist natively
(`typescript/no-non-null-assertion`, `typescript/no-explicit-any`,
`unicorn/consistent-function-scoping`, `require-yield`). The many
`@typescript-eslint/no-unsafe-*` and `only-throw-error` disables are moot here
because those type-aware rules are not enabled in the first place.

## Enabling type-aware native rules later (optional)

To recover the typescript-eslint type-checked rules natively, add the optional
`oxlint-tsgolint` package and set `options.typeAware: true` (or run
`oxlint --type-aware`). This powers oxlint's **native** TS rules only — it still
does **not** expose type info to the custom JS plugins, so the three
`module-boundaries` rules remain LOST regardless.

## Summary

- **4 / 4** custom test-hygiene rules: **ported** (verified firing).
- **0 / 3** custom module-boundaries rules: **LOST** (type-aware; stubbed + TODO).
- Composed plugins: large native subsets of `eslint`-core, `unicorn`, `import`,
  `promise`, `node`, plus non-type-aware `typescript`. **LOST:** `@stylistic`,
  `sonarjs`, `lodash`, `lodash-es`, `regexp`, `eslint-comments` (rule form),
  `package-json`, and all type-aware typescript-eslint rules.
