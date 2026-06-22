@hughescr/stryker-llm-mutator
=============================

LLM-driven mutation generation for [Stryker](https://stryker-mutator.io/). Instead of relying solely on Stryker's built-in, formulaic mutators (arithmetic-operator swaps, boolean flips, string-literal edits, and so on), this plugin uses a lightweight LLM to identify mutation locations and rewrite them — producing a wider, more semantically interesting variety of mutants.

The default model is **`claude-haiku-4-5`** (Anthropic Claude Haiku), chosen because mutant generation is a high-volume, latency-sensitive task that suits a small, fast model.

Status
------

**Early scaffolding.** This repository currently contains only tooling and configuration — build, lint, typecheck, test, mutation-testing, and dead-code scaffolds. No mutation features are implemented yet. The entry point (`src/index.ts`) is an intentional placeholder.

- Runtime: [Bun](https://bun.sh/)
- Language: TypeScript (`typescript@^6`), ESM only
- License: Apache-2.0

Installation
------------

> Not yet published. Once released:

```bash
bun add -D @hughescr/stryker-llm-mutator
```

`@stryker-mutator/core` (v9) is a peer dependency and must be present in the consuming project.

Architecture / design direction
-------------------------------

**Important constraint:** Stryker v9 has **no public "Mutator" plugin kind**. Unlike test runners, checkers, and reporters — which are first-class, pluggable `PluginKind`s — the set of mutators is **hardcoded inside Stryker's instrumenter**. There is no supported extension point to register a custom mutator that participates in the normal instrumentation pipeline.

Consequently, LLM-driven mutant generation in this plugin will **wrap or augment the instrument step** rather than register a new mutator plugin. The intended approach is to:

1. Hook the instrumentation phase (or run as a pre-pass that produces a mutant manifest), letting the LLM propose mutation locations and concrete rewrites for each source file.
2. Emit those LLM-generated mutants in the shape Stryker expects, so the existing run/check/report pipeline consumes them unchanged.
3. Optionally compose with the built-in mutators rather than replacing them, so LLM mutants are additive.

This design direction is deliberately documented up front because it shapes the public surface: the plugin will likely expose configuration and an instrument-time integration rather than a `declareClassPlugin(PluginKind.Mutator, ...)`-style registration, which Stryker v9 does not offer.

Configuration / usage (skeleton)
--------------------------------

Planned configuration in `stryker.conf.mjs` (subject to change as the design lands):

```js
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    plugins: [
        '@hughescr/stryker-llm-mutator',
        // ...other plugins
    ],
    // Planned plugin-specific options (illustrative, not yet implemented):
    llmMutator: {
        model:        'claude-haiku-4-5', // default
        // provider:  'anthropic',        // pluggable provider (see below)
        // mutantsPerLocation: 1,
    },
};
```

LLM provider plan
-----------------

The plugin will use a **pluggable provider** abstraction so the LLM backend is not hard-wired:

- The Anthropic SDK (`@anthropic-ai/sdk`) will be declared as an **optional `peerDependency`** (via `peerDependenciesMeta.optional`), **not** a hard dependency. Projects that use the default Anthropic provider install it; projects supplying their own provider do not pay for it.
- The default model is **`claude-haiku-4-5`**.
- No LLM SDK is included in this scaffold — provider wiring arrives with the feature work.

Development
-----------

```bash
bun install
bun run build       # bun build + dts-bundle-generator -> dist/
bun run lint        # oxlint
bun run typecheck   # tsc --noEmit
bun test            # bun test (preload + coverage thresholds in bunfig.toml)
bun run mutate      # stryker run (self mutation testing)
bun run clones      # jscpd duplicate detection
bun run dead-code   # knip
```

Linting
-------

This project uses **full [oxlint](https://oxc.rs/docs/guide/usage/linter)** as its only linter — there is no ESLint. The historical `@hughescr` ESLint ruleset has been mapped onto oxlint (native rules + custom JS plugins) as faithfully as possible. Some rules cannot be ported because oxlint's custom JS plugins are not type-aware; these are documented honestly rather than silently dropped.

See [docs/oxlint-coverage.md](./docs/oxlint-coverage.md) for the full rule-by-rule mapping (native / ported / LOST).

License
-------

[Apache-2.0](./LICENSE.md) — Copyright 2026 Craig Hughes.
