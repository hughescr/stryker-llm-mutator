/*
 * The out-of-band Stryker instrumentation seam (development-plan §3.3 step 1).
 *
 * Given a set of source files and a vetted {@link Replacement} table, this
 * produces the TWO coupled artifacts a working mutant requires (§3.1): the
 * switch-embedded source (`stryMutAct_9fa48("<id>") ? mutated : original`) AND a
 * matching mutant manifest, kept consistent for free because BOTH are emitted by
 * Stryker's own collector + placers in a single pass.
 *
 * We do NOT use the refuted `instrumenterTokens.transform` DI route (§3.2). We
 * drive Stryker's real `transformBabel`/collector/placers/printer directly with
 * our own custom mutator. Because Stryker's instrumenter relies on Node's
 * CJS/ESM default-interop for `@babel/generator` (which Bun unwraps differently;
 * see `instrument-worker.mjs`), the instrumentation itself runs in a short-lived
 * Node child process; this module is the Bun-side typed facade over that worker.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Mutant } from '@stryker-mutator/api/core';

import { computeMutantId } from './mutant-id';
import type { Replacement, SeamMutant } from './types';

/** Absolute path to the Node-side instrumentation worker, resolved from this module. */
const WORKER_PATH = fileURLToPath(new URL('./instrument-worker.mjs', import.meta.url));

/** A source file to instrument: its name (path) and current content. */
export interface SourceFile {
    /** File name / path. Must match the `fileName` of any {@link Replacement} targeting it. */
    name: string;
    /** Current (unmutated) source text. */
    content: string;
}

/**
 * The result of instrumenting a file set: the emitted switch-embedded source
 * per file, plus the manifest of collected mutants. The two are guaranteed
 * consistent — every {@link SeamMutant} in `mutants` has its activation switch
 * present in the corresponding emitted file (§3.1).
 */
export interface InstrumentResult {
    /** Emitted, switch-embedded source per input file (same order as input). */
    files: SourceFile[];
    /**
     * The collected mutants, each carrying its deterministic id, the Stryker
     * `mutatorName`, the printed `replacement` text, and the 0-based source
     * `location`. This is the manifest half of the two coupled artifacts.
     */
    mutants: SeamMutant[];
}

/** Shape of one mutant record as emitted by the Node worker (Stryker's `Mutant.toApiMutant()`). */
type WorkerMutant = Pick<Mutant, 'id' | 'fileName' | 'mutatorName' | 'replacement' | 'location'>;

/** Shape of the worker's JSON response. */
interface WorkerResponse {
    files?: SourceFile[];
    mutants?: WorkerMutant[];
    error?: string;
}

/**
 * Run the Node instrumentation worker with the given JSON request and resolve
 * its parsed JSON response. Rejects if Node cannot be spawned, the worker exits
 * non-zero / emits an `error`, or its stdout is not valid JSON.
 */
function runWorker(requestJson: string): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
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
            reject(new Error(`Failed to spawn instrumentation worker: ${error.message}`));
        });
        child.on('close', code => {
            let parsed: WorkerResponse | undefined;
            try {
                parsed = JSON.parse(stdout) as WorkerResponse;
            } catch {
                reject(
                    new Error(
                        `Instrumentation worker emitted invalid JSON (exit ${String(code)}): ${stdout || stderr}`,
                    ),
                );
                return;
            }
            if (parsed.error) {
                reject(new Error(`Instrumentation worker failed: ${parsed.error}`));
                return;
            }
            if (code !== 0) {
                reject(
                    new Error(`Instrumentation worker exited with code ${String(code)}: ${stderr}`),
                );
                return;
            }
            resolve(parsed);
        });
        child.stdin.end(requestJson, 'utf8');
    });
}

/**
 * Instrument `files`, expressing `replacements` as Stryker mutants via the
 * out-of-band seam.
 *
 * Each {@link Replacement} is assigned its deterministic id (a pure function of
 * `{ fileName, range, replacement }`), then handed to Stryker's machinery so the
 * id ends up baked into BOTH the source switch and the manifest record. The
 * returned {@link SeamMutant}s carry that id, the printed replacement, and the
 * 0-based location. A replacement whose span matches no babel node is silently
 * not collected (it produces neither a switch nor a record) — callers that need
 * to detect un-placed replacements can diff the returned ids against the ids
 * they computed from their input.
 *
 * @param files The source files to instrument.
 * @param replacements The vetted edits to express as mutants.
 * @returns The emitted source per file plus the mutant manifest, in lockstep.
 * @throws If the Node worker cannot run or fails to instrument.
 */
export async function instrument(
    files: readonly SourceFile[],
    replacements: readonly Replacement[],
): Promise<InstrumentResult> {
    const seamMutants: SeamMutant[] = replacements.map(replacement => ({
        ...replacement,
        id: computeMutantId(replacement),
    }));

    const request = JSON.stringify({
        files: files.map(file => ({ name: file.name, content: file.content })),
        replacements: seamMutants.map(mutant => ({
            id: mutant.id,
            fileName: mutant.fileName,
            range: mutant.range,
            replacement: mutant.replacement,
            mutatorName: mutant.mutatorName,
        })),
    });

    const response = await runWorker(request);
    const collected = response.mutants ?? [];

    // Re-attach our full SeamMutant metadata (original/rationale) onto the
    // collected records, keyed by the deterministic id the worker stamped.
    const byId = new Map(seamMutants.map(mutant => [mutant.id, mutant]));
    const mutants: SeamMutant[] = collected.map(record => {
        const seam = byId.get(record.id);
        if (!seam) {
            // The worker collected a mutant whose id we did not request. This
            // should be impossible given the id-override collector, but surface
            // it loudly rather than emit an inconsistent manifest.
            throw new Error(`Instrumentation produced unknown mutant id ${record.id}`);
        }
        return {
            ...seam,
            mutatorName: record.mutatorName,
            replacement: record.replacement,
            range: record.location,
        };
    });

    return {
        files: response.files ?? [],
        mutants,
    };
}
