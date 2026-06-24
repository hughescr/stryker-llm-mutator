@hughescr/stryker-llm-mutator
=============================

LLM-driven mutation generation for [Stryker](https://stryker-mutator.io/). Instead of relying solely on Stryker's built-in, formulaic mutators (arithmetic-operator swaps, boolean flips, string-literal edits, and so on), this plugin uses a lightweight LLM to identify mutation locations and rewrite them — producing a wider, more semantically interesting variety of mutants.

The default model is **`claude-haiku-4-5`** (Anthropic Claude Haiku), chosen because mutant generation is a high-volume, latency-sensitive task that suits a small, fast model.

Status
------

**Early development — the runtime half of the slice is real.** This is not just scaffolding: the load-bearing seam and the first vertical slice are implemented and covered by an offline test suite. `src/index.ts` is a real barrel re-exporting the implemented components. Concretely:

- **Phase-0 out-of-band seam** (`src/seam/`): drives Stryker's own instrumenter out-of-band to emit BOTH coupled artifacts — the `stryMutAct_9fa48(id) ? mutated : original` activation switch in source AND the matching mutant-manifest record — in lockstep, with deterministic content-addressed mutant ids, then scores each mutant killed/survived/timeout/error.
- **Phase-1 LLM provider** (`src/llm/`): a pluggable provider abstraction plus the first real provider — the Anthropic **Agent SDK** subscription path (`@anthropic-ai/claude-agent-sdk`, default model `claude-haiku-4-5`), with schema-validated structured output, a content-addressed cache, cost accounting, and a fully offline mock provider.
- **Stage-2 pipeline** (`src/pipeline/`): `propose()` (LLM-driven candidate generation) feeding cheap deterministic filters (unparseable / identical / duplicate winnowing).
- **Config** (`src/config.ts`): plugin defaults including the default model.

The architecture has since been **decided as monkeypatch-injection** (see [docs/functional-architecture.md](./docs/functional-architecture.md)): rather than building our own runner/sandbox, the tool injects custom mutators into Stryker's internal `allMutators` registry and runs **stock Stryker** end-to-end. The out-of-band seam above (`src/seam/instrument-worker.mjs`, `runner.ts`) is no longer on the critical path — its replacement-string→AST-node parsing is reused by the LLM pre-pass, and the out-of-band path is retained only as a documented fallback. **[docs/functional-architecture.md](./docs/functional-architecture.md) is the current source of truth** for the architecture and build plan; [docs/development-plan.md](./docs/development-plan.md) holds the design rationale and provider plan. This README summarizes both.

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

**How this plugin works anyway — monkeypatch-injection.** Stryker's instrumenter holds its mutator set in a module-level array, `allMutators`, that is **mutable, non-frozen, and read by reference** at instrumentation time (`@stryker-mutator/instrumenter`'s `babel-transformer.js` uses `mutators = allMutators` as a default parameter). So this plugin:

1. **Authors heuristic operators directly as Stryker `NodeMutator`s** (`{ name, mutate(path) }` — the tiny interface Stryker itself uses), and **dynamic-LLM mutants** as a single `LLMMutator` backed by an async pre-pass that precomputes replacements (because `mutate()` is synchronous).
2. **Pushes those mutators into `allMutators`** (clearing it first to run ours-only, or augmenting to keep the built-ins), then…
3. **…runs STOCK Stryker** in the same process (`new Stryker(cliOptions).runMutationTest()`). Stryker then instruments with our mutators and drives its entire normal pipeline over them — sandboxing, perTest coverage scoping, concurrency, checkers, incremental mode, and every configured reporter. Our mutants appear in Stryker's standard report, tagged distinctly (`heuristic/<op>`, `llm/<tag>`).

We do **not** build our own runner, sandbox, or coverage planner — stock Stryker provides all of it. See [docs/functional-architecture.md](./docs/functional-architecture.md) for the verified mechanism, the build plan, and the full risk analysis.

**Why Stryker has no mutator plugin system (and why injecting anyway is reasonable).** It is a deliberate design choice, not an oversight: a standardized cross-implementation mutator catalog + report schema keeps mutation scores comparable; the instrumenter is performance-critical and tightly Babel-coupled, so a public mutator API would freeze Babel internals as a contract; a curated operator set controls equivalent-mutant noise; and Stryker offers escape hatches (`// Stryker disable` comments, mutation ranges, "contribute upstream"). The injection works because the mutator interface is tiny and the array is mutable — **provided we own the consequences** (tag our mutants, keep our own survivor view, and never present the blended score as a comparable mutation score).

### For Stryker users thinking of adopting this

If you already run Stryker and want this plugin's heuristic and/or dynamic-LLM mutants, here is the honest "know what you're getting into":

- **What it does:** adds extra, more semantically interesting mutants (formulaic heuristics, and optionally LLM-generated ones) to your mutation run, so you can find test holes the built-in operators cannot express.
- **How it ties in:** it monkeypatches Stryker's internal `allMutators` registry and then runs **stock Stryker**, so you keep your normal Stryker sandboxing, perTest coverage, concurrency, and reporting — and our mutants show up in your standard report.
- **What might break or surprise you:**
  - **It depends on Stryker *internals* pinned to a specific version range.** Upgrading Stryker may break the injection, **possibly silently** (you'd get a clean run with *none* of our mutants, not an error). Check this project's supported-version note / run its smoke test before bumping Stryker.
  - **It deep-imports past Stryker's package `exports` map** (a relative `node_modules` path), which is unsupported and fragile across versions.
  - **Your reported mutation score will include our mutants**, so it is **not comparable** to a vanilla Stryker score. Use our tagged survivor view for the per-tool signal.
  - **LLM mutants are non-deterministic** run-to-run and **cost real money** — dynamic-LLM mode needs your own `ANTHROPIC_API_KEY` and makes live API calls.
  - **It is an unofficial monkeypatch Stryker does not sanction.** Use at your own risk.

If those tradeoffs are acceptable, heuristics-only mode (the default) gives you the extra mutants with **zero LLM spend, no credentials, and no network**.

This design direction is documented up front because it shapes the public surface: the plugin exposes configuration plus a `stryker-llm run` driver that injects mutators and invokes Stryker, rather than a `declareClassPlugin(PluginKind.Mutator, ...)`-style registration, which Stryker v9 does not offer.

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

The plugin uses a **pluggable provider** abstraction so the LLM backend is not hard-wired — its single operation is "given a prompt and a JSON schema, return a validated object." See [docs/development-plan.md](./docs/development-plan.md) §4.1 / §6 for the full direction. The committed posture:

- The **first** provider is the Anthropic **subscription path via the Agent SDK** (`@anthropic-ai/claude-agent-sdk`), driving **`claude-haiku-4-5`** and authenticated with `CLAUDE_CODE_OAUTH_TOKEN`. This SDK is a **direct dependency** (currently dev-facing while the package is pre-publish). The Agent SDK is agentic, so the provider obtains structured output via the SDK's JSON-schema output mode rather than assuming a single round-trip.
- The sanctioned shippable default for published consumers is the per-user Anthropic **API-key** path (raw API). Additional providers (OpenAI, OpenAI-compatible) implement the *same* interface and arrive later (§6).
- The default model is **`claude-haiku-4-5`**.
- Offline unit tests never touch the network: they inject a mock provider returning canned schema-valid objects. The single live smoke test is human-run.

Development
-----------

```bash
bun install
bun run build       # bun build (esm bundle) + tsc dts (tsconfig.dts.json) -> dist/
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
