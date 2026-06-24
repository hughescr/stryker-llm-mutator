# Functional Architecture & Build Plan — stryker-llm-mutator

> The blueprint the implementation workflows follow. This revision adopts the
> **monkeypatch-injection** architecture, which SUPERSEDES the prior
> "roll-our-own runner" / "executor-substitution" approaches: we inject our
> mutators into Stryker's own internal registry and run **stock Stryker**
> end-to-end. Companion to `docs/development-plan.md` (the design rationale);
> this is the *what-to-build-next*, ordered.

---

## 1. Bottom line

To be **genuinely functional against isambard** (249 src `.ts` / 258 test files,
100% mutation score under vanilla Stryker, so the bar is *finding behavior
changes the test suite cannot kill that the 16 built-in operators cannot even
express*) we no longer need to build a runner, a sandbox, or a coverage planner.
**Stryker already has all of that.** The single load-bearing realization is that
Stryker's instrumenter reads its mutator set from a **mutable, non-frozen
module-level array** (`allMutators`) **by reference**, so we can **push our own
`NodeMutator`s into it and then run stock `new Stryker(...).runMutationTest()` in
the same process** — and Stryker will instrument with our mutators and drive its
entire pipeline (sandbox, perTest coverage scoping, concurrency, checkers,
incremental, every reporter) over them, for free.

That collapses the project to four things in dependency order: a tiny
**injection seam** (push mutators into `allMutators`, then invoke Stryker); a
**heuristics engine** of formulaic operators authored directly as Stryker
`NodeMutator`s (zero LLM spend or credentials); an **efficient targeted
dynamic-LLM pre-pass** that precomputes replacements so a single injected
`LLMMutator` can serve them synchronously; and a **thin driver/CLI**
(`stryker-llm run [dir]`) that reads the target's `llmMutator` config, gates the
two pipelines, optionally runs the LLM pre-pass, pushes the mutators, and calls
Stryker. Reporting and survivor-surfacing layer on top of Stryker's standard
report. The cheapest proof of value — author **one** real heuristic
`NodeMutator`, push it, run **stock `stryker run`** on a single isambard file,
and confirm our mutant shows up in Stryker's normal report as killed/survived —
costs ~$0 and a few minutes, and **must be the first milestone**.

---

## 2. Target architecture

```
                          stryker-llm  (bin/CLI)
                                 │
          ┌──────────────────────┴───────────────────────┐
          │ DRIVER  (src/driver/*)                        │
          │  • read target stryker.conf llmMutator block  │
          │  • parse the two switches via zod schema      │
          │  • gate pipelines on heuristics / dynamicLLM  │
          └──────────────────────┬───────────────────────┘
                                 │
            ┌─────────────────────┼─────────────────────┐
            │                     │                     │
   ┌────────▼────────┐   ┌────────▼────────┐            │
   │ HEURISTICS      │   │ DYNAMIC-LLM     │            │
   │ engine          │   │ PRE-PASS        │            │
   │ (default ON)    │   │ (default OFF)   │            │
   │                 │   │                 │            │
   │ authored as     │   │ target → batch  │◄── provider (Haiku, cache, cost)
   │ Stryker         │   │  Haiku propose  │            │
   │ NodeMutator[]   │   │ → filters →     │            │
   │ (formulaic)     │   │ precomputed map │            │
   │                 │   │ (file,loc)→Node │            │
   └────────┬────────┘   └────────┬────────┘            │
            │  NodeMutator[]      │  ONE LLMMutator      │
            │                     │  (sync lookup in     │
            │                     │   precomputed map)   │
            └──────────┬──────────┘                      │
                       │  push into allMutators          │
            ┌──────────▼──────────────────────────────┐  │
            │ INJECTION SEAM  (src/seam/inject)        │  │
            │  deep-import allMutators (relative path)  │  │
            │  allMutators.length = 0   (ours-only) OR │  │
            │  allMutators.push(...ours) (augment)     │  │
            └──────────┬──────────────────────────────┘  │
                       │  in-process, same module graph   │
            ┌──────────▼──────────────────────────────┐  │
            │ STOCK STRYKER (unmodified)               │  │
            │  new Stryker(cliOptions)                 │  │
            │    .runMutationTest()                    │  │
            │  → instrument (reads allMutators) →      │  │
            │    sandbox → dry-run perTest coverage →  │  │
            │    checkers → mutantRun (concurrency) →  │  │
            │    incremental → ALL reporters           │  │
            └──────────┬──────────────────────────────┘  │
                       │  MutantResult[] in standard report
            ┌──────────▼──────────────────────────────┐  │
            │ REPORTER  (src/report/*)                 │◄─┘ cost snapshot
            │  • standard mutation-testing report      │
            │    already contains our mutants          │
            │  • OUR survivor view + cost summary,      │
            │    tagged distinctly (heuristic/* , llm/*)│
            └──────────────────────────────────────────┘
```

**Component responsibilities**

| Component | New? | Owns |
|---|---|---|
| Driver/CLI (`src/driver/`, `bin`) | NEW | read target config, switch gating, optional LLM pre-pass, push mutators, invoke `Stryker` in-process |
| Heuristics engine (`src/heuristics/`) | NEW | formulaic operators authored directly as Stryker `NodeMutator`s, default ON |
| Dynamic-LLM pre-pass (`src/pipeline/`) | EXTEND | stage-1 targeting (NEW), batched propose (exists), filters (exists), build precomputed `(fileName,loc)→Node[]` map (NEW), budget/stop enforcement (NEW) |
| `LLMMutator` (`src/heuristics/` or `src/pipeline/`) | NEW | ONE injected `NodeMutator` doing a synchronous lookup in the precomputed map and yielding precomputed replacement nodes |
| Injection seam (`src/seam/inject*`) | NEW (replaces runner.ts) | deep-import `allMutators`, clear-or-augment, push our mutators; smoke-assert the array is still mutable |
| Provider (`src/llm/`) | EXTEND | Haiku call, cache wrap, cost accumulate, mid-run ceiling check (NEW) |
| Config (`src/config.ts`) | EXTEND | add `heuristics` + `dynamicLLM` blocks + `maxCostUsd` |
| Reporter (`src/report/`) | NEW | our survivor view + cost summary on top of Stryker's standard report |

