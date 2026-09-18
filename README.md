@hughescr/stryker-llm-mutator
=============================

Extra, more semantically interesting mutants for [Stryker](https://stryker-mutator.io/) — a set of 7 deterministic **heuristic** operators plus an optional **dynamic‑LLM** pre‑pass (default model alias **`haiku`**) — that you wire into your `stryker.conf.mjs` and then run with **stock `stryker run`**. No separate runner.

> **What this is, honestly.** Stryker v9 has **no public "Mutator" plugin kind** — the operator set is hardcoded inside its instrumenter. This package is therefore **not a sanctioned plugin**: it is a **monkeypatch** that pushes custom `NodeMutator`s into the instrumenter's mutable, module‑level `allMutators` array (resolved at runtime against *your* hoisted instrumenter instance), then lets **stock Stryker** do all the rest — sandboxing, perTest coverage, concurrency, checkers, incremental mode, and every reporter. Our mutants show up in your normal Stryker report, tagged by `mutatorName` (bare PascalCase for heuristics, e.g. `NumberLiteralValue`; a category‑qualified `Llm<Category>` name such as `LlmComparison` for dynamic‑LLM — see [LLM mutant categories](#llm-mutant-categories)). It also ships a real `PluginKind.Reporter` plugin (`llm-mutator`) for a survivor + cost view. Use at your own risk — and read [Limitations](#limitations-read-before-adopting) first. Architecture detail lives in [docs/functional-architecture.md](./docs/functional-architecture.md).

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

The default posture. The 7 deterministic operators only. `withLlmMutators` always returns a Promise, so you **must** `await` it — Stryker reads the config module's `default` export only after the module's top-level `await`s settle, and it does **not** unwrap a Promise `default`. Omitting `await` makes Stryker see an empty `{}` and silently drop your `testRunner`/`plugins`/`reporters`.

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
            operators: [],   // [] = all 7 operators; else an allow-list of names
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
        dynamicLLM: {
            enabled: true,                 // costs money + needs credentials
            // parallelBatches: 4,         // Haiku requests per wave; >1 speeds cold runs (see caveats)
        },
        provider: 'anthropic-agent-sdk',   // see Authentication below
        model:    'haiku',                 // default Anthropic alias
        cacheDir: '.stryker-llm-cache',    // commit/restore for warm, free CI
    },
});
```

**What `withLlmMutators(config)` does.** Stryker loads `stryker.conf.mjs` with `await import(...)` in its main process, **before instrumentation**. The wrapper reads `config.llmMutator`, selects + injects the heuristic `NodeMutator`s — and, when `dynamicLLM.enabled`, runs the async LLM pre‑pass, installs the legacy‑`llm` directive alias, and injects the 17 synchronous LLM `NodeMutator`s (the no‑op `llm` wildcard plus one per `Llm<Category>`) whose replacements it precomputed — into your live, runtime‑resolved `allMutators`, **in that same process during config evaluation**. It then returns your config with `llmMutator` **removed** so Stryker sees a clean config (no unknown‑key warning), and with a bare `llm` in `excludedMutations` expanded to every category name. Because injection happens before instrumentation, stock `stryker run` then instruments with our mutators for free.

> Import `withLlmMutators` **statically at the top** of the config (not via a deferred dynamic `import()` inside the config) so the registry resolution settles before the config is read. Calling the wrapper twice on the same object is a safe no‑op (it carries an idempotency marker).

### The reporter plugin

Stryker auto‑loads `node_modules/@stryker-mutator/*` plugins but **not** third‑party ones, so the explicit `plugins: ['@hughescr/stryker-llm-mutator']` entry is required for the reporter to load. Activate it by name in `reporters`:

```js
plugins:   ['@stryker-mutator/*', '@hughescr/stryker-llm-mutator'],
reporters: ['llm-mutator', 'html', 'clear-text'],   // 'llm-mutator' is ours
```

The `llm-mutator` reporter renders OUR view on top of Stryker's standard report: a **survivors** section (the test holes the tool exists to find — one line per survivor, heuristic vs precise `Llm<Category>/<tag>` distinguished), an **LLM mutants by category** line (`LlmComparison 812 (survived 2), LlmLogical 301, …`), a **not‑comparable** note, and a **total LLM cost** line (`$0.00` on a heuristics‑only run). It reuses `formatReport` and reads cost from the pre‑pass via an in‑process runtime‑state hand‑off.

Run
---

Just run stock Stryker — no separate CLI:

```bash
npx stryker run        # instruments with our mutators (in allMutators) + the built-ins
```

Our mutants appear in the standard Stryker report tagged by `mutatorName` (bare PascalCase, e.g. `NumberLiteralValue`; `Llm<Category>` for dynamic — one of `LlmComparison`, `LlmArithmetic`, `LlmLogical`, `LlmNullish`, `LlmNegate`, `LlmAwait`, `LlmTernary`, `LlmMethod`, `LlmArgument`, `LlmProperty`, `LlmIdentifier`, `LlmNumber`, `LlmString`, `LlmConstant`, `LlmStatement`, `LlmOther`). With both switches **off** you get a warning + **stock, unmodified Stryker**. With `dynamicLLM` on and credentials missing, the run **fails fast** with a clear message — it never silently degrades.

### LLM mutant categories

Every dynamic‑LLM mutant is named `Llm<Category>` — chosen **deterministically from the parsed `(original, replacement)` pair** (`src/pipeline/classify.ts`), never from the model's free‑text tag — so a `// Stryker disable` directive can target one *kind* of change on a line and leave the others live. (With a single `llm` name, a directive written for one vetted‑equivalent proposal also hid every other proposal on that line: `c.unreadCount > 0` → `>= 1` (equivalent) vs `!== 0` (real).) Classification happens after the cache boundary, so the proposal cache key is untouched.

| Name | The kind of change |
| --- | --- |
| `LlmComparison` | A relational/equality operator changed (`===`↔`!==`, `>`↔`>=`), comparison operands swapped, or a comparison wrapped around / removed from an expression. |
| `LlmArithmetic` | An arithmetic/bitwise operator changed, an arithmetic op added/removed, `++`/`--` flipped or dropped, a compound assignment operator changed, a unary `-`/`+`/`~` change. |
| `LlmLogical` | `&&`↔`\|\|`, their operands swapped, or a logical composition introduced/removed (a guard added or dropped). Never involves `??`. |
| `LlmNullish` | `??` or optional chaining (`?.`) added, removed, relocated, or swapped with another operator — counted separately, so `a?.b → a.b ?? 0` cannot cancel out. |
| `LlmNegate` | A `!` wrapped around / removed from an expression. |
| `LlmAwait` | An `await` added or removed. |
| `LlmTernary` | A conditional's branches swapped (at any depth), or a ternary introduced/removed. An edit *inside* one branch keeps its own kind. |
| `LlmMethod` | A different callee (function/method/constructor, or its receiver), or a call wrapper added/removed (`x → x.trim()`). |
| `LlmArgument` | A call's arguments, an array/object literal, or a parameter list changed: an element added, removed, reordered, or replaced outright; object‑key/shorthand changes. |
| `LlmProperty` | A member access changed: a different property name, or a property access added/removed (`a → a.b`). |
| `LlmIdentifier` | A bare identifier swapped for another (wrong variable), including a member's object or one identifier inside a non‑swapped ternary branch. |
| `LlmNumber` | A numeric/bigint literal changed or introduced in place of another expression. |
| `LlmString` | A string, template text or regex literal changed or introduced in place of another expression. |
| `LlmConstant` | `true`/`false`/`null`/`undefined` changed or introduced in place of another expression. |
| `LlmStatement` | A statement‑level change inside a function/arrow body (a statement added/removed, an assignment effect dropped, a declaration list changed). |
| `LlmOther` | Total fallback: a side that does not parse as an expression, a shape‑equal pair (a near‑equivalent that slipped the filters), or no rule applies (`typeof x → void x`). < 1 % on real data. |

Two proposals of the same kind on one span deliberately share a name (`> 0 → >= 1` and `> 0 → !== 0` are both `LlmComparison`); two of clearly different kinds never do.

**Directives.** `// Stryker disable next-line LlmComparison: reason` targets one kind. A plain **`llm` is a wildcard alias for every category**: on a dynamic‑LLM run the plugin wraps Stryker's directive bookkeeper so that every `// Stryker disable|restore [next-line] …` list naming `llm` (in any position, any case, with or without a `: reason`) is read **in memory** as if it also named the 16 category names — Stryker then does its own bookkeeping and reports those mutants as `Ignored` with your reason; the source and the printed output are never touched. `disable llm … restore llm` regions work, and a `restore LlmNumber` inside a `disable llm` region restores only that category. **`excludedMutations: ['llm']`** likewise is expanded to the category list before Stryker sees it, on BOTH the `withLlmMutators` path (in the returned config) and the `stryker-llm run` path (read from your config file, passed as an override). The `llm` name stays registered as a no‑op mutator so no "Unused directive" warning fires. The alias only exists on dynamic‑LLM runs; a heuristics‑only run is byte‑for‑byte today's behaviour.

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
| `heuristics.operators` | `[]` | `[]` = all 7 (P1–P4); else an allow‑list of operator names. |
| `heuristics.skipUncovered` | `true` | Deprioritize zero‑coverage spans where a coverage signal exists. |
| `dynamicLLM.enabled` | `false` | The targeted LLM pre‑pass + the injected `Llm<Category>` mutators. Costs money + needs credentials. |
| `dynamicLLM.frozen` | `false` | Cache‑only deterministic re‑score (a cache miss yields no mutant, no network) — the CI gate. |
| `dynamicLLM.budget.maxCostUsd` | `5` | **Hard** dollar abort, checked between calls. |
| `dynamicLLM.parallelBatches` | `1` | Number of Haiku requests issued concurrently per wave; >1 speeds cold runs (see caveats). |
| `provider` | `anthropic-agent-sdk` | LLM provider (only `anthropic-agent-sdk` + `mock` implemented today). |
| `model` | `haiku` | Model id or alias. |
| `cacheDir` | `.stryker-llm-cache` | Content‑addressed cache keyed by each function's structural fingerprint. Commit/restore it for warm, free CI runs. |

`haiku` follows Anthropic's current Haiku alias for fresh requests. The cache key records the requested alias, so existing cached responses remain reusable if that alias later resolves to a newer model snapshot; clear the cache or set a different explicit model when you want to force fresh responses.

### The response cache: fingerprint keys + monotone targeting

Each `propose()` call is cached under `SHA‑256(model, "fp:<fingerprint>|max:<candidate cap>", system prompt, schema)`, where **`<fingerprint>` is a canonical‑AST digest of the function** (`src/pipeline/fingerprint.ts`) rather than its verbatim text. The digest drops every positional and formatting artefact — comments anywhere (including `// Stryker disable …`), whitespace/indentation, literal spelling (`0xFF` vs `255`, `0x10n` vs `16n`, quote style, untagged template escapes), trailing commas, redundant parentheses — and keeps every identifier, literal **value**, operator and the tree shape (`(a + b) * c` ≠ `a + b * c`), plus the raw text of a **tagged** template (a tag can read `strings.raw`, so `String.raw`\n`` and a literal newline are different code). So a comment or reformatting edit is a cache **hit** (the same proposals, `$0`), while any behavioural edit is a miss. The model is also shown the comment‑stripped function text, so comments cannot steer the proposals; the stripper is semantics‑preserving (a comment that owns its line goes with the line, an inline one becomes a single newline if it held any line terminator — LF, CR, LS or PS — or a single space so tokens never fuse, and template/string contents are never touched). New entries carry a `meta` block (`fingerprint`, `fileName`, `functionName`) for provenance; older entries without it still read fine. A function slice that parses under none of the wrappers (rare — a probe over a real cache saw 0 in 1,107 functions) is keyed by a fallback text hash instead: comments removed by a string/template/regex‑aware scanner, space/tab runs collapsed, lines trimmed, but **newlines kept** (unparsed, `return\nx` must not merge with `return x`); every such fallback is reported in the pre‑pass log with the function's location.

A hit **replays the whole purchased mutant set** even though the source has been respelled: each cached candidate's `original` is first matched verbatim inside the current function and, whenever that yields no single node‑aligned occurrence — the text is gone, or it now also appears inside a comment (raw‑ambiguous), or its only verbatim copy *is* a comment — **by AST shape** (the same canonical form the fingerprint uses), so `a + 1` still finds `a+1`, `(a + 1)` or `a + /* c */ 1` after the edit, and the mutant is emitted with the **current** source text and range. The ambiguity safeguard is unchanged: an expression that now occurs twice as real code (verbatim or by shape) is dropped rather than guessed. The per‑function summary line counts the replays (`… dropped 0/3; recovered 2 by shape`) next to the drop buckets.

Targeting is **monotone** over that cache: every eligible function already cached is always re‑proposed (free, fast, never counted against `maxLlmCallsPerRun` or the diminishing‑returns window), and `topSpansPerFile` / `maxLlmCallsPerRun` bound only the **new** (paid) functions ranked by EV. The pre‑pass logs the split: `Gate1/2: N cached target(s) (free) + M new target(s) selected (cap K)`. The pre‑pass then **replays every cached function first**, outside every stopping rule, and only then walks the paid queue in EV order under the cost ceiling / call cap / diminishing‑returns stops — a paid stop can never skip a cached function that ranked below it. Net effect: the LLM mutant set grows run‑over‑run instead of drifting as EV ranks shuffle functions in and out of a fixed window.

**Upgrading from ≤ 1.2.1 (verbatim‑prompt keys):** existing entries would all miss under the new key. Migrate them offline (`$0`, no network) **before** the next unfrozen run:

```bash
bun scripts/migrate-cache-fingerprint.ts --project /path/to/project [--config stryker.config.json] [--mutate 'src/**/*.ts']... [--dry-run]
```

It rebuilds every legacy request from the project's sources (a frozen copy of the 1.2.1 prompt lives in the script), and for each function whose legacy entry exists and whose fingerprint entry does not, copies it under the new key with `meta` added; it prints `scanned / migrated / already present / missing`. A JS config that calls `withLlmMutators()` is deliberately **not** imported (that would run a live pre‑pass) — it is skipped with a note and the schema defaults apply; pass a `.json` config if your `llmMutator` block overrides `model`, `cacheDir` or `budget.maxCandidatesPerFile`. Legacy files are left in place. Only functions whose source is unchanged since their entry was bought can match — exactly the set that would have hit anyway.

**Upgrading from ≤ 1.2.3 (single `llm` name):** the proposal cache is unaffected (its key is unchanged), and every existing `// Stryker disable … llm` directive keeps working through the alias. What changes is Stryker's **incremental report**: its mutant identity includes `mutatorName`, so every existing `llm` row in `reports/stryker-incremental.json` would re‑execute once (isambard: ~3,900 rows, roughly a tenth of a full run). To keep those verdicts, run the offline, name‑only migration — **only when no Stryker run is writing that file**:

