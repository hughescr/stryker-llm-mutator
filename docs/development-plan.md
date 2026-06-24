# Development Plan — `@hughescr/stryker-llm-mutator`

> Status: committed direction. This document supersedes the open-ended "design
> direction" prose in `README.md` and turns the design-analysis memo into a
> concrete, phased build plan. It is the source of truth for the seam and the
> provider interface, and is written to guide a multi-agent implementation
> workflow.

## 1. Purpose & scope

This project builds an **LLM-driven mutation generator for Stryker v9** that
produces a wider, more semantically interesting variety of mutants than
Stryker's 17 built-in formulaic operators. The literature reports that
context-dependent, real-bug-like LLM mutants deliver materially higher
fault-detection power (≈90–111% over built-ins); capturing that lift is the
point.

**Committed direction:** build the **runtime-LLM mutation pipeline** (the memo's
*Approach 2*) **first**, and treat that work as the test bed for the
infrastructure a runtime-LLM approach needs anyway — the out-of-band Stryker
seam, the LLM provider abstraction, the deterministic filters, and the
reporting. Discovering *formulaic* operators at design time and contributing
them upstream to StrykerJS (the memo's *Approach 1*) remains a **possible
side-benefit**, pursued only opportunistically when the runtime work happens to
surface a clean, table-drivable operator — it is **not** the current priority.

Out of scope for now: a from-scratch fork of Stryker's instrumenter; any
shipped reliance on the Anthropic subscription/OAuth path (dev-only — see §7);
treating stage-3 as a default or as an equivalence oracle.

## 2. Background — the two approaches

The design-analysis memo evaluated two ways to get LLM signal into Stryker.

- **Approach 1 — design-time operator discovery.** Run an offline LLM pass *now,
  author-side*, over a corpus of real bug-fix diffs to generalize recurring
  *formulaic* transforms into deterministic `NodeMutator` specs; humans review;
  accepted specs ship as plain compiled TypeScript with **zero runtime LLM
  calls**. Cheap, deterministic, zero per-user credential/ToS exposure, and its
  output is upstream-PR-shaped. But the memo is explicit that its **ceiling is
  "a better fixed-operator tool"**: the literature's advantage comes from
  context-dependent mutants that are *by definition* not reducible to a fixed
  replacement table, so distilling into static rules keeps only the formulaic
  residue. Net-new yield could be near zero without a hard novelty gate.

- **Approach 2 — runtime Haiku pipeline.** A pre-pass before instrumentation in
  three stages (risk targeting → propose → confirm-wrongness) that feeds vetted
  LLM replacements through Stryker's own instrumentation machinery, scored by
  the unmodified run/report pipeline. This is **where the literature's
  fault-detection advantage lives**, at the cost of runtime LLM spend, an
  adoption-tax credential requirement, and run-to-run non-reproducibility.

**Why Approach 2 is the chosen path:** the user's goal is the high-fault-detection
LLM mutation capability and the infrastructure it requires. Approach 1's best
honest outcome (per the memo) is often to *upstream the good operators and ship
no plugin at all* — valuable, but a side quest relative to this project's goal.
We therefore commit to Approach 2 and reuse Approach-1-style design-time work
only opportunistically.

## 3. The integration seam (make-or-break)

This is the section everything else depends on. Get it wrong and nothing
downstream works.

### 3.1 A mutant is two coupled artifacts

A working Stryker mutant is **two artifacts that must stay consistent**:

1. **Switch-embedded source** — the mutated location wrapped as
   `stryMutAct_9fa48(id) ? mutated : original`, activated at runtime when
   `global.__stryker__.activeMutant === id` (set via the
   `__STRYKER_ACTIVE_MUTANT__` env var the runner injects).
2. **A matching `Mutant` record** in `instrumentResult.mutants`
   (`{ id, fileName, replacement, location, mutatorName, … }`).

If a mutant record exists but the source never received the switch, the mutant
**never executes** — it silently does nothing. This coupling is the whole game,
and any seam we choose must produce *both* artifacts in lockstep.

### 3.2 The refuted route — do NOT use `instrumenterTokens.transform` DI injection

> **Settled: do not attempt this. The memo proved it does not work against the
> installed v9.6.1 source.**

The tempting "supported DI seam" is to pre-provide a custom Babel `transform`
value via `instrumenterTokens.transform` so Stryker's own instrumenter uses our
mutator. **This override is silently discarded at runtime.** In
`create-instrumenter.js`, `createInstrumenter` *unconditionally* does
`.provideValue(instrumenterTokens.transform, transform).injectClass(Instrumenter)`,
and `MutantInstrumenterExecutor` resolves the instrumenter via
`injector.injectFunction(createInstrumenter)` — so `createInstrumenter` runs
**last and overwrites** any transform we injected. Two further blockers even if
the override took: `transformer.js` calls `transformBabel(ast, mutantCollector,
context)` with **no `mutators` argument** (the `mutators = allMutators` param is
unreachable), and the `collect`/`registerInPlacementMap` machinery lives
**inside `transformBabel`'s closure**, not exposed. Nobody on this project
should spend time on this path; it is a dead end confirmed against installed
code.

### 3.3 The chosen route — out-of-band `instrument()` + public `TestRunner`

We use the **durable out-of-band seam** the memo identified (Design B's
"fallback architecture", which the memo promotes to *primary*):

1. **Construct the instrumenter ourselves** — call
   `createInstrumenter().instrument(files, options)` directly. Because *we*
   construct it, we control its inputs, sidestepping the override problem
   entirely. Express our LLM-vetted replacements as inputs to that call so each
   becomes a collected mutant: Stryker's own collector + placers emit the
   `stryMutAct_9fa48(id) ? mutant : original` switch **and** the matching
   `Mutant` record in one pass — keeping the two artifacts provably consistent
   for free, reusing Stryker's parser, placers, syntax-helper header, and code
   printer.
2. **Execute via the public contract** — drive execution through
   `@stryker-mutator/api`'s public `TestRunner` contract together with the
   existing **`@hughescr/stryker-bun-runner`** (already a devDependency; Stryker
   has no built-in Bun runner). Activate each mutant via
   `__STRYKER_ACTIVE_MUTANT__=<id>` exactly as Stryker does.
3. **Report** — emit results through the standard mutation-testing report
   schema; LLM mutants carry a distinct `mutatorName` so they are
   distinguishable from built-ins.

This touches only the public-ish `instrument()` entry point and the **public**
`TestRunner` contract — no internal DI tokens, no module-binding interception,
no fork.

### 3.4 Residual coupling (honest)

`instrument()` still lives in `@stryker-mutator/instrumenter` and we pin to
v9.6.1. A Stryker bump can change `instrument()`'s shape, and **the failure mode
is silent** — mutants just stop appearing, with no loud error. Mitigation
(§7): a pinned version range plus a CI smoke test asserting a known mutant
appears as **both** a switch in emitted source **and** a record in the manifest,
run against every supported Stryker version.

### 3.5 Implementation note — the seam drives instrumenter internals (ADR)

§3.3 step 1's prose says "call `createInstrumenter().instrument(files, options)`
directly." The shipped Phase-0 seam meets that route's GOALS (§3.2: out-of-band,
both artifacts in lockstep, no DI-override) but reaches **one level below** that
public-ish entry point, for two forcing reasons:

