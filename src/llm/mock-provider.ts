/*
 * Deterministic, offline mock LLM provider.
 *
 * Every offline unit test in this project injects a {@link MockProvider}
 * instead of a real backend (see `docs/development-plan.md` §4.1 mockability
 * constraint + §5 network note). It returns CANNED, schema-shaped objects keyed
 * by prompt (or computed by a caller-supplied callback) with a fixed cost, and
 * NEVER touches the network. Because callers only ever see the
 * {@link LLMProvider} interface, swapping the real Anthropic provider for this
 * mock requires no branching anywhere in the pipeline.
 *
 * The mock deliberately does NOT validate its canned responses against
 * `request.schema`: the test author is responsible for supplying schema-valid
 * fixtures. The real providers are the runtime schema authority; the mock's job
 * is to be a predictable stand-in.
 */

import type { LLMProvider, ProviderRequest, ProviderResult } from './types';

/**
 * A function that produces a canned response for a given request. Lets a test
 * compute a response from the prompt/schema instead of pre-registering a fixed
 * map entry — useful for asserting the provider is called with the expected
 * prompt, or for returning per-call-varying shapes.
 */
export type MockResponder = (request: ProviderRequest) => unknown;

/** Construction options for {@link MockProvider}. */
export interface MockProviderOptions {
    /**
     * Canned responses keyed by the EXACT prompt string. A request whose
     * `prompt` matches a key resolves with the mapped value. Consulted before
     * {@link MockProviderOptions.responder}.
     */
    responses?: Record<string, unknown>;
    /**
     * Fallback responder consulted when no `responses` entry matches the
     * prompt. When neither matches, {@link MockProvider.generate} rejects so a
     * test never silently passes on an unexpected prompt.
     */
    responder?: MockResponder;
    /**
     * Fixed cost in US dollars reported on every result. Defaults to `0`
     * (a mock makes no real call, so zero spend is the honest default), but a
     * test can set a non-zero value to exercise cost-accumulation logic.
     */
    costUsd?: number;
    /**
     * Model id reported on every result. Defaults to the request's `model` when
     * present, else `mock-model`. Lets a test assert model propagation.
     */
    model?: string;
}

/**
 * In-memory {@link LLMProvider} for offline tests. Deterministic: the same
 * request always yields the same result, with no randomness, no clock, and no
 * network. Records every request it received on {@link MockProvider.calls} so a
 * test can assert what the pipeline asked for.
 */
export class MockProvider implements LLMProvider {
    readonly name = 'mock';

    readonly #responses: Record<string, unknown>;
    readonly #responder?: MockResponder;
    readonly #costUsd: number;
    readonly #model?: string;

    /** Every request passed to {@link generate}, in call order, for assertions. */
    readonly calls: ProviderRequest[] = [];

    constructor(options: MockProviderOptions = {}) {
        this.#responses = options.responses ?? {};
        this.#responder = options.responder;
        this.#costUsd = options.costUsd ?? 0;
        this.#model = options.model;
    }

    /**
     * Resolve the canned response for `request`, honoring a fired abort signal
     * first, then the prompt map, then the responder callback. Rejects when the
     * signal is already aborted, or when no canned response matches — never
     * makes a network call.
     */
    async generate<T>(request: ProviderRequest): Promise<ProviderResult<T>> {
        this.calls.push(request);

        if (request.signal?.aborted) {
            throw new Error('MockProvider.generate: request aborted');
        }

        let value: unknown;
        if (Object.hasOwn(this.#responses, request.prompt)) {
            value = this.#responses[request.prompt];
        } else if (this.#responder) {
            value = this.#responder(request);
        } else {
            throw new Error(
                `MockProvider.generate: no canned response for prompt ${JSON.stringify(request.prompt)}`,
            );
        }

        const model = this.#model ?? request.model ?? 'mock-model';
        return {
            value: value as T,
            costUsd: this.#costUsd,
            model,
            cached: false,
        };
    }
}
