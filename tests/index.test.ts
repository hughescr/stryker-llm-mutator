import { describe, expect, it } from 'bun:test';

import { strykerPlugins, VERSION } from '../src/index';

describe('@hughescr/stryker-llm-mutator placeholder entry', () => {
    it('exposes a version marker', () => {
        expect(VERSION).toBe('0.1.0');
    });

    it('exposes an (empty for now) strykerPlugins array', () => {
        expect(Array.isArray(strykerPlugins)).toBe(true);
        expect(strykerPlugins).toHaveLength(0);
    });
});
