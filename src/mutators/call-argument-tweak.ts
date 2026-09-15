import {
    cloneNode,
    type Expression,
    isExpression,
    isArrayExpression,
    isIdentifier,
    isMemberExpression,
    isNodesEquivalent,
    isStringLiteral,
} from '@babel/types';

import type { NodeMutator } from './types';

/** Swap the two bounds of a plain, two-argument `.slice(start, end)` call. */
export const callArgumentTweakMutator: NodeMutator = {
    name: 'CallArgumentTweak',

    *mutate(path) {
        if (!path.isCallExpression()) {
            return;
        }
        const { node } = path;
        const { callee } = node;
        if (
            node.optional === true ||
            !isMemberExpression(callee) ||
            callee.computed ||
            callee.optional === true ||
            (isArrayExpression(callee.object) && callee.object.elements.length === 0) ||
            (isStringLiteral(callee.object) && callee.object.value.length === 0) ||
            !isIdentifier(callee.property, { name: 'slice' }) ||
            node.arguments.length !== 2
        ) {
            return;
        }

        const [first, second] = node.arguments;
        if (
            !isExpression(first) ||
            !isExpression(second) ||
            isNodesEquivalent(first as Expression, second as Expression)
        ) {
            return;
        }

        const replacement = cloneNode(node, true);
        replacement.arguments = [cloneNode(second, true), cloneNode(first, true)];
        yield replacement;
    },
};
