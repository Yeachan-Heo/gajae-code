// A/B adapter: native PTY command completion and interactive stdin/stdout.
import { PtySession } from "../native/index.js";
import { runAbSuite } from "./ab-adapter";

const cases = [
	{
		id: "P01",
		async run() {
			const session = new PtySession();
			let output = "";
			let callbackError: Error | null = null;
			const result = await session.start(
				{
					command: "printf 'pty-adapter-ready\\n'",
					shell: "sh",
					cols: 80,
					rows: 24,
				},
				(error, chunk) => {
					if (error) callbackError = error;
					else output += chunk;
				},
			);
			if (callbackError) throw callbackError;
			if (!output.includes("pty-adapter-ready")) {
				throw new Error(`PTY command output did not include its marker: ${JSON.stringify(output)}`);
			}
			if (result.exitCode !== 0 || result.cancelled || result.timedOut) {
				throw new Error(`PTY command did not complete successfully: ${JSON.stringify(result)}`);
			}
		},
	},
	{
		id: "P02",
		async run() {
			const session = new PtySession();
			const expected = "pty-adapter-echo";
			let output = "";
			let callbackError: Error | null = null;
			let resolveOutput!: () => void;
			const outputReady = new Promise<void>(resolve => {
				resolveOutput = resolve;
			});
			let runPromise: ReturnType<PtySession["start"]> | undefined;
			try {
				runPromise = session.start(
					{
						command: "cat",
						shell: "sh",
						cols: 80,
						rows: 24,
						timeoutMs: 10_000,
					},
					(error, chunk) => {
						if (error) {
							callbackError = error;
						resolveOutput();
						return;
					}
					output += chunk;
					if (output.includes(expected)) resolveOutput();
				},
				);
				session.write(`${expected}\n`);
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						outputReady,
						runPromise.then(() => {
							throw new Error("PTY cat exited before echoing input");
						}),
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(() => reject(new Error("timed out waiting for PTY input echo")), 2_000);
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
				}
				if (callbackError) throw callbackError;
				if (!output.includes(expected)) {
					throw new Error(`PTY output did not include written input: ${JSON.stringify(output)}`);
				}
				session.kill();
				const result = await runPromise;
				if (!result.cancelled || result.timedOut) {
					throw new Error(`PTY cat was not terminated by kill: ${JSON.stringify(result)}`);
				}
			} catch (error) {
				try {
					session.kill();
				} catch {
					// The command may already have exited while its output callback ran.
				}
				if (runPromise) await runPromise.catch(() => undefined);
				throw error;
			}
		},
	},
];

await runAbSuite("pty", cases, 10);