- **Deterministic mutant ids.** `instrument()` does not expose the
  `MutantCollector` whose sequential numeric ids we must override with our
  content-addressed ids (so the SAME id appears in the switch, the manifest, and
  the `__STRYKER_ACTIVE_MUTANT__` activation). We therefore drive
  `transformBabel` with a subclassed `MutantCollector`, plus `createParser` and
  `print`, directly.
- **Bun/Node `@babel/generator` interop.** Stryker's instrumenter relies on
  Node's CJS/ESM default-interop for `@babel/generator`; Bun unwraps it
  differently, so the instrumentation step runs in a short-lived Node
  subprocess (`src/seam/instrument-worker.mjs`).

Because `@stryker-mutator/instrumenter`'s `exports` map only exposes its barrel
(which omits these lower-level helpers), the worker imports them via deep
`node_modules/@stryker-mutator/instrumenter/dist/src/...` file paths.

**Pinned-version smoke-test surface (§7).** This widens the §3.4 silent-break
surface beyond `instrument()` + the public `TestRunner`. The §7 pinned-version
smoke test MUST therefore also assert that these internals still resolve and
behave, so a Stryker bump that moves or renames them fails loudly rather than
silently dropping mutants:

- `transformBabel` — `dist/src/transformers/babel-transformer.js`
- `MutantCollector` — `dist/src/transformers/mutant-collector.js`
- `createParser` — `dist/src/parsers/index.js`
- `print` — `dist/src/printers/index.js`

