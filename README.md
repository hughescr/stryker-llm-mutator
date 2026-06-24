@hughescr/stryker-llm-mutator
=============================

Extra, more semantically interesting mutants for [Stryker](https://stryker-mutator.io/) — a set of 14 deterministic **heuristic** operators plus an optional **dynamic‑LLM** pre‑pass (default model **`claude-haiku-4-5`**) — that you wire into your `stryker.conf.mjs` and then run with **stock `stryker run`**. No separate runner.

> **What this is, honestly.** Stryker v9 has **no public "Mutator" plugin kind** — the operator set is hardcoded inside its instrumenter. This package is therefore **not a sanctioned plugin**: it is a **monkeypatch** that pushes custom `NodeMutator`s into the instrumenter's mutable, module‑level `allMutators` array (resolved at runtime against *your* hoisted instrumenter instance), then lets **stock Stryker** do all the rest — sandboxing, perTest coverage, concurrency, checkers, incremental mode, and every reporter. Our mutants show up in your normal Stryker report, tagged by `mutatorName` (bare PascalCase for heuristics, e.g. `NumberLiteralValue`; `llm` for dynamic‑LLM). It also ships a real `PluginKind.Reporter` plugin (`llm-mutator`) for a survivor + cost view. Use at your own risk — and read [Limitations](#limitations-read-before-adopting) first. Architecture detail lives in [docs/functional-architecture.md](./docs/functional-architecture.md).

Install
-------

```bash
npm i -D @hughescr/stryker-llm-mutator
# or: bun add -D @hughescr/stryker-llm-mutator
```

**Peer requirement.** Stryker v9 must already be installed in the consuming project — this package injects into **your** instrumenter instance, the same one stock `stryker run` reads:

```jsonc
// these are peerDependencies; install/keep them in your project
"@stryker-mutator/core":        ">=9.6.0 <10",
"@stryker-mutator/api":         ">=9.6.0 <10",
"@stryker-mutator/instrumenter":">=9.6.0 <10"
```

Tested against **Stryker 9.6.1**. The `<10` upper bound is the honest contract: a Stryker major bump may move or freeze the internal `allMutators` array and break the injection — possibly **silently** (a clean run with *none* of our mutants, no error). Run this package's `canary` before bumping Stryker (see [Limitations](#limitations-read-before-adopting)).

Requires **Node ≥ 20** (Stryker 9's runtime). `withLlmMutators` and the reporter run inside your `stryker run` Node process; they never import `@stryker-mutator/core`.

Configure
---------

Wrap your existing Stryker config with `withLlmMutators(...)` in `stryker.conf.mjs`, list this package in `plugins`, and add the `llm-mutator` reporter. Then you run **stock `stryker run`** — there is no separate CLI to learn.

### Heuristics only (synchronous — no credentials, no network, $0)

The default posture. The 14 deterministic operators only. `withLlmMutators` always returns a Promise, so you **must** `await` it — Stryker reads the config module's `default` export only after the module's top-level `await`s settle, and it does **not** unwrap a Promise `default`. Omitting `await` makes Stryker see an empty `{}` and silently drop your `testRunner`/`plugins`/`reporters`.

```js
// stryker.conf.mjs
import { withLlmMutators } from '@hughescr/stryker-llm-mutator';

export default await withLlmMutators({
    // ...your normal Stryker config (testRunner, mutate globs, ...)
    plugins: ['@stryker-mutator/*', '@hughescr/stryker-llm-mutator'],
    reporters: ['llm-mutator', 'html', 'clear-text'],

    // OUR extension block — stripped from the config handed back to Stryker:
    llmMutator: {
        heuristics: {
            enabled: true,   // default ON
            operators: [],   // [] = all 14 operators; else an allow-list of names
            skipUncovered: true,
        },
    },
});
```

### Add the dynamic‑LLM tier (async — top‑level `await`)

Same `await` requirement (and additionally the LLM pre‑pass is async, so it must complete before instrumentation). Stryker `await import()`s your config, so a top‑level `await` is supported — and because you await the call, the default export stays an **object**, never a Promise/function:

```js
// stryker.conf.mjs
import { withLlmMutators } from '@hughescr/stryker-llm-mutator';

const strykerConfig = {
    // ...your normal Stryker config
    plugins: ['@stryker-mutator/*', '@hughescr/stryker-llm-mutator'],
    reporters: ['llm-mutator', 'html', 'clear-text'],
};

export default await withLlmMutators({
    ...strykerConfig,
    llmMutator: {
        heuristics: { enabled: true },
        dynamicLLM: { enabled: true },     // costs money + needs credentials
        provider: 'anthropic-agent-sdk',   // see Authentication below
        model:    'claude-haiku-4-5',      // default
        cacheDir: '.stryker-llm-cache',    // commit/restore for warm, free CI
    },
});
```

**What `withLlmMutators(config)` does.** Stryker loads `stryker.conf.mjs` with `await import(...)` in its main process, **before instrumentation**. The wrapper reads `config.llmMutator`, selects + injects the heuristic `NodeMutator`s — and, when `dynamicLLM.enabled`, runs the async LLM pre‑pass and injects a single synchronous `llm` `LLMMutator` whose replacements it precomputed — into your live, runtime‑resolved `allMutators`, **in that same process during config evaluation**. It then returns your config with `llmMutator` **removed** so Stryker sees a clean config (no unknown‑key warning). Because injection happens before instrumentation, stock `stryker run` then instruments with our mutators for free.

> Import `withLlmMutators` **statically at the top** of the config (not via a deferred dynamic `import()` inside the config) so the registry resolution settles before the config is read. Calling the wrapper twice on the same object is a safe no‑op (it carries an idempotency marker).

### The reporter plugin

Stryker auto‑loads `node_modules/@stryker-mutator/*` plugins but **not** third‑party ones, so the explicit `plugins: ['@hughescr/stryker-llm-mutator']` entry is required for the reporter to load. Activate it by name in `reporters`:

```js
plugins:   ['@stryker-mutator/*', '@hughescr/stryker-llm-mutator'],
reporters: ['llm-mutator', 'html', 'clear-text'],   // 'llm-mutator' is ours
```

The `llm-mutator` reporter renders OUR view on top of Stryker's standard report: a **survivors** section (the test holes the tool exists to find — one line per survivor, heuristic vs precise `llm/<tag>` distinguished), a **not‑comparable** note, and a **total LLM cost** line (`$0.00` on a heuristics‑only run). It reuses `formatReport` and reads cost from the pre‑pass via an in‑process runtime‑state hand‑off.

Run
---

Just run stock Stryker — no separate CLI:

```bash
npx stryker run        # instruments with our mutators (in allMutators) + the built-ins
```

Our mutants appear in the standard Stryker report tagged by `mutatorName` (bare PascalCase, e.g. `NumberLiteralValue`; `llm` for dynamic). With both switches **off** you get a warning + **stock, unmodified Stryker**. With `dynamicLLM` on and credentials missing, the run **fails fast** with a clear message — it never silently degrades.

### Alternative — the `stryker-llm` CLI (still supported)

The same `llmMutator` config also drives a bundled `stryker-llm` CLI, which injects our mutators and invokes Stryker itself. It adds an **`--ours-only`** replace mode (clear Stryker's built‑ins, run *only* ours — best against a suite already at 100%) and **`--frozen`** (cache‑only deterministic re‑score):

```bash
stryker-llm run . --ours-only --live    # heuristics-only, ours-only, live
stryker-llm run . --live                 # + dynamic-LLM (set dynamicLLM.enabled first)
stryker-llm run . --live --frozen        # deterministic, free CI gate (cache-only LLM)
```

`stryker-llm run [projectDir]` flags: `--dry-run` (default) / `--live`; `--ours-only` / `--augment`; `--frozen`; and pass‑through `--mutate <glob>`, `--config-file <path>`, `--concurrency <n>`, `--reporters <r,...>`, `--incremental`/`--no-incremental`, `--temp-dir <name>`. (Augment‑vs‑ours‑only is CLI‑only; `withLlmMutators` always augments.)

Authentication
--------------

- **Heuristics** need **nothing** — no credentials, no network, $0.
- **Dynamic‑LLM** needs a provider with credentials. The currently‑implemented provider is `anthropic-agent-sdk` (the Anthropic Agent SDK subscription path), authenticated with **`CLAUDE_CODE_OAUTH_TOKEN`** — this is what the live proof below used. The raw per‑user API‑key provider (`anthropic-api`, reading `ANTHROPIC_API_KEY`) and OpenAI providers are **planned but not yet wired** — selecting them today throws a clear `NotImplementedError`. The credential check runs **before** any network call: `dynamicLLM` enabled with a network provider but missing credentials throws and exits non‑zero (no silent fallback to heuristics).

Switches and knobs
------------------

Everything lives under `llmMutator`. Both switches default such that an empty `llmMutator: {}` gives you all heuristics, no LLM.

| Key | Default | Meaning |
| --- | --- | --- |
| `heuristics.enabled` | `true` | The deterministic, network‑free operators. |
| `heuristics.operators` | `[]` | `[]` = all 14 (P1–P4); else an allow‑list of operator names. |
| `heuristics.skipUncovered` | `true` | Deprioritize zero‑coverage spans where a coverage signal exists. |
| `dynamicLLM.enabled` | `false` | The targeted LLM pre‑pass + injected `llm` mutator. Costs money + needs credentials. |
| `dynamicLLM.frozen` | `false` | Cache‑only deterministic re‑score (a cache miss yields no mutant, no network) — the CI gate. |
| `dynamicLLM.budget.maxCostUsd` | `5` | **Hard** dollar abort, checked between calls. |
| `provider` | `anthropic-agent-sdk` | LLM provider (only `anthropic-agent-sdk` + `mock` implemented today). |
| `model` | `claude-haiku-4-5` | Model id. |
| `cacheDir` | `.stryker-llm-cache` | Content‑addressed cache. Commit/restore it for warm, free CI runs. |

The 14 heuristic operators (allow‑list names for `heuristics.operators`): **P1** `NumberLiteralValue`, `BoundaryOffByOne`, `FallbackOperandSubstitution`; **P2** `ComparisonBoundaryShift`, `CallArgumentTweak`, `AwaitDrop`; **P3** `EarlyReturnInjection`, `SpreadOperandDrop`, `ArrayMethodSwap`, `PromiseCombinatorSwap`; **P4** `DefaultParamValueTweak`, `OptionalChainForce`, `StringMethodArgSwap`, `TernaryBranchSwap`. (Some — `AwaitDrop`, the type‑changing method swaps, `OptionalChainForce` — honestly produce mutants that score as `error`/`compileError` rather than `survived`; a build‑time‑caught mutant is still a kill.)

Live proof
----------

Proven end‑to‑end against [isambard](https://github.com/hughescr/) — 249 src `.ts` files, **100% mutation score under vanilla Stryker**, so the bar is finding behavior changes the suite cannot kill that the 16 built‑ins cannot even express:

- **Heuristics only:** **7 real survivors** the 100%‑suite missed (e.g. in `src/utils/time.ts`), network‑free, **$0**, no credentials.
- **Dynamic‑LLM:** **29 node‑aligned `llm` mutants** scored by stock Stryker, **2 survivors**, total cost **$0.31** (well under the default $5 ceiling). A warm re‑run is cache‑stable and free.

Limitations (read before adopting)
----------------------------------

1. **Version‑coupling to Stryker internals.** The injection deep‑imports the instrumenter's internal `allMutators` array (past Stryker's `exports` map) — unsupported and fragile across versions. A Stryker upgrade can break it, **possibly silently**: you'd get a clean run with *none* of our mutants, not an error. This is guarded by a per‑version smoke test (`bun run canary`, pinned to 9.6.1) — run it before bumping Stryker.
2. **The blended score is NOT comparable** to a vanilla Stryker mutation score (it includes our injected mutants). Use the `llm-mutator` reporter's tagged survivor view for the per‑tool signal; never present the blended number as your project's "real" mutation score.
3. **Equivalent re‑surfacing.** Pre‑existing `// Stryker disable <BuiltInName>` comments do **not** cover our differently‑named mutants (ours are bare PascalCase / `llm`), so a span vetted‑and‑disabled for a built‑in can re‑surface as a survivor under our operator — needing human audit. Going forward, `// Stryker disable next-line all` or `// Stryker disable next-line <OurName>`/`llm` does suppress ours, via Stryker's own bookkeeper.
4. **Cold‑run LLM non‑determinism + real cost.** LLM proposals vary run‑to‑run on cache **misses**, which changes which `llm` mutants exist, and dynamic‑LLM makes live, billed API calls. Heuristics are fully deterministic and free. For a deterministic, free CI gate use `dynamicLLM.frozen: true` (or `--frozen`) with a committed/restored `cacheDir`; spend is bounded by `dynamicLLM.budget.maxCostUsd` (default $5, a hard abort).
5. **Unofficial monkeypatch.** Stryker does not sanction this. If the tradeoffs above are unacceptable, heuristics‑only mode (the default) still gives you the extra mutants with zero LLM spend, no credentials, and no network.

LLM provider plan
-----------------

The plugin codes against a single `LLMProvider` abstraction ("given a prompt and a JSON schema, return a validated object"), so the backend is pluggable. The first implemented provider is the Anthropic **Agent SDK** subscription path (`@anthropic-ai/claude-agent-sdk`, default model `claude-haiku-4-5`, auth `CLAUDE_CODE_OAUTH_TOKEN`). A raw per‑user Anthropic **API‑key** path and OpenAI(‑compatible) providers implement the same interface and are planned (they currently throw `NotImplementedError`). Offline tests never touch the network — they inject a mock provider returning canned schema‑valid objects. See [docs/development-plan.md](./docs/development-plan.md) §4.1 / §6.

Development
----------

```bash
bun install
bun run build       # clean + bun build (esm) + tsc dts (tsconfig.dts.json) -> dist/
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint (zero warnings)
bun run format      # oxfmt --write   (format:check verifies)
bun test            # bun test (preload + coverage thresholds in bunfig.toml)
bun run build       # dist build (above)
bun run dead-code   # knip
bun run canary      # the per-version monkeypatch canary (run before bumping Stryker)
bun run test:injection  # all offline real-instrumenter proofs
```

CI runs the six gates in order (typecheck, lint, format:check, test, build, dead‑code) then the canary as a final named step — see [.github/workflows/ci.yml](./.github/workflows/ci.yml). CI runs nothing live (no `stryker run`, no Anthropic call); those stay human‑run.

This project uses **full [oxlint](https://oxc.rs/docs/guide/usage/linter)** as its only linter (no ESLint). See [docs/oxlint-coverage.md](./docs/oxlint-coverage.md) for the rule‑by‑rule mapping.

License
-------

[Apache-2.0](./LICENSE.md) — Copyright 2026 Craig Hughes.
