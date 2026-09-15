import {
    cloneNode,
    identifier,
    isArrayExpression,
    isExpression,
    isIdentifier,
    isMemberExpression,
    isSpreadElement,
} from '@babel/types';

import type { NodeMutator } from './types';

const SWAP_TABLE: Readonly<Record<string, readonly string[]>> = {
    all: ['allSettled', 'race'],
    allSettled: ['all'],
    race: ['all'],
    any: ['all'],
};

/** Swap an unshadowed global Promise combinator only when its awaited value is discarded. */
export const promiseCombinatorSwapMutator: NodeMutator = {
    name: 'PromiseCombinatorSwap',

    // The explicit conditions are the safety boundary for this deliberately narrow mutator.
    // oxlint-disable-next-line eslint/complexity
    *mutate(path) {
        if (!path.isCallExpression()) {
            return;
        }
        const { node } = path;
        const { callee } = node;
        const awaitPath = path.parentPath;
        if (
            node.optional === true ||
            !isMemberExpression(callee) ||
            callee.computed ||
            callee.optional === true ||
            !isIdentifier(callee.object, { name: 'Promise' }) ||
            !isIdentifier(callee.property) ||
            !Object.hasOwn(SWAP_TABLE, callee.property.name) ||
            node.arguments.length !== 1 ||
            !isExpression(node.arguments[0]) ||
            !awaitPath?.isAwaitExpression() ||
            awaitPath.node.argument !== node ||
            !awaitPath.parentPath?.isExpressionStatement() ||
            path.scope?.getBinding === undefined ||
            path.scope.getBinding('Promise') !== undefined
        ) {
            return;
        }

        const knownCardinality =
            isArrayExpression(node.arguments[0]) &&
            !node.arguments[0].elements.some(element => isSpreadElement(element))
                ? node.arguments[0].elements.length
                : undefined;
        if (knownCardinality === 0 && callee.property.name === 'all') {
            return;
        }

        const swapNames = SWAP_TABLE[callee.property.name];
        if (swapNames === undefined) {
            return;
        }
        for (const swapName of swapNames) {
            if (
                knownCardinality === 1 &&
                ((callee.property.name === 'all' && swapName === 'race') ||
                    (callee.property.name === 'race' && swapName === 'all'))
            ) {
                continue;
            }
            const replacement = cloneNode(node, true);
            const replacementCallee = replacement.callee;
            if (!isMemberExpression(replacementCallee)) {
                return;
            }
            replacementCallee.property = identifier(swapName);
            yield replacement;
        }
    },
};