`@babel/core`, `@babel/parser`, and `@stryker-mutator/instrumenter` are declared
as **direct** dependencies (pinned, the instrumenter to 9.6.1 matching the api
pin) so this coupling never depends on a transitive hoist.

## 4. Architecture

Four major components, each with a clear responsibility and a prose-level
interface contract.

### 4.1 LLM provider abstraction (+ first Anthropic Agent SDK provider)

**Responsibility:** hide *how* a model is reached behind a single, high-level
operation.

**Interface (prose):** the abstraction exposes essentially one method —
*"given a prompt and a JSON schema, return a validated object conforming to that
schema."* It deliberately says nothing about transport, auth, or whether the
backend is agentic or one-shot. Callers (the pipeline stages) only ever see
validated structured output.

**Critical structural implication:** the **first** provider is the Anthropic
**subscription path via the Agent SDK** (`@anthropic-ai/claude-agent-sdk`),
driving **`claude-haiku-4-5`**, authenticated with `CLAUDE_CODE_OAUTH_TOKEN`.
The Agent SDK is **agentic** — it runs an internal tool/loop, not necessarily a
single request→response round-trip. Therefore the abstraction **must not assume
a single round-trip**: its contract is "prompt + schema in, validated object
out," and the implementation may take multiple internal turns to get there.
Structured output is obtained via the SDK's JSON-schema output mode, which
re-prompts on mismatch and surfaces a terminal error if it cannot satisfy the
schema.

**Mockability constraint (working note):** the provider must be trivially
mockable. Offline unit tests inject a fake provider that returns canned
schema-valid objects and never touches the network (see §5 network note).

Later providers (raw Anthropic API key, OpenAI, OpenAI-compatible) implement the
*same* interface — see §6.

### 4.2 Stryker out-of-band seam / runner

**Responsibility:** turn a set of vetted `{ fileName, range, replacement }`
entries into scored mutation results, using §3.3.

**Interface (prose):** accepts the file set to mutate and the vetted replacement
table; calls `createInstrumenter().instrument()` to produce switch-embedded
source + mutant manifest; hands both to a thin runner built on the public
`TestRunner` contract + `@hughescr/stryker-bun-runner`; returns
killed/survived/timeout per mutant plus the manifest. Mutant IDs are
**deterministic**, derived from a hash of `{ fileName, range, replacement }`, so
a given proposal yields a stable ID across runs (a prerequisite for the cache in
§7). Grafting uses **precise 1-indexed Babel positions**, never string search,
to avoid scope-breaking import-time errors that masquerade as "killed."

### 4.3 The three-stage pipeline

A pre-pass that runs **before** the seam, producing the vetted replacement table.

| Stage | Name | LLM? | Responsibility |
|---|---|---|---|
| **1** | Risk targeting | No | Deterministic per-span score = branch count + nesting depth + coverage gap + off-by-one-prone constructs (indexing/slice/boundary literals). Keep top-N spans/file under a budget cap. |
| **2** | Propose | Yes (batched per file) | Send function source + targeted span + JSON schema; receive `{ location, original, replacement, mutatorTag, rationale }`. Then **cheap deterministic filters, no LLM:** parse-check (kills the ~36% non-compile tax), reject `replacement === original`, dedup, optional TCE-style minify-and-compare to drop provably-equivalent. |
| **3** | Confirm-wrongness | Yes (opt-in) | LLM proposes a concrete distinguishing input + predicted differing output; execute baseline-fn vs mutant-fn on it in a Bun subprocess; **keep only if observed outputs differ.** |

**Stage-3 is a non-equivalence CONFIRMER, never an equivalence ORACLE.** Per the
memo it is sound but **narrow**: ground-truth correct only for **pure,
standalone-importable functions**; it abstains or wrongly-drops on stateful /
business-logic code — which is precisely the value subset. Therefore stage-3 is
planned as:

- **`off` by default** (config `stage3: 'confirm' | 'off'`),
- **scoped to pure standalone-importable functions** when enabled,
- **confirm-only — never asserts equivalence**,
- **every drop logged** for human audit.

This keeps recall-vs-precision a user choice and never silently throws away a
test-suite hole without a record.

