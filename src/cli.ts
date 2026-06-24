/*
 * The `stryker-llm` bin entry (functional-architecture §6 CLI surface). Shipped
 * as built `dist/cli.js` (with a `#!/usr/bin/env node` shebang) so a consumer's
 * Node runs it without relying on >=23 type-stripping.
 *
 * This is the ONLY module that touches `process.argv` / `process.exit`. It is a
 * thin shell: parse argv with the PURE {@link parseArgs}, dispatch the single
 * `run` subcommand to the Node-only {@link runLlmMutation}, translate the gating
 * errors (missing credentials / not-yet-implemented dynamicLLM) into a clear
 * message + non-zero exit, and print usage on bad input. All the testable logic
 * lives in the pure helpers (`parseArgs`, `buildRunPlan`, `gateSwitches`, …),
 * which `bun test` covers; this file imports `@stryker-mutator/core` via
 * `run.ts`, so it is Node-only and coverage-exempt (like `scripts/`).
 */

import process from 'node:process';

import { parseArgs } from './driver/cli-args';
import { MissingCredentialsError, NotImplementedError } from './driver/gate';
import { runLlmMutation } from './driver/run';

/** Write a line to stderr. */
function err(line: string): void {
    process.stderr.write(`${line}\n`);
}

/** Parse argv, dispatch `run`, and set `process.exitCode` on failure. */
async function main(): Promise<void> {
    const parsed = parseArgs(process.argv.slice(2), process.cwd());
    if (!parsed.ok) {
        err(parsed.error);
        process.exitCode = 1;
        return;
    }

    try {
        await runLlmMutation(parsed.options);
    } catch (error) {
        if (error instanceof MissingCredentialsError) {
            err(`error: ${error.message}`);
            process.exitCode = 1;
            return;
        }
        if (error instanceof NotImplementedError) {
            err(`error: ${error.message}`);
            process.exitCode = 1;
            return;
        }
        // Unknown failure: surface the message and exit non-zero.
        err(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

await main();
