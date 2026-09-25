import { expect, test } from "bun:test";
import { executeShell } from "@gajae-code/natives";

const READ_WAIT_LIMIT_MS = 1_000;
const SHELL_STARTUP_LIMIT_MS = 5_000;

test("read builtin abort is interrupted promptly", async () => {
	if (process.platform === "win32") return;

	const controller = new AbortController();
	const started = Promise.withResolvers<void>();
	let output = "";
	const run = executeShell(
		{ command: "printf 'ready\\n'; read value < /dev/zero", signal: controller.signal },
		(error, chunk) => {
			if (error) throw error;
			output += chunk;
			if (output.includes("ready")) started.resolve();
		},
	);
	await Promise.race([
		started.promise,
		Bun.sleep(SHELL_STARTUP_LIMIT_MS).then(() => {
			throw new Error("shell did not start the blocking read");
		}),
	]);

	const abortedAt = Date.now();
	controller.abort();
	const result = await Promise.race([
		run,
		Bun.sleep(READ_WAIT_LIMIT_MS).then(() => {
			throw new Error("read did not stop within one second of cancellation");
		}),
	]);

	expect(result).toMatchObject({ cancelled: true, timedOut: false });
	expect(Date.now() - abortedAt).toBeLessThan(READ_WAIT_LIMIT_MS);
});

test("read builtin timeout exits above the signal-status range", async () => {
	if (process.platform === "win32") return;

	const result = await executeShell({
		command: "read -t 0.1 value < /dev/zero",
		timeoutMs: SHELL_STARTUP_LIMIT_MS,
	});

	expect(result.timedOut).toBe(false);
	expect(result.exitCode).toBeGreaterThan(128);
});