### 4.4 Config + reporting

**Responsibility:** validated user config and honest reporting.

**Interface (prose):** a schema-validated (`zod` or equivalent) `llmMutator`
options block in `stryker.conf.*` — model, provider, budget caps, `stage3` mode,
cache location. Reporting **tags LLM mutants distinctly**, emits a **separate
LLM mutation-score line** (LLM mutants are *additive signal*, not a score
replacement), and **surfaces `total_cost_usd`** per run from the provider
payload.

## 5. Phased milestones

Ordered, incremental, each phase independently testable/shippable. DAG ordering
(`→` sequential, `||` parallelizable). The **network** column marks phases that
require a **live LLM call** — those smoke tests must be run by the
**human / main thread**, because background/headless agents in this environment
cannot clear the network sandbox prompt (see working note below). Everything
else is **offline-testable** with the mocked provider.

> **Working note — network in this environment.** Background/headless agents
> cannot make live network calls here (sandbox approval only resolves in the
> main thread). So: (a) every live LLM/network smoke test is **human-run** in
> the main thread; (b) the LLM provider MUST be mockable; (c) offline unit tests
> MUST NOT hit the network. Structure all code so the network lives behind the
> provider seam only.

| Phase | Work | Network? | Gate / output |
|---|---|---|---|
| **0 — Seam proof** | One **hardcoded** mutant via out-of-band `createInstrumenter().instrument()` + public `TestRunner` + bun-runner, scored on a tiny fixture. CI smoke test: switch-in-source **and** record-in-manifest. | Offline | Mutant appears killed/survived in the standard report → seam is real. **If this fails, stop and reassess** — the whole runtime half is in question. |
| **1 — LLM client** | Implement the provider abstraction (§4.1) + the Anthropic Agent SDK / subscription provider (`claude-haiku-4-5`, `CLAUDE_CODE_OAUTH_TOKEN`). Schema-validated structured output, content-addressed cache, cost logging. Mockable by construction. | **Live (human)** for the real-call smoke test; offline for all unit tests (mock provider) | A prompt+schema returns a validated object; cache + cost logging work. |
| **2 — Stage-2 vertical slice** | Feed a hand-picked function → schema-valid replacements → Phase-0 seam → real LLM mutants scored by the runner. No risk targeting, no stage-3 yet. | **Live (human)** end-to-end; offline with mock | **First shippable vertical slice:** real LLM mutants appear in the report. |
| **3 — Deterministic filters** | `||` Parse-check, `replacement === original` reject, dedup, optional TCE-minify equivalence drop — all **no LLM**. | Offline | Measurably cuts the non-compile/duplicate tax before more LLM spend. |
| **4 — Stage-1 risk targeting** | `||` Branch/nesting/coverage-gap scoring + budget caps to pick spans, replacing hand-picked functions. **No LLM.** | Offline | Spans chosen automatically under budget. |
| **5 — Stage-3 confirmer** | LLM distinguishing-input generation + baseline-vs-mutant Bun execution harness; keep-only-on-observed-difference; k-retry; drop-and-log. **`off` by default, pure-fn scope, confirm-only.** | **Live (human)** for confirm runs; offline harness logic testable with mock | Config-gated `confirm|off`; drops are logged. |
| **6 — Reporting / polish** | Tag LLM mutants, separate LLM-score line, `total_cost_usd` surfacing, `zod` config schema, docs, self-mutation in CI. | Offline | Clean, documented, configurable output. |
| **7 — Resilience / fallback** | Provider fallback (subscription → API-key), graceful degradation, and the seam smoke test wired per supported Stryker version so an upgrade break is loud, not silent. | Offline | Upgrade/auth breakage degrades gracefully instead of bricking. |

Phases 3 and 4 are independent of each other and of the live-network phases, so
they can proceed in parallel against the mock provider while the human runs the
live smoke tests for 1/2/5.

## 6. Provider roadmap

All providers sit behind the single abstraction in §4.1 — "prompt + schema in,
validated object out." Order of implementation:

1. **Anthropic subscription via Agent SDK (FIRST).**
   `@anthropic-ai/claude-agent-sdk`, `claude-haiku-4-5`, authed with
   `CLAUDE_CODE_OAUTH_TOKEN`. Agentic (multi-turn-capable). Dev/author use —
   see the ToS caveat in §7.
