import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	disposeAllKernelSessions,
	disposeKernelSessionsByOwner,
	executePython,
	executePythonWithKernel,
	type PythonResult,
} from "@gajae-code/coding-agent/eval/py/executor";
import * as pythonKernel from "@gajae-code/coding-agent/eval/py/kernel";
import {
	type KernelShutdownResult,
	PythonKernel,
	PythonKernelStartError,
} from "@gajae-code/coding-agent/eval/py/kernel";
import { TempDir } from "@gajae-code/utils";

const originalStart = PythonKernel.start;
const originalAvailability = pythonKernel.checkPythonKernelAvailability;
let skipPythonCheckBeforeEach: string | undefined;
let cleanupFailures: unknown[] = [];

function trackStartedKernels(): PythonKernel[] {
	const kernels: PythonKernel[] = [];
	vi.spyOn(PythonKernel, "start").mockImplementation(async options => {
		const kernel = await originalStart(options);
		kernels.push(kernel);
		return kernel;
	});
	return kernels;
}

function holdAvailability(cwd: string, release: Promise<void>, entered: () => void): void {
	let held = false;
	vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockImplementation(async (...args) => {
		if (args[0] === cwd && !held) {
			held = true;
			entered();
			await release;
		}
		return await originalAvailability(...args);
	});
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await Bun.file(path).exists()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for Python marker file: ${path}`);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessFile(filePath: string, timeoutMs = 5_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await Bun.file(filePath).exists()) {
			const pid = Number((await Bun.file(filePath).text()).trim());
			if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) return pid;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for a live Python process in ${filePath}`);
}

async function waitForProcessGone(pid: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await Bun.sleep(25);
	}
	expect(isProcessAlive(pid)).toBe(false);
}

async function shutdownAndConfirm(kernel: PythonKernel): Promise<void> {
	const result = await kernel.shutdown();
	if (!result.confirmed) throw new Error(`Python kernel ${kernel.id} shutdown was not confirmed`);
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

async function flushMicrotasks(turns = 6): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

async function waitForRequest<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function markSettled(promise: Promise<unknown>, onSettled: () => void): void {
	void promise.then(onSettled, onSettled);
}

async function joinCleanupTasks(tasks: Promise<unknown>[]): Promise<void> {
	const settled = await Promise.allSettled(tasks);
	for (const result of settled) {
		if (result.status === "rejected") cleanupFailures.push(result.reason);
	}
}

function cleanupFailuresFrom(settled: PromiseSettledResult<unknown>[]): AggregateError | undefined {
	const failures = settled.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
	return failures.length > 0 ? new AggregateError(failures, "Python cleanup tasks failed") : undefined;
}

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
		vi.restoreAllMocks();
		if (skipPythonCheckBeforeEach === undefined) delete Bun.env.PI_PYTHON_SKIP_CHECK;
		else Bun.env.PI_PYTHON_SKIP_CHECK = skipPythonCheckBeforeEach;
	}
	if (failures.length > 0) throw new AggregateError(failures, "Python owner-cleanup fixture cleanup failed");
});

