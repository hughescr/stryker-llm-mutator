/**
 * oxlint JS plugin: test-hygiene
 *
 * Faithful port of @hughescr/eslint-plugin-test-hygiene (v1.0.0) to the oxlint
 * custom-JS-plugin API. These four rules are PURE-AST (ESTree-only, no
 * type-checker), so they port directly. Rule ids, options schemas, messages and
 * visitor logic mirror the upstream ESLint plugin.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Ported from @hughescr/eslint-plugin-test-hygiene
 *   https://github.com/hughescr/eslint-plugin-test-hygiene
 *   Copyright (c) 2026 Craig Hughes
 *   Licensed BSD-3-Clause. Redistributed here under the original BSD-3-Clause
 *   terms (attribution + disclaimer retained), within this Apache-2.0 project.
 *
 *   BSD 3-Clause License — Copyright (c) 2026 Craig Hughes
 *   Redistribution and use in source and binary forms, with or without
 *   modification, are permitted provided that the conditions of the
 *   BSD-3-Clause license are met. THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT
 *   WARRANTY OF ANY KIND. See the upstream LICENSE.md for the full text.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * oxlint custom JS plugins expose ESTree-style AST visitors + scope analysis,
 * but NO TypeScript parser services / type-checker (context.sourceCode
 * .parserServices is empty). The four rules below need none of that.
 */

import type { Plugin, Rule } from 'oxlint/plugins-dev';

// ── Shared AST helpers (untyped — oxlint hands us plain ESTree nodes) ────────

/* eslint-disable @typescript-eslint/no-explicit-any -- oxlint passes plain ESTree nodes without TS types */
type AnyNode = any;

function isFunctionLike(node: AnyNode): boolean {
    return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';
}

/** Match `<object>.<property>(...)` call expressions. */
function isMemberCall(node: AnyNode, objectName: string, propertyName: string): boolean {
    return (
        node?.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        node.callee.object?.type === 'Identifier' &&
        node.callee.object.name === objectName &&
        node.callee.property?.type === 'Identifier' &&
        node.callee.property.name === propertyName
    );
}

/** Match a bare-identifier call `<name>(...)` (e.g. hook calls like afterEach()). */
function isIdentifierCall(node: AnyNode, name: string): boolean {
    return (
        node?.type === 'CallExpression' &&
        node.callee?.type === 'Identifier' &&
        node.callee.name === name
    );
}

const SKIP_KEYS = new Set(['parent', 'loc', 'start', 'end', 'range', 'tokens', 'comments']);

/** Generic recursive ESTree walker (mirrors upstream require-mock-cleanup walk). */
function walk(node: AnyNode, visitor: (n: AnyNode) => void): void {
    if (!node || typeof node !== 'object') {
        return;
    }
    visitor(node);
    for (const key of Object.keys(node)) {
        if (SKIP_KEYS.has(key)) {
            continue;
        }
        const child = node[key];
        if (Array.isArray(child)) {
            for (const item of child) {
                if (item && typeof item === 'object' && item.type) {
                    walk(item, visitor);
                }
            }
        } else if (child && typeof child === 'object' && child.type) {
            walk(child, visitor);
        }
    }
}

// ── Rule 1: no-mock-module-in-test-body ─────────────────────────────────────

const noMockModuleInTestBody: Rule = {
    meta: {
        type: 'problem',
        docs: { description: 'Disallow mock.module() calls outside designated setup files' },
        messages: {
            noMockModuleOutsideSetup:
                'mock.module() is global and order-dependent — declare shared mocks only in the designated setup file(s) ({{setupFiles}}). For per-test mock overrides, use spyOn() or mock().mockImplementation().',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    setupFiles: {
                        type: 'array',
                        minItems: 1,
                        items: { type: 'string', minLength: 1 },
                    },
                },
                additionalProperties: false,
            },
        ],
        defaultOptions: [{ setupFiles: ['tests/setup.ts'] }],
    },
    create(context) {
        const opts = (context.options[0] as { setupFiles?: string[] } | undefined) ?? {};
        const setupFiles = opts.setupFiles ?? ['tests/setup.ts'];
        const filename = context.filename;

        // Configured setup files are exempt — canonical home for module mocks.
        if (setupFiles.some(f => filename.endsWith(f))) {
            return {};
        }

        return {
            CallExpression(node: AnyNode) {
                if (isMemberCall(node, 'mock', 'module')) {
                    context.report({
                        node,
                        messageId: 'noMockModuleOutsideSetup',
                        data: { setupFiles: setupFiles.join(', ') },
                    });
                }
            },
        };
    },
};

// ── Rule 2: require-fake-timers-cleanup ─────────────────────────────────────

