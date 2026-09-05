import * as readline from "node:readline";
import type { Shell as NativeShell } from "@gajae-code/natives";
import type { BashShellWorkerRequest, BashShellWorkerResponse } from "./bash-shell-worker-protocol";

type NativeShellBindings = Pick<typeof import("@gajae-code/natives"), "Shell">;

function writeResponse(response: BashShellWorkerResponse, callback?: () => void): void {
	process.stdout.write(`${JSON.stringify(response)}\n`, callback);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runBashShellWorker(): Promise<void> {
	let shell: NativeShell | undefined;
	let initialized = false;
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
			if (initialized) {
				writeResponse({ type: "error", message: "Shell worker was initialized more than once." });
				return;
			}
			try {
				const { Shell } = require("@gajae-code/natives") as NativeShellBindings;
				shell = new Shell(request.options);
				initialized = true;
				writeResponse({ type: "ready" });
			} catch (error) {
				writeResponse({ type: "error", message: errorMessage(error) }, () => process.exit(1));
			}
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
