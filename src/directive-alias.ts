/*
 * The legacy-`llm` DIRECTIVE ALIAS — the second (and last) monkeypatch of the
 * Stryker instrumenter, beside `allMutators` (functional-architecture §3.4 / §5).
 *
 * WHY: every dynamic-LLM mutant is now named `Llm<Category>` (16 names) instead
 * of the single `llm`, so a directive can target one kind of change on a line.
 * Existing projects carry hundreds of `// Stryker disable next-line llm[: reason]`
 * directives (isambard: 579, incl. list forms like `llm, NumberLiteralValue` and
 * region forms `disable llm … restore llm`). Those must keep ignoring EVERY LLM
 * mutant on their line/region — and Stryker must still report those mutants as
 * `Ignored` with the directive's reason, not merely leave them absent.
 *
 * THE SEAM: Stryker's `DirectiveBookkeeper.prototype.processStrykerDirectives`
 * (`@stryker-mutator/instrumenter/dist/src/transformers/directive-bookkeeper.js`,
 * byte-identical in 9.6.1 and 10.0.0) destructures `{ loc, leadingComments }`
 * off the node it is handed, parses each comment `value` with a fixed regex,
 * and books an IgnoreRule / RestoreRule per name — exact-after-lowercase, `all`
 * being the only wildcard. Mutators cannot set `ignoreReason` themselves, and
 * there is no source/comment hook on the stock `stryker run` path, so the ONE
 * place to make `llm` mean "every category" is the comment TEXT the bookkeeper
 * reads. We wrap that prototype method ONCE (Symbol guard) and, only when a
 * leading comment is a Stryker directive mentioning `llm`, hand it a SUBSTITUTE
 * `{ ...node, leadingComments: [...] }` whose directive values have the name
 * list extended in place with the 16 category names ({@link expandLlmDirective},
 * pure). The real AST and the printed output are never modified; Stryker then
 * does its own bookkeeping on the expanded list, so `disable next-line llm:
 * reason`, list forms in either order, `disable llm … restore llm` regions and
 * `restore LlmNumber` inside a `disable llm` region all behave natively and are
 * reported by Stryker as `status: 'Ignored'` with the directive's reason.
 * `disable next-line LlmComparison` still ignores only that category.
 *
 * `excludedMutations` is a SEPARATE, case-sensitive exact-name check inside a
 * transformer-local closure the patch cannot reach, so a list containing `'llm'`
 * is expanded to the category list by {@link expandExcludedMutations} on BOTH
 * entry paths (`withLlmMutators` and `stryker-llm run`) before Stryker sees it.
 *
 * REGISTRATION: the no-op `llm` mutator stays registered alongside the 16
 * category mutators (static names, pushed before any instrumentation), so the
 * expanded list only ever names registered mutators and the bookkeeper's
 * "Unused directive" warning never fires.
 *
 * WHEN THE SEAM IS MISSING (module unresolvable or method absent after a Stryker
 * bump): {@link installLlmDirectiveAliasIntoStryker} logs a LOUD warning and
 * returns `false` — never throws — and the run proceeds. What is lost in that
 * state is only legacy plain-`llm` directive matching (those mutants surface as
 * live instead of Ignored); `Llm<Category>` and `all` directives and the
 * expanded `excludedMutations` keep working natively. The per-version canary
 * fails loudly in CI.
 *
 * Heuristics-only runs install nothing (see `with-llm-mutators.ts` / `run.ts`).
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LLM_CATEGORIES } from './pipeline/classify';

/** The legacy wildcard name a directive may carry (matched case-insensitively). */
const LEGACY_NAME = 'llm';

/**
 * Stryker's exact directive regex (`directive-bookkeeper.js`
 * `strykerCommentDirectiveRegex`): groups = type, scope, names, reason.
 */
const DIRECTIVE_REGEX = /^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/;

/** The cheap pre-check: a Stryker directive comment that mentions `llm` at all. */
const MAYBE_LLM_DIRECTIVE = /^\s?Stryker (?:disable|restore)\b/;

/**
 * Resolve the absolute path of the instrumenter's internal
 * `directive-bookkeeper.js` against the HOISTED `@stryker-mutator/instrumenter`
 * instance — the same technique as `resolveMutatePath()` (the package's
 * `exports` map does not expose it as a subpath).
 */
export function resolveDirectiveBookkeeperPath(): string {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve('@stryker-mutator/instrumenter/package.json');
    return join(dirname(pkgJsonPath), 'dist', 'src', 'transformers', 'directive-bookkeeper.js');
}

/**
 * Expand ONE directive comment value in place: when it is a Stryker
 * `disable|restore [next-line] <names>[: reason]` directive whose name list
 * contains a bare `llm` (case-insensitive), append every `category` not already
 * present (case-insensitive) after the existing names — which keep their
 * original order — and leave the `: reason` suffix, `all`, unrelated names and
 * any surrounding whitespace untouched. Any other value is returned unchanged.
 * PURE.
 */
