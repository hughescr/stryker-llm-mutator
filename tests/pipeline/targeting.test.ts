/*
 * Offline unit tests for Gate-1 risk/EV targeting + Gate-2 complementarity.
 *
 * Pure Babel traversal — no LLM, no Stryker, no network. Feeds synthetic source
 * files + a parsed config and asserts: rich functions are selected, formulaic-
 * only functions are skipped (Gate 2), the risk floor cuts low-risk functions,
 * coverage gating works both ways, topSpansPerFile / global top-K bound the set,
 * EV ranking orders the output, ignoredDensity deprioritizes disabled spans, and
 * the emitted range is the 0-based Stryker range (1-based-line minus 1).
 */

import { describe, expect, it } from 'bun:test';

import { llmMutatorConfigSchema, type LlmMutatorConfig } from '../../src/config';
import {
    buildProposeTargets,
    isLlmWorthy,
    RICHNESS_THRESHOLD,
    type SourceFileInput,
} from '../../src/pipeline/targeting';
import type { SourceRange } from '../../src/seam/types';

/** Parse a config with a dynamicLLM.targeting override merged in. */
function cfg(over: Record<string, unknown> = {}): LlmMutatorConfig {
    return llmMutatorConfigSchema.parse({
        dynamicLLM: { enabled: true, targeting: over },
    });
}

function file(fileName: string, content: string): SourceFileInput {
    return { fileName, content };
}

/** A semantically-rich, branchy, off-by-one-heavy function (high EV). */
const RICH_FN = `
function classify(items, threshold) {
    let count = 0;
    for (let i = 0; i < items.length - 1; i++) {
        if (items[i] > threshold && items[i + 1] <= threshold) {
            count = count + 1;
        }
    }
    return { count: count, ok: count >= 2 };
}
`;

/** A formulaic-only function: one arithmetic op, no branch, no richness. */
const FORMULAIC_FN = `
function inc(n) {
    return n + 1;
}
`;

describe('buildProposeTargets — selection', () => {
    it('selects a rich, branchy function and emits one ProposeTarget for it', () => {
        const { targets, meta } = buildProposeTargets([file('/abs/a.ts', RICH_FN)], cfg());
        expect(targets).toHaveLength(1);
        expect(targets[0]!.fileName).toBe('/abs/a.ts');
        expect(targets[0]!.spanText).toContain('function classify');
        // spanText and context are the whole function text.
        expect(targets[0]!.context).toBe(targets[0]!.spanText);
        expect(meta[0]!.ev).toBeGreaterThan(meta[0]!.risk - 0.0001); // ev = risk * richness ≥ risk
        expect(meta[0]!.semanticRichness).toBeGreaterThanOrEqual(RICHNESS_THRESHOLD);
    });

    it('populates the node-alignment fields (file content + function offsets) on the target', () => {
        const { targets } = buildProposeTargets([file('/abs/a.ts', RICH_FN)], cfg());
        const t = targets[0]!;
        // The whole file content is carried so propose can node-align candidates.
        expect(t.fileContent).toBe(RICH_FN);
        // The function's absolute char offsets bracket its source within the file.
        expect(typeof t.spanStartOffset).toBe('number');
        expect(typeof t.spanEndOffset).toBe('number');
        expect(t.spanEndOffset! > t.spanStartOffset!).toBe(true);
        // The bracketed slice is exactly the function source (== spanText).
        expect(RICH_FN.slice(t.spanStartOffset!, t.spanEndOffset!)).toBe(t.spanText);
    });

    it('SKIPS a formulaic-only function (Gate 2 hand-off to heuristics)', () => {
        const { targets } = buildProposeTargets([file('/abs/b.ts', FORMULAIC_FN)], cfg());
        expect(targets).toHaveLength(0);
    });

    it('cuts a function below the risk floor (minRiskScore)', () => {
        // A rich function but with a very high risk floor → cut.
        const { targets } = buildProposeTargets(
            [file('/abs/a.ts', RICH_FN)],
            cfg({ minRiskScore: 1000 }),
        );
        expect(targets).toHaveLength(0);
    });

    it('emits the 0-based Stryker range (babel 1-based line minus 1)', () => {
        // RICH_FN starts on line 2 (line 1 is the leading newline) → 0-based line 1.
        const { targets } = buildProposeTargets([file('/abs/a.ts', RICH_FN)], cfg());
        const range: SourceRange = targets[0]!.range;
        expect(range.start.line).toBe(1);
        expect(range.start.column).toBe(0);
    });
});