**The seam's old job is gone.** The Phase-0 out-of-band `instrument()` worker
(`src/seam/instrument-worker.mjs`) and the proof-grade `runner.ts` were built to
drive instrumentation and scoring **ourselves**, out of band. Under
monkeypatch-injection, **Stryker does both in its own process**, so neither is on
the critical path. We keep ONE high-value piece of the old seam — the
**replacement-string → AST-node parsing** logic (`parseFragment` in
`instrument-worker.mjs`) — and REUSE it in the LLM pre-pass to pre-parse each
LLM replacement into the node the injected `LLMMutator` yields. (The old seam
also remains a documented contingency; see §3.)

**Key invariants that hold the architecture together**

- **`allMutators` is shared by reference.** `babel-transformer.js` imports
  `allMutators` from `../mutators/index.js` (an ESM re-export barrel whose
  `export * from './mutate.js'` re-exports the array) and declares
  `transformBabel = (..., mutators = allMutators, ...)` — the built-in array is the
  *default parameter*, read by reference at call time. Our injection seam (and the
  canary) DEEP-IMPORT `mutate.js` directly; ESM module-instance caching guarantees
  `mutators/index.js`'s re-export and our direct deep-import resolve to the SAME
  array object, so a `push` on the array we hold is seen by `transformBabel`.
  (The per-version canary asserts this behaviorally: push → transform → see our
  mutant.) Stryker's own `transformer.js` calls `transformBabel(...)` with no
  `mutators` argument, so it picks up whatever `allMutators` currently contains.
  Mutating the array in place (push, or clear-then-push) before Stryker instruments
  changes what Stryker instruments. We never replace the binding; we mutate the
  array object.
- **Same process, same module instance.** The push and the
  `new Stryker(...).runMutationTest()` call MUST happen in the **same Node
  process** so they share one `@stryker-mutator/instrumenter` module instance
  (and therefore one `allMutators` array). Instrumentation runs **in-process** in
  the main Stryker process (`MutantInstrumenterExecutor.execute()`:
  `this.injector.injectFunction(createInstrumenter); instrumenter.instrument(...)`),
  so the array our driver mutated is the array the executor reads.
- **One mutant identity = Stryker's identity.** We no longer compute our own
  mutant ids or manifest. Stryker's collector assigns ids and emits the standard
  report; our mutators only supply `{ name, mutate }`. Distinctness comes from the
  mutator `name`, which flows into the report's `mutatorName`. SHIPPED NAMES are
  bare PascalCase per operator (`NumberLiteralValue`, `BoundaryOffByOne`,
  `ComparisonBoundaryShift`, … the full §5 catalog) and the single name `llm` for
  the dynamic-LLM mutator — NOT the `heuristic/<op>` / `llm/<tag>` forms some older
  diagrams below still show (the per-candidate `llm/<tag>` tag lives only inside the
  filtered report artifact, §6). Distinctness from the 16 built-ins holds because
  none of our names collide with a built-in name.
- **The LLM `mutate()` is synchronous.** Stryker's `NodeMutator.mutate(path)`
  returns a *synchronous* `Iterable<types.Node>`. There is no place to await an
  LLM call inside it. All LLM work happens in an **async pre-pass** before the
  push; the injected `LLMMutator.mutate(path)` only does a sync map lookup keyed
  by `(fileName, node-location)` and yields the precomputed nodes.

---

## 3. The injection decision — DECISIVE: monkeypatch `allMutators`, run stock Stryker

**Decision: inject our custom mutators into Stryker's own internal mutator
registry (`allMutators`) and run STOCK Stryker. Do NOT build our own runner,
sandbox, coverage planner, or executor chain. The prior "roll-our-own runner"
(Option B) and the "executor-substitution" idea are BOTH CUT.**

This is **verified feasible against installed v9.6.1 code** and is **not** a
repeat of the dead `instrumenterTokens.transform` DI route (which
`createInstrumenter()` overwrites at construction — `development-plan §3.2`). The
mechanism is simpler and reaches Stryker at an earlier, more durable point: the
mutator catalog itself.

### 3.1 The verified mechanism

1. **`allMutators` is a mutable, non-frozen array.**
   `@stryker-mutator/instrumenter`'s `dist/src/mutators/mutate.js` declares
   `export const allMutators = [ ... ]` — 16 built-in mutators. Verified at
   runtime: `Array.isArray(allMutators) === true`,
   `Object.isFrozen(allMutators) === false`, and `allMutators.push(...)` grows
   it. `const` binds the *reference*, not the array contents, so the array stays
   mutable.

2. **`babel-transformer.js` reads it by reference.** It imports `allMutators`
   from `../mutators/index.js` (the ESM re-export barrel — `export * from
   './mutate.js'`) and uses it as a default parameter:
   ```js
   import { allMutators } from '../mutators/index.js';
   export const transformBabel = (..., mutators = allMutators, mutantPlacers = allMutantPlacers) => {
       ...
       for (const mutator of mutators)
           for (const replacement of mutator.mutate(node)) { ... }
   };
   ```
   `allMutators` is a *default parameter*, resolved at each call. We deep-import
   `mutate.js` DIRECTLY (the array's definition site), and ESM module-instance
   caching makes the re-export and the direct import the SAME array object — so a
   push on the array we hold is the array `transformBabel` sees. Stryker's
   `transformer.js` invokes `transformBabel` with **no `mutators` argument**, so
   it always uses the live `allMutators`. Mutating that array (push, or
   clear-then-push) before the call changes what Stryker instruments on the next
   run. (The per-version canary guards this re-export/deep-import equivalence.)

3. **The mutator interface is tiny and public-ish.**
   `dist/src/mutators/node-mutator.d.ts`:
   ```ts
   interface NodeMutator {
       mutate(path: NodePath): Iterable<types.Node>;
       readonly name: string;
   }
   ```
   Any object with a `name` and a synchronous `mutate(path)` generator is a valid
   member of `allMutators`. Our heuristics are authored exactly this way; this is
   also the shape an upstream-PR operator would take.

4. **Instrumentation runs IN-PROCESS in the main Stryker process.**
   `MutantInstrumenterExecutor.execute()` does
   `const instrumenter = this.injector.injectFunction(createInstrumenter); ...
   await instrumenter.instrument(...)` — synchronously in the main process, not
   in a worker. So a driver that pushes mutators and then constructs
   `new Stryker(cliOptions)` and awaits `runMutationTest()` **in the same
   process** makes stock Stryker use our mutators for the *whole* pipeline:
   sandbox copy, perTest coverage analysis, concurrency, checkers, incremental
   mode, and every configured reporter.

5. **Internals are reached by a relative `node_modules` path.** The
   instrumenter's package `exports` map exposes only `.` (its barrel, which does
   NOT re-export `allMutators`) and `./package.json`. So the injection seam reads
   the array via a **direct relative filesystem path** into
   `node_modules/@stryker-mutator/instrumenter/dist/src/mutators/mutate.js`
   (exactly the deep-import style `src/seam/instrument-worker.mjs` already uses
   for `transformBabel` et al.), **not** a bare subpath specifier.