describe("python executor owner cleanup", () => {
	it("registers cold-process cleanup synchronously for a borrowed direct request", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-registration-");
		const resultPath = path.join(tempDir.path(), "cold-registration-result.json");
		const pidPath = path.join(tempDir.path(), "cold-registration.pid");
		const readyPath = path.join(tempDir.path(), "cold-registration-ready");
		const pythonCode = `from pathlib import Path\nimport os, time\nPath(${JSON.stringify(pidPath)}).write_text(str(os.getpid()))\nPath(${JSON.stringify(readyPath)}).touch()\ntime.sleep(60)`;
		const probe = `
import * as lifecycle from ${JSON.stringify(new URL("../../src/runtime/process-lifecycle.ts", import.meta.url).href)};
import { vi, test } from "bun:test";
import { PythonKernel } from ${JSON.stringify(new URL("../../src/eval/py/kernel.ts", import.meta.url).href)};
import * as executor from ${JSON.stringify(new URL("../../src/eval/py/executor.ts", import.meta.url).href)};
test("cold Python resource registration", async () => {
const originalRegister = lifecycle.registerResourceOwner;
const registrationSpy = vi.spyOn(lifecycle, "registerResourceOwner").mockImplementation((...args) =>
	Reflect.apply(originalRegister, lifecycle, args),
);
const kernel = await PythonKernel.start({ cwd: ${JSON.stringify(tempDir.path())} });
let execution;
try {
const registrationsBefore = registrationSpy.mock.calls.filter(([name]) => name === "python-kernel-sessions").length;
let executionSettled = false;
execution = executor.executePythonWithKernel(kernel, ${JSON.stringify(pythonCode)})
	.finally(() => { executionSettled = true; });
const registeredSynchronously = registrationSpy.mock.calls
	.filter(([name]) => name === "python-kernel-sessions").length === registrationsBefore + 1;
if (!registeredSynchronously || executionSettled) throw new Error("Cold Python process cleanup was not registered synchronously");
const readyPath = ${JSON.stringify(readyPath)};
const pidPath = ${JSON.stringify(pidPath)};
const deadline = Date.now() + 5_000;
while (!(await Bun.file(readyPath).exists()) && Date.now() < deadline) await Bun.sleep(10);
if (!(await Bun.file(readyPath).exists())) throw new Error("Borrowed Python execution did not start");
const pid = Number((await Bun.file(pidPath).text()).trim());
await executor.disposeAllKernelSessions();
const result = await execution;
const borrowedKernelAlive = kernel.isAlive();
const shutdown = await kernel.shutdown();
await lifecycle.disposeAllResourceOwners();
const resourceOwnersAfterCleanup = lifecycle.resourceOwnerCount();
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
	pid,
	registeredSynchronously,
	resultCancelled: result.cancelled,
	executionSettled,
	borrowedKernelAlive,
	shutdownConfirmed: shutdown.confirmed,
	resourceOwnersAfterCleanup,
}));
} finally {
	const shutdown = (async () => {
		let firstFailure;
		try {
			const first = await kernel.shutdown();
			if (first.confirmed) return;
			firstFailure = new Error("Borrowed Python kernel shutdown was unconfirmed");
		} catch (error) {
			firstFailure = error;
		}
		const retry = await kernel.shutdown();
		if (!retry.confirmed) throw new AggregateError([firstFailure], "Borrowed Python kernel retry was unconfirmed");
		throw new Error("First borrowed Python kernel cleanup attempt failed", { cause: firstFailure });
	})();
	const cleanupResults = await Promise.allSettled([
		executor.disposeAllKernelSessions(),
		...(execution ? [execution] : []),
		shutdown,
		lifecycle.disposeAllResourceOwners(),
	]);
	const cleanupFailure = cleanupResults.find(result => result.status === "rejected");
	if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
}
}, 30_000);
`;
		const probePath = path.join(tempDir.path(), "cold-registration.test.ts");
		await Bun.write(probePath, probe);
		const child = Bun.spawn([process.execPath, "test", probePath], {
			cwd: path.resolve(fileURLToPath(new URL("../../../../", import.meta.url))),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
		const result = JSON.parse(await Bun.file(resultPath).text()) as {
			pid: number;
			registeredSynchronously: boolean;
			resultCancelled: boolean;
			executionSettled: boolean;
			borrowedKernelAlive: boolean;
			shutdownConfirmed: boolean;
			resourceOwnersAfterCleanup: number;
		};
		expect(result.pid).toBeGreaterThan(0);
		expect(result.registeredSynchronously).toBe(true);
		expect(result.resultCancelled).toBe(true);
		expect(result.executionSettled).toBe(true);
		expect(result.borrowedKernelAlive).toBe(true);
		expect(result.shutdownConfirmed).toBe(true);
		expect(result.resourceOwnersAfterCleanup).toBe(0);
	}, 30_000);

	it("shares a retained physical kernel across owner labels until the last owner detaches", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-shared-");
		const kernels = trackStartedKernels();
		try {
			const options = {
				cwd: tempDir.path(),
				sessionId: "shared-session",
				kernelMode: "session" as const,
			};
			const first = await executePython("print('owner-a')", { ...options, kernelOwnerId: "owner-a" });
			const second = await executePython("print('owner-b')", { ...options, kernelOwnerId: "owner-b" });

			expect(first.exitCode).toBe(0);
			expect(second.exitCode).toBe(0);
			expect(kernels).toHaveLength(1);

			await disposeKernelSessionsByOwner("owner-a");
			expect(kernels[0].isAlive()).toBe(true);

			const stillShared = await executePython("print('still shared')", { ...options, kernelOwnerId: "owner-b" });
			expect(stillShared.exitCode).toBe(0);
			expect(kernels).toHaveLength(1);

			await disposeKernelSessionsByOwner("owner-b");
			expect(kernels[0].isAlive()).toBe(false);
		} finally {
			await joinCleanupTasks([disposeAllKernelSessions()]);
		}
	}, 30_000);

	it("disposes all physical sessions for one owner without touching another owner's process", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-sessions-");
		const kernels = trackStartedKernels();
		try {
			const first = await executePython("print('one')", {
				cwd: tempDir.path(),
				sessionId: "owner-a-one",
				kernelMode: "session",
				kernelOwnerId: "owner-a",
			});
			const second = await executePython("print('two')", {
				cwd: tempDir.path(),
				sessionId: "owner-a-two",
				kernelMode: "session",
				kernelOwnerId: "owner-a",
			});
			const unrelated = await executePython("print('other')", {
				cwd: tempDir.path(),
				sessionId: "owner-b-one",
				kernelMode: "session",
				kernelOwnerId: "owner-b",
			});
			expect([first.exitCode, second.exitCode, unrelated.exitCode]).toEqual([0, 0, 0]);
			expect(kernels).toHaveLength(3);

			await disposeKernelSessionsByOwner("owner-a");
			expect(kernels[0].isAlive()).toBe(false);
			expect(kernels[1].isAlive()).toBe(false);
			expect(kernels[2].isAlive()).toBe(true);

			const stillUnrelated = await executePython("print('still alive')", {
				cwd: tempDir.path(),
				sessionId: "owner-b-one",
				kernelMode: "session",
				kernelOwnerId: "owner-b",
			});
			expect(stillUnrelated.exitCode).toBe(0);
			expect(kernels).toHaveLength(3);
		} finally {
			await joinCleanupTasks([disposeAllKernelSessions()]);
		}
	}, 30_000);

	it("uses the retained session id as the existing fallback owner label", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-fallback-");
		const kernels = trackStartedKernels();
		try {
			const result = await executePython("print('fallback')", {
				cwd: tempDir.path(),
				sessionId: "fallback-session",
				kernelMode: "session",
			});
			expect(result.exitCode).toBe(0);
			expect(kernels).toHaveLength(1);

			await disposeKernelSessionsByOwner("fallback-session");
			expect(kernels[0].isAlive()).toBe(false);
		} finally {
			await joinCleanupTasks([disposeAllKernelSessions()]);
		}
	}, 30_000);

	it("tracks a direct execution lifetime without claiming shutdown authority over its borrowed kernel", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-borrowed-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		const readyFile = `${tempDir.path()}/borrowed-execution-ready`;
		let execution: Promise<PythonResult> | undefined;
		try {
			execution = executePythonWithKernel(
				kernel,
				`from pathlib import Path\nimport time\nPath(${JSON.stringify(readyFile)}).touch()\ntime.sleep(60)`,
				{ kernelOwnerId: "borrowed-owner", timeoutMs: 30_000 },
			);
			await waitForFile(readyFile);
			await disposeKernelSessionsByOwner("borrowed-owner");
			const result = await execution;
			expect(result.cancelled).toBe(true);
			expect(kernel.isAlive()).toBe(true);
		} finally {
			await joinCleanupTasks([
				disposeKernelSessionsByOwner("borrowed-owner"),
				...(execution ? [execution] : []),
				shutdownAndConfirm(kernel),
				disposeAllKernelSessions(),
			]);
		}
	}, 30_000);

	it("finishes cleanup of the captured physical kernel without shutting down a same-name successor", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-replacement-");
		const kernels = trackStartedKernels();
		const shutdownStarted = Promise.withResolvers<void>();
		const releaseShutdown = Promise.withResolvers<void>();
		let cleanup: Promise<void> | undefined;
		let repeatedCleanup: Promise<void> | undefined;
		let shutdownCalls = 0;
		try {
			const options = {
				cwd: tempDir.path(),
				sessionId: "replacement-session",
				kernelMode: "session" as const,
			};
			const first = await executePython("print('A')", { ...options, kernelOwnerId: "owner-a" });
			expect(first.exitCode).toBe(0);
			const kernelA = kernels[0];
			const shutdown = kernelA.shutdown.bind(kernelA);
			kernelA.shutdown = async shutdownOptions => {
				shutdownCalls += 1;
				shutdownStarted.resolve();
				await releaseShutdown.promise;
				return await shutdown(shutdownOptions);
			};

			cleanup = disposeKernelSessionsByOwner("owner-a");
			await shutdownStarted.promise;
			repeatedCleanup = disposeKernelSessionsByOwner("owner-a");
			let firstSettled = false;
			let repeatedSettled = false;
			markSettled(cleanup, () => {
				firstSettled = true;
			});
			markSettled(repeatedCleanup, () => {
				repeatedSettled = true;
			});
			await flushMicrotasks();
			expect(firstSettled).toBe(false);
			expect(repeatedSettled).toBe(false);
			expect(shutdownCalls).toBe(1);

			const second = await executePython("print('B')", { ...options, kernelOwnerId: "owner-b" });
			expect(second.exitCode).toBe(0);
			expect(kernels).toHaveLength(2);
			expect(kernels[1].isAlive()).toBe(true);

			releaseShutdown.resolve();
			await Promise.all([cleanup, repeatedCleanup]);
			expect(shutdownCalls).toBe(1);
			expect(kernelA.isAlive()).toBe(false);
			expect(kernels[1].isAlive()).toBe(true);
		} finally {
			releaseShutdown.resolve();
			await joinCleanupTasks([
				cleanup ?? disposeKernelSessionsByOwner("owner-a"),
				...(repeatedCleanup ? [repeatedCleanup] : []),
				disposeAllKernelSessions(),
			]);
		}
	}, 30_000);

	it("captures a same-label successor during earlier held cleanup and joins both physical shutdowns", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-same-label-replacement-");
		const kernels = trackStartedKernels();
		const shutdownAStarted = Promise.withResolvers<void>();
		const releaseShutdownA = Promise.withResolvers<void>();
		const pidAFile = `${tempDir.path()}/kernel-a.pid`;
		const pidBFile = `${tempDir.path()}/kernel-b.pid`;
		let pidA: number | undefined;
		let pidB: number | undefined;
		let executionB: Promise<PythonResult> | undefined;
		let cleanupA: Promise<void> | undefined;
		let cleanupB: Promise<void> | undefined;
		let shutdownCallsA = 0;
		let bodyFailed = false;
		let bodyError: unknown;
		let cleanupFailed = false;
		let cleanupError: unknown;
		try {
			const options = {
				cwd: tempDir.path(),
				sessionId: "same-label-replacement-session",
				kernelMode: "session" as const,
				kernelOwnerId: "same-owner-label",
			};
			const first = await executePython(
				`from pathlib import Path\nimport os\nPath(${JSON.stringify(pidAFile)}).write_text(str(os.getpid()))`,
				options,
			);
			expect(first.exitCode).toBe(0);
			expect(kernels).toHaveLength(1);
			pidA = await waitForProcessFile(pidAFile);

			const kernelA = kernels[0];
			const originalShutdownA = kernelA.shutdown.bind(kernelA);
			kernelA.shutdown = async shutdownOptions => {
				shutdownCallsA += 1;
				shutdownAStarted.resolve();
				await releaseShutdownA.promise;
				return await originalShutdownA(shutdownOptions);
			};
			cleanupA = disposeKernelSessionsByOwner(options.kernelOwnerId);
			await shutdownAStarted.promise;
			expect(isProcessAlive(pidA)).toBe(true);

			const readyBFile = `${tempDir.path()}/kernel-b.ready`;
			executionB = executePython(
				`from pathlib import Path\nimport os, time\nPath(${JSON.stringify(pidBFile)}).write_text(str(os.getpid()))\nPath(${JSON.stringify(readyBFile)}).touch()\ntime.sleep(60)`,
				options,
			);
			await waitForFile(readyBFile);
			pidB = await waitForProcessFile(pidBFile);
			expect(kernels).toHaveLength(2);
			expect(kernels[0].isAlive()).toBe(true);
			expect(kernels[1].isAlive()).toBe(true);

			cleanupB = disposeKernelSessionsByOwner(options.kernelOwnerId);
			let cleanupASettled = false;
			let cleanupBSettled = false;
			markSettled(cleanupA, () => {
				cleanupASettled = true;
			});
			markSettled(cleanupB, () => {
				cleanupBSettled = true;
			});
			await waitForProcessGone(pidB);
			await flushMicrotasks();
			expect(cleanupASettled).toBe(false);
			expect(cleanupBSettled).toBe(false);
			expect(isProcessAlive(pidA)).toBe(true);
			expect(kernels[0].isAlive()).toBe(true);
			expect(kernels[1].isAlive()).toBe(false);
			expect(shutdownCallsA).toBe(1);

			releaseShutdownA.resolve();
			await Promise.all([cleanupA, cleanupB]);
			await executionB;
			await waitForProcessGone(pidA);
			expect(cleanupASettled).toBe(true);
			expect(cleanupBSettled).toBe(true);
			expect(isProcessAlive(pidA)).toBe(false);
			expect(isProcessAlive(pidB)).toBe(false);
			expect(kernels[0].isAlive()).toBe(false);
			expect(kernels[1].isAlive()).toBe(false);
			expect(shutdownCallsA).toBe(1);
		} catch (error) {
			bodyFailed = true;
			bodyError = error;
		} finally {
			releaseShutdownA.resolve();
			const finalCleanup = cleanupB ?? disposeKernelSessionsByOwner("same-owner-label");
			const settled = await Promise.allSettled([
				...(cleanupA ? [cleanupA] : []),
				finalCleanup,
				...(executionB ? [executionB] : []),
				disposeAllKernelSessions(),
			]);
			const failure = cleanupFailuresFrom(settled);
			if (failure) {
				cleanupFailed = true;
				cleanupError = failure;
			}
		}
		if (bodyFailed) throw bodyError;
		if (cleanupFailed) throw cleanupError;
	}, 30_000);

	it("publishes every physical retirement before an abort listener reenters owner cleanup", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-reentrant-cleanup-");
		const kernels: PythonKernel[] = [];
		const shutdownStarted = Promise.withResolvers<void>();
		const shutdownBStarted = Promise.withResolvers<void>();
		const releaseShutdown = Promise.withResolvers<void>();
		const releaseShutdownB = Promise.withResolvers<void>();
		const readyFile = `${tempDir.path()}/reentrant-running.ready`;
		const pidFile = `${tempDir.path()}/reentrant-running.pid`;
		const pidBFile = `${tempDir.path()}/reentrant-second.pid`;
		const ownerId = "reentrant-owner";
		let pid: number | undefined;
		let pidB: number | undefined;
		let execution: Promise<PythonResult> | undefined;
		let outerCleanup: Promise<void> | undefined;
		let nestedCleanup: Promise<void> | undefined;
		let nestedSettled = false;
		let shutdownCalls = 0;
		let shutdownCallsB = 0;
		let bodyFailed = false;
		let bodyError: unknown;
		let cleanupFailed = false;
		let cleanupError: unknown;
		vi.spyOn(PythonKernel, "start").mockImplementation(async options => {
			const kernel = await originalStart(options);
			kernels.push(kernel);
			if (options.cwd === tempDir.path()) {
				const originalExecute = kernel.execute.bind(kernel);
				kernel.execute = async (code, executeOptions) => {
					if (code.includes("reentrant-cleanup-session")) {
						executeOptions?.signal?.addEventListener(
							"abort",
							() => {
								nestedCleanup = disposeKernelSessionsByOwner(ownerId);
								markSettled(nestedCleanup, () => {
									nestedSettled = true;
								});
							},
							{ once: true },
						);
					}
					return await originalExecute(code, executeOptions);
				};
			}
			return kernel;
		});
		try {
			execution = executePython(
				`# reentrant-cleanup-session\nfrom pathlib import Path\nimport os, time\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))\nPath(${JSON.stringify(readyFile)}).touch()\ntime.sleep(60)`,
				{
					cwd: tempDir.path(),
					sessionId: "reentrant-cleanup-session",
					kernelMode: "session",
					kernelOwnerId: ownerId,
				},
			);
			await waitForFile(readyFile);
			pid = await waitForProcessFile(pidFile);
			const kernel = kernels[0];
			const second = await executePython(
				`from pathlib import Path\nimport os\nPath(${JSON.stringify(pidBFile)}).write_text(str(os.getpid()))`,
				{
					cwd: tempDir.path(),
					sessionId: "reentrant-second-session",
					kernelMode: "session",
					kernelOwnerId: ownerId,
				},
			);
			expect(second.exitCode).toBe(0);
			pidB = await waitForProcessFile(pidBFile);
			const kernelB = kernels[1];
			const originalShutdown = kernel.shutdown.bind(kernel);
			kernel.shutdown = async options => {
				shutdownCalls += 1;
				shutdownStarted.resolve();
				await releaseShutdown.promise;
				return await originalShutdown(options);
			};
			const originalShutdownB = kernelB.shutdown.bind(kernelB);
			kernelB.shutdown = async options => {
				shutdownCallsB += 1;
				shutdownBStarted.resolve();
				await releaseShutdownB.promise;
				return await originalShutdownB(options);
			};

			outerCleanup = disposeKernelSessionsByOwner(ownerId);
			await Promise.all([shutdownStarted.promise, shutdownBStarted.promise]);
			await flushMicrotasks();
			expect(nestedCleanup).toBeDefined();
			expect(nestedSettled).toBe(false);
			expect(isProcessAlive(pid)).toBe(true);
			expect(isProcessAlive(pidB)).toBe(true);
			expect(shutdownCalls).toBe(1);
			expect(shutdownCallsB).toBe(1);

			releaseShutdown.resolve();
			await waitForProcessGone(pid);
			await flushMicrotasks();
			expect(isProcessAlive(pidB)).toBe(true);
			expect(kernels[1].isAlive()).toBe(true);
			expect(nestedSettled).toBe(false);
			expect(shutdownCallsB).toBe(1);

			releaseShutdownB.resolve();
			await Promise.all([outerCleanup, nestedCleanup]);
			const result = await execution;
			expect(result.cancelled).toBe(true);
			await waitForProcessGone(pidB);
			expect(nestedSettled).toBe(true);
			expect(shutdownCalls).toBe(1);
			expect(shutdownCallsB).toBe(1);
		} catch (error) {
			bodyFailed = true;
			bodyError = error;
		} finally {
			releaseShutdown.resolve();
			releaseShutdownB.resolve();
			const finalCleanup = outerCleanup ?? disposeKernelSessionsByOwner(ownerId);
			const settled = await Promise.allSettled([
				finalCleanup,
				...(nestedCleanup ? [nestedCleanup] : []),
				...(execution ? [execution] : []),
				disposeAllKernelSessions(),
			]);
			const failure = cleanupFailuresFrom(settled);
			if (failure) {
				cleanupFailed = true;
				cleanupError = failure;
			}
		}
		if (bodyFailed) throw bodyError;
		if (cleanupFailed) throw cleanupError;
	}, 30_000);

	it("a second global cleanup captures a new same-name process while the first retirement is held", async () => {
		using tempDir = TempDir.createSync("@gjc-python-global-recapture-");
		const kernels = trackStartedKernels();
		const releaseShutdownA = Promise.withResolvers<void>();
		const shutdownAStarted = Promise.withResolvers<void>();
		const readyA = `${tempDir.path()}/global-a.ready`;
		const readyB = `${tempDir.path()}/global-b.ready`;
		const pidAFile = `${tempDir.path()}/global-a.pid`;
		const pidBFile = `${tempDir.path()}/global-b.pid`;
		let pidA: number | undefined;
		let pidB: number | undefined;
		let executionA: Promise<PythonResult> | undefined;
		let executionB: Promise<PythonResult> | undefined;
		let cleanupA: Promise<void> | undefined;
		let cleanupB: Promise<void> | undefined;
		let shutdownCallsA = 0;
		let bodyFailed = false;
		let bodyError: unknown;
		let cleanupFailed = false;
		let cleanupError: unknown;
		try {
			const options = {
				cwd: tempDir.path(),
				sessionId: "global-recapture-session",
				kernelMode: "session" as const,
			};
			executionA = executePython(
				`from pathlib import Path\nimport os, time\nPath(${JSON.stringify(pidAFile)}).write_text(str(os.getpid()))\nPath(${JSON.stringify(readyA)}).touch()\ntime.sleep(60)`,
				options,
			);
			await waitForFile(readyA);
			pidA = await waitForProcessFile(pidAFile);
			const kernelA = kernels[0];
			const originalShutdownA = kernelA.shutdown.bind(kernelA);
			kernelA.shutdown = async shutdownOptions => {
				shutdownCallsA += 1;
				shutdownAStarted.resolve();
				await releaseShutdownA.promise;
				return await originalShutdownA(shutdownOptions);
			};
			cleanupA = disposeAllKernelSessions();
			await shutdownAStarted.promise;

			executionB = executePython(
				`from pathlib import Path\nimport os, time\nPath(${JSON.stringify(pidBFile)}).write_text(str(os.getpid()))\nPath(${JSON.stringify(readyB)}).touch()\ntime.sleep(60)`,
				options,
			);
			await waitForFile(readyB);
			pidB = await waitForProcessFile(pidBFile);
			expect(kernels).toHaveLength(2);
			cleanupB = disposeAllKernelSessions();
			let cleanupASettled = false;
			let cleanupBSettled = false;
			markSettled(cleanupA, () => {
				cleanupASettled = true;
			});
			markSettled(cleanupB, () => {
				cleanupBSettled = true;
			});
			await waitForProcessGone(pidB);
			await flushMicrotasks();
			expect(cleanupASettled).toBe(false);
			expect(cleanupBSettled).toBe(false);
			expect(isProcessAlive(pidA)).toBe(true);
			expect(kernels[0].isAlive()).toBe(true);
			expect(kernels[1].isAlive()).toBe(false);
			expect(shutdownCallsA).toBe(1);

			releaseShutdownA.resolve();
			await Promise.all([cleanupA, cleanupB]);
			const [resultA, resultB] = await Promise.all([executionA, executionB]);
			expect(resultA.cancelled).toBe(true);
			expect(resultB.cancelled).toBe(true);
			await waitForProcessGone(pidA);
			expect(cleanupASettled).toBe(true);
			expect(cleanupBSettled).toBe(true);
			expect(kernels[0].isAlive()).toBe(false);
			expect(kernels[1].isAlive()).toBe(false);
		} catch (error) {
			bodyFailed = true;
			bodyError = error;
		} finally {
			releaseShutdownA.resolve();
			const finalCleanup = cleanupB ?? disposeAllKernelSessions();
			const settled = await Promise.allSettled([
				...(cleanupA ? [cleanupA] : []),
				finalCleanup,
				...(executionA ? [executionA] : []),
				...(executionB ? [executionB] : []),
				disposeAllKernelSessions(),
			]);
			const failure = cleanupFailuresFrom(settled);
			if (failure) {
				cleanupFailed = true;
				cleanupError = failure;
			}
		}
		if (bodyFailed) throw bodyError;
		if (cleanupFailed) throw cleanupError;
	}, 30_000);

	it("rejects unsuccessful physical shutdown and retries the same retained kernel", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-shutdown-retry-");
		const kernels = trackStartedKernels();
		const pidFile = `${tempDir.path()}/retry-kernel.pid`;
		let pid: number | undefined;
		let shutdownCalls = 0;
		try {
			const result = await executePython(
				`from pathlib import Path\nimport os\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))`,
				{
					cwd: tempDir.path(),
					sessionId: "shutdown-retry-session",
					kernelMode: "session",
					kernelOwnerId: "retry-owner",
				},
			);
			expect(result.exitCode).toBe(0);
			pid = await waitForProcessFile(pidFile);
			const kernel = kernels[0];
			const originalShutdown = kernel.shutdown.bind(kernel);
			const originalError = new Error("first real shutdown attempt rejected");
			kernel.shutdown = async options => {
				shutdownCalls += 1;
				if (shutdownCalls === 1) throw originalError;
				return await originalShutdown(options);
			};

			await expect(disposeKernelSessionsByOwner("retry-owner")).rejects.toBe(originalError);
			expect(isProcessAlive(pid)).toBe(true);
			expect(kernel.isAlive()).toBe(true);
			await disposeKernelSessionsByOwner("retry-owner");
			await waitForProcessGone(pid);
			expect(shutdownCalls).toBe(2);
			expect(kernel.isAlive()).toBe(false);
		} finally {
			await joinCleanupTasks([disposeAllKernelSessions()]);
		}
	}, 30_000);

	it("propagates an actual unconfirmed shutdown result and retries that retained physical kernel", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-shutdown-unconfirmed-");
		const kernels = trackStartedKernels();
		const readyFile = `${tempDir.path()}/unconfirmed-shutdown.ready`;
		const pidFile = `${tempDir.path()}/unconfirmed-shutdown.pid`;
		const secondShutdownStarted = Promise.withResolvers<void>();
		const releaseSecondShutdown = Promise.withResolvers<void>();
		let pid: number | undefined;
		let execution: Promise<PythonResult> | undefined;
		let firstCleanup: Promise<void> | undefined;
		let retryCleanup: Promise<void> | undefined;
		let firstShutdownResult: KernelShutdownResult | undefined;
		let secondShutdownResult: KernelShutdownResult | undefined;
		let secondShutdownReceiver: PythonKernel | undefined;
		let shutdownCalls = 0;
		let bodyFailed = false;
		let bodyError: unknown;
		let cleanupFailed = false;
		let cleanupError: unknown;
		try {
			execution = executePython(
				`from pathlib import Path\nimport os, signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))\nPath(${JSON.stringify(readyFile)}).touch()\ntime.sleep(60)`,
				{
					cwd: tempDir.path(),
					sessionId: "shutdown-unconfirmed-session",
					kernelMode: "session",
					kernelOwnerId: "unconfirmed-owner",
				},
			);
			await waitForFile(readyFile);
			pid = await waitForProcessFile(pidFile);
			const kernel = kernels[0];
			const originalShutdown = kernel.shutdown.bind(kernel);
			kernel.shutdown = async function (this: PythonKernel, options?: Parameters<PythonKernel["shutdown"]>[0]) {
				const call = ++shutdownCalls;
				if (call === 2) {
					secondShutdownReceiver = this;
					secondShutdownStarted.resolve();
					await releaseSecondShutdown.promise;
				}
				const result = await originalShutdown(call === 1 ? { ...options, timeoutMs: 0 } : options);
				if (call === 1) firstShutdownResult = result;
				else secondShutdownResult = result;
				return result;
			};

			firstCleanup = disposeKernelSessionsByOwner("unconfirmed-owner");
			await expect(firstCleanup).rejects.toMatchObject({
				name: "PythonKernelShutdownUnconfirmedError",
			});
			expect(kernels).toHaveLength(1);
			expect(kernels[0]).toBe(kernel);
			const executionResult = await execution;
			expect(executionResult.cancelled).toBe(true);
			expect(firstShutdownResult).toEqual({ confirmed: false });
			expect(shutdownCalls).toBe(1);

			await waitForProcessGone(pid);
			retryCleanup = disposeKernelSessionsByOwner("unconfirmed-owner");
			const retryStartTimeout = Promise.withResolvers<void>();
			const retryStartTimer = setTimeout(retryStartTimeout.resolve, 5_000);
			try {
				await Promise.race([
					secondShutdownStarted.promise,
					retryStartTimeout.promise.then(() => {
						throw new Error("Timed out waiting for retained Python kernel shutdown retry");
					}),
				]);
			} finally {
				clearTimeout(retryStartTimer);
			}
			let retrySettled = false;
			void retryCleanup.then(
				() => {
					retrySettled = true;
				},
				() => {
					retrySettled = true;
				},
			);
			await flushMicrotasks();
			expect(retrySettled).toBe(false);
			expect(shutdownCalls).toBe(2);
			expect(secondShutdownReceiver).toBe(kernel);
			releaseSecondShutdown.resolve();
			await retryCleanup;
			await waitForProcessGone(pid);
			expect(secondShutdownResult).toEqual({ confirmed: true });
			expect(shutdownCalls).toBe(2);
			expect(secondShutdownReceiver).toBe(kernel);
			expect(kernels).toHaveLength(1);
			expect(kernels[0]).toBe(kernel);
			expect(kernel.isAlive()).toBe(false);
		} catch (error) {
			bodyFailed = true;
			bodyError = error;
		} finally {
			releaseSecondShutdown.resolve();
			const settled = await Promise.allSettled([
				...(retryCleanup ? [retryCleanup] : []),
				disposeKernelSessionsByOwner("unconfirmed-owner"),
				...(execution ? [execution] : []),
				...(pid !== undefined ? [waitForProcessGone(pid)] : []),
				disposeAllKernelSessions(),
			]);
			const failure = cleanupFailuresFrom(settled);
			if (failure) {
				cleanupFailed = true;
				cleanupError = failure;
			}
		}
		if (bodyFailed) throw bodyError;
		if (cleanupFailed) throw cleanupError;
	}, 30_000);

	it("joins owner cleanup across held real availability preflight and prevents a late kernel launch", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-preflight-");
		const cwd = tempDir.path();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const kernels = trackStartedKernels();
		let execution: Promise<PythonResult> | undefined;
		let cleanup: Promise<void> | undefined;
		holdAvailability(cwd, release.promise, entered.resolve);
		try {
			execution = executePython("print('must not launch')", {
				cwd,
				sessionId: "held-preflight",
				kernelMode: "session",
				kernelOwnerId: "owner-a",
			});
			await entered.promise;
			cleanup = disposeKernelSessionsByOwner("owner-a");
			let cleanupSettled = false;
			markSettled(cleanup, () => {
				cleanupSettled = true;
			});
			await flushMicrotasks();
			expect(cleanupSettled).toBe(false);
			expect(kernels).toHaveLength(0);

			release.resolve();
			const result = await execution;
			await cleanup;
			expect(result.cancelled).toBe(true);
			expect(kernels).toHaveLength(0);
		} finally {
			release.resolve();
			await joinCleanupTasks([
				cleanup ?? disposeKernelSessionsByOwner("owner-a"),
				...(execution ? [execution] : []),
				disposeAllKernelSessions(),
			]);
		}
	}, 30_000);

	it("joins a held genuine initializer and shuts down its unpublished real kernel", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-initializer-");
		const cwd = tempDir.path();
		const pidFile = `${cwd}/held-initializer.pid`;
		const initialized = Promise.withResolvers<PythonKernel>();
		const release = Promise.withResolvers<void>();
		const kernels: PythonKernel[] = [];
		vi.spyOn(PythonKernel, "start").mockImplementation(async options => {
			const kernel = await originalStart(options);
			kernels.push(kernel);
			if (options.cwd === cwd) {
				const marked = await kernel.execute(
					`from pathlib import Path\nimport os\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))`,
				);
				if (marked.status !== "ok") throw new Error("Could not mark the held initializer process");
				initialized.resolve(kernel);
				await release.promise;
			}
			return kernel;
		});
		let execution: Promise<PythonResult> | undefined;
		let cleanup: Promise<void> | undefined;
		let pid: number | undefined;
		try {
			execution = executePython("print('must not execute')", {
				cwd,
				sessionId: "held-initializer",
				kernelMode: "session",
				kernelOwnerId: "owner-a",
			});
			const kernel = await initialized.promise;
			pid = await waitForProcessFile(pidFile);
			expect(kernel.isAlive()).toBe(true);

			cleanup = disposeKernelSessionsByOwner("owner-a");
			let cleanupSettled = false;
			markSettled(cleanup, () => {
				cleanupSettled = true;
			});
			await flushMicrotasks();
			expect(cleanupSettled).toBe(false);
			await waitForProcessGone(pid);
			expect(kernel.isAlive()).toBe(false);

			release.resolve();
			const result = await execution;
			await cleanup;
			expect(result.cancelled).toBe(true);
			expect(result.output).not.toContain("must not execute");
			expect(kernel.isAlive()).toBe(false);
		} finally {
			release.resolve();
			await joinCleanupTasks([
				cleanup ?? disposeKernelSessionsByOwner("owner-a"),
				...(execution ? [execution] : []),
				disposeAllKernelSessions(),
			]);
		}
	}, 30_000);

	it("keeps a shared initializer created by A alive when owner B survives A retirement", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-creator-a-shared-");
		const cwd = tempDir.path();
		const pidFile = `${cwd}/creator-a.pid`;
		const readyFile = `${cwd}/creator-b.ready`;
		const initialized = Promise.withResolvers<PythonKernel>();
		const waiterAvailability = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const kernels: PythonKernel[] = [];
		let initializationReached = false;
		let executionA: Promise<PythonResult> | undefined;
		let executionB: Promise<PythonResult> | undefined;
		let ownerCleanup: Promise<void> | undefined;
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockImplementation(async (...args) => {
			if (initializationReached && args[0] === cwd) waiterAvailability.resolve();
			return await originalAvailability(...args);
		});
		vi.spyOn(PythonKernel, "start").mockImplementation(async options => {
			const kernel = await originalStart(options);
			kernels.push(kernel);
			if (options.cwd === cwd) {
				const marked = await kernel.execute(
					`from pathlib import Path\nimport os\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))`,
				);
				if (marked.status !== "ok") throw new Error("Could not mark owner A's shared initializer");
				initializationReached = true;
				initialized.resolve(kernel);
				await release.promise;
			}
			return kernel;
		});
		try {
			executionA = executePython("print('A initializer request')", {
				cwd,
				sessionId: "creator-a-shared-initializer",
				kernelMode: "session",
				kernelOwnerId: "owner-a",
			});
			const failIfSettled = (execution: Promise<PythonResult>, owner: string): Promise<never> =>
				execution.then(result => {
					throw new Error(`${owner} request settled before its initializer gate: ${result.output}`);
				});
			const kernel = await Promise.race([initialized.promise, failIfSettled(executionA, "A")]);
			const pid = await waitForProcessFile(pidFile);
			executionB = executePython(`from pathlib import Path\nPath(${JSON.stringify(readyFile)}).touch()`, {
				cwd,
				sessionId: "creator-a-shared-initializer",
				kernelMode: "session",
				kernelOwnerId: "owner-b",
			});
			await Promise.race([waiterAvailability.promise, failIfSettled(executionB, "B")]);
			await flushMicrotasks(12);

			ownerCleanup = disposeKernelSessionsByOwner("owner-a");
			const resultA = await waitForRequest(
				executionA,
				5_000,
				"Cancelled creator A remained joined to the surviving B initializer",
			);
			expect(resultA.cancelled).toBe(true);
			let cleanupSettled = false;
			markSettled(ownerCleanup, () => {
				cleanupSettled = true;
			});
			await flushMicrotasks();
			expect(cleanupSettled).toBe(false);
			expect(kernels).toHaveLength(1);
			expect(kernel.isAlive()).toBe(true);
			expect(isProcessAlive(pid)).toBe(true);

			release.resolve();
			const resultB = await executionB;
			await ownerCleanup;
			expect(resultB.exitCode).toBe(0);
			expect(await Bun.file(readyFile).exists()).toBe(true);
			expect(kernels).toHaveLength(1);
			expect(kernel.isAlive()).toBe(true);
			expect(isProcessAlive(pid)).toBe(true);

			await disposeKernelSessionsByOwner("owner-b");
			await waitForProcessGone(pid);
			expect(kernel.isAlive()).toBe(false);
		} finally {
			release.resolve();
			await joinCleanupTasks([
				...(ownerCleanup ? [ownerCleanup] : []),
				...(executionA ? [executionA] : []),
				...(executionB ? [executionB] : []),
				disposeKernelSessionsByOwner("owner-b"),
				disposeAllKernelSessions(),
			]);
		}
	}, 30_000);

	it("keeps an A waiter joined through synchronous cleanup reentry while B's shared initializer survives", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-shared-initializer-");
		const cwd = tempDir.path();
		const startEntered = Promise.withResolvers<void>();
		const allowCreation = Promise.withResolvers<void>();
		const initialized = Promise.withResolvers<PythonKernel>();
		const release = Promise.withResolvers<void>();
		const waiterAvailability = Promise.withResolvers<void>();
		const readyPath = `${cwd}/initializer-b.ready`;
		const pidPath = `${cwd}/initializer-b.pid`;
		const kernels: PythonKernel[] = [];
		let initializerStartEntered = false;
		let creationCallbackEntered = false;
		let executionA: Promise<PythonResult> | undefined;
		let executionB: Promise<PythonResult> | undefined;
		let ownerCleanup: Promise<void> | undefined;
		let reentrantCleanup: Promise<void> | undefined;
		let bodyFailed = false;
		let bodyError: unknown;
		let cleanupFailed = false;
		let cleanupError: unknown;
		const controller = new AbortController();
		const options = {
			cwd,
			sessionId: "shared-held-initializer",
			kernelMode: "session" as const,
		};
		controller.signal.addEventListener(
			"abort",
			() => {
				reentrantCleanup = disposeKernelSessionsByOwner("owner-a");
			},
			{ once: true },
		);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockImplementation(async (...args) => {
			if (initializerStartEntered && args[0] === cwd) waiterAvailability.resolve();
			return await originalAvailability(...args);
		});
		vi.spyOn(PythonKernel, "start").mockImplementation(async startOptions => {
			if (startOptions.cwd !== cwd) return await originalStart(startOptions);
			initializerStartEntered = true;
			startEntered.resolve();
			await allowCreation.promise;
			const registerKernel = startOptions.onKernelCreated;
			const kernel = await originalStart({
				...startOptions,
				onKernelCreated: created => {
					registerKernel?.(created);
					kernels.push(created);
					if (creationCallbackEntered) return;
					creationCallbackEntered = true;
					ownerCleanup = disposeKernelSessionsByOwner("owner-a");
					controller.abort(new DOMException("reenter owner cleanup", "AbortError"));
				},
			});
			const marked = await kernel.execute(
				`from pathlib import Path\nimport os\nPath(${JSON.stringify(pidPath)}).write_text(str(os.getpid()))`,
			);
			if (marked.status !== "ok") throw new Error("Could not mark the real shared initializer process");
			initialized.resolve(kernel);
			await release.promise;
			return kernel;
		});
		try {
			executionB = executePython(`from pathlib import Path\nPath(${JSON.stringify(readyPath)}).touch()`, {
				...options,
				kernelOwnerId: "owner-b",
			});
			const failIfSettled = (execution: Promise<PythonResult>, owner: string): Promise<never> =>
				execution.then(result => {
					throw new Error(`${owner} request settled before its setup gate: ${result.output}`);
				});
			await Promise.race([startEntered.promise, failIfSettled(executionB, "B")]);

			executionA = executePython("print('A waits on B initializer')", {
				...options,
				kernelOwnerId: "owner-a",
				signal: controller.signal,
			});
			await Promise.race([
				waiterAvailability.promise,
				failIfSettled(executionA, "A"),
				failIfSettled(executionB, "B"),
			]);
			await flushMicrotasks(12);
			allowCreation.resolve();

			const kernel = await Promise.race([initialized.promise, failIfSettled(executionB, "B")]);
			const pid = await waitForProcessFile(pidPath);
			expect(kernel.isAlive()).toBe(true);

			if (!ownerCleanup || !reentrantCleanup) throw new Error("Creation callback did not trigger cleanup reentry");
			let ownerCleanupSettled = false;
			let reentrantCleanupSettled = false;
			markSettled(ownerCleanup, () => {
				ownerCleanupSettled = true;
			});
			markSettled(reentrantCleanup, () => {
				reentrantCleanupSettled = true;
			});
			expect(reentrantCleanup).toBeDefined();
			const resultA = await waitForRequest(executionA, 5_000, "Cancelled A remained joined to B's held initializer");
			expect(resultA.cancelled).toBe(true);
			await flushMicrotasks();
			expect(ownerCleanupSettled).toBe(false);
			expect(reentrantCleanupSettled).toBe(false);
			expect(kernels).toHaveLength(1);
			expect(kernel.isAlive()).toBe(true);
			expect(isProcessAlive(pid)).toBe(true);

			release.resolve();
			const resultB = await executionB;
			expect(resultB.exitCode).toBe(0);
			await Promise.all([ownerCleanup, reentrantCleanup]);
			expect(ownerCleanupSettled).toBe(true);
			expect(reentrantCleanupSettled).toBe(true);
			expect(kernels).toHaveLength(1);
			expect(kernel.isAlive()).toBe(true);
			expect(await Bun.file(readyPath).exists()).toBe(true);

			await disposeKernelSessionsByOwner("owner-b");
			await waitForProcessGone(pid);
			expect(kernel.isAlive()).toBe(false);
		} catch (error) {
			bodyFailed = true;
			bodyError = error;
		} finally {
			allowCreation.resolve();
			release.resolve();
			controller.abort();
			const settled = await Promise.allSettled([
				...(ownerCleanup ? [ownerCleanup] : []),
				...(reentrantCleanup ? [reentrantCleanup] : []),
				...(executionA ? [executionA] : []),
				...(executionB ? [executionB] : []),
				disposeKernelSessionsByOwner("owner-b"),
				disposeAllKernelSessions(),
			]);
			const failure = cleanupFailuresFrom(settled);
			if (failure) {
				cleanupFailed = true;
				cleanupError = failure;
			}
		}
		if (bodyFailed) throw bodyError;
		if (cleanupFailed) throw cleanupError;
	}, 30_000);

	it("retains a real partial-start kernel when its first shutdown rejects, then retries explicitly", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-partial-start-retention-");
		const cwd = tempDir.path();
		const ownerId = "partial-start-owner";
		const startupError = new Error("injected actual creation-callback failure");
		const shutdownError = new Error("first partial-start shutdown rejected");
		const getRunnerPid = observeRunnerPid(cwd);
		let pid: number | undefined;
		let kernel: PythonKernel | undefined;
		let creationCallbacks = 0;
		let startupFailureCallbacks = 0;
		let shutdownCalls = 0;
		let cleanup: Promise<void> | undefined;
		vi.spyOn(PythonKernel, "start").mockImplementation(async options => {
			const registerKernel = options.onKernelCreated;
			const handleStartupFailure = options.onStartupFailure;
			return await originalStart({
				...options,
				onKernelCreated: created => {
					registerKernel?.(created);
					kernel = created;
					creationCallbacks += 1;
					const shutdown = created.shutdown.bind(created);
					created.shutdown = async shutdownOptions => {
						shutdownCalls += 1;
						if (shutdownCalls === 1) throw shutdownError;
						return await shutdown(shutdownOptions);
					};
					throw startupError;
				},
				onStartupFailure: async failed => {
					startupFailureCallbacks += 1;
					await handleStartupFailure?.(failed);
				},
			});
		});
		try {
			const execution = executePython("print('partial startup must not execute')", {
				cwd,
				sessionId: "partial-start-session",
				kernelMode: "session",
				kernelOwnerId: ownerId,
			});
			await expect(execution).rejects.toBe(startupError);
			expect(creationCallbacks).toBe(1);
			expect(startupFailureCallbacks).toBe(1);
			expect(shutdownCalls).toBe(1);
			pid = getRunnerPid();
			if (!kernel || pid === undefined) throw new Error("Actual runner process was not captured at creation");
			expect(isProcessAlive(pid)).toBe(true);
			expect(kernel.isAlive()).toBe(true);

			cleanup = disposeKernelSessionsByOwner(ownerId);
			await cleanup;
			expect(shutdownCalls).toBe(2);
			await waitForProcessGone(pid);
			expect(kernel.isAlive()).toBe(false);
		} finally {
			await joinCleanupTasks([
				...(cleanup ? [cleanup] : [disposeKernelSessionsByOwner(ownerId)]),
				disposeAllKernelSessions(),
				...(pid !== undefined ? [waitForProcessGone(pid)] : []),
			]);
		}
	}, 30_000);

	it("keeps a fallback owner through another request's failed preflight", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-fallback-preflight-");
		const cwd = tempDir.path();
		const pidFile = `${cwd}/fallback-owner.pid`;
		const releaseStart = Promise.withResolvers<void>();
		const started = Promise.withResolvers<PythonKernel>();
		const preflightError = new Error("B preflight failed before acquisition");
		let rejectBPreflight = false;
		let startCalls = 0;
		let executionA: Promise<PythonResult> | undefined;
		let executionB: Promise<PythonResult> | undefined;
		let executionASettled = false;
		let executionBSettled = false;
		let globalCleanup: Promise<void> | undefined;
		let pid: number | undefined;
		let bodyError: unknown;
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockImplementation(async (...args) => {
			if (args[0] === cwd && rejectBPreflight) {
				rejectBPreflight = false;
				throw preflightError;
			}
			return await originalAvailability(...args);
		});
		vi.spyOn(PythonKernel, "start").mockImplementation(async options => {
			startCalls += 1;
			const created = await originalStart(options);
			if (options.cwd === cwd) {
				const marked = await created.execute(
					`from pathlib import Path\nimport os\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))`,
				);
				if (marked.status !== "ok") throw new Error("Could not observe the fallback initializer PID");
				started.resolve(created);
				await releaseStart.promise;
			}
			return created;
		});
		try {
			executionA = executePython("print('fallback A remains active')", {
				cwd,
				sessionId: "fallback-preflight-session",
				kernelMode: "session",
			});
			markSettled(executionA, () => {
				executionASettled = true;
			});
			const actualKernel = await started.promise;
			pid = await waitForProcessFile(pidFile);
			expect(actualKernel.isAlive()).toBe(true);
			rejectBPreflight = true;
			executionB = executePython("print('B must fail before acquisition')", {
				cwd,
				sessionId: "fallback-preflight-session",
				kernelMode: "session",
				kernelOwnerId: "explicit-owner-b",
			});
			markSettled(executionB, () => {
				executionBSettled = true;
			});
			await expect(executionB).rejects.toBe(preflightError);
			expect(actualKernel.isAlive()).toBe(true);
			expect(isProcessAlive(pid)).toBe(true);
			expect(startCalls).toBe(1);

			releaseStart.resolve();
			const resultA = await executionA;
			expect(resultA.exitCode).toBe(0);
			expect(actualKernel.isAlive()).toBe(true);
			globalCleanup = disposeAllKernelSessions();
			await globalCleanup;
			await waitForProcessGone(pid);
			expect(actualKernel.isAlive()).toBe(false);
			expect(startCalls).toBe(1);
		} catch (error) {
			bodyError = error;
		} finally {
			releaseStart.resolve();
			await joinCleanupTasks([
				...(executionA && !executionASettled ? [executionA] : []),
				...(executionB && !executionBSettled ? [executionB] : []),
				...(globalCleanup ? [globalCleanup] : []),
				disposeAllKernelSessions(),
				...(pid !== undefined ? [waitForProcessGone(pid)] : []),
			]);
		}
		if (bodyError !== undefined) throw bodyError;
	}, 30_000);

	it("direct PythonKernel.start exposes a real spawned kernel when standalone cleanup rejects", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-direct-start-retention-");
		const cwd = tempDir.path();
		const startupError = new Error("direct kernel creation callback failed");
		const shutdownError = new Error("direct startup shutdown rejected");
		const getRunnerPid = observeRunnerPid(cwd);
		let kernel: PythonKernel | undefined;
		let shutdownCalls = 0;
		let startError: PythonKernelStartError | undefined;
		try {
			await PythonKernel.start({
				cwd,
				onKernelCreated: created => {
					kernel = created;
					const shutdown = created.shutdown.bind(created);
					created.shutdown = async shutdownOptions => {
						shutdownCalls += 1;
						if (shutdownCalls === 1) throw shutdownError;
						return await shutdown(shutdownOptions);
					};
					throw startupError;
				},
			});
			throw new Error("Direct kernel start unexpectedly succeeded");
		} catch (error) {
			if (!(error instanceof PythonKernelStartError)) {
				const pid = getRunnerPid();
				await joinCleanupTasks([
					...(kernel ? [shutdownAndConfirm(kernel)] : []),
					...(pid !== undefined ? [waitForProcessGone(pid)] : []),
				]);
				throw error;
			}
			startError = error;
		}
		try {
			const pid = getRunnerPid();
			if (!startError) throw new Error("Standalone startup did not report cleanup failure");
			if (!kernel) throw new Error("Actual standalone Python kernel was not captured before startup failure");
			expect(startError.startupError).toBe(startupError);
			expect(startError.cause).toBe(startupError);
			expect(startError.cleanupFailure).toEqual({ kind: "rejected", error: shutdownError });
			expect(startError.kernel).toBe(kernel);
			expect(shutdownCalls).toBe(1);
			if (pid === undefined) throw new Error("Actual standalone Python runner PID was not observed");
			expect(isProcessAlive(pid)).toBe(true);
			expect(startError.kernel.isAlive()).toBe(true);
			const result = await startError.kernel.shutdown();
			expect(result.confirmed).toBe(true);
			expect(shutdownCalls).toBe(2);
			await waitForProcessGone(pid);
		} finally {
			const pid = getRunnerPid();
			await joinCleanupTasks([
				...(kernel ? [shutdownAndConfirm(kernel)] : []),
				...(pid !== undefined ? [waitForProcessGone(pid)] : []),
			]);
		}
		expect(kernel?.isAlive()).toBe(false);
	}, 30_000);

	it("direct startup failure reports the real shutdown outcome without assuming PID state", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-direct-start-outcome-");
		const cwd = tempDir.path();
		const startupError = new Error("direct startup failed after spawn");
		const getRunnerPid = observeRunnerPid(cwd);
		let kernel: PythonKernel | undefined;
		let shutdownCalls = 0;
		try {
			let startError: unknown;
			try {
				await PythonKernel.start({
					cwd,
					onKernelCreated: created => {
						kernel = created;
						const shutdown = created.shutdown.bind(created);
						created.shutdown = async shutdownOptions => {
							shutdownCalls += 1;
							return await shutdown(
								shutdownCalls === 1 ? { ...shutdownOptions, timeoutMs: 0 } : shutdownOptions,
							);
						};
						throw startupError;
					},
				});
				throw new Error("Direct startup unexpectedly succeeded");
			} catch (error) {
				startError = error;
			}
			if (startError instanceof PythonKernelStartError) {
				expect(startError.startupError).toBe(startupError);
				if (startError.cleanupFailure.kind === "unconfirmed") {
					expect(startError.cleanupFailure.result.confirmed).toBe(false);
				} else {
					expect(startError.cleanupFailure.error).toBeDefined();
				}
				kernel = startError.kernel;
				const retry = await kernel.shutdown();
				expect(retry.confirmed).toBe(true);
				expect(shutdownCalls).toBe(2);
			} else {
				expect(startError).toBe(startupError);
			}
			const pid = getRunnerPid();
			if (pid === undefined) throw new Error("Actual direct-start runner PID was not observed");
			await waitForProcessGone(pid);
			expect(kernel).toBeDefined();
		} finally {
			const pid = getRunnerPid();
			await joinCleanupTasks([
				...(kernel ? [shutdownAndConfirm(kernel)] : []),
				...(pid !== undefined ? [waitForProcessGone(pid)] : []),
			]);
		}
	}, 30_000);

	it("does not publish a replacement when cancellation arrives during failed-initializer retry", async () => {
		using tempDir = TempDir.createSync("@gjc-python-cancel-retry-startup-");
		const cwd = tempDir.path();
		const getRunnerPid = observeRunnerPid(cwd);
		const retryEntered = Promise.withResolvers<void>();
		const releaseRetry = Promise.withResolvers<void>();
		const startupError = new Error("retry startup callback failed");
		const shutdownError = new Error("initial partial-start shutdown rejected");
		let kernel: PythonKernel | undefined;
		let startCalls = 0;
		let shutdownCalls = 0;
		let pid: number | undefined;
		let initialExecution: Promise<PythonResult> | undefined;
		let retryExecution: Promise<PythonResult> | undefined;
		let cleanup: Promise<void> | undefined;
		const retryController = new AbortController();
		vi.spyOn(PythonKernel, "start").mockImplementation(async options => {
			startCalls += 1;
			const registerKernel = options.onKernelCreated;
			const handleStartupFailure = options.onStartupFailure;
			return await originalStart({
				...options,
				onKernelCreated: created => {
					registerKernel?.(created);
					if (options.cwd !== cwd) return;
					kernel = created;
					const shutdown = created.shutdown.bind(created);
					created.shutdown = async shutdownOptions => {
						shutdownCalls += 1;
						if (shutdownCalls === 1) throw shutdownError;
						if (shutdownCalls === 2) {
							retryEntered.resolve();
							await releaseRetry.promise;
						}
						return await shutdown(shutdownOptions);
					};
					throw startupError;
				},
				onStartupFailure: async failed => {
					await handleStartupFailure?.(failed);
				},
			});
		});
		try {
			initialExecution = executePython("print('initial start')", {
				cwd,
				sessionId: "cancel-during-initializer-retry",
				kernelMode: "session",
				kernelOwnerId: "retry-owner",
			});
			await expect(initialExecution).rejects.toBe(startupError);
			expect(shutdownCalls).toBe(1);
			if (!kernel) throw new Error("Partial-start callback did not retain its real kernel");
			pid = getRunnerPid();
			if (pid === undefined) throw new Error("Partial-start runner PID was not observed");
			expect(kernel.isAlive()).toBe(true);
			expect(isProcessAlive(pid)).toBe(true);

			retryExecution = executePython("print('cancelled retry')", {
				cwd,
				sessionId: "cancel-during-initializer-retry",
				kernelMode: "session",
				kernelOwnerId: "retry-owner",
				signal: retryController.signal,
			});
			await retryEntered.promise;
			retryController.abort(new DOMException("cancel retry", "AbortError"));
			releaseRetry.resolve();
			const result = await retryExecution;
			expect(result.cancelled).toBe(true);
			expect(startCalls).toBe(1);
			expect(shutdownCalls).toBe(2);
			await waitForProcessGone(pid);
			expect(kernel.isAlive()).toBe(false);
			cleanup = disposeAllKernelSessions();
			await cleanup;
			expect(startCalls).toBe(1);
		} finally {
			releaseRetry.resolve();
			retryController.abort();
			await joinCleanupTasks([
				...(retryExecution ? [retryExecution] : []),
				...(cleanup ? [cleanup] : []),
				disposeKernelSessionsByOwner("retry-owner"),
				disposeAllKernelSessions(),
				...(kernel ? [shutdownAndConfirm(kernel)] : []),
				...(pid !== undefined ? [waitForProcessGone(pid)] : []),
			]);
		}
	}, 30_000);

	it("propagates and retries failed shutdown of a captured late initializer by its original label", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-late-shutdown-retry-");
		const cwd = tempDir.path();
		const initialized = Promise.withResolvers<PythonKernel>();
		const release = Promise.withResolvers<void>();
		const pidFile = `${cwd}/late-kernel.pid`;
		const kernels: PythonKernel[] = [];
		const originalError = new Error("late kernel shutdown failed");
		const shutdownStarted = Promise.withResolvers<void>();
		let shutdownCalls = 0;
		vi.spyOn(PythonKernel, "start").mockImplementation(async options => {
			const kernel = await originalStart(options);
			kernels.push(kernel);
			if (options.cwd === cwd) {
				const shutdown = kernel.shutdown.bind(kernel);
				kernel.shutdown = async shutdownOptions => {
					shutdownCalls += 1;
					if (shutdownCalls === 1) {
						shutdownStarted.resolve();
						throw originalError;
					}
					return await shutdown(shutdownOptions);
				};
				const marked = await kernel.execute(
					`from pathlib import Path\nimport os\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))`,
				);
				if (marked.status !== "ok") throw new Error("Could not mark the real late initializer process");
				initialized.resolve(kernel);
				await release.promise;
			}
			return kernel;
		});
		let execution: Promise<PythonResult> | undefined;
		let cleanup: Promise<void> | undefined;
		let pid: number | undefined;
		try {
			execution = executePython("print('late initializer must not publish')", {
				cwd,
				sessionId: "late-initializer-retry-session",
				kernelMode: "session",
				kernelOwnerId: "late-retry-owner",
			});
			const kernel = await initialized.promise;
			pid = await waitForProcessFile(pidFile);
			cleanup = disposeKernelSessionsByOwner("late-retry-owner");
			await shutdownStarted.promise;
			await flushMicrotasks();
			expect(shutdownCalls).toBe(1);
			expect(isProcessAlive(pid)).toBe(true);
			expect(kernel.isAlive()).toBe(true);
			release.resolve();
			await expect(cleanup).rejects.toBe(originalError);
			const result = await execution;
			expect(result.cancelled).toBe(true);
			expect(isProcessAlive(pid)).toBe(true);
			expect(kernel.isAlive()).toBe(true);

			await disposeKernelSessionsByOwner("late-retry-owner");
			await waitForProcessGone(pid);
			expect(shutdownCalls).toBe(2);
			expect(kernel.isAlive()).toBe(false);
		} finally {
			release.resolve();
			await joinCleanupTasks([...(execution ? [execution] : []), disposeAllKernelSessions()]);
		}
	}, 30_000);

	it("global cleanup cancels a captured pre-spawn request without retiring the later same-name kernel", async () => {
		using tempDir = TempDir.createSync("@gjc-python-global-preflight-");
		const cwd = tempDir.path();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const pidFile = `${cwd}/global-successor.pid`;
		const kernels: PythonKernel[] = [];
		const physicallyCreated: PythonKernel[] = [];
		vi.spyOn(PythonKernel, "start").mockImplementation(async options => {
			const onKernelCreated = options.onKernelCreated;
			const kernel = await originalStart({
				...options,
				onKernelCreated: created => {
					physicallyCreated.push(created);
					onKernelCreated?.(created);
				},
			});
			kernels.push(kernel);
			return kernel;
		});
		let executionA: Promise<PythonResult> | undefined;
		let globalCleanup: Promise<void> | undefined;
		holdAvailability(cwd, release.promise, entered.resolve);
		try {
			executionA = executePython("print('A must not launch')", {
				cwd,
				sessionId: "global-captured-session",
				kernelMode: "session",
				kernelOwnerId: "owner-a",
			});
			await entered.promise;
			expect(physicallyCreated).toHaveLength(0);
			globalCleanup = disposeAllKernelSessions();
			let cleanupSettled = false;
			markSettled(globalCleanup, () => {
				cleanupSettled = true;
			});

			const firstB = await executePython(
				`from pathlib import Path\nimport os\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))`,
				{
					cwd,
					sessionId: "global-captured-session",
					kernelMode: "session",
					kernelOwnerId: "owner-b",
				},
			);
			expect(firstB.exitCode).toBe(0);
			const successorPid = await waitForProcessFile(pidFile);
			expect(isProcessAlive(successorPid)).toBe(true);
			expect(kernels).toHaveLength(1);
			expect(physicallyCreated).toHaveLength(1);
			expect(kernels[0].isAlive()).toBe(true);
			expect(cleanupSettled).toBe(false);

			release.resolve();
			const resultA = await executionA;
			await globalCleanup;
			expect(resultA.cancelled).toBe(true);

			const secondB = await executePython(
				`from pathlib import Path\nimport os\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))`,
				{
					cwd,
					sessionId: "global-captured-session",
					kernelMode: "session",
					kernelOwnerId: "owner-b",
				},
			);
			expect(secondB.exitCode).toBe(0);
			expect(Number((await Bun.file(pidFile).text()).trim())).toBe(successorPid);
			expect(isProcessAlive(successorPid)).toBe(true);
			expect(kernels).toHaveLength(1);
			expect(physicallyCreated).toHaveLength(1);
			expect(kernels[0].isAlive()).toBe(true);
		} finally {
			release.resolve();
			await joinCleanupTasks([
				globalCleanup ?? disposeAllKernelSessions(),
				...(executionA ? [executionA] : []),
				disposeAllKernelSessions(),
			]);
		}
	}, 30_000);

	it("settles a real in-flight kernel that ignores SIGINT within the finite outer timeout", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-sigint-");
		const kernels = trackStartedKernels();
		const controller = new AbortController();
		const readyFile = `${tempDir.path()}/ignoring-sigint-ready`;
		let execution: Promise<PythonResult> | undefined;
		try {
			execution = executePython(
				`import signal, time\nfrom pathlib import Path\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nPath(${JSON.stringify(readyFile)}).touch()\ntime.sleep(60)`,
				{
					cwd: tempDir.path(),
					sessionId: "ignore-sigint-session",
					kernelMode: "session",
					kernelOwnerId: "owner-a",
					signal: controller.signal,
					timeoutMs: 30_000,
				},
			);
			await waitForFile(readyFile);
			const abortedAt = Date.now();
			controller.abort(new DOMException("cancel ignored-SIGINT cell", "AbortError"));
			const result = await execution;
			expect(result.cancelled).toBe(true);
			expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(4_000);
			expect(kernels).toHaveLength(1);
			expect(kernels[0].isAlive()).toBe(false);
			await disposeKernelSessionsByOwner("owner-a");
		} finally {
			controller.abort();
			await joinCleanupTasks([...(execution ? [execution] : []), disposeAllKernelSessions()]);
		}
	}, 30_000);

	it("global disposal cancels queued real executions before their Python code runs", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-queue-");
		const kernels = trackStartedKernels();
		const firstMarker = `${tempDir.path()}/first-running`;
		const queuedMarker = `${tempDir.path()}/queued-must-not-run`;
		let first: Promise<PythonResult> | undefined;
		let queued: Promise<PythonResult> | undefined;
		try {
			first = executePython(
				`from pathlib import Path\nimport time\nPath(${JSON.stringify(firstMarker)}).touch()\ntime.sleep(60)`,
				{
					cwd: tempDir.path(),
					sessionId: "queued-disposal-session",
					kernelMode: "session",
				},
			);
			await waitForFile(firstMarker);
			queued = executePython(`from pathlib import Path\nPath(${JSON.stringify(queuedMarker)}).touch()`, {
				cwd: tempDir.path(),
				sessionId: "queued-disposal-session",
				kernelMode: "session",
			});
			await flushMicrotasks();
			await disposeAllKernelSessions();
			const [firstResult, queuedResult] = await Promise.all([first, queued]);
			expect(firstResult.cancelled).toBe(true);
			expect(queuedResult.cancelled).toBe(true);
			expect(await Bun.file(queuedMarker).exists()).toBe(false);
			expect(kernels).toHaveLength(1);
			expect(kernels[0].isAlive()).toBe(false);
		} finally {
			await joinCleanupTasks([disposeAllKernelSessions(), ...(first ? [first] : []), ...(queued ? [queued] : [])]);
		}
	}, 30_000);
});
