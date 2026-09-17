/*
 * Content-addressed LLM response cache.
 *
 * Mutation scores produced by an LLM are non-reproducible run-to-run (no
 * temperature control + agentic nondeterminism — see `docs/development-plan.md`
 * §7). The mitigation is a content-addressed cache: a request is identified by
 * the SHA-256 of `(model + prompt + system + serialized schema)`, so a WARM run returns
 * the exact same validated object it returned before and the mutation score is
 * stable. A COLD run on a changed span may differ — that is documented and
 * expected. The pre-pass fills the `prompt` slot with the function's STRUCTURAL
 * fingerprint (`src/pipeline/propose.ts` `proposeCacheIdentity`), not its
 * verbatim text, so comment / formatting edits keep hitting the same entry.
 *
 * This module is PURE and OFFLINE: it only touches the filesystem under the
 * configured cache directory and never makes a network call, so it is fully
 * unit-testable without a live model.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The identity inputs that define a cache entry. Two requests with the same
 * model, prompt, system instructions and schema are considered the same call and share a cache slot.
 * The schema is included because changing the requested shape changes the model
 * output, so it must change the key.
 */
export interface CacheKeyParts {
    /**
     * The requested model id or alias (e.g. `haiku`). The exact requested string
     * enters the key, so an alias keeps hitting its existing cache entries even
     * when the provider later resolves fresh requests to a newer model snapshot.
     */
    model: string;
    /** The fully-rendered prompt string. */
    prompt: string;
    /** Optional system instructions that can change the requested behavior. */
    system?: string;
    /** The JSON Schema the response must conform to. */
    schema: Record<string, unknown>;
}

/**
 * Provenance recorded on entries written under the FINGERPRINT-keyed scheme
 * (`src/pipeline/fingerprint.ts`). Purely informational — the key is still the
 * request's `cacheKey` — but it lets a human (or a migration) tell which
 * function an entry belongs to without recomputing anything. Absent on entries
 * written by older versions; readers must tolerate that.
 */
export interface CacheEntryMeta {
    /** The structural fingerprint of the function text the entry was proposed for. */
    fingerprint: string;
    /** The absolute file the function lived in when the entry was written. */
    fileName?: string;
    /** The function's name when it has one (declarations, methods). */
    functionName?: string;
}

/**
 * The on-disk shape of one cached entry. Stores the validated value plus the
 * call metadata reporting needs so a cache hit reconstructs a full result
 * without a fresh model call.
 */
export interface CacheEntry<T = unknown> {
    /** The schema-validated value the provider returned. */
    value: T;
    /** Cost in USD of the ORIGINAL call that produced this entry. */
    costUsd: number;
    /** The model id that actually served the original call. */
    model: string;
    /** Raw model text before parsing, when the original call exposed it. */
    rawText?: string;
    /** Fingerprint provenance; written on new entries, absent on legacy ones. */
    meta?: CacheEntryMeta;
}

/**
 * Stable JSON serialization with object keys sorted recursively, so that two
 * schemas that are structurally equal but were authored with keys in a
 * different order hash to the SAME cache key. Without this, key ordering would
 * leak into the digest and cause spurious cache misses.
 */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
        key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(',')}}`;
}

/**
 * Compute the content-addressed cache key for a request: the hex SHA-256 of the
 * model, prompt, system instructions and stably-serialized schema joined by delimiters that cannot
 * occur in the inputs themselves. Deterministic: identical inputs always yield
 * an identical key, across processes and machines.
 */
export function computeCacheKey(parts: CacheKeyParts): string {
    const hash = createHash('sha256');
    hash.update(parts.model);
    hash.update('\0');
    hash.update(parts.prompt);
    hash.update('\0');
    hash.update(parts.system ?? '');
    hash.update('\0');
    hash.update(stableStringify(parts.schema));
    return hash.digest('hex');
}

/**
 * A small content-addressed JSON-file cache rooted at a single directory. Each
 * entry lives in its own `<key>.json` file, so reads and writes are independent
 * and the cache can be shared or committed (development-plan §8 open question
 * #4) without a central index file to contend on.
 */
export class ResponseCache {
    readonly #dir: string;

    /**
     * @param dir Directory under which cache files are stored. Created lazily on
     *   the first {@link set}. Relative paths resolve against the process cwd —
     *   callers pass the configured `cacheDir` (default `.stryker-llm-cache`).
     */
    constructor(dir: string) {
        this.#dir = dir;
    }

    /** Absolute-or-relative path of the JSON file backing a given key. */
    #pathForKey(key: string): string {
        return join(this.#dir, `${key}.json`);
    }

    /**
     * Look up a cached entry by its precomputed key. Resolves to the stored
     * {@link CacheEntry} on a hit, or `undefined` on a miss (including when the
     * cache directory does not exist yet). A corrupt/unparseable file is treated
     * as a miss rather than throwing, so a damaged cache degrades to a cold run.
     */
    async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
        let raw: string;
        try {
            raw = await readFile(this.#pathForKey(key), 'utf8');
        } catch {
            return undefined;
        }
        try {
            return JSON.parse(raw) as CacheEntry<T>;
        } catch {
            return undefined;
        }
    }

    /**
     * Store an entry under its key, creating the cache directory if needed. The
     * write is atomic-ish per file (a single `writeFile`); entries never share a
     * file so concurrent writes to distinct keys do not clobber each other.
     */
    async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
        const filePath = this.#pathForKey(key);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, `${JSON.stringify(entry, null, 4)}\n`, 'utf8');
    }

    /**
     * Every key currently stored: ONE directory listing (not a stat per probe),
     * so a caller that must ask "is this target cached?" for thousands of
     * targets does it against an in-memory set. An absent cache directory is an
     * empty set. Only `<key>.json` files count; other files are ignored.
     */
    async keys(): Promise<Set<string>> {
        let names: string[];
        try {
            names = await readdir(this.#dir);
        } catch {
            return new Set();
        }
        const keys = new Set<string>();
        for (const name of names) {
            if (name.endsWith('.json')) {
                keys.add(name.slice(0, -'.json'.length));
            }
        }
        return keys;
    }

    /**
     * Convenience over {@link computeCacheKey} + {@link get}: look up by the
     * request's content parts directly.
     */
    async getByParts<T>(parts: CacheKeyParts): Promise<CacheEntry<T> | undefined> {
        return this.get<T>(computeCacheKey(parts));
    }

    /**
     * Convenience over {@link computeCacheKey} + {@link set}: store by the
     * request's content parts directly.
     */
    async setByParts<T>(parts: CacheKeyParts, entry: CacheEntry<T>): Promise<void> {
        return this.set<T>(computeCacheKey(parts), entry);
    }
}