### 3.2 How each mutator type is injected

- **Heuristics (formulaic, non-LLM).** Authored DIRECTLY as Stryker
  `NodeMutator`s — `{ name: 'heuristic/<op>', *mutate(path) { ... yield
  replacementNode } }` — and pushed onto `allMutators`. This is the native fit:
  no string-grafting, no manifest coupling, no position-offset bookkeeping;
  Stryker's collector + placers + printer handle all of it. It is also exactly
  the shape these operators would take as an upstream StrykerJS PR.

- **Dynamic LLM.** Because `mutate(path)` is **synchronous**, the LLM work runs
  in an async **pre-pass** *before* the push:
  1. **target** spans (risk/EV ranking, coverage-gated — §4),
  2. **batched Haiku propose** (per enclosing function — §4),
  3. **filters** (parse-check / identical-reject / dedup / conservative
     near-equivalence — §4),
  4. **build a precomputed map** keyed by `(fileName, node-location)` →
     pre-parsed replacement AST node(s).

  Then ONE injected `LLMMutator` (`name: 'llm/<tag>'`) does a **synchronous
  lookup** in that map inside `mutate(path)` and yields the precomputed nodes.
  The replacement-string → AST-node logic the old seam used (`parseFragment`,
  wrap-in-parens) is **REUSED** here to build the map — it is not wasted work.

- **The two config switches.** `heuristics` (default ON) → push the heuristic
  mutators; `dynamicLLM` (default OFF) → run the pre-pass and push the
  `LLMMutator`. For a suite already at 100% on the built-ins (isambard), the
  driver can run **OURS ONLY** to avoid re-running the 16 built-ins:
  ```js
  allMutators.length = 0;      // clear built-ins
  allMutators.push(...ours);   // inject just our mutators
  ```
  Augmenting instead (keep built-ins, `push(...ours)`) is also supported and is
  the right default for a suite that is *not* already at 100%.

### 3.3 Why this is safe given Stryker has no mutator plugin system

Stryker v9 deliberately has **no public Mutator `PluginKind`** — test runners,
checkers, reporters, and ignorers are pluggable, but the mutator set is hardcoded
in the instrumenter. This is a **design choice, not an oversight or a technical
barrier**:

1. A standardized, cross-implementation **mutator catalog + report schema** keeps
   mutation scores comparable across projects and across StrykerJS / Stryker.NET
   / Stryker4s.
2. The instrumenter is **performance-critical and tightly Babel-coupled**; a
   public mutator API would freeze Babel-internal types as a compatibility
   contract and block instrumenter refactors.
3. A curated operator set controls **equivalent-mutant noise** and score quality.
4. They provide **escape hatches** instead: `// Stryker disable` comments,
   mutation ranges, and "contribute the operator upstream."

So it is a consistency / performance / quality decision. Our injection works
**precisely because** the interface is tiny and the array is mutable — but the
consequences of bypassing the curation are ours to own: we **tag our mutants
distinctly**, we maintain **our own survivor view + equivalent filtering**, and
we **do not present a comparable-looking score** (§6, and risks below).

### 3.4 Honest risks (these are real — keep them in view)

- **It is a MONKEYPATCH on internal, version-pinned state.** If a future Stryker
  release froze `allMutators` (`Object.freeze`), copied it into a closure at
  module load instead of reading the live binding, or moved instrumentation
  out-of-process, the injection breaks — **possibly SILENTLY**: no mutants get
  added, the run still completes, and nothing throws. **Mitigation:** pin a
  tested Stryker version range **and** a CI smoke test that asserts an injected
  mutator yields a known mutant in the standard report, run **per supported
  Stryker version**. The smoke test is the canary; without it a break is silent.

- **Deep imports bypass the package `exports` map.** `allMutators` (and the
  legacy `transformBabel`/`MutantCollector`/`createParser`/`print` the old seam
  used) are reached by a relative `node_modules/...` filesystem path, not a
  supported specifier — fragile across versions, part of the same smoke-test
  surface.

- **The reported mutation SCORE now includes our mutants.** Because our mutants
  are added to Stryker's run, the standard report's score covers them too and is
  **NOT comparable to a vanilla Stryker score**. We tag our mutants distinctly
  (`heuristic/*`, `llm/*`) and surface our own survivor view; we never claim the
  blended number is the project's "real" mutation score.

- **LLM mutants are non-deterministic run-to-run.** No temperature control via
  the Agent SDK, so a COLD `propose()` on a span not yet cached can return
  different candidates run-to-run — which changes WHICH `llm` mutants exist, the
  blended score, and the survivor set. The heuristic mutators are fully
  deterministic (pure AST); only the dynamicLLM path is non-deterministic, and only
  on cache MISSES. A content-addressed cache (key = `SHA256(model + prompt +
  stableStringify(schema))`) makes a WARM run (every targeted call already cached)
  byte-for-byte reproducible and free: the budgeted provider's cache-hit branch
  reconstructs the identical validated value at `costUsd:0`/`cached:true` and never
  calls the model. So **reproducibility == cache coverage**. For a deterministic,
  free CI GATE, the **frozen-set mode** (`dynamicLLM.frozen` / `--frozen`) makes the
  pre-pass CACHE-ONLY: on a cache MISS the provider returns an EMPTY result (no
  candidates, `$0`) instead of delegating to the network, so the run re-scores
  EXACTLY the already-cached "frozen mutant set" and adds no new mutant. Commit (or
  restore from an Actions cache) the `cacheDir` for a warm CI gate. (A
  heuristics-only run is already deterministic and needs no flag.)

- **Equivalent-mutant noise.** Custom mutators (heuristic and LLM) can introduce
  equivalent mutants. We filter conservatively (§4) and log every drop, but the
  filtering is imperfect; survivors still need human audit.

- **Dynamic-LLM makes real API calls and costs money.** The per-user
  `ANTHROPIC_API_KEY` path is the sanctioned shippable path; the Anthropic
  subscription / Agent-SDK path is author/dev-only (ToS — `dev-plan §7`).

### 3.5 Fallback if the monkeypatch ever breaks (documented contingency only)

If a Stryker bump freezes or closure-captures `allMutators`, or moves
instrumentation out-of-process, the **previously-designed out-of-band path is the
documented fallback** — not built now, but kept on record:

