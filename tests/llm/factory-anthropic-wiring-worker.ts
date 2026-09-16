/*
 * Offline worker for the production Anthropic factory regression. Bun's
 * `mock.module` is process-global, so this runs in its own process: it can replace
 * the Agent SDK before loading the factory without affecting any other test file.
 */

import { mock } from 'bun:test';

interface CapturedCall {
    prompt: string;
    options: {
        model?: unknown;
        outputFormat?: unknown;
        thinking?: unknown;
    };
}

let captured: CapturedCall | undefined;

// oxlint-disable-next-line test-hygiene/no-mock-module-in-test-body -- this entire worker is a disposable subprocess, so its process-global mock cannot leak.
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    query(call: CapturedCall) {
        captured = call;
        return (async function* () {
            yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                result: '{"answer":42}',
                structured_output: { answer: 42 },
                total_cost_usd: 0,
                modelUsage: { 'claude-factory-wiring-test': {} },
                usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                },
            };
        })();
    },
}));

async function run(): Promise<void> {
    const [{ llmMutatorConfigSchema }, { createProvider }] = await Promise.all([
        import('../../src/config'),
        import('../../src/llm/factory'),
    ]);
    const schema = {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'number' } },
    };
    const provider = createProvider(
        llmMutatorConfigSchema.parse({
            provider: 'anthropic-agent-sdk',
            model: 'claude-factory-wiring-test',
        }),
    );
    const result = await provider.generate({ prompt: 'Return the answer.', schema });
    if (!captured) {
        throw new Error('mock Agent SDK query was not called');
    }

    process.stdout.write(
        JSON.stringify({
            model: captured.options.model,
            outputFormat: captured.options.outputFormat,
            thinking: captured.options.thinking,
            value: result.value,
        }),
    );
}

try {
    await run();
} catch (error) {
    process.stdout.write(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
}
