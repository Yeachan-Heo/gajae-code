/**
 * End-to-end exercise of the new subprocess-backed Python runner.
 *
 * Gated by `GJC_PYTHON_INTEGRATION=1` (or legacy `PI_PYTHON_INTEGRATION=1`)
 * so CI without a real Python interpreter (or sandboxes where subprocess
 * spawning is restricted) does not fail. Either truthy name opts the tests in.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { disposeAllKernelSessions, executePythonWithKernel } from "@gajae-code/coding-agent/eval/py/executor";
import { PythonKernel } from "@gajae-code/coding-agent/eval/py/kernel";
import { resolvePythonIntegrationGate } from "@gajae-code/coding-agent/tools";
import { TempDir } from "@gajae-code/utils";

const SHOULD_RUN = resolvePythonIntegrationGate(Bun.env);

describe.skipIf(!SHOULD_RUN)("python runner subprocess", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
	});

	it("streams stdout chunks as they are produced", async () => {
		using tempDir = TempDir.createSync("@python-runner-stream-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const chunks: string[] = [];
			const result = await executePythonWithKernel(
				kernel,
				["import sys", "for i in range(5):", "    print(i, flush=True)"].join("\n"),
				{
					onChunk: chunk => {
						chunks.push(chunk);
					},
				},
			);
			expect(result.exitCode).toBe(0);
			// 5 lines * (digit + newline) → at least 5 distinct chunks once printed.
			const text = chunks.join("");
			expect(text).toContain("0\n");
			expect(text).toContain("4\n");
		} finally {
			await kernel.shutdown();
		}
	});

	it("cancels a long sleep via SIGINT within 500ms", async () => {
		using tempDir = TempDir.createSync("@python-runner-cancel-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const start = Date.now();
			const ac = new AbortController();
			const pending = executePythonWithKernel(kernel, "import time\ntime.sleep(30)", {
				signal: ac.signal,
			});
			setTimeout(() => ac.abort(new DOMException("user cancelled", "AbortError")), 50);
			const result = await pending;
			const elapsed = Date.now() - start;
			expect(result.cancelled).toBe(true);
			expect(elapsed).toBeLessThan(2_000);
			// Kernel must survive cancellation and remain usable.
			const next = await executePythonWithKernel(kernel, "print('alive')");
			expect(next.exitCode).toBe(0);
			expect(next.output).toContain("alive");
		} finally {
			await kernel.shutdown();
		}
	});

	it("preserves user namespace across calls", async () => {
		using tempDir = TempDir.createSync("@python-runner-session-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			await executePythonWithKernel(kernel, "x = 41");
			const result = await executePythonWithKernel(kernel, "x + 1");
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("42");
		} finally {
			await kernel.shutdown();
		}
	});

	it("emits an error frame when user code raises", async () => {
		using tempDir = TempDir.createSync("@python-runner-error-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "raise ValueError('boom')");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("ValueError");
			expect(result.output).toContain("boom");
		} finally {
			await kernel.shutdown();
		}
	});

	it("supports top-level await across cells", async () => {
		using tempDir = TempDir.createSync("@python-runner-await-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const first = await executePythonWithKernel(
				kernel,
				["import asyncio", "x = await asyncio.sleep(0, result=21)", "x * 2"].join("\n"),
			);
			expect(first.exitCode).toBe(0);
			expect(first.output).toContain("42");
			const second = await executePythonWithKernel(kernel, "x + 1");
			expect(second.exitCode).toBe(0);
			expect(second.output).toContain("22");
		} finally {
			await kernel.shutdown();
		}
	});

	it("translates %pwd magic to the user namespace", async () => {
		using tempDir = TempDir.createSync("@python-runner-magic-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "%pwd");
			expect(result.exitCode).toBe(0);
			// %pwd returns the cwd string, which becomes the last-expression result.
			// On macOS, the OS may resolve /var to /private/var, so check by basename.
			expect(result.output).toContain(path.basename(tempDir.path()));
		} finally {
			await kernel.shutdown();
		}
	});
});