- Drive instrumentation **ourselves** via the deep-imported `transformBabel` +
  subclassed `MutantCollector` + `createParser` + `print` (the existing
  `src/seam/instrument-worker.mjs` already does exactly this), producing the
  switch-embedded source + manifest in lockstep, then…
- …either substitute into Stryker's executor chain (executor-substitution) **or**
  run a thin runner on the public `@stryker-mutator/api` `TestRunner` contract +
  `@hughescr/stryker-bun-runner` (the old "Option B" ~500–800 LOC sandbox+runner).

This contingency is **strictly more expensive** (it re-implements sandboxing,
perTest scoping, and concurrency that stock Stryker gives us for free), which is
exactly why monkeypatch-injection is the primary path. The smoke test (§3.4)
tells the fixer which surface moved so the fallback can be re-targeted precisely.

---

## 4. The efficient dynamic-LLM algorithm (now an LLM-CALL-budget problem)

Execution efficiency — per-mutant runs, perTest coverage scoping, concurrency —
is **now stock Stryker's job** and is handled natively once our mutators are
injected. The remaining efficiency concern is therefore purely the **LLM CALL
budget**: don't make a gajillion Haiku queries. The targeting / pre-pass /
caching / budget-cap design below is still load-bearing, reframed around call
count and dollars rather than test runs.

Priority: **no wasteful calls.** Haiku is the LAST resort; spend strictly
top-down under a hard ceiling. The thesis "find holes built-ins cannot express"
is real, but its purest operationalization (`builtinKilledCleanly` eligibility)
secretly needs a **full vanilla mutation run as an oracle** — so **CUT that gate
for the first useful run** and ship the cheaper, equally-grounded version below;
add the oracle gate later only if equivalent-survivor noise proves real in
practice.

**GATE 0 — OBSERVE coverage (no LLM).** We no longer run our own dry-run for
coverage; Stryker produces perTest coverage itself during the injected run. For
*targeting* in the pre-pass we still want a coverage signal so we don't spend
Haiku on uncovered spans. Options, cheapest first: (a) read the target's existing
coverage artifact if trustworthy; (b) a lightweight pre-pass coverage probe;
(c) accept Stryker's `NoCoverage` status as after-the-fact feedback and skip
covered-only gating on the first run. Cache any coverage map keyed by
source-content hash so config-only changes don't re-trigger it. (Note: a target's
shipped `mutation.json` may be bail-truncated — do not trust `coveredBy` from it
blindly.)

**GATE 1 — TARGET (deterministic, no LLM).** Pure Babel traversal per span:
```
risk = w1·branchCount + w2·nestingDepth + w3·offByOneAffinity − w4·ignoredDensity
```
where `offByOneAffinity` counts indexing/slice/boundary-literal/comparison
constructs and `ignoredDensity` counts human `// Stryker disable` mutants in the
span (author-vetted equivalents, deprioritize). **Eligibility (the CUT version):
`coveredBy(span) ≥ 1` (when a coverage signal is available) AND
`risk ≥ minRiskScore`.** Rank eligible spans by `EV = risk · semanticRichness`,
where `semanticRichness` boosts spans with ≥2 distinct operators / object-array
construction / multi-arg calls (where single-token formulaic swaps under-cover).
Keep `topSpansPerFile` (default 10) and a global top-K under the ceiling.

**GATE 2 — COMPLEMENTARITY HAND-OFF (heuristics first).** Heuristics run inside
Stryker for free (zero LLM spend). The LLM pre-pass is invoked only on
Gate-1-eligible, semantically-rich spans — multi-operator / business-logic,
precisely what a fixed replacement table (and our formulaic heuristics) cannot
express. Formulaic-only spans (single comparison, single arithmetic op, no domain
meaning) are left to the heuristic mutators and **skipped for LLM** — they add no
signal a cheaper path didn't already cover.

**GATE 3 — AMORTIZE (batched, diverse, capped).** **Batch by enclosing
function**, not by span: one `provider.generate()` per hot function asking for up
to `maxCandidatesPerFile` **diverse** mutants spanning that function's eligible
spans, each with a distinct `mutatorTag` and an explicit "produce DIVERSE
mutation kinds" instruction (the propose stage already pins `range` to the
caller's span and carries the anti-equivalence system prompt —
`propose.ts:147-158`). This collapses ~216 runnable files × ~3–5 hot functions
into **~150–400 calls**, not thousands of per-span calls. Spend top-down on the
EV queue until `budget.maxCostUsd` is hit.

**GATE 4 — DEDUP/EQUIVALENCE then BUILD THE MAP (filters before instrumentation).**
Run existing `applyFilters` (identical-reject → dedup on
`{fileName,range,replacement}` → parse-check — kills the ~36% non-compile tax)
BEFORE building the precomputed map. Add a **conservative** near-equivalence pass
(AST-normalize whitespace/paren/redundant-cast only; **log every drop**; do NOT
false-drop literal-format changes that may be semantically meaningful). Only
survivors are pre-parsed into AST nodes and entered into the
`(fileName, node-location) → Node[]` map the `LLMMutator` reads. Content-address
every LLM call via the existing `ResponseCache`
(`computeCacheKey = SHA256(model+prompt+schema)`); re-runs and overlapping spans
are free.

**STOPPING.** Halt the pre-pass when ANY of: (1) global cost ≥
`budget.maxCostUsd`; (2) EV queue exhausted; (3) diminishing returns — rolling
new-*candidate*-yield over the last `M` (default 20) calls drops below a floor.
(On a 0-survivor suite, *survivor* yield is only known after Stryker runs, so the
pre-pass stop uses candidate/diversity yield as its proxy; survivor counts come
back from Stryker's report and feed the next run's targeting.) The 150–400 /
$2–5 bound holds because the cost ceiling + diminishing-returns + cache ship
together.

**Mid-run ceiling enforcement (load-bearing fix).** The dollar ceiling must be
**consulted BETWEEN calls** or it is decorative — wrap the provider so each
`generate()` checks `accumulator.snapshot().totalUsd` against `maxCostUsd` and
aborts the queue when crossed.

**Projected isambard cold run.** LLM **$ is trivial** (~150–400 Haiku calls ≈
**$2–5**, consistent with the LLMorpheus $3.62/13-app prior; default
`maxCostUsd` = 5 as hard abort). **Wall clock is now Stryker's concern**, handled
natively by its perTest scoping + concurrency — no longer something we budget or
build. **Smallest useful run (one file, prove a real survivor) ≈ $0.02–0.05 and
a few minutes — target that first.**