```bash
bun scripts/migrate-incremental-llm-names.ts --in reports/stryker-incremental.json [--dry-run]
```

It re‑derives each `llm` row's live name from the report's own `source` slice + `replacement`, writes a SEPARATE `reports/stryker-incremental.llm-migrated.json` (it refuses to write in place), and prints per‑category counts; you then copy that file over the original yourself. Rows it skips (an unparseable slice, an ambiguous shorthand‑object expansion) keep `llm` and simply re‑run once. It is sound by construction: the differ still performs its full source and test checks, and a wrong name is only ever a miss, never a false verdict.

**On `dynamicLLM.parallelBatches`.** Default `1` is the original strictly sequential pre‑pass. Raising it slices the EV‑ranked targets into consecutive waves of that size and fires a whole wave of Haiku `propose()` calls at once, which overlaps the model round‑trips and speeds up **cold** (cache‑miss) runs. Honest, bounded tradeoffs: the hard `maxCostUsd`/`maxLlmCallsPerRun` ceilings can **overshoot by up to `parallelBatches − 1` calls** (that many may be in flight when a ceiling trips — they're only checked between calls), the diminishing‑returns stop is evaluated **per wave** so it may run up to `parallelBatches − 1` calls past the sequential stop point, and very high values may hit the provider's **API rate limits**. There is no hard maximum — pick a value your quota tolerates.

The 7 heuristic operators (allow-list names for `heuristics.operators`): **P1** `NumberLiteralValue`; **P2** `CallArgumentTweak`, `AwaitDrop`; **P3** `SpreadOperandDrop`, `ArrayMethodSwap`, `PromiseCombinatorSwap`; **P4** `StringMethodArgSwap`. `CallArgumentTweak` swaps the two distinct positional bounds of exactly-two-argument plain `.slice(a, b)` calls. `ArrayMethodSwap` is limited to non-empty `push`↔`unshift` calls. `PromiseCombinatorSwap` applies only to an unshadowed global `Promise` call used as a whole discarded `await` statement. It skips known-empty `Promise.all` calls and suppresses only the equivalent `all`↔`race` swap for known singleton arrays; rejection-changing singleton swaps remain. Mutants rejected by compilation are excluded as invalid and do not count as test kills.

Live proof
----------

Proven end‑to‑end against [isambard](https://github.com/hughescr/) — 249 src `.ts` files, **100% mutation score under vanilla Stryker**, so the bar is finding behavior changes the suite cannot kill that the 16 built‑ins cannot even express:

- **Heuristics only:** **7 real survivors** the 100%‑suite missed (e.g. in `src/utils/time.ts`), network‑free, **$0**, no credentials.
- **Dynamic‑LLM:** **29 node‑aligned `llm` mutants** scored by stock Stryker, **2 survivors**, total cost **$0.31** (well under the default $5 ceiling). A warm re‑run is cache‑stable and free.

Limitations (read before adopting)
----------------------------------

1. **Version‑coupling to Stryker internals — two monkeypatches.** The injection deep‑imports the instrumenter's internal `allMutators` array (past Stryker's `exports` map), and the legacy‑`llm` directive alias wraps `DirectiveBookkeeper.prototype.processStrykerDirectives` from the same internal tree — both unsupported and fragile across versions. A Stryker upgrade can break either, **possibly silently**: you'd get a clean run with *none* of our mutants, or (for the alias) plain `llm` directives that stop suppressing `Llm*` mutants — the alias installer logs a loud `WARNING` in that case, and `Llm<Category>` / `all` directives keep working natively. Both are guarded by a per‑version smoke test (`bun run canary`, pinned to 9.6.1) — run it before bumping Stryker.
2. **The blended score is NOT comparable** to a vanilla Stryker mutation score (it includes our injected mutants). Use the `llm-mutator` reporter's tagged survivor view for the per‑tool signal; never present the blended number as your project's "real" mutation score.
3. **Equivalent re‑surfacing.** Pre‑existing `// Stryker disable <BuiltInName>` comments do **not** cover our differently‑named mutants (ours are bare PascalCase / `Llm<Category>`), so a span vetted‑and‑disabled for a built‑in can re‑surface as a survivor under our operator — needing human audit. Going forward, `// Stryker disable next-line all`, `// Stryker disable next-line <OurName>` / `Llm<Category>`, or the `llm` wildcard does suppress ours, via Stryker's own bookkeeper (see [LLM mutant categories](#llm-mutant-categories)).
4. **Cold‑run LLM non‑determinism + real cost.** LLM proposals vary run‑to‑run on cache **misses**, which changes which LLM mutants exist, and dynamic‑LLM makes live, billed API calls. Heuristics are fully deterministic and free. For a deterministic, free CI gate use `dynamicLLM.frozen: true` (or `--frozen`) with a committed/restored `cacheDir`; spend is bounded by `dynamicLLM.budget.maxCostUsd` (default $5, a hard abort).
5. **Unofficial monkeypatch.** Stryker does not sanction this. If the tradeoffs above are unacceptable, heuristics‑only mode (the default) still gives you the extra mutants with zero LLM spend, no credentials, and no network.

LLM provider plan
-----------------

The plugin codes against a single `LLMProvider` abstraction ("given a prompt and a JSON schema, return a validated object"), so the backend is pluggable. The first implemented provider is the Anthropic **Agent SDK** subscription path (`@anthropic-ai/claude-agent-sdk`, default model alias `haiku`, auth `CLAUDE_CODE_OAUTH_TOKEN`). A raw per‑user Anthropic **API‑key** path and OpenAI(‑compatible) providers implement the same interface and are planned (they currently throw `NotImplementedError`). Offline tests never touch the network — they inject a mock provider returning canned schema‑valid objects. See [docs/development-plan.md](./docs/development-plan.md) §4.1 / §6.

In production, the Agent SDK provider uses the SDK's multi-turn **`json_schema` structured-output mode** and disables extended thinking. The SDK receives the caller's exact schema as `outputFormat`, validates the emitted object, and can re-prompt on mismatch; disabling extended thinking avoids unnecessary reasoning latency for the mechanical propose task. Prompt-and-parse remains an internal benchmark option rather than the production default.

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