export function expandLlmDirective(
    value: string,
    categories: readonly string[] = LLM_CATEGORIES,
): string {
    const match = DIRECTIVE_REGEX.exec(value);
    if (match === null) {
        return value;
    }
    const [, type, scope, names] = match as unknown as [string, string, string | undefined, string];
    const existing = names.split(',').map(name => name.trim());
    if (!existing.some(name => name.toLowerCase() === LEGACY_NAME)) {
        return value;
    }
    const lower = new Set(existing.map(name => name.toLowerCase()));
    const appended = categories.filter(category => !lower.has(category.toLowerCase()));
    const leading = /^\s*/.exec(names)?.[0] ?? '';
    const trailing = /\s*$/.exec(names)?.[0] ?? '';
    const list = [...existing, ...appended].join(', ');
    const offset =
        value.indexOf('Stryker') +
        'Stryker '.length +
        type.length +
        (scope === undefined ? 0 : scope.length + 1) +
        1;
    return `${value.slice(0, offset)}${leading}${list}${trailing}${value.slice(offset + names.length)}`;
}

/**
 * Expand an `excludedMutations` list: when it contains exactly `'llm'`
 * (case-sensitive, mirroring Stryker's own `includes` check), append every
 * `category` not already present; otherwise return a copy. PURE.
 */
export function expandExcludedMutations(
    excluded: readonly string[],
    categories: readonly string[] = LLM_CATEGORIES,
): string[] {
    if (!excluded.includes(LEGACY_NAME)) {
        return [...excluded];
    }
    const present = new Set(excluded);
    return [...excluded, ...categories.filter(category => !present.has(category))];
}

/** The slice of a babel node the bookkeeper destructures. */
export interface DirectiveNode {
    loc?: unknown;
    leadingComments?: ReadonlyArray<{ value: string }> | null;
}

/** The structural minimum of Stryker's `DirectiveBookkeeper` class we patch. */
export interface DirectiveBookkeeperClass {
    prototype: { processStrykerDirectives(node: DirectiveNode): void };
}

/** The once-only install guard, stable across package instances in one process. */
const INSTALLED = Symbol.for('@hughescr/stryker-llm-mutator/directive-alias');

/** Whether a comment is a Stryker directive that mentions `llm` (worth expanding). */
function mentionsLlm(comment: { value: string }): boolean {
    return MAYBE_LLM_DIRECTIVE.test(comment.value) && /llm/i.test(comment.value);
}

/**
 * Wrap `bookkeeper.prototype.processStrykerDirectives` once so every directive
 * naming a bare `llm` is booked as if it also named every `category`. Pure
 * apart from the prototype write; testable with a fake class.
 *
 * @returns `'installed'` on the first call, `'already-installed'` afterwards.
 */
export function installLlmDirectiveAlias(
    bookkeeper: DirectiveBookkeeperClass,
    categories: readonly string[] = LLM_CATEGORIES,
): 'installed' | 'already-installed' {
    const proto = bookkeeper.prototype as DirectiveBookkeeperClass['prototype'] & {
        [INSTALLED]?: true;
    };
    if (proto[INSTALLED] === true) {
        return 'already-installed';
    }
    const original = proto.processStrykerDirectives;
    proto.processStrykerDirectives = function processStrykerDirectivesWithLlmAlias(
        this: unknown,
        node: DirectiveNode,
    ): void {
        const comments = node.leadingComments;
        if (comments === undefined || comments === null || !comments.some(mentionsLlm)) {
            original.call(this, node);
            return;
        }
        const substitute: DirectiveNode = {
            ...node,
            leadingComments: comments.map(comment => ({
                ...comment,
                value: expandLlmDirective(comment.value, categories),
            })),
        };
        original.call(this, substitute);
    };
    Object.defineProperty(proto, INSTALLED, { value: true, enumerable: false });
    return 'installed';
}

/** Test seam for {@link installLlmDirectiveAliasIntoStryker}. */
export interface InstallLlmDirectiveAliasOptions {
    /** Override the module resolution (tests point it at a missing / methodless module). */
    resolvePath?: () => string;
}

/**
 * Resolve the real instrumenter `directive-bookkeeper.js` by runtime path,
 * dynamic-import it (a computed `file://` URL, so the bundler keeps it
 * external) and install the alias on its `DirectiveBookkeeper` class. Returns
 * `true` when the alias is (or already was) installed; on ANY failure — module
 * unresolvable, class or method missing — logs a loud warning through `log`
 * and returns `false`. Never throws.
 */
export async function installLlmDirectiveAliasIntoStryker(
    log?: (line: string) => void,
    options: InstallLlmDirectiveAliasOptions = {},
): Promise<boolean> {
    const warn = (detail: string): void => {
        log?.(
            "stryker-llm: WARNING directive alias not installed — plain 'llm' directives will " +
                'NOT suppress Llm* mutants (Stryker internals moved); write category names ' +
                `explicitly. (${detail})`,
        );
    };
    let modulePath: string;
    try {
        modulePath = (options.resolvePath ?? resolveDirectiveBookkeeperPath)();
    } catch (error) {
        warn(error instanceof Error ? error.message : String(error));
        return false;
    }
    let mod: { DirectiveBookkeeper?: unknown };
    try {
        mod = (await import(pathToFileURL(modulePath).href)) as { DirectiveBookkeeper?: unknown };
    } catch (error) {
        warn(
            `cannot import ${modulePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
    const bookkeeper = mod.DirectiveBookkeeper as Partial<DirectiveBookkeeperClass> | undefined;
    if (typeof bookkeeper?.prototype?.processStrykerDirectives !== 'function') {
        warn(`${modulePath} exports no DirectiveBookkeeper.prototype.processStrykerDirectives`);
        return false;
    }
    installLlmDirectiveAlias(bookkeeper as DirectiveBookkeeperClass);
    return true;
}
