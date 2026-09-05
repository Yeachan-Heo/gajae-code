import * as readline from "node:readline";
import type { Shell as NativeShell, ShellOptions } from "@gajae-code/natives";
import { fatalCatchableSignals, signalExitCode } from "./bash-shell-signals";
import type { BashShellWorkerRequest, IsolatedShellRunResult } from "./bash-shell-worker-protocol";

type NativeShellConstructor = new (options?: ShellOptions | null) => NativeShell;
type NativeShellBindings = { Shell: NativeShellConstructor };
type BashShellWorkerResponsePayload =
	| { type: "ready" }
	| { type: "chunk"; id: number; chunk: string }
	| { type: "result"; id: number; result: IsolatedShellRunResult }
	| { type: "void"; id: number }
	| { type: "error"; id?: number; message: string };

function restoreFatalSignalSemantics(): void {
	for (const signal of fatalCatchableSignals()) {
		const exitCode = signalExitCode(signal);
		if (exitCode === undefined) continue;
		try {
			process.removeAllListeners(signal);
			process.on(signal, () => process.exit(exitCode));
		} catch {
			// Unsupported signal handlers retain the platform's default disposition.
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runBashShellWorker(): Promise<void> {
	restoreFatalSignalSemantics();
	let shell: NativeShell | undefined;
	let initialized = false;
	let protocolToken: string | undefined;
	const writeResponse = (response: BashShellWorkerResponsePayload, callback?: () => void): void => {
		if (!protocolToken) return;
		process.stdout.write(`${JSON.stringify({ ...response, token: protocolToken })}\n`, callback);
	};
	const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

	input.on("line", line => {
		let request: BashShellWorkerRequest;
		try {
			request = JSON.parse(line) as BashShellWorkerRequest;
		} catch (error) {
			writeResponse({ type: "error", message: `Invalid shell worker request: ${errorMessage(error)}` });
			return;
		}

		if (request.type === "init") {
			protocolToken = request.token;
			if (initialized) {
				writeResponse({ type: "error", message: "Shell worker was initialized more than once." });
				return;
			}
			try {
				const { Shell } = require("@gajae-code/natives") as NativeShellBindings;
				const shellOptions = {
					...request.options,
					containedProcessGroup: process.platform !== "win32",
					ownershipLedgerPath: request.ownershipLedger?.path,
					ownershipLedgerToken: request.ownershipLedger?.token,
				} as ShellOptions;
				shell = new Shell(shellOptions);
				initialized = true;
				writeResponse({ type: "ready" });
			} catch (error) {
				writeResponse({ type: "error", message: errorMessage(error) }, () => process.exit(1));
			}
			return;
		}
		if (!protocolToken || request.token !== protocolToken) {
			writeResponse({
				type: "error",
				id: "id" in request ? request.id : undefined,
				message: "Invalid protocol token.",
			});
			return;
		}

		if (!shell) {
			writeResponse({ type: "error", id: request.id, message: "Shell worker is not initialized." });
			return;
		}

		if (request.type === "run") {
			void shell
				.run(request.options, (error, chunk) => {
					if (!error) writeResponse({ type: "chunk", id: request.id, chunk });
				})
				.then(result => writeResponse({ type: "result", id: request.id, result }))
				.catch(error => writeResponse({ type: "error", id: request.id, message: errorMessage(error) }));
			return;
		}

		if (request.type === "abort") {
			void shell
				.abort()
				.then(() => writeResponse({ type: "void", id: request.id }))
				.catch(error => writeResponse({ type: "error", id: request.id, message: errorMessage(error) }));
			return;
		}

		void shell
			.close()
			.then(() => writeResponse({ type: "void", id: request.id }, () => process.exit(0)))
			.catch(error => writeResponse({ type: "error", id: request.id, message: errorMessage(error) }));
	});

	const closed = Promise.withResolvers<void>();
	input.once("close", closed.resolve);
	await closed.promise;
	await shell?.close().catch(() => undefined);
}