const HOOK_PAIRS: Record<string, string> = { beforeEach: 'afterEach', beforeAll: 'afterAll' };

function isUseFakeTimersCall(node: AnyNode): boolean {
    return isMemberCall(node, 'jest', 'useFakeTimers');
}
function isUseRealTimersCall(node: AnyNode): boolean {
    return isMemberCall(node, 'jest', 'useRealTimers');
}
function isTestCall(node: AnyNode): boolean {
    return (
        node?.type === 'CallExpression' &&
        node.callee?.type === 'Identifier' &&
        (node.callee.name === 'it' || node.callee.name === 'test')
    );
}
function isDescribeCall(node: AnyNode): boolean {
    return (
        node?.type === 'CallExpression' &&
        node.callee?.type === 'Identifier' &&
        (node.callee.name === 'describe' ||
            node.callee.name === 'fdescribe' ||
            node.callee.name === 'xdescribe')
    );
}
function bodyContainsFakeTimers(body: AnyNode): boolean {
    if (body?.type !== 'BlockStatement') {
        return false;
    }
    return body.body.some(
        (stmt: AnyNode) =>
            stmt.type === 'ExpressionStatement' &&
            stmt.expression?.type === 'CallExpression' &&
            isUseFakeTimersCall(stmt.expression),
    );
}
function callbackContainsUseRealTimers(callback: AnyNode): boolean {
    if (!callback || !isFunctionLike(callback)) {
        return false;
    }
    const body = callback.body;
    if (body.type !== 'BlockStatement') {
        return isUseRealTimersCall(body);
    }
    return body.body.some(
        (stmt: AnyNode) =>
            stmt.type === 'ExpressionStatement' && isUseRealTimersCall(stmt.expression),
    );
}
function findCleanupHooksAt(stmts: AnyNode[], cleanupHookName: string): AnyNode[] {
    return stmts.filter(
        (stmt: AnyNode) =>
            stmt.type === 'ExpressionStatement' &&
            isIdentifierCall(stmt.expression, cleanupHookName),
    );
}
function cleanupHooksHaveUseRealTimers(hookStmts: AnyNode[]): boolean {
    return hookStmts.some((stmt: AnyNode) => {
        const call = stmt.expression;
        if (call.type !== 'CallExpression' || call.arguments.length === 0) {
            return false;
        }
        return callbackContainsUseRealTimers(call.arguments[0]);
    });
}

const requireFakeTimersCleanup: Rule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require jest.useRealTimers() cleanup when jest.useFakeTimers() is used in a hook or test body',
        },
        messages: {
            missingCleanup:
                'jest.useFakeTimers() in {{hookKind}} at line {{line}} has no matching jest.useRealTimers() in the corresponding cleanup hook. Add it to avoid fake-timer leakage.',
        },
        schema: [],
    },
    create(context) {
        function processBlock(stmts: AnyNode[], enclosingAfterEachChain: AnyNode[]): void {
            for (const stmt of stmts) {
                if (stmt.type !== 'ExpressionStatement') {
                    continue;
                }
                const call = stmt.expression;

                for (const [hookName, cleanupName] of Object.entries(HOOK_PAIRS)) {
                    if (!isIdentifierCall(call, hookName)) {
                        continue;
                    }
                    if (call.type !== 'CallExpression' || call.arguments.length === 0) {
                        continue;
                    }
                    const callback = call.arguments[0];
                    if (!callback || !isFunctionLike(callback)) {
                        continue;
                    }
                    if (!bodyContainsFakeTimers(callback.body)) {
                        continue;
                    }
                    const cleanupHooks = findCleanupHooksAt(stmts, cleanupName);
                    if (cleanupHooksHaveUseRealTimers(cleanupHooks)) {
                        continue;
                    }
                    context.report({
                        node: call,
                        messageId: 'missingCleanup',
                        data: { hookKind: hookName, line: String(call.loc.start.line) },
                    });
                }

                if (
                    isTestCall(call) &&
                    call.type === 'CallExpression' &&
                    call.arguments.length >= 2
                ) {
                    const callback = call.arguments[call.arguments.length - 1];
                    if (!callback || !isFunctionLike(callback)) {
                        continue;
                    }
                    if (!bodyContainsFakeTimers(callback.body)) {
                        continue;
                    }
                    const siblingsAfterEach = findCleanupHooksAt(stmts, 'afterEach');
                    const allAfterEach = [...siblingsAfterEach, ...enclosingAfterEachChain];
                    const hasEnclosingCleanup = allAfterEach.some((hookStmt: AnyNode) => {
                        const hookCall = hookStmt.expression;
                        if (hookCall.type !== 'CallExpression' || hookCall.arguments.length === 0) {
                            return false;
                        }
                        return callbackContainsUseRealTimers(hookCall.arguments[0]);
                    });
                    if (hasEnclosingCleanup) {
                        continue;
                    }
                    context.report({
                        node: call,
                        messageId: 'missingCleanup',
                        data: { hookKind: 'test body', line: String(call.loc.start.line) },
                    });
                }

                if (
                    isDescribeCall(call) &&
                    call.type === 'CallExpression' &&
                    call.arguments.length >= 2
                ) {
                    const callback = call.arguments[call.arguments.length - 1];
                    if (!callback || !isFunctionLike(callback)) {
                        continue;
                    }
                    if (callback.body.type !== 'BlockStatement') {
                        continue;
                    }
                    const thisLevelAfterEach = findCleanupHooksAt(stmts, 'afterEach');
                    processBlock(callback.body.body, [
                        ...enclosingAfterEachChain,
                        ...thisLevelAfterEach,
                    ]);
                }
            }
        }

        return {
            'Program:exit'(programNode: AnyNode) {
                processBlock(programNode.body, []);
            },
        };
    },
};

