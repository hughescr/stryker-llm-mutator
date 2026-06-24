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
- **Heuristics catalog** (`src/mutators/`): the **full P1–P4 catalog (14 deterministic, network-free operators)** is implemented as Stryker `NodeMutator`s — numeric/boundary/fallback probes (P1); comparison-strictness, call-argument, and `await`-drop (P2); early-return injection, object-spread drop, array-method and Promise-combinator swaps (P3); default-param tweak, optional-chain force, string-predicate swap, and ternary-branch swap (P4). Each has a sibling unit test at ~100% coverage and is verified to place through the **real** Stryker instrumenter. The one statement-shaped operator, `EarlyReturnInjection`, ships with a dedicated offline real-instrumenter placement canary (`tests/injection/early-return-placement-proof.test.ts`) proving Stryker's `statementMutantPlacer` accepts a block replacement at a function-body block. Some operators (`AwaitDrop`, the type-changing method swaps, `OptionalChainForce`) honestly produce mutants that score as `error`/`compileError` rather than `survived` — a build-time-caught mutant is still a kill.
- **Config** (`src/config.ts`): plugin defaults including the default model and the `heuristics` / `dynamicLLM` switch blocks (heuristics on by default, dynamic-LLM off).

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
3. **…runs STOCK Stryker** in the same process (`new Stryker(cliOptions).runMutationTest()`). Stryker then instruments with our mutators and drives its entire normal pipeline over them — sandboxing, perTest coverage scoping, concurrency, checkers, incremental mode, and every configured reporter. Our mutants appear in Stryker's standard report, tagged distinctly by `mutatorName` (each operator's bare PascalCase name, e.g. `NumberLiteralValue`, and `llm` for dynamic-LLM mutants).

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

Configuration / usage
---------------------

You configure the plugin in a `llmMutator` block in your existing `stryker.conf.*` (the same config file serves both `stryker run` and `stryker-llm run`; Stryker core only `log.warn`s on the unknown `llmMutator` key, never fatal), then drive a run with the `stryker-llm` CLI. Every field has a sane default, so an empty `llmMutator: {}` (or no block at all) parses to **heuristics-on, dynamic-LLM-off**.

```js
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    // ...your normal Stryker config (testRunner, mutate globs, reporters, ...)
    llmMutator: {
        // --- The two switches ---
        heuristics: {
            enabled: true,          // default ON — deterministic, network-free
            operators: [],          // [] = all P1–P4 operators; else an allow-list of names
            skipUncovered: true,
        },
        dynamicLLM: {
            enabled: false,         // default OFF — costs money + needs credentials
            frozen: false,          // CI gate: cache-only deterministic re-score (see --frozen)
            // targeting / budget / diminishingReturns sub-blocks have sane defaults;
            // budget.maxCostUsd defaults to 5 (a HARD abort, checked between calls).
        },

        // The following apply only when dynamicLLM.enabled:
        provider: 'anthropic-agent-sdk', // or 'anthropic-api' (per-user API key)
        model:    'claude-haiku-4-5',    // default
        cacheDir: '.stryker-llm-cache',  // content-addressed cache (commit/restore for warm CI)
    },
};
```

Then run:

```bash
# Heuristics-only (the default), ours-only against a 100%-suite, live:
stryker-llm run . --ours-only --live

# Add dynamic-LLM mutants (needs credentials + network; costs money):
#   set dynamicLLM.enabled: true in the config first
stryker-llm run . --live

# Deterministic, free CI gate: re-score only already-cached LLM proposals:
stryker-llm run . --live --frozen
```

`stryker-llm run [projectDir]` flags:

- `--dry-run` (default) / `--live` — `--dry-run` builds + validates + prints the plan WITHOUT invoking Stryker; `--live` actually runs it.
- `--ours-only` / `--augment` — clear Stryker's 16 built-ins and run ONLY our mutators (best against a suite already at 100%), or keep the built-ins and add ours (the safer default for a non-100% suite).
- `--frozen` — force CACHE-ONLY dynamic-LLM: a cache miss yields no mutant (no network), so the run is deterministic and free. Affects dynamic-LLM only; heuristics are already deterministic. The sanctioned CI gate.
- pass-through: `--mutate <glob>` (repeatable / comma-list), `--config-file <path>`, `--concurrency <n>`, `--reporters <r,...>`, `--incremental`/`--no-incremental`, `--temp-dir <name>`.

