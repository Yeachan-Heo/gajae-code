import { afterEach, describe, expect, it } from "bun:test";
import { executePython, type PythonResult } from "@gajae-code/coding-agent/eval/py/executor";
import { PythonKernel } from "@gajae-code/coding-agent/eval/py/kernel";
import { TempDir } from "@gajae-code/utils";

type KernelStartOptions = Parameters<typeof PythonKernel.start>[0];

const originalDateNow = Date.now;

const originalStart = PythonKernel.start;

function createCancellationError(name: "AbortError" | "TimeoutError", message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

function rejectOnStartupCancellation(options: KernelStartOptions): Promise<never> {
	const { promise, reject } = Promise.withResolvers<never>();
	let settled = false;
	let timeout: NodeJS.Timeout | undefined;
	const finish = (error: unknown) => {
		if (settled) return;
		settled = true;
		if (timeout) clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
		reject(error);
	};
	const onAbort = () => {
		finish(options.signal?.reason ?? createCancellationError("AbortError", "Python kernel startup aborted"));
	};

	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.deadlineMs !== undefined) {
		const remainingMs = Math.max(0, options.deadlineMs - Date.now());
		timeout = setTimeout(() => {
			finish(createCancellationError("TimeoutError", "Python kernel startup timed out"));
		}, remainingMs);
		timeout.unref();
	}

	return promise;
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await Bun.file(filePath).exists()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for Python marker file: ${filePath}`);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessGone(pid: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await Bun.sleep(25);
	}
	expect(isProcessAlive(pid)).toBe(false);
}

describe("executePython (per-call)", () => {
	afterEach(() => {
		PythonKernel.start = originalStart;
		Date.now = originalDateNow;
	});

	it("returns a cancelled timeout result when kernel startup exceeds the deadline", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-executor-per-call-");

		PythonKernel.start = async options => await rejectOnStartupCancellation(options);

		const result = await executePython("sleep(10)", {
			kernelMode: "per-call",
			timeoutMs: 25,
			cwd: tempDir.path(),
		});

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command timed out");
	});

	it("returns a cancelled timeout result when the startup budget expires before kernel creation", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-executor-per-call-");

		let nowCalls = 0;
		Date.now = () => {
			nowCalls += 1;
			return nowCalls <= 2 ? 1_000 : 2_000;
		};

		const result = await executePython("sleep(10)", {
			kernelMode: "per-call",
			timeoutMs: 10,
			cwd: tempDir.path(),
		});

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command timed out");
	});

	it("returns a cancelled result when caller aborts during kernel startup", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-executor-per-call-");
		const startupStarted = Promise.withResolvers<void>();

		PythonKernel.start = async options => {
			startupStarted.resolve();
			return await rejectOnStartupCancellation(options);
		};

		const abortController = new AbortController();
		const resultPromise = executePython("sleep(10)", {
			kernelMode: "per-call",
			signal: abortController.signal,
			cwd: tempDir.path(),
		});
		await startupStarted.promise;
		abortController.abort(createCancellationError("AbortError", "caller aborted"));

		const result = await resultPromise;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toBe("");
	});

	it("shuts down kernel on timed-out cancellation", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-executor-per-call-");
		const pidFile = `${tempDir.path()}/per-call-kernel.pid`;
		const readyFile = `${tempDir.path()}/per-call-kernel.ready`;
		const kernels: PythonKernel[] = [];
		let execution: Promise<PythonResult> | undefined;
		PythonKernel.start = async options => {
			const kernel = await originalStart(options);
			kernels.push(kernel);
			return kernel;
		};

		let pid: number | undefined;
		try {
			execution = executePython(
				`from pathlib import Path\nimport os, time\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))\nPath(${JSON.stringify(readyFile)}).touch()\ntime.sleep(60)`,
				{
					kernelMode: "per-call",
					timeoutMs: 5000,
					cwd: tempDir.path(),
				},
			);
			await waitForFile(readyFile);
			pid = Number((await Bun.file(pidFile).text()).trim());
			expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
			expect(isProcessAlive(pid)).toBe(true);
			const result = await execution;

			expect(result.cancelled).toBe(true);
			expect(result.exitCode).toBeUndefined();
			expect(result.output).toContain("Command timed out after 5 seconds");
			expect(kernels).toHaveLength(1);
			await waitForProcessGone(pid);
			expect(kernels[0].isAlive()).toBe(false);
		} finally {
			await execution?.catch(() => undefined);
		}
	}, 30_000);
});