// ── Rule 3: require-mock-cleanup ────────────────────────────────────────────

function isSpyOnCall(node: AnyNode): boolean {
    return isMemberCall(node, 'jest', 'spyOn');
}
function hasMockRestoreCall(node: AnyNode): boolean {
    return (
        node?.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        node.callee.property?.type === 'Identifier' &&
        node.callee.property.name === 'mockRestore'
    );
}
function hasRestoreInCallback(callback: AnyNode): boolean {
    let found = false;
    walk(callback, (node: AnyNode) => {
        if (found) {
            return;
        }
        // jest.restoreAllMocks()
        if (isMemberCall(node, 'jest', 'restoreAllMocks')) {
            found = true;
            return;
        }
        // for (const spy of spies) { spy.mockRestore() }
        if (node.type === 'ForOfStatement') {
            walk(node.body, (inner: AnyNode) => {
                if (hasMockRestoreCall(inner)) {
                    found = true;
                }
            });
        }
        // spies.forEach(spy => spy.mockRestore())
        if (
            node.type === 'CallExpression' &&
            node.callee?.type === 'MemberExpression' &&
            node.callee.property?.type === 'Identifier' &&
            node.callee.property.name === 'forEach' &&
            node.arguments.length > 0
        ) {
            const cb = node.arguments[0];
            if (cb) {
                walk(cb, (inner: AnyNode) => {
                    if (hasMockRestoreCall(inner)) {
                        found = true;
                    }
                });
            }
        }
    });
    return found;
}
function hasRestoreAfterEach(body: AnyNode[]): boolean {
    let found = false;
    walk({ type: 'Program', body, sourceType: 'module', comments: [] }, (node: AnyNode) => {
        if (found) {
            return;
        }
        if (
            node.type === 'CallExpression' &&
            node.callee?.type === 'Identifier' &&
            node.callee.name === 'afterEach' &&
            node.arguments.length > 0
        ) {
            const firstArg = node.arguments[0];
            if (firstArg && hasRestoreInCallback(firstArg)) {
                found = true;
            }
        }
    });
    return found;
}

const requireMockCleanup: Rule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require jest.restoreAllMocks() or mockRestore() cleanup when spyOn is used',
        },
        messages: {
            missingRestore:
                'spyOn() used without jest.restoreAllMocks() in an afterEach. Spies leak across tests. Add jest.restoreAllMocks() to an afterEach, or use a tracked spies array with mockRestore() cleanup.',
        },
        schema: [],
    },
    create(context) {
        let firstSpyOnNode: AnyNode = null;
        return {
            CallExpression(node: AnyNode) {
                if (firstSpyOnNode === null && isSpyOnCall(node)) {
                    firstSpyOnNode = node;
                }
            },
            'Program:exit'(programNode: AnyNode) {
                if (firstSpyOnNode === null) {
                    return;
                }
                if (!hasRestoreAfterEach(programNode.body)) {
                    context.report({ node: firstSpyOnNode, messageId: 'missingRestore' });
                }
            },
        };
    },
};

// ── Rule 4: require-mock-reset ──────────────────────────────────────────────

export function isSetupImport(source: string, setupModules: string[]): boolean {
    return setupModules.some(
        name => source === `./${name}` || source === `../${name}` || source.endsWith(`/${name}`),
    );
}

