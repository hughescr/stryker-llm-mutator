import {
    cloneNode,
    identifier,
    isArrayExpression,
    isIdentifier,
    isMemberExpression,
} from '@babel/types';

import type { NodeMutator } from './types';

const SWAP_TABLE: Readonly<Record<string, string>> = { push: 'unshift', unshift: 'push' };

/** Swap insertion end while preserving every argument and its order. */
export const arrayMethodSwapMutator: NodeMutator = {
    name: 'ArrayMethodSwap',

    *mutate(path) {
        if (!path.isCallExpression()) {
            return;
        }
        const { node } = path;
        const { callee } = node;
        if (
            node.optional === true ||
            node.arguments.length === 0 ||
            !isMemberExpression(callee) ||
            callee.computed ||
            callee.optional === true ||
            !isIdentifier(callee.property) ||
            !Object.hasOwn(SWAP_TABLE, callee.property.name) ||
            (isArrayExpression(callee.object) && callee.object.elements.length === 0)
        ) {
            return;
        }

        const replacement = cloneNode(node, true);
        const replacementCallee = replacement.callee;
        if (!isMemberExpression(replacementCallee)) {
            return;
        }
        const swapName = SWAP_TABLE[callee.property.name];
        if (swapName === undefined) {
            return;
        }
        replacementCallee.property = identifier(swapName);
        yield replacement;
    },
};