Both switches OFF ⇒ a warning + **stock Stryker, unmodified**. Dynamic-LLM ON with no credentials ⇒ **fail fast** with a clear message (no silent degrade).

Live proof results
------------------

The architecture was proven end-to-end against [isambard](https://github.com/hughescr/) (249 src `.ts` files, **100% mutation score under vanilla Stryker** — so the bar is finding behavior changes the suite cannot kill that the 16 built-ins cannot even express):

- **Heuristics-only:** produced **7 real survivors** the 100%-suite missed (e.g. on `src/utils/time.ts`), network-free, **$0**, no credentials.
- **Dynamic-LLM:** produced **29 node-aligned `llm` mutants** scored by stock Stryker, **2 survivors**, total cost **$0.31** (well under the default `$5` ceiling). A warm re-run is cache-stable and free.

Three integration bugs were found and fixed during the live proof (Bun/Node `glob` interop, a disable-comment EOF over-scope, and the LLM range node-alignment exposed by the placement bug), each now guarded by an offline test.

Limitations (read before adopting)
---------------------------------

Beyond the architecture-level risks above, the honest tradeoffs:

1. **The blended Stryker score includes our mutants** and is **NOT comparable** to a vanilla Stryker score. Use the tool's tagged survivor view for the per-tool signal; never present the blended number as your project's "real" mutation score.
2. **Equivalent re-surfacing.** Pre-existing `// Stryker disable <BuiltInName>` comments do NOT cover our differently-named mutants (our names are bare PascalCase / `llm`), so a span an author vetted-and-disabled for a built-in operator can re-surface as a survivor under our operator — needing human audit. (Going forward, `// Stryker disable next-line all` or `// Stryker disable next-line <OurName>`/`llm` DOES suppress ours, for free, via Stryker's own bookkeeper.)
3. **Cold-run non-determinism.** LLM proposals vary run-to-run on cache MISSES (no temperature control via the Agent SDK), which changes which `llm` mutants exist. Heuristics are fully deterministic. For a deterministic CI gate use `--frozen` (re-scores only the already-cached "frozen mutant set") with a committed/restored `cacheDir`.
4. **Real per-user LLM cost.** Dynamic-LLM makes live Anthropic calls billed to your `ANTHROPIC_API_KEY` / subscription, bounded by `dynamicLLM.budget.maxCostUsd` (default `$5`, a hard abort consulted between calls).
5. **Monkeypatch coupling to internal Stryker `allMutators`,** reached by a deep import — fragile across versions and **silently** breakable if a future Stryker freezes/moves the array. Guarded by a **per-version CI canary** (`bun run canary`, run in `.github/workflows/ci.yml`), pinned to Stryker `9.6.1`. Run the canary before bumping Stryker.

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
bun run canary      # the per-version monkeypatch canary alone (run before bumping Stryker)
bun run test:injection  # all offline real-instrumenter proofs
bun run mutate      # stryker run (self mutation testing)
bun run clones      # jscpd duplicate detection
bun run dead-code   # knip
```

CI runs the six gates in order (typecheck, lint, format:check, test, build, dead-code) then the canary as a final named step — see [.github/workflows/ci.yml](./.github/workflows/ci.yml). CI runs nothing live (no `stryker run`, no Anthropic call); those stay human-run.

Linting
-------

This project uses **full [oxlint](https://oxc.rs/docs/guide/usage/linter)** as its only linter — there is no ESLint. The historical `@hughescr` ESLint ruleset has been mapped onto oxlint (native rules + custom JS plugins) as faithfully as possible. Some rules cannot be ported because oxlint's custom JS plugins are not type-aware; these are documented honestly rather than silently dropped.

See [docs/oxlint-coverage.md](./docs/oxlint-coverage.md) for the full rule-by-rule mapping (native / ported / LOST).

License
-------

[Apache-2.0](./LICENSE.md) — Copyright 2026 Craig Hughes.