function collectCallsInNode(node: AnyNode, names: Set<string>): void {
    if (!node || !isFunctionLike(node)) {
        return;
    }
    const body = node.body;
    // Arrow with expression body: () => resetMockFs()
    if (body.type === 'CallExpression') {
        if (body.callee?.type === 'Identifier') {
            names.add(body.callee.name);
        }
        return;
    }
    if (body.type === 'BlockStatement') {
        for (const stmt of body.body) {
            if (stmt.type === 'ExpressionStatement' && stmt.expression?.type === 'CallExpression') {
                const callee = stmt.expression.callee;
                if (callee?.type === 'Identifier') {
                    names.add(callee.name);
                }
            }
        }
    }
}

function collectAfterEachResets(body: AnyNode[]): Set<string> {
    const resetNames = new Set<string>();

    function visitNode(node: AnyNode): void {
        if (!node) {
            return;
        }
        if (node.type === 'ExpressionStatement' && node.expression?.type === 'CallExpression') {
            const call = node.expression;
            if (
                call.callee?.type === 'Identifier' &&
                (call.callee.name === 'afterEach' || call.callee.name === 'afterAll') &&
                call.arguments.length > 0
            ) {
                const callback = call.arguments[0];
                if (callback) {
                    collectCallsInNode(callback, resetNames);
                }
            }
            // Recurse into describe blocks
            if (
                call.callee?.type === 'Identifier' &&
                (call.callee.name === 'describe' ||
                    call.callee.name === 'fdescribe' ||
                    call.callee.name === 'xdescribe') &&
                call.arguments.length >= 2
            ) {
                const callback = call.arguments[call.arguments.length - 1];
                if (
                    callback &&
                    isFunctionLike(callback) &&
                    callback.body.type === 'BlockStatement'
                ) {
                    for (const stmt of callback.body.body) {
                        visitNode(stmt);
                    }
                }
            }
        }
    }

    for (const stmt of body) {
        visitNode(stmt);
    }
    return resetNames;
}

const requireMockReset: Rule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require reset helpers for mocks imported from setup modules in afterEach',
        },
        messages: {
            missingReset:
                "'{{identifier}}' imported from setup module without a matching {{resetFn}} call in an afterEach or afterAll — mock state will leak across tests.",
        },
        schema: [
            {
                type: 'object',
                properties: {
                    mocks: {
                        type: 'object',
                        propertyNames: { minLength: 1 },
                        additionalProperties: {
                            type: 'array',
                            minItems: 1,
                            items: { type: 'string', minLength: 1 },
                        },
                    },
                    setupModules: {
                        type: 'array',
                        minItems: 1,
                        items: { type: 'string', minLength: 1 },
                    },
                },
                required: ['mocks'],
                additionalProperties: false,
            },
        ],
        defaultOptions: [{ mocks: {}, setupModules: ['setup'] }],
    },
    create(context) {
        const opts =
            (context.options[0] as
                | { mocks?: Record<string, string[]>; setupModules?: string[] }
                | undefined) ?? {};
        const mockResetMap = opts.mocks ?? {};
        const setupModules = opts.setupModules ?? ['setup'];
        const trackedImports: { name: string; node: AnyNode }[] = [];

        return {
            ImportDeclaration(node: AnyNode) {
                const sourceValue = node.source.value;
                if (typeof sourceValue !== 'string' || !isSetupImport(sourceValue, setupModules)) {
                    return;
                }
                for (const specifier of node.specifiers) {
                    if (specifier.type === 'ImportSpecifier') {
                        const name =
                            specifier.imported.type === 'Identifier'
                                ? specifier.imported.name
                                : specifier.imported.value;
                        if (name in mockResetMap) {
                            trackedImports.push({ name, node: specifier });
                        }
                    }
                }
            },
            'Program:exit'(programNode: AnyNode) {
                if (trackedImports.length === 0) {
                    return;
                }
                const afterEachResets = collectAfterEachResets(programNode.body);
                for (const { name, node } of trackedImports) {
                    const resets = mockResetMap[name];
                    if (!resets) {
                        continue;
                    }
                    const hasReset = resets.some(r => afterEachResets.has(r));
                    if (!hasReset) {
                        const description = `${resets.join(' or ')}()`;
                        context.report({
                            node,
                            messageId: 'missingReset',
                            data: { identifier: name, resetFn: description },
                        });
                    }
                }
            },
        };
    },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Plugin export ───────────────────────────────────────────────────────────

const plugin: Plugin = {
    meta: { name: 'test-hygiene' },
    rules: {
        'no-mock-module-in-test-body': noMockModuleInTestBody,
        'require-fake-timers-cleanup': requireFakeTimersCleanup,
        'require-mock-cleanup': requireMockCleanup,
        'require-mock-reset': requireMockReset,
    },
};

export default plugin;