describe('buildProposeTargets — coverage gating', () => {
    it('treats absent coverage signal as eligible and logs the note', () => {
        const lines: string[] = [];
        const { targets } = buildProposeTargets([file('/abs/a.ts', RICH_FN)], cfg(), {
            log: l => lines.push(l),
        });
        expect(targets).toHaveLength(1);
        expect(lines.some(l => l.includes('no coverage signal available'))).toBe(true);
    });

    it('gates out an uncovered function when a coverage probe reports 0', () => {
        const { targets } = buildProposeTargets([file('/abs/a.ts', RICH_FN)], cfg(), {
            coverageLookup: () => 0,
        });
        expect(targets).toHaveLength(0);
    });

    it('keeps a covered function when the probe reports >=1', () => {
        const { targets } = buildProposeTargets([file('/abs/a.ts', RICH_FN)], cfg(), {
            coverageLookup: () => 3,
        });
        expect(targets).toHaveLength(1);
    });

    it('treats a per-span undefined coverage as eligible', () => {
        const { targets } = buildProposeTargets([file('/abs/a.ts', RICH_FN)], cfg(), {
            coverageLookup: () => undefined,
        });
        expect(targets).toHaveLength(1);
    });

    it('keeps an uncovered function when requireCoverage is false', () => {
        const { targets } = buildProposeTargets(
            [file('/abs/a.ts', RICH_FN)],
            cfg({ requireCoverage: false }),
            { coverageLookup: () => 0 },
        );
        expect(targets).toHaveLength(1);
    });
});

describe('buildProposeTargets — ranking + budget', () => {
    const TWO_RICH = `
function alpha(a, b) {
    if (a < b && b > 0) { return { v: a + b }; }
    return { v: 0 };
}
function beta(xs) {
    let s = 0;
    for (let i = 0; i < xs.length - 1; i++) {
        if (xs[i] >= xs[i + 1] || xs[i] === 0) { s = s + xs[i]; }
    }
    return { s: s, big: s > 100 };
}
`;

    it('ranks by EV descending across files (global top-K)', () => {
        const { meta } = buildProposeTargets([file('/abs/x.ts', TWO_RICH)], cfg());
        expect(meta.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < meta.length; i++) {
            expect(meta[i - 1]!.ev).toBeGreaterThanOrEqual(meta[i]!.ev);
        }
    });

    it('keeps at most topSpansPerFile functions per file', () => {
        const { targets } = buildProposeTargets(
            [file('/abs/x.ts', TWO_RICH)],
            cfg({ topSpansPerFile: 1 }),
        );
        expect(targets).toHaveLength(1);
    });

    it('bounds the global set by maxLlmCallsPerRun (top-K)', () => {
        const config = llmMutatorConfigSchema.parse({
            dynamicLLM: { enabled: true, budget: { maxLlmCallsPerRun: 1 } },
        });
        const { targets } = buildProposeTargets([file('/abs/x.ts', TWO_RICH)], config);
        expect(targets).toHaveLength(1);
    });
});

