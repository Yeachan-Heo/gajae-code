import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	disposeAllKernelSessions,
	disposeKernelSessionsByOwner,
	executePython,
	type PythonResult,
} from "@gajae-code/coding-agent/eval/py/executor";
import { PythonKernel } from "@gajae-code/coding-agent/eval/py/kernel";
import { TempDir } from "@gajae-code/utils";

type KernelStartOptions = Parameters<typeof PythonKernel.start>[0];

const originalDateNow = Date.now;

const originalStart = PythonKernel.start;
let skipPythonCheckBeforeEach: string | undefined;
let cleanupFailures: unknown[] = [];

async function joinCleanupTasks(tasks: Promise<unknown>[]): Promise<void> {
	const settled = await Promise.allSettled(tasks);
	for (const result of settled) {
		if (result.status === "rejected") cleanupFailures.push(result.reason);
	}
}

function observeSettlement(promise: Promise<unknown>): void {
	void promise.then(
		() => undefined,
		() => undefined,
	);
}

function observeRunnerPid(cwd: string): () => number | undefined {
	const spawn = Bun.spawn.bind(Bun);
	let pid: number | undefined;
	function spawnObserver<
		const In extends Bun.SpawnOptions.Writable = "ignore",
		const Out extends Bun.SpawnOptions.Readable = "pipe",
		const Err extends Bun.SpawnOptions.Readable = "inherit",
	>(options: Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { cmd: string[] }): Bun.Subprocess<In, Out, Err>;
	function spawnObserver<
		const In extends Bun.SpawnOptions.Writable = "ignore",
		const Out extends Bun.SpawnOptions.Readable = "pipe",
		const Err extends Bun.SpawnOptions.Readable = "inherit",
	>(commands: string[], options?: Bun.SpawnOptions.SpawnOptions<In, Out, Err>): Bun.Subprocess<In, Out, Err>;
	function spawnObserver<
		const In extends Bun.SpawnOptions.Writable = "ignore",
		const Out extends Bun.SpawnOptions.Readable = "pipe",
		const Err extends Bun.SpawnOptions.Readable = "inherit",
	>(
		command: string[] | (Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { cmd: string[] }),
		options?: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
	): Bun.Subprocess<In, Out, Err> {
		const proc = Array.isArray(command) ? spawn(command, options) : spawn(command);
		const spawnOptions = Array.isArray(command) ? options : command;
		if (spawnOptions?.cwd === cwd && spawnOptions.detached === true) pid = proc.pid;
		return proc;
	}
	vi.spyOn(Bun, "spawn").mockImplementation(spawnObserver);
	return () => pid;
}

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
	beforeEach(() => {
		skipPythonCheckBeforeEach = Bun.env.PI_PYTHON_SKIP_CHECK;
		cleanupFailures = [];
	});

	afterEach(async () => {
		const failures = [...cleanupFailures];
		try {
			await disposeAllKernelSessions();
		} catch (error) {
			failures.push(error);
		} finally {
			PythonKernel.start = originalStart;
			Date.now = originalDateNow;
			vi.restoreAllMocks();
			if (skipPythonCheckBeforeEach === undefined) delete Bun.env.PI_PYTHON_SKIP_CHECK;
			else Bun.env.PI_PYTHON_SKIP_CHECK = skipPythonCheckBeforeEach;
		}
		if (failures.length > 0) throw new AggregateError(failures, "Python per-call fixture cleanup failed");
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
		let executionObserved = false;
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
			observeSettlement(execution);
			await waitForFile(readyFile);
			pid = Number((await Bun.file(pidFile).text()).trim());
			expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
			expect(isProcessAlive(pid)).toBe(true);
			const result = await execution;
			executionObserved = true;

			expect(result.cancelled).toBe(true);
			expect(result.exitCode).toBeUndefined();
			expect(result.output).toContain("Command timed out after 5 seconds");
			expect(kernels).toHaveLength(1);
			await waitForProcessGone(pid);
			expect(kernels[0].isAlive()).toBe(false);
		} finally {
			await joinCleanupTasks([
				...(execution && !executionObserved ? [execution] : []),
				disposeAllKernelSessions(),
				...(pid !== undefined ? [waitForProcessGone(pid)] : []),
			]);
		}
	}, 30_000);

	it("surfaces failed cleanup after a cancelled per-call body and permits an explicit retry", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-per-call-cancel-cleanup-");
		const pidFile = `${tempDir.path()}/cancel-cleanup.pid`;
		const readyFile = `${tempDir.path()}/cancel-cleanup.ready`;
		const controller = new AbortController();
		const shutdownError = new Error("per-call shutdown rejected after cancellation");
		let kernel: PythonKernel | undefined;
		let shutdownCalls = 0;
		let execution: Promise<PythonResult> | undefined;
		let executionObserved = false;
		let cleanup: Promise<void> | undefined;
		PythonKernel.start = async options => {
			const created = await originalStart(options);
			kernel = created;
			const shutdown = created.shutdown.bind(created);
			created.shutdown = async shutdownOptions => {
				shutdownCalls += 1;
				if (shutdownCalls === 1) throw shutdownError;
				return await shutdown(shutdownOptions);
			};
			return created;
		};
		let pid: number | undefined;
		try {
			execution = executePython(
				`from pathlib import Path\nimport os, time\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))\nPath(${JSON.stringify(readyFile)}).touch()\ntime.sleep(60)`,
				{
					kernelMode: "per-call",
					kernelOwnerId: "per-call-cancel-cleanup-owner",
					signal: controller.signal,
					cwd: tempDir.path(),
				},
			);
			observeSettlement(execution);
			await waitForFile(readyFile);
			pid = Number((await Bun.file(pidFile).text()).trim());
			if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0)
				throw new Error("Per-call Python PID marker was invalid");
			expect(isProcessAlive(pid)).toBe(true);
			controller.abort(createCancellationError("AbortError", "cancel body"));
			await expect(execution).rejects.toThrow("Python kernel cleanup failed");
			executionObserved = true;
			expect(shutdownCalls).toBe(1);
			expect(kernel?.isAlive()).toBe(true);
			expect(isProcessAlive(pid)).toBe(true);

			cleanup = disposeKernelSessionsByOwner("per-call-cancel-cleanup-owner");
			await cleanup;
			expect(shutdownCalls).toBe(2);
			await waitForProcessGone(pid);
			expect(kernel?.isAlive()).toBe(false);
		} finally {
			controller.abort();
			await joinCleanupTasks([
				...(execution && !executionObserved ? [execution] : []),
				...(cleanup ? [cleanup] : []),
				disposeKernelSessionsByOwner("per-call-cancel-cleanup-owner"),
				disposeAllKernelSessions(),
				...(pid !== undefined ? [waitForProcessGone(pid)] : []),
			]);
		}
	}, 30_000);

	it("surfaces cleanup failure when cancellation occurs after real start but before cell execution", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-per-call-start-cancel-cleanup-");
		const markerFile = `${tempDir.path()}/cell-must-not-run`;
		const getRunnerPid = observeRunnerPid(tempDir.path());
		const controller = new AbortController();
		const shutdownError = new Error("cleanup rejected after startup cancellation");
		let kernel: PythonKernel | undefined;
		let shutdownCalls = 0;
		let execution: Promise<PythonResult> | undefined;
		let executionObserved = false;
		let cleanup: Promise<void> | undefined;
		PythonKernel.start = async options => {
			const created = await originalStart(options);
			kernel = created;
			const shutdown = created.shutdown.bind(created);
			created.shutdown = async shutdownOptions => {
				shutdownCalls += 1;
				if (shutdownCalls === 1) throw shutdownError;
				return await shutdown(shutdownOptions);
			};
			controller.abort(createCancellationError("AbortError", "cancel immediately after start"));
			return created;
		};
		let pid: number | undefined;
		try {
			execution = executePython(`from pathlib import Path\nPath(${JSON.stringify(markerFile)}).touch()`, {
				kernelMode: "per-call",
				kernelOwnerId: "per-call-start-cancel-owner",
				signal: controller.signal,
				cwd: tempDir.path(),
			});
			observeSettlement(execution);
			await expect(execution).rejects.toMatchObject({ cause: shutdownError });
			executionObserved = true;
			pid = getRunnerPid();
			if (pid === undefined) throw new Error("Actual per-call runner PID was not captured");
			expect(shutdownCalls).toBe(1);
			expect(await Bun.file(markerFile).exists()).toBe(false);
			expect(isProcessAlive(pid)).toBe(true);
			expect(kernel?.isAlive()).toBe(true);

			cleanup = disposeKernelSessionsByOwner("per-call-start-cancel-owner");
			await cleanup;
			expect(shutdownCalls).toBe(2);
			await waitForProcessGone(pid);
			expect(kernel?.isAlive()).toBe(false);
		} finally {
			controller.abort();
			await joinCleanupTasks([
				...(execution && !executionObserved ? [execution] : []),
				...(cleanup ? [cleanup] : []),
				disposeKernelSessionsByOwner("per-call-start-cancel-owner"),
				disposeAllKernelSessions(),
				...(pid !== undefined ? [waitForProcessGone(pid)] : []),
			]);
		}
	}, 30_000);

	it("does not convert thrown post-start cancellation when retained cleanup fails", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-per-call-thrown-cancel-cleanup-");
		const markerFile = `${tempDir.path()}/cell-must-not-run`;
		const getRunnerPid = observeRunnerPid(tempDir.path());
		const controller = new AbortController();
		const shutdownError = new Error("cleanup rejected after pre-cell cancellation");
		let kernel: PythonKernel | undefined;
		let shutdownCalls = 0;
		let execution: Promise<PythonResult> | undefined;
		let executionObserved = false;
		let cleanup: Promise<void> | undefined;
		PythonKernel.start = async options => {
			const created = await originalStart(options);
			kernel = created;
			const shutdown = created.shutdown.bind(created);
			created.shutdown = async shutdownOptions => {
				shutdownCalls += 1;
				if (shutdownCalls === 1) throw shutdownError;
				return await shutdown(shutdownOptions);
			};
			controller.abort(createCancellationError("AbortError", "cancel after real startup"));
			return created;
		};
		let pid: number | undefined;
		try {
			execution = executePython(`from pathlib import Path\nPath(${JSON.stringify(markerFile)}).touch()`, {
				kernelMode: "per-call",
				kernelOwnerId: "per-call-thrown-cancel-owner",
				signal: controller.signal,
				cwd: tempDir.path(),
			});
			observeSettlement(execution);
			await expect(execution).rejects.toMatchObject({ cause: shutdownError });
			executionObserved = true;
			pid = getRunnerPid();
			if (pid === undefined) throw new Error("Actual per-call runner PID was not captured");
			expect(shutdownCalls).toBe(1);
			expect(await Bun.file(markerFile).exists()).toBe(false);
			expect(isProcessAlive(pid)).toBe(true);
			expect(kernel?.isAlive()).toBe(true);

			cleanup = disposeKernelSessionsByOwner("per-call-thrown-cancel-owner");
			await cleanup;
			expect(shutdownCalls).toBe(2);
			await waitForProcessGone(pid);
			expect(kernel?.isAlive()).toBe(false);
		} finally {
			controller.abort();
			await joinCleanupTasks([
				...(execution && !executionObserved ? [execution] : []),
				...(cleanup ? [cleanup] : []),
				disposeKernelSessionsByOwner("per-call-thrown-cancel-owner"),
				disposeAllKernelSessions(),
				...(pid !== undefined ? [waitForProcessGone(pid)] : []),
			]);
		}
	}, 30_000);

	it("preserves a non-cancellation body error when cleanup reenters with cancellation", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-per-call-body-cleanup-");
		const pidFile = `${tempDir.path()}/body-cleanup.pid`;
		const readyFile = `${tempDir.path()}/body-cleanup.ready`;
		const controller = new AbortController();
		const bodyError = new Error("original host body callback failed");
		const shutdownError = new Error("shutdown rejected while body error was primary");
		let kernel: PythonKernel | undefined;
		let shutdownCalls = 0;
		let bodyReachedCleanup = false;
		let cleanupReenteredWithAbort = false;
		let execution: Promise<PythonResult> | undefined;
		let executionObserved = false;
		let cleanup: Promise<void> | undefined;
		PythonKernel.start = async options => {
			const created = await originalStart(options);
			kernel = created;
			const execute = created.execute.bind(created);
			created.execute = async (code, executeOptions) => {
				const result = await execute(code, executeOptions);
				if (code.includes("raise-after-actual-execution")) {
					expect(controller.signal.aborted).toBe(false);
					bodyReachedCleanup = true;
					throw bodyError;
				}
				return result;
			};
			const shutdown = created.shutdown.bind(created);
			created.shutdown = async shutdownOptions => {
				shutdownCalls += 1;
				if (shutdownCalls === 1) {
					expect(bodyReachedCleanup).toBe(true);
					controller.abort(createCancellationError("AbortError", "cleanup reentry"));
					cleanupReenteredWithAbort = controller.signal.aborted;
					throw shutdownError;
				}
				return await shutdown(shutdownOptions);
			};
			return created;
		};
		let pid: number | undefined;
		try {
			execution = executePython(
				`# raise-after-actual-execution\nfrom pathlib import Path\nimport os\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))\nPath(${JSON.stringify(readyFile)}).touch()\nprint('body finished')`,
				{
					kernelMode: "per-call",
					kernelOwnerId: "per-call-body-cleanup-owner",
					signal: controller.signal,
					cwd: tempDir.path(),
				},
			);
			observeSettlement(execution);
			await waitForFile(readyFile);
			pid = Number((await Bun.file(pidFile).text()).trim());
			if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0)
				throw new Error("Per-call Python PID marker was invalid");
			expect(isProcessAlive(pid)).toBe(true);
			await expect(execution).rejects.toBe(bodyError);
			executionObserved = true;
			expect(controller.signal.aborted).toBe(true);
			expect(cleanupReenteredWithAbort).toBe(true);
			expect(shutdownCalls).toBe(1);
			expect(isProcessAlive(pid)).toBe(true);

			cleanup = disposeKernelSessionsByOwner("per-call-body-cleanup-owner");
			await cleanup;
			expect(shutdownCalls).toBe(2);
			await waitForProcessGone(pid);
			expect(kernel?.isAlive()).toBe(false);
		} finally {
			controller.abort();
			await joinCleanupTasks([
				...(execution && !executionObserved ? [execution] : []),
				...(cleanup ? [cleanup] : []),
				disposeKernelSessionsByOwner("per-call-body-cleanup-owner"),
				disposeAllKernelSessions(),
				...(pid !== undefined ? [waitForProcessGone(pid)] : []),
			]);
		}
	}, 30_000);
});