---

## 5. The heuristics catalog

Each operator is authored DIRECTLY as a Stryker `NodeMutator` —
`{ name: 'heuristic/<op>', *mutate(path) { ... } }` — and pushed onto
`allMutators`. **No seam wiring, no manifest, no position offsets, no string
grafting:** Stryker's own collector + placers + printer consume the yielded AST
node, exactly as they do for the 16 built-ins. `mutate(path)` yields one or more
replacement `types.Node`s for each matching `NodePath`; that is the entire
contract (`node-mutator.d.ts`).

**Non-negotiable implementer constraints:**
1. **Yield real AST nodes, not strings.** `mutate` returns
   `Iterable<types.Node>`. Build replacement nodes with `@babel/types`
   (`t.numericLiteral(n+1)`, etc.) or parse a fragment into a node — never emit a
   string; Stryker's placers expect nodes.
2. **Match on `path`, not on text.** Use the visited `NodePath`/node type and its
   `.loc` directly; do not re-derive positions or sub-slice a node. (No
   Stryker-vs-Babel position offsetting is needed anymore — Stryker owns the
   node's `loc`.)
3. **Replacements must be syntactically valid in place.** A statement-shaped
   replacement (early-return) at an expression position will be rejected by
   Stryker's placers — confirm each operator's replacement node is legal at the
   node's position before shipping; defer any operator that is not.

**PRIORITIZED CATALOG** (built-ins confirmed unable to express these — there is
no NumericLiteral mutator among the 16, `LogicalOperator` swaps the *operator*
not the *operand*, `EqualityOperator` swaps operators not boundary
*literals/arithmetic*):

**Status: the FULL P1–P4 catalog is IMPLEMENTED (M5).** All 14 operators ship as
Stryker `NodeMutator`s in `src/mutators/` (barrel `src/mutators/index.ts`,
registry `src/driver/select-mutators.ts`), each with a sibling unit test in
`tests/mutators/` at ~100% coverage, and each verified to place cleanly through
the REAL `@stryker-mutator/instrumenter`.

| Pri | Operator | Status | Match (AST) | Replacement | isambard example |
|---|---|---|---|---|---|
| **P1** | `NumberLiteralValue` | ✅ M1 | `NumericLiteral` (not in a Stryker-disabled span) | `n → n+1`, `n → n-1`, `n → 0` (skip when already 0) | `text.ts:34 slice(0, maxLength-1)`; `task-list-reader.ts:239 slice(0, 47)` |
| **P1** | `BoundaryOffByOne` | ✅ M1 | `BinaryExpression` `i+1` / `len-1` (exactly one operand the literal `1`) | swap `+1↔-1`, drop the `±1` | `scene-detector.ts:34 i < boundaries.length-1`; `:39 boundaries[i+1]` |
| **P1** | `FallbackOperandSubstitution` | ✅ M1 | `LogicalExpression` `??` / `\|\|` right operand | replace fallback with `undefined` / `null` / `0` / `''` (skip when already that value) | `scene-detector.ts:39 ?? duration`; `time.ts:187 ?? resolveTimezone()` |
| P2 | `ComparisonBoundaryShift` | ✅ M5 | `BinaryExpression` `<`↔`<=`, `>`↔`>=` | flip strictness (both operands reused) | `time.ts:190 hour>=5 && hour<12` |
| P2 | `CallArgumentTweak` | ✅ M5 | `CallExpression`: numeric arg of slice/substring/substr/padStart/padEnd/repeat/splice; OR any ≥2-arg call | `±1` on each numeric arg (gated methods); swap first two args | `filename.ts:36-37`; `task-list-reader.ts:205 slice(0,10)` |
| P2 | `AwaitDrop` | ✅ M5 | `AwaitExpression` | drop `await` → yield the argument (bucket honestly — may type-error → `error` not `survived`) | repo-wide |
| P3 | `EarlyReturnInjection`* | ✅ M5 | function-body `BlockStatement` (parent is a function shape; non-empty) | prepend `return;` / `return undefined;` | repo-wide |
| P3 | `SpreadOperandDrop` | ✅ M5 | object `SpreadElement` (in an `ObjectExpression`) | drop ONE spread per mutant | `scene-detector.ts:30` |
| P3 | `ArrayMethodSwap` | ✅ M5 | `CallExpression` `xs.<m>(…)` where `m` ∈ {map, filter, forEach, push, unshift} | swap method name (`map`↔`filter`↔`forEach`, `push`↔`unshift`) | repo-wide |
| P3 | `PromiseCombinatorSwap` | ✅ M5 | `CallExpression` `Promise.<c>(…)` where `c` ∈ {all, allSettled, race, any} | swap combinator (`all`→{allSettled,race}, etc.) | `path-validator.ts:51`; `session-cleanup.ts:282`; `live-signals.ts:573` |
| P4 | `DefaultParamValueTweak` | ✅ M5 | `AssignmentPattern` with a numeric/boolean/string literal default | numeric `±1`/`0`, boolean flip, string `→ ''` | repo-wide |
| P4 | `OptionalChainForce` | ✅ M5 | plain `MemberExpression` (`a.b`, `a[i]`, `this.x`; not a PrivateName) | force `?.` (emit an `OptionalMemberExpression`) | repo-wide |
| P4 | `StringMethodArgSwap` | ✅ M5 | `CallExpression` `s.<m>(…)` where `m` ∈ {includes, startsWith, endsWith} | swap predicate method name | repo-wide |
| P4 | `TernaryBranchSwap` | ✅ M5 | `ConditionalExpression` with non-equal branches | swap consequent/alternate (test reused) | repo-wide |

\* `EarlyReturnInjection` is the ONLY statement-shaped operator (it yields a
`BlockStatement` to replace a function-body `BlockStatement`). Per §5 constraint 3,
its placement was VERIFIED against Stryker's real placers before shipping: it
PLACES CLEANLY because `statementMutantPlacer` (`canPlace = path.isStatement()`)
special-cases `path.isBlockStatement()` and wraps the placed block correctly. It
therefore SHIPS (not deferred), guarded by a dedicated offline real-instrumenter
canary, `tests/injection/early-return-placement-proof.test.ts` (+ its
`.mjs` Node worker), cloned from the LLM placement proof. If that canary ever fails
on a Stryker bump, `EarlyReturnInjection` must be deferred (unregistered from the
barrel) until the statement-placement contract is re-confirmed.

**Honest bucketing (intended).** Several operators deliberately produce mutants
that score as `error` / `compileError` rather than `survived` — a build-time-caught
mutant is a kill of a different colour, not a placement failure: `AwaitDrop`
(`Promise<T>` vs `T` type errors), `ArrayMethodSwap`/`StringMethodArgSwap` return-
or receiver-type mismatches (`forEach` drops the return value; `Array.includes`
swapped to `startsWith` throws), `PromiseCombinatorSwap` `all`→`race` (result-shape
change), and `OptionalChainForce` on a non-nullable typed object. This is
documented in each operator's file header.

**Volume guard.** Heuristics fire on **every** matching node across all files —
but the run cost of that is now **Stryker's** perTest-scoped, concurrency-bounded
execution, not ours to engineer. So volume is a *score-noise* and *LLM-targeting*
concern, not a wall-clock blocker. Still: **M1 ships P1 only** (3 operators) for a
clean first proof; P2–P4 land after the survivor view + equivalent filtering
(§6) exist to manage the extra noise. Honor a `skipUncovered`-style targeting
preference where a coverage signal is available.

**Equivalence/disable-comment handling.** Our operators ship under BARE PascalCase
names (`NumberLiteralValue`, `BoundaryOffByOne`, `ComparisonBoundaryShift`, …) and
the dynamic-LLM mutator under the single name `llm` — NOT `heuristic/<op>` /
`llm/<tag>` (the per-candidate `llm/<tag>` tag survives only inside the filtered
report artifact's `mutatorName`, not as the Stryker operator name). Disable-comment
honoring works for our names FOR FREE, because of HOW Stryker wires its
`DirectiveBookkeeper`: `babel-transformer.js` constructs the bookkeeper with the
SAME live `mutators` array (our injected `allMutators`), and at collection time it
computes `findIgnoreReason(line, mutator.name)` against the comment's
case-insensitively-matched names OR the wildcard `all`, then filters out
`ignoreReason`d mutants. Injection happens BEFORE the bookkeeper is constructed, so:

- `// Stryker disable all` (and `disable next-line all`) DOES suppress our
  heuristic mutants AND the `llm` mutant — the wildcard matches everything,
  including our names. **Confirmed clean win, no code needed.**
- `// Stryker disable NumberLiteralValue` (or `disable llm`, `disable
  BoundaryOffByOne`, …) WORKS going forward — our names are in the live list the
  bookkeeper was built with (case-insensitive match), so a user CAN suppress a
  specific re-surfaced equivalent by name.
- A pre-existing `// Stryker disable EqualityOperator` (a BUILT-IN name) does NOT
  suppress our differently-named mutants — by design. So a span the author vetted
  and disabled for a built-in operator can RE-SURFACE as a survivor under our
  different operator name (the author never vetted ours). This is EXPECTED; such
  survivors still need human audit (§3.4).
- `warnAboutUnusedDirective`: a `disable <name>` comment naming a mutator not in
  the live injected set (e.g. naming `llm` in a heuristics-only run) emits a benign
  `log.warn("Unused 'Stryker disable' directive…")`.

To suppress one of OUR re-surfaced equivalents, add `// Stryker disable next-line
all` (covers everything at that line) OR `// Stryker disable next-line
<OurOperatorName>` / `// Stryker disable next-line llm`, with a `:reason`. We add
NO parallel disable-honoring layer — duplicating Stryker's bookkeeper would risk
diverging from it. For the first useful run, **accept the residual noise and
human-audit survivors**.

---

## 6. Config and switches

Extend `src/config.ts` `llmMutatorConfigSchema`. Keep `.strict()` on the
`llmMutator` object (it is parsed from the sub-object only, not the whole
`StrykerOptions`). Add the two switch blocks; keep `provider`/`model`/`stage3`/
`cacheDir` at top level (they apply only when `dynamicLLM.enabled`).

```ts
export const HeuristicOperator = z.enum([
  'NumberLiteralValue', 'BoundaryOffByOne', 'FallbackOperandSubstitution',   // P1
  'ComparisonBoundaryShift', 'CallArgumentTweak', 'AwaitDrop',               // P2
  'EarlyReturnInjection', 'SpreadOperandDrop', 'ArrayMethodSwap', 'PromiseCombinatorSwap', // P3
  'DefaultParamValueTweak', 'OptionalChainForce', 'StringMethodArgSwap', 'TernaryBranchSwap', // P4
]);

heuristics: z.object({
  enabled: z.boolean().default(true),                 // THE switch — default ON
  operators: z.array(HeuristicOperator).default([]),  // [] = all enabled; else allow-list
  skipUncovered: z.boolean().default(true),           // deprioritize zero-coverage spans where a signal exists
}).prefault({}),

dynamicLLM: z.object({
  enabled: z.boolean().default(false),                // THE switch — default OFF
  targeting: z.object({
    topSpansPerFile: z.number().int().positive().default(10),
    minRiskScore: z.number().min(0).default(1),
    requireCoverage: z.boolean().default(true),
  }).prefault({}),
  budget: z.object({
    maxCandidatesPerFile: z.number().int().positive().default(20),
    maxLlmCallsPerRun: z.number().int().positive().default(500),
    maxCostUsd: z.number().positive().default(5),      // HARD abort, checked BETWEEN calls
  }).prefault({}),
  diminishingReturns: z.object({
    window: z.number().int().positive().default(20),       // M calls
    minYieldPerCall: z.number().min(0).default(0.1),       // floor: pre-pass candidate/diversity yield
  }).prefault({}),
}).prefault({}),
// provider / model / stage3 / cacheDir stay at top level (unchanged)
```

An empty `llmMutator: {}` (or no block at all) parses to
`{ heuristics:{enabled:true,…}, dynamicLLM:{enabled:false,…} }` —
**heuristics-only by default**, exactly the spec.

**Reading from the target & invoking Stryker.** The driver reads the target's
config and then constructs `new Stryker(cliOptions).runMutationTest()` in the
same process AFTER pushing mutators. Two viable config paths: (a) read the full
`StrykerOptions` via Stryker's own config machinery and parse
`options.llmMutator ?? {}` with `llmMutatorConfigSchema`; or (b) let Stryker load
its own config during `runMutationTest()` and have the driver read only the
`llmMutator` block. Either way, **the same `stryker.conf.*` serves both
`stryker run` and `stryker-llm run`** — Stryker core only `log.warn`s on the
unknown `llmMutator` key (never fatal). (This is part of the smoke-test surface:
assert the config read + the push + the run still wire up on each supported
version.)

**CLI surface.** Add a `bin` entry `stryker-llm` (`src/cli.ts` → `dist/cli.js`),
one subcommand `stryker-llm run [projectDir]` (default cwd). It: loads the target
config, parses the two switches, optionally runs the LLM pre-pass (building the
precomputed map), **pushes** the heuristic mutators and/or the `LLMMutator` into
`allMutators` (clear-then-push for ours-only, or augment), then constructs and
awaits `new Stryker(cliOptions).runMutationTest()` in-process. Switch interplay:
both ON = additive (tagged distinctly); both OFF = **warn + run stock Stryker
unmodified** (or no-op); dynamicLLM ON but no credentials = **fail fast** with a
clear message (do not silently degrade). Flags (as shipped): `--dry-run` (default)
/ `--live`; `--ours-only` / `--augment` to pick the clear-vs-push mode; `--frozen`
to force CACHE-ONLY dynamicLLM (deterministic, free CI gate — §3.4); plus
pass-through `--mutate`, `--config-file`, `--concurrency`, `--reporters`,
`--incremental`/`--no-incremental`, `--temp-dir`.

**Reporting.** Because our mutants run *inside* Stryker, they already appear in
**Stryker's standard report** (HTML / JSON / dashboard) with `mutatorName` set to
our operator's bare PascalCase name (`NumberLiteralValue`, …) or `llm` — visually
distinct from built-ins, no schema emission of our own required for basic
consumption. On top of that, the reporter
adds **our own view**: a console summary with a **SURVIVORS** section
(`file:line  mutatorName  original → replacement  (rationale)` — survivors ARE
the test holes the tool exists to find), a clear note that **the blended score
includes our mutants and is not comparable to a vanilla Stryker score**, and a
final `Total LLM cost: $X.XX across N calls` from `CostAccumulator.snapshot()`.
Optionally emit a filtered `reports/mutation-llm.json` containing only our mutants
for a clean per-tool view.

---

## 7. Sequenced build plan

Each milestone is independently runnable and moves toward a useful isambard run.
The spine is now **injection-first**: prove that one custom mutator, pushed into
`allMutators`, shows up in a STOCK Stryker run. Everything else builds on that one
load-bearing proof.

### M0 — Injection smoke test on a real isambard file *(prerequisite canary; no LLM, no network)*
- **Build:** a CI test in *this* repo that authors ONE real heuristic
  `NodeMutator` (e.g. `NumberLiteralValue`), deep-imports `allMutators`
  (relative `node_modules` path), pushes it (or clear-then-push for ours-only),
  and runs **stock `stryker run`** against one isambard file (pinned as a git
  submodule or tarball). Assert our mutant appears in Stryker's normal report
  (killed or survived).
- **Acceptance:** the test passes and **fails loudly** if `allMutators` is no
  longer a mutable array, if the deep import path moves, or if instrumentation
  stops reading the live array — i.e. it is the per-version canary for the whole
  monkeypatch surface (§3.4).
- **Network:** none. This IS the load-bearing proof; everything else assumes it.

### M1 — Heuristics-only end-to-end against isambard via stock Stryker *(NO LLM, NO credentials — the first proof of value)*
- **Build:** (a) the **injection seam** (`src/seam/inject*`) — deep-import
  `allMutators`, clear-or-augment, push; (b) the **P1 heuristics engine** —
  `NumberLiteralValue`, `BoundaryOffByOne`, `FallbackOperandSubstitution`
  authored as Stryker `NodeMutator`s; (c) a minimal driver: read target config,
  push P1 mutators (ours-only against isambard's 100% suite), invoke
  `new Stryker(...).runMutationTest()` on a small file set.
- **Acceptance:** on at least one isambard file, produce a **real survivor** — a
  P1 heuristic mutant the 100%-suite cannot kill — confirmed by hand-audit as a
  genuine test hole (not equivalent), visible in **Stryker's standard report**.
  Zero LLM spend, no credentials.
- **Network:** none (offline, no creds). **Parallel:** (b) the operators can be
  built alongside (a) the seam; they join at (c). This is the critical milestone
  — **if M1 yields no survivor on any file, surface that to the user before
  building M3+.**

### M2 — Multi-file scale-up + coverage targeting *(no LLM)*
- **Build:** run the heuristics injection over a multi-file glob with isambard's
  real config (concurrency, perTest coverage — all handled by stock Stryker);
  wire `heuristics.operators` allow-listing and `skipUncovered` targeting where a
  coverage signal exists; tune the ours-only-vs-augment switch.
- **Acceptance:** a multi-file heuristics run completes through stock Stryker
  with perTest scoping and concurrency (verify via Stryker's own output), and the
  heuristic survivors are collected for review.
- **Network:** none. **Parallel:** depends on M1; gates M3.

### M3 — Efficient targeted dynamic-LLM pre-pass + `LLMMutator` *(LLM — live network, human-run)*
- **Build:** stage-1 risk/EV targeting (Gate 1, pure, offline-testable with mock
  provider); Gate-2 complementarity hand-off; Gate-3 function-batched propose;
  Gate-4 filters + conservative near-equivalence + cache wiring on the real
  provider; **build the precomputed `(fileName,loc)→Node[]` map** (reusing the old
  seam's `parseFragment` logic); the **single injected `LLMMutator`** doing a sync
  lookup; mid-run `maxCostUsd` enforcement; diminishing-returns stop. **CUT** the
  `builtinKilledCleanly` oracle gate (eligibility = covered AND risk≥threshold).
- **Acceptance:** offline — targeting / map-building / `LLMMutator` lookup /
  stop logic fully tested with `MockProvider` (the `LLMMutator` is synchronous and
  fully testable against a hand-built map, no network). **Live (human-run)** — a
  cold isambard run, with the `LLMMutator` pushed into `allMutators` and stock
  Stryker invoked, produces ≥1 LLM survivor under `maxCostUsd=5`, ~150–400 calls,
  cost surfaced; warm re-run is cache-stable (free).
- **Network:** **YES — live Anthropic. Background/headless agents cannot clear the
  sandbox prompt; the live smoke run must be human / main-thread.** **Parallel:**
  the targeting + filters + map-building + `LLMMutator` (all offline) are
  parallelizable; the live run is serial after them.

### M4 — Reporting / survivor-surfacing / cost *(no new network)*
- **Build:** the reporter (§6) — our survivor view + cost summary layered on
  Stryker's standard report, the "score includes our mutants, not comparable"
  note, optional filtered `reports/mutation-llm.json`.
- **Acceptance:** an M1 or M3 run surfaces a clean SURVIVORS list (heuristic vs
  LLM tagged distinctly via `mutatorName`) and total LLM cost; the standard
  Stryker HTML/JSON report already contains our mutants.
- **Network:** none (consumes prior run output). **Parallel:** can be built
  alongside M3 (it only needs the report + cost snapshot, available from M1).

### M5 — Scale / caching / resilience / CI canary *(mixed)* — **DONE**
- **Build:** full P2–P4 heuristics (now safe under the survivor view) — **DONE:
  all 11 P2–P4 operators are implemented as `NodeMutator`s, registered in the
  barrel, unit-tested at ~100%, and verified to place through the real
  instrumenter** (the 10 expression-shaped ones by the unit-test idiom + the M0
  injection canary; the single statement-shaped `EarlyReturnInjection` by its own
  `tests/injection/early-return-placement-proof.test.ts` canary, which proved it
  places cleanly — so it ships rather than deferring). Plus, also DONE:
  - **The per-version monkeypatch canary (§3.4) is wired into CI.** A single
    consolidated `tests/injection/canary.test.ts` (+ `canary-worker.mjs`) asserts,
    in one Node-subprocess round-trip, the FOUR load-bearing invariants:
    (1) `allMutators` is a non-frozen `Array` of the built-in count (16);
    (2) the five deep `dist/src/...` imports resolve AND `babel-transformer` reads
    the same array we push to; (3) a heuristic mutant instruments+places (the
    `5000` fixture → 3 `NumberLiteralValue` mutants + switches); (4) an `llm` mutant
    instruments+places with NO `statementMutantPlacer` throw (the node-aligned
    `hour >= 12 → hour > 12` survivor). A `bun run canary` script runs it in
    isolation, and `.github/workflows/ci.yml` runs the six gates in order then the
    canary as a final named "per-version monkeypatch canary" step. The two detailed
    proofs (`injection-proof` + `llm-placement-proof` + `early-return-placement-
    proof`) remain for regression depth. (Open-question #5: Stryker is pinned to
    exactly 9.6.1; the workflow carries a commented matrix stub to widen the range.)
  - **Cold-run non-determinism documented + frozen-set mode shipped** (§3.4). The
    config gains `dynamicLLM.frozen` and the CLI gains `--frozen`; the budgeted
    provider gains a `cacheOnly` path that, on a cache MISS, records a `$0` call and
    returns empty candidates WITHOUT calling the network or writing the cache — a
    deterministic, free CI gate that re-scores only the already-cached frozen set
    (open-question #6).
  - **Disable-comment honoring is a CLEAN WIN with no code** (§5): Stryker's own
    `DirectiveBookkeeper` is constructed with the live injected `allMutators`, so
    `// Stryker disable all` AND `// Stryker disable <OurName>` / `disable llm` both
    suppress ours for free; only pre-existing built-in-name disables don't cover us
    (expected equivalent re-surfacing) (open-question #7).
  - **The mode-downgrade follow-up fix** (`src/driver/plan.ts`): the `replace →
    augment` downgrade now counts the deferred dynamic-LLM mutator
    (`gate.runDynamicLLM`), so `--ours-only` + dynamicLLM-on (heuristics-off) keeps
    `mode: replace` instead of wrongly retaining the 16 built-ins (the 265-vs-29
    live bug). Unit-tested in `tests/driver/plan.test.ts`.
  - Recorded-but-not-built: the documented out-of-band contingency (§3.5); optional
    provider fallback (subscription → API key); dog-food self-mutation script.
- **Acceptance:** a full-repo isambard run completes through stock Stryker; warm
  re-run is reproducible (frozen-set mode for the deterministic CI gate); the CI
  canary gates every Stryker bump.
- **Network:** live for the full run (human-run). **Parallel:** sub-items largely
  independent.

**Deferred / cut (not on the critical path to a useful run):** the entire
roll-our-own runner / sandbox / coverage planner (CUT — stock Stryker does it);
executor-substitution (CUT — kept only as the §3.5 contingency); stage-3
confirm-wrongness (off-by-default cost bomb — `dev-plan §7`); OpenAI /
OpenAI-compatible providers (subscription-only is fine for first proof); the
`builtinKilledCleanly` oracle eligibility gate (needs a full vanilla mutation run;
add only if equivalent-survivor noise proves real).

---

## 8. Open questions for the user

These are genuine decisions, not implementation details:

1. **Is M1 (heuristics-only, no LLM, no credentials) an acceptable first
   shippable result?** It proves real value — a survivor the 100%-suite misses —
   for ~$0, but it is *not* the LLM tool; the LLM only arrives at M3. Recommend:
   **yes**, ship M1 as the first proof.

2. **Ours-only vs. augment as the default mode.** Against a suite already at 100%
   (isambard) `allMutators.length = 0; push(...ours)` avoids re-running 16
   built-ins; against a non-100% suite, augmenting (keep built-ins) is the safer
   default. Ship which as the default, and expose the toggle how?

3. **Budget defaults — confirm or override.** `dynamicLLM.budget.maxCostUsd = 5`
   (hard abort), `maxLlmCallsPerRun = 500`, diminishing-returns window `M=20` /
   floor `0.1`. Acceptable, or lower?

4. **Monkeypatch-tolerance posture.** The injection couples us to an internal,
   non-frozen `allMutators` array reached by a deep import, with a **silent**
   failure mode if a future Stryker freezes/moves it. The per-version smoke test
   (§3.4 / M5) makes breaks loud, but maintaining it per Stryker bump is ongoing
   cost. Confirm: accept the monkeypatch coupling guarded by the smoke test, and
   keep the out-of-band path (§3.5) only as a documented contingency?

5. **Supported Stryker version range.** Pin to exactly `9.6.1`, or a tested range
   (e.g. `^9.6`)? The smoke test must pass for every version in the declared
   range; wider ranges mean more CI matrix and more silent-break surface.

6. **CI reproducibility posture.** Cold LLM runs are non-deterministic (no
   temperature control via the Agent SDK). For a CI gate, accept warm-cache-only /
   "frozen mutant set" mode, or require some bounded cold-run variance?
   (Recommend frozen-set mode for any gating use; document cold variance plainly.)

7. **Equivalent-survivor noise for heuristics.** Accept noise + human-audit
   survivors for the first run (recommended), or invest up front in
   `// Stryker disable heuristic/*` honoring / TCE-style equivalence pruning?

8. **Provider scope for MVP.** Ship subscription-only (Agent SDK, simpler,
   dev-grade) for the first LLM milestone, or block M3 on the raw-API-key provider
   (the "sanctioned shippable default")? (Recommend subscription-first; API-key in
   M5.)