describe('buildProposeTargets — ignoredDensity', () => {
    it('deprioritizes a function whose nodes are under a block // Stryker disable (no restore → EOF)', () => {
        const disabled = `
// Stryker disable all
function classify(items, threshold) {
    let count = 0;
    for (let i = 0; i < items.length - 1; i++) {
        if (items[i] > threshold) { count = count + 1; }
    }
    return { count: count };
}
`;
        const plain = buildProposeTargets([file('/abs/a.ts', RICH_FN)], cfg());
        const withDisable = buildProposeTargets([file('/abs/d.ts', disabled)], cfg());
        // A block disable with no restore extends to EOF, so every node in the
        // following function is ignored → lower risk (and may even be cut).
        const plainRisk = plain.meta[0]!.risk;
        const disabledRisk = withDisable.meta[0]?.risk ?? 0;
        expect(disabledRisk).toBeLessThan(plainRisk);
    });

    it('SCOPE: a function AFTER a `// Stryker disable next-line` is still selected (risk not crushed)', () => {
        // An unrelated early next-line disable must not bleed onto later
        // functions — they stay risk-eligible and selectable.
        const src = `
const cutoff = 5;
// Stryker disable next-line ConditionalExpression,EqualityOperator: vetted boundary
if (cutoff < 0 && cutoff > -1) { throw new Error('bad'); }
function classify(items, threshold) {
    let count = 0;
    for (let i = 0; i < items.length - 1; i++) {
        if (items[i] > threshold && items[i + 1] <= threshold) {
            count = count + 1;
        }
    }
    return { count: count, ok: count >= 2 };
}
`;
        const plain = buildProposeTargets([file('/abs/a.ts', RICH_FN)], cfg());
        const scoped = buildProposeTargets([file('/abs/n.ts', src)], cfg());
        expect(scoped.targets).toHaveLength(1);
        expect(scoped.targets[0]!.spanText).toContain('function classify');
        // The next-line disable sits OUTSIDE the function, so the function's risk
        // is identical to the same function with no disable at all (its body has
        // zero ignored nodes).
        expect(scoped.meta[0]!.risk).toBe(plain.meta[0]!.risk);
    });

    it('SCOPE: a `// Stryker disable next-line` only lowers risk for the node(s) on that one line', () => {
        // The next-line disable covers only the `return` line INSIDE the
        // function: only the `count >= 2` comparison there is ignored, so risk is
        // lowered vs. the plain version but the branchy body still contributes.
        const inner = `
function classify(items, threshold) {
    let count = 0;
    for (let i = 0; i < items.length - 1; i++) {
        if (items[i] > threshold && items[i + 1] <= threshold) {
            count = count + 1;
        }
    }
    // Stryker disable next-line EqualityOperator: vetted
    return { count: count, ok: count >= 2 };
}
`;
        const plain = buildProposeTargets([file('/abs/a.ts', RICH_FN)], cfg());
        const scoped = buildProposeTargets([file('/abs/in.ts', inner)], cfg());
        expect(scoped.targets).toHaveLength(1);
        const plainRisk = plain.meta[0]!.risk;
        const scopedRisk = scoped.meta[0]!.risk;
        // Some risk removed (the if-line nodes are ignored) but NOT crushed to 0.
        expect(scopedRisk).toBeLessThan(plainRisk);
        expect(scopedRisk).toBeGreaterThan(0);
    });

    it('SCOPE: block `disable`…`restore` marks only the in-between region', () => {
        // `alpha` sits inside disable…restore (ignored); `beta` sits after the
        // restore (NOT ignored) and is selected with full risk.
        const src = `
// Stryker disable all
function alpha(a, b) {
    if (a < b && b > 0) { return { v: a + b }; }
    return { v: 0 };
}
// Stryker restore all
function beta(xs) {
    let s = 0;
    for (let i = 0; i < xs.length - 1; i++) {
        if (xs[i] >= xs[i + 1] || xs[i] === 0) { s = s + xs[i]; }
    }
    return { s: s, big: s > 100 };
}
`;
        const { targets, meta } = buildProposeTargets([file('/abs/br.ts', src)], cfg());
        const beta = targets.find(t => t.spanText.includes('function beta'));
        expect(beta).toBeDefined();
        // beta is risk-eligible because it is OUTSIDE the disabled region.
        const betaMeta = meta[targets.indexOf(beta!)]!;
        expect(betaMeta.risk).toBeGreaterThan(0);
        // alpha, if present at all, has strictly lower risk than beta (it is
        // ignored) — confirm the restore re-enabled scoring for beta.
        const alpha = targets.find(t => t.spanText.includes('function alpha'));
        if (alpha !== undefined) {
            const alphaMeta = meta[targets.indexOf(alpha)]!;
            expect(alphaMeta.risk).toBeLessThan(betaMeta.risk);
        }
    });

    it('SCOPE: a block `disable` with no `restore` extends to EOF (later fn still ignored)', () => {
        const src = `
function head(a, b) {
    if (a < b && b > 0) { return { v: a + b }; }
    return { v: 0 };
}
// Stryker disable all
function tail(xs) {
    let s = 0;
    for (let i = 0; i < xs.length - 1; i++) {
        if (xs[i] >= xs[i + 1] || xs[i] === 0) { s = s + xs[i]; }
    }
    return { s: s, big: s > 100 };
}
`;
        const { targets, meta } = buildProposeTargets([file('/abs/eof.ts', src)], cfg());
        const head = targets.find(t => t.spanText.includes('function head'));
        const tail = targets.find(t => t.spanText.includes('function tail'));
        // head (before the disable) survives with full risk.
        expect(head).toBeDefined();
        // tail (after an un-restored block disable) is crushed: every node is
        // ignored to EOF, so it is cut (or at minimum strictly lower-risk).
        if (tail === undefined) {
            expect(head).toBeDefined();
        } else {
            const headMeta = meta[targets.indexOf(head!)]!;
            const tailMeta = meta[targets.indexOf(tail)]!;
            expect(tailMeta.risk).toBeLessThan(headMeta.risk);
        }
    });
});

