/*
 * Offline unit tests for the provider factory.
 *
 * Constructs each provider branch WITHOUT making a network call. The production
 * Anthropic wiring is exercised in an isolated Bun subprocess whose Agent SDK
 * module is mocked before the factory loads, so the exact SDK options are visible
 * without leaking a global module mock into the rest of the suite. The mock branch is fully offline;
 * the `openai` / `openai-compatible` branches construct the dependency-free
 * OpenAI-compatible provider with the expected `name`; the one remaining
 * not-implemented branch (`anthropic-api`) asserts the thrown error. No live
 * query() / fetch() is ever invoked here (that is the human-run live smoke test).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'bun:test';

import { llmMutatorConfigSchema, type LlmMutatorConfig } from '../../src/config';
import { createProvider } from '../../src/llm/factory';
import { OpenAiCompatibleProvider } from '../../src/llm/openai-compatible-provider';
import { NotImplementedError } from '../../src/driver/gate';

const ANTHROPIC_WIRING_WORKER = fileURLToPath(
    new URL('./factory-anthropic-wiring-worker.ts', import.meta.url),
);

interface AnthropicWiringResult {
    model: unknown;
    outputFormat: unknown;
    thinking: unknown;
    value: unknown;
    error?: string;
}

/** Run the SDK-mocked worker in a fresh process so `mock.module` cannot leak. */
function runAnthropicWiringWorker(): Promise<AnthropicWiringResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ANTHROPIC_WIRING_WORKER], {
            env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'offline-test-token' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.on('error', error => {
            reject(new Error(`Failed to spawn Anthropic wiring worker: ${error.message}`));
        });
        child.on('close', code => {
            let parsed: AnthropicWiringResult;
            try {
                parsed = JSON.parse(stdout) as AnthropicWiringResult;
            } catch {
                reject(
                    new Error(
                        `Anthropic wiring worker emitted invalid JSON (exit ${String(code)}): ${stdout || stderr}`,
                    ),
                );
                return;
            }
            if (parsed.error) {
                reject(new Error(`Anthropic wiring worker failed: ${parsed.error}`));
                return;
            }
            if (code !== 0) {
                reject(new Error(`Anthropic wiring worker exited ${String(code)}: ${stderr}`));
                return;
            }
            resolve(parsed);
        });
    });
}

function cfg(provider: LlmMutatorConfig['provider']): LlmMutatorConfig {
    return llmMutatorConfigSchema.parse({ provider });
}

describe('createProvider', () => {
    it('constructs the AnthropicAgentProvider for anthropic-agent-sdk (no network)', () => {
        const provider = createProvider(cfg('anthropic-agent-sdk'));
        expect(provider.name).toBe('anthropic-agent-sdk');
    });

    it('wires production Anthropic calls to SDK json_schema output with thinking disabled', async () => {
        const result = await runAnthropicWiringWorker();
        const schema = {
            type: 'object',
            required: ['answer'],
            properties: { answer: { type: 'number' } },
        };

        expect(result.model).toBe('claude-factory-wiring-test');
        expect(result.outputFormat).toEqual({ type: 'json_schema', schema });
        expect(result.thinking).toEqual({ type: 'disabled' });
        expect(result.value).toEqual({ answer: 42 });
    });

    it('constructs a MockProvider for mock', () => {
        const provider = createProvider(cfg('mock'));
        expect(provider.name).toBe('mock');
    });

    it('throws NotImplementedError for anthropic-api', () => {
        expect(() => createProvider(cfg('anthropic-api'))).toThrow(NotImplementedError);
    });

    it('constructs an OpenAiCompatibleProvider labelled `openai` for openai', () => {
        const config = cfg('openai');
        const provider = createProvider(config);
        expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
        expect(provider.name).toBe(`openai(${config.model})`);
    });

    it('constructs an OpenAiCompatibleProvider labelled `openai-compatible` for openai-compatible', () => {
        const config = cfg('openai-compatible');
        const provider = createProvider(config);
        expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
        expect(provider.name).toBe(`openai-compatible(${config.model})`);
    });
});