2. **Raw Anthropic API key.** Straight one-shot completion with a per-user
   `ANTHROPIC_API_KEY`. **This is the sanctioned shippable default** for other
   users.
3. **OpenAI.** One-shot completion, OpenAI key.
4. **OpenAI-compatible third parties.** Same one-shot interface, configurable
   base URL.

The abstraction hides whether a provider is **agentic** (1) or a **straight
one-shot** (2–4); callers never branch on it. Requiring a per-user
`ANTHROPIC_API_KEY` (or other provider key) for shipped use is an accepted
adoption tax.

## 7. Risks & caveats

- **Seam coupling to Stryker internals (silent break on upgrade).** The
  out-of-band `instrument()` seam pins to v9.6.1; a Stryker bump can silently
  stop producing mutants. **Mitigation:** pinned version range + a CI smoke test
  asserting a known mutant appears as both a source switch and a manifest record,
  run per supported Stryker version. Treat as an ongoing maintenance liability,
  not a one-time cost.

- **Subscription / OAuth ToS & quota caveat (recorded, not relitigated).** The
  memo flags the Anthropic subscription path (`CLAUDE_CODE_OAUTH_TOKEN`) as
  likely **ToS-problematic for a shipped multi-user tool**, individual-use,
  single shared quota (rate-limits at mutation-testing scale), no Batch API, no
  native concurrency, no temperature pinning, with billing rules in flux. The
  user has chosen to make the subscription path work **first anyway** — that is
  fine for author/dev use. **The per-user `ANTHROPIC_API_KEY` path remains the
  sanctioned shippable default for everyone else.** Operational note: the API
  key outranks the OAuth token, and `--bare` mode ignores the OAuth token — the
  subscription provider must account for both.

- **Stage-3 false-DROP risk.** If the LLM fails to guess a differentiating input
  in *k* tries, a genuinely-buggy mutant is silently discarded — exactly the
  test-suite hole the tool exists to find. The FP rate of this specific gate is
  unmeasured in the literature. Also, scope-breaking replacements can error at
  import and register as "killed" — false coverage. **Mitigation:** stage-3
  `off` by default, pure-standalone-function scope, confirm-only, every drop
  logged; precise Babel positions; reject replacements whose function fails to
  compile/import.

- **Non-reproducibility of LLM mutation scores.** No temperature control +
  agentic nondeterminism → scores vary run-to-run, a real CI-gate adoption
  blocker. **Mitigation:** content-addressed cache (key =
  SHA(model + prompt + file content + span)) and **deterministic mutant IDs**
  from `{ fileName, range, replacement }`, so warm runs are stable. Document
  plainly that a **cold** run on a changed span may differ.

- **Cost shape.** Stage-2 proposal is modest (LLMorpheus ≈ $3.62 across 13 apps;
  Haiku is comparable order). The **cost bomb is stage-3**: per surviving
  candidate, a distinguishing-input call + up-to-*k* retries + a Bun subprocess
  spawn per input — hundreds-to-thousands of agent-loop subprocesses on a large
  repo. **Mitigation:** budget caps at every stage, batch stage-2 per file,
  cache aggressively, run stage-3 only on filter survivors, keep it opt-in.

## 8. Open questions for the user

Only genuine, still-open decisions remain (priority, seam, provider order,
stage-3 posture, and the subscription-first caveat are all **settled** above):

1. **Budget caps / defaults.** What concrete default caps (top-N spans/file, max
   candidates/file, stage-3 retry `k`, monthly cost ceiling) should ship?
2. **Reproducibility tolerance for CI.** Is a warm-cache-stable but cold-run-
   variable mutation score acceptable as a CI gate, or do we need a "frozen
   mutant set" mode that refuses to propose new mutants on cold paths?
3. **Stage-3 usefulness bar.** Given stage-3 only reliably fires on pure
   standalone functions, is building it worth it now, or should it wait until
   stages 1–2 plus deterministic filters are proven in real use?
4. **Cache invalidation policy.** Should the content-addressed cache invalidate
   on model version bumps automatically (model id is already in the key), and
   should there be a committed/shared cache or a per-developer one?
5. **Opportunistic Approach-1 upstreaming.** When the runtime work surfaces a
   clean formulaic operator, do we want a lightweight path to package it as a
   StrykerJS upstream PR, or simply note it and move on?