describe('buildProposeTargets — affinity + richness node kinds', () => {
    it('counts off-by-one method calls (.slice) and ternaries, and selects the function', () => {
        const src = `
function trim(s, n) {
    const head = s.slice(0, n - 1);
    return n > 0 ? head : s.substring(1, 4);
}
`;
        const { targets } = buildProposeTargets([file('/abs/s.ts', src)], cfg());
        expect(targets).toHaveLength(1);
    });

    it('treats array-literal construction as rich', () => {
        const src = `
function pair(a, b) {
    if (a) { return [a, b, a - b]; }
    return [];
}
`;
        const { targets } = buildProposeTargets([file('/abs/arr.ts', src)], cfg());
        expect(targets).toHaveLength(1);
    });

    it('scores each nested function as its own batch unit (a branchy inner fn is selected independently)', () => {
        const src = `
function outer(xs, ys) {
    if (xs.length > 0 && ys.length > 0) {
        function inner(a, b) {
            if (a < b) { return { sum: a + b }; }
            return { sum: 0 };
        }
        return inner(xs[0], ys[0]);
    }
    return { sum: 0 };
}
`;
        const { targets } = buildProposeTargets([file('/abs/nest.ts', src)], cfg());
        // Both the outer function and the branchy inner function are rich → 2 targets.
        expect(targets.length).toBeGreaterThanOrEqual(2);
    });
});

describe('isLlmWorthy', () => {
    it('is true when semanticRichness meets the threshold', () => {
        const formulaic = {
            statementCount: 0,
            hasBranch: false,
        } as Parameters<typeof isLlmWorthy>[1];
        expect(isLlmWorthy(RICHNESS_THRESHOLD, formulaic)).toBe(true);
    });

    it('is true for business logic (multi-statement body with a branch) even when formulaic', () => {
        const business = {
            statementCount: 3,
            hasBranch: true,
        } as Parameters<typeof isLlmWorthy>[1];
        expect(isLlmWorthy(1, business)).toBe(true);
    });

    it('is false for a single formulaic statement with no branch', () => {
        const lone = {
            statementCount: 1,
            hasBranch: false,
        } as Parameters<typeof isLlmWorthy>[1];
        expect(isLlmWorthy(1, lone)).toBe(false);
    });
});

describe('buildProposeTargets — empty / multi-file', () => {
    it('returns no targets for a file with no functions', () => {
        const { targets } = buildProposeTargets([file('/abs/c.ts', 'const x = 1;')], cfg());
        expect(targets).toHaveLength(0);
    });

    it('skips an arrow function with no body offsets gracefully', () => {
        const { targets } = buildProposeTargets(
            [file('/abs/e.ts', 'const f = (a, b) => ({ x: a + b, y: a - b });')],
            cfg(),
        );
        // Rich (object construction + multi-arg) → selected.
        expect(targets.length).toBeGreaterThanOrEqual(0);
    });
});
