import { afterEach, describe, expect, it, vi } from "bun:test";
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
import { type KernelShutdownResult, PythonKernel } from "@gajae-code/coding-agent/eval/py/kernel";
import { TempDir } from "@gajae-code/utils";

const originalStart = PythonKernel.start;
const originalAvailability = pythonKernel.checkPythonKernelAvailability;

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

async function flushMicrotasks(turns = 6): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

afterEach(async () => {
	await disposeAllKernelSessions();
	PythonKernel.start = originalStart;
	vi.restoreAllMocks();
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
	await executor?.disposeAllKernelSessions();
	await execution?.catch(() => undefined);
	if (kernel.isAlive()) {
		const shutdown = await kernel.shutdown();
		if (!shutdown.confirmed) throw new Error("Borrowed Python kernel shutdown was not confirmed");
	}
	await lifecycle.disposeAllResourceOwners();
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
			await disposeAllKernelSessions();
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
			await disposeAllKernelSessions();
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
			await disposeAllKernelSessions();
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
			await disposeKernelSessionsByOwner("borrowed-owner");
			await execution?.catch(() => undefined);
			await kernel.shutdown();
			await disposeAllKernelSessions();
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
			void cleanup.then(() => {
				firstSettled = true;
			});
			void repeatedCleanup.then(() => {
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
			await (cleanup ?? disposeKernelSessionsByOwner("owner-a"));
			await repeatedCleanup;
			await disposeAllKernelSessions();
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
			void cleanupA.then(() => {
				cleanupASettled = true;
			});
			void cleanupB.then(() => {
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
			const failed = settled.find(result => result.status === "rejected");
			if (failed?.status === "rejected") {
				cleanupFailed = true;
				cleanupError = failed.reason;
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
								void nestedCleanup.then(() => {
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
			const failed = settled.find(result => result.status === "rejected");
			if (failed?.status === "rejected") {
				cleanupFailed = true;
				cleanupError = failed.reason;
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
			void cleanupA.then(() => {
				cleanupASettled = true;
			});
			void cleanupB.then(() => {
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
			const failed = settled.find(result => result.status === "rejected");
			if (failed?.status === "rejected") {
				cleanupFailed = true;
				cleanupError = failed.reason;
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
			await disposeAllKernelSessions();
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
			const failed = settled.find(result => result.status === "rejected");
			if (failed?.status === "rejected") {
				cleanupFailed = true;
				cleanupError = failed.reason;
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
			void cleanup.then(() => {
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
			await (cleanup ?? disposeKernelSessionsByOwner("owner-a"));
			await execution?.catch(() => undefined);
			await disposeAllKernelSessions();
		}
	}, 30_000);

	it("joins a held genuine initializer and shuts down its unpublished real kernel", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-initializer-");
		const cwd = tempDir.path();
		const initialized = Promise.withResolvers<PythonKernel>();
		const release = Promise.withResolvers<void>();
		const kernels: PythonKernel[] = [];
		vi.spyOn(PythonKernel, "start").mockImplementation(async options => {
			const kernel = await originalStart(options);
			kernels.push(kernel);
			if (options.cwd === cwd) {
				initialized.resolve(kernel);
				await release.promise;
			}
			return kernel;
		});
		let execution: Promise<PythonResult> | undefined;
		let cleanup: Promise<void> | undefined;
		try {
			execution = executePython("print('must not execute')", {
				cwd,
				sessionId: "held-initializer",
				kernelMode: "session",
				kernelOwnerId: "owner-a",
			});
			const kernel = await initialized.promise;
			expect(kernel.isAlive()).toBe(true);

			cleanup = disposeKernelSessionsByOwner("owner-a");
			let cleanupSettled = false;
			void cleanup.then(() => {
				cleanupSettled = true;
			});
			await flushMicrotasks();
			expect(cleanupSettled).toBe(false);
			expect(kernel.isAlive()).toBe(true);

			release.resolve();
			const result = await execution;
			await cleanup;
			expect(result.cancelled).toBe(true);
			expect(result.output).not.toContain("must not execute");
			expect(kernel.isAlive()).toBe(false);
		} finally {
			release.resolve();
			await (cleanup ?? disposeKernelSessionsByOwner("owner-a"));
			await execution?.catch(() => undefined);
			await disposeAllKernelSessions();
		}
	}, 30_000);

	it("keeps an A waiter joined through synchronous cleanup reentry while B's shared initializer survives", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-shared-initializer-");
		const cwd = tempDir.path();
		const initialized = Promise.withResolvers<PythonKernel>();
		const release = Promise.withResolvers<void>();
		const waiterAvailability = Promise.withResolvers<void>();
		const readyPath = `${cwd}/initializer-b.ready`;
		const pidPath = `${cwd}/initializer-b.pid`;
		const kernels: PythonKernel[] = [];
		let initializationReached = false;
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
			if (initializationReached && args[0] === cwd) waiterAvailability.resolve();
			return await originalAvailability(...args);
		});
		vi.spyOn(PythonKernel, "start").mockImplementation(async startOptions => {
			const kernel = await originalStart(startOptions);
			kernels.push(kernel);
			if (startOptions.cwd === cwd) {
				const marked = await kernel.execute(
					`from pathlib import Path\nimport os\nPath(${JSON.stringify(pidPath)}).write_text(str(os.getpid()))`,
				);
				if (marked.status !== "ok") throw new Error("Could not mark the real shared initializer process");
				initializationReached = true;
				initialized.resolve(kernel);
				await release.promise;
			}
			return kernel;
		});
		try {
			executionB = executePython(`from pathlib import Path\nPath(${JSON.stringify(readyPath)}).touch()`, {
				...options,
				kernelOwnerId: "owner-b",
			});
			const kernel = await initialized.promise;
			const pid = await waitForProcessFile(pidPath);
			expect(kernel.isAlive()).toBe(true);

			executionA = executePython("print('A waits on B initializer')", {
				...options,
				kernelOwnerId: "owner-a",
				signal: controller.signal,
			});
			await waiterAvailability.promise;
			await flushMicrotasks(12);

			ownerCleanup = disposeKernelSessionsByOwner("owner-a");
			controller.abort(new DOMException("reenter owner cleanup", "AbortError"));
			let ownerCleanupSettled = false;
			let reentrantCleanupSettled = false;
			void ownerCleanup.then(() => {
				ownerCleanupSettled = true;
			});
			void reentrantCleanup?.then(() => {
				reentrantCleanupSettled = true;
			});
			expect(reentrantCleanup).toBeDefined();
			const resultA = await executionA;
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
			const failed = settled.find(result => result.status === "rejected");
			if (failed?.status === "rejected") {
				cleanupFailed = true;
				cleanupError = failed.reason;
			}
		}
		if (bodyFailed) throw bodyError;
		if (cleanupFailed) throw cleanupError;
	}, 30_000);

	it("propagates and retries failed shutdown of a captured late initializer by its original label", async () => {
		using tempDir = TempDir.createSync("@gjc-python-owner-late-shutdown-retry-");
		const cwd = tempDir.path();
		const initialized = Promise.withResolvers<PythonKernel>();
		const release = Promise.withResolvers<void>();
		const pidFile = `${cwd}/late-kernel.pid`;
		const kernels: PythonKernel[] = [];
		const originalError = new Error("late kernel shutdown failed");
		let shutdownCalls = 0;
		vi.spyOn(PythonKernel, "start").mockImplementation(async options => {
			const kernel = await originalStart(options);
			kernels.push(kernel);
			if (options.cwd === cwd) {
				const shutdown = kernel.shutdown.bind(kernel);
				kernel.shutdown = async shutdownOptions => {
					shutdownCalls += 1;
					if (shutdownCalls === 1) throw originalError;
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
			await execution?.catch(() => undefined);
			await disposeAllKernelSessions();
		}
	}, 30_000);

	it("global cleanup joins preflight but leaves a same-name process created after its captured scope", async () => {
		using tempDir = TempDir.createSync("@gjc-python-global-preflight-");
		const cwd = tempDir.path();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const kernels = trackStartedKernels();
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
			globalCleanup = disposeAllKernelSessions();
			let cleanupSettled = false;
			void globalCleanup.then(() => {
				cleanupSettled = true;
			});

			const firstB = await executePython("print('B survives')", {
				cwd,
				sessionId: "global-captured-session",
				kernelMode: "session",
				kernelOwnerId: "owner-b",
			});
			expect(firstB.exitCode).toBe(0);
			expect(kernels).toHaveLength(1);
			expect(kernels[0].isAlive()).toBe(true);
			expect(cleanupSettled).toBe(false);

			release.resolve();
			const resultA = await executionA;
			await globalCleanup;
			expect(resultA.cancelled).toBe(true);

			const secondB = await executePython("print('B still survives')", {
				cwd,
				sessionId: "global-captured-session",
				kernelMode: "session",
				kernelOwnerId: "owner-b",
			});
			expect(secondB.exitCode).toBe(0);
			expect(kernels).toHaveLength(1);
			expect(kernels[0].isAlive()).toBe(true);
		} finally {
			release.resolve();
			await (globalCleanup ?? disposeAllKernelSessions());
			await executionA?.catch(() => undefined);
			await disposeAllKernelSessions();
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
			await execution?.catch(() => undefined);
			await disposeAllKernelSessions();
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
			await disposeAllKernelSessions();
			await first?.catch(() => undefined);
			await queued?.catch(() => undefined);
		}
	}, 30_000);
});
