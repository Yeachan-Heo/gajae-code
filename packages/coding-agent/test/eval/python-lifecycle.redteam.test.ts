import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { disposeAllKernelSessions, executePython, type PythonResult } from "@gajae-code/coding-agent/eval/py/executor";
import type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelShutdownResult,
} from "@gajae-code/coding-agent/eval/py/kernel";
import { PythonKernel } from "@gajae-code/coding-agent/eval/py/kernel";
import { ensurePythonRuntime } from "@gajae-code/coding-agent/eval/py/runtime";
import { TempDir } from "@gajae-code/utils";

const originalStart = PythonKernel.start;

const READINESS_TIMEOUT_MS = 1_000;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const CLEANUP_TIMEOUT_MS = 9_000;
// Kernel startup permits two 10s phases; readiness and cleanup consume up to 10s more.
const LIFECYCLE_TEST_TIMEOUT_MS = 35_000;

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

class FakeKernel {
	alive = true;
	executeCalls: string[] = [];
	shutdownCalls = 0;
	shutdownResult: KernelShutdownResult = { confirmed: true };
	private readonly executeImpl?: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;

	constructor(executeImpl?: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>) {
		this.executeImpl = executeImpl;
	}

	async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.executeCalls.push(code);
		return this.executeImpl ? await this.executeImpl(code, options) : OK_RESULT;
	}

	async shutdown(): Promise<KernelShutdownResult> {
		this.shutdownCalls += 1;
		this.alive = false;
		return this.shutdownResult;
	}

	isAlive(): boolean {
		return this.alive;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessGone(pid: number, timeoutMs = PROCESS_EXIT_TIMEOUT_MS): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await Bun.sleep(50);
	}
	return !isProcessAlive(pid);
}

async function waitForOwnedProcess(pidFile: string, timeoutMs = READINESS_TIMEOUT_MS): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await Bun.file(pidFile).exists()) {
			const pid = Number((await Bun.file(pidFile).text()).trim());
			if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) return pid;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for owned descendant PID at ${pidFile}`);
}

async function waitForFile(path: string, timeoutMs = READINESS_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await Bun.file(path).exists()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for readiness file at ${path}`);
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	return await Promise.race([
		promise.then(
			() => true,
			() => true,
		),
		Bun.sleep(timeoutMs).then(() => false),
	]);
}

function countAbortListeners(signal: AbortSignal): { readonly count: () => number; readonly restore: () => void } {
	let count = 0;
	const originalAdd = signal.addEventListener.bind(signal);
	const originalRemove = signal.removeEventListener.bind(signal);
	signal.addEventListener = ((
		type: string,
		listener: Parameters<typeof originalAdd>[1],
		options?: AddEventListenerOptions | boolean,
	) => {
		if (type === "abort") count += 1;
		return originalAdd(type, listener, options);
	}) as typeof signal.addEventListener;
	signal.removeEventListener = ((
		type: string,
		listener: Parameters<typeof originalRemove>[1],
		options?: EventListenerOptions | boolean,
	) => {
		if (type === "abort") count -= 1;
		return originalRemove(type, listener, options);
	}) as typeof signal.removeEventListener;
	return {
		count: () => count,
		restore: () => {
			signal.addEventListener = originalAdd as typeof signal.addEventListener;
			signal.removeEventListener = originalRemove as typeof signal.removeEventListener;
		},
	};
}

describe("python eval lifecycle red-team", () => {
	it("terminates the complete managed-runtime provisioning process group on cancellation", async () => {
		if (process.platform === "win32") return;
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-redteam-");
		const binDir = path.join(tempDir.path(), "bin");
		const pythonPath = path.join(binDir, "python3");
		const childPidPath = path.join(tempDir.path(), "provision-child.pid");
		await fs.mkdir(binDir);
		await Bun.write(
			pythonPath,
			'#!/bin/sh\n(trap "" TERM; while :; do sleep 1; done) &\nprintf \'%s\' "$!" > "$PWD/provision-child.pid"\nwait\n',
		);
		await fs.chmod(pythonPath, 0o755);
		const controller = new AbortController();
		const originalPath = process.env.PATH;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		let provisioning: Promise<unknown> | undefined;
		try {
			provisioning = ensurePythonRuntime(
				tempDir.path(),
				{ PATH: process.env.PATH },
				{ managedWorkspaceVenv: true, seedPackages: [] },
				{ signal: controller.signal },
			);
			void provisioning.catch(() => undefined);
			const childPid = await waitForOwnedProcess(childPidPath);
			controller.abort();
			await expect(provisioning!).rejects.toMatchObject({ name: "AbortError" });
			expect(await waitForProcessGone(childPid)).toBe(true);
		} finally {
			controller.abort();
			await provisioning?.catch(() => undefined);
			process.env.PATH = originalPath;
		}
	});

	afterEach(async () => {
		PythonKernel.start = originalStart;
		delete Bun.env.PI_PYTHON_SKIP_CHECK;
		await disposeAllKernelSessions();
	});

	it("coalesces five concurrent first acquires for the same new session without orphan kernels", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-redteam-");
		const startup = Promise.withResolvers<void>();
		const kernel = new FakeKernel();
		let startCalls = 0;
		PythonKernel.start = async () => {
			startCalls += 1;
			await startup.promise;
			return kernel as unknown as PythonKernel;
		};

		const executions = Array.from({ length: 5 }, (_, index) =>
			executePython(`print(${index})`, {
				cwd: tempDir.path(),
				sessionId: "redteam-concurrent-same-session",
				kernelMode: "session",
			}),
		);
		await Bun.sleep(0);
		expect(startCalls).toBe(1);

		startup.resolve();
		await Promise.all(executions);
		expect(startCalls).toBe(1);
		expect(kernel.executeCalls).toEqual(["print(0)", "print(1)", "print(2)", "print(3)", "print(4)"]);

		await disposeAllKernelSessions();
		expect(kernel.shutdownCalls).toBe(1);
	});

	it(
		"kills only the owned bash background descendant after timeout while an unrelated sibling survives",
		async () => {
			if (process.platform === "win32") return;
			Bun.env.PI_PYTHON_SKIP_CHECK = "1";
			using tempDir = TempDir.createSync("@gjc-python-lifecycle-redteam-");
			const unrelated = Bun.spawn(["/bin/sh", "-c", "sleep 30"], { stdout: "ignore", stderr: "ignore" });
			const startupGate = Promise.withResolvers<void>();
			const startupCalled = Promise.withResolvers<void>();
			const kernelStarted = Promise.withResolvers<void>();
			const controller = new AbortController();
			let execution: Promise<PythonResult> | undefined;
			try {
				PythonKernel.start = async options => {
					startupCalled.resolve();
					await startupGate.promise;
					try {
						const kernel = await originalStart(options);
						kernelStarted.resolve();
						return kernel;
					} catch (error) {
						kernelStarted.reject(error);
						throw error;
					}
				};
				const pidFile = `${tempDir.path()}/owned-child.pid`;
				execution = executePython(`%%bash\n(sleep 30) &\nprintf '%s' "$!" > "${pidFile}"\nwait`, {
					cwd: tempDir.path(),
					sessionId: "redteam-bash-descendant-timeout",
					kernelMode: "session",
					signal: controller.signal,
				});
				await startupCalled.promise;
				startupGate.resolve();
				await kernelStarted.promise;
				const childPid = await waitForOwnedProcess(pidFile);
				controller.abort(new DOMException("Python execution timed out", "TimeoutError"));
				const result = await execution;
				expect(result.cancelled).toBe(true);
				expect(await waitForProcessGone(childPid)).toBe(true);
				expect(isProcessAlive(unrelated.pid)).toBe(true);
			} finally {
				startupGate.resolve();
				controller.abort(new DOMException("Python execution timed out", "TimeoutError"));
				await execution?.catch(() => undefined);
				try {
					unrelated.kill("SIGKILL");
				} catch {
					// ignore cleanup races
				}
				await unrelated.exited.catch(() => undefined);
			}
		},
		LIFECYCLE_TEST_TIMEOUT_MS,
	);

	it(
		"rejects the startup handshake and cleans up when kernel startup fails",
		async () => {
			Bun.env.PI_PYTHON_SKIP_CHECK = "1";
			using tempDir = TempDir.createSync("@gjc-python-lifecycle-redteam-");
			const unrelated = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30_000)"], {
				stdout: "ignore",
				stderr: "ignore",
			});
			const kernelStarted = Promise.withResolvers<void>();
			const startupError = new Error("kernel startup failed");
			PythonKernel.start = async () => {
				try {
					throw startupError;
				} catch (error) {
					kernelStarted.reject(error);
					throw error;
				}
			};
			const execution = executePython("print('never runs')", {
				cwd: tempDir.path(),
				sessionId: "redteam-startup-failure",
				kernelMode: "session",
			});
			void execution.catch(() => undefined);
			try {
				await expect(kernelStarted.promise).rejects.toThrow(startupError);
				await expect(execution).rejects.toThrow(startupError);
				expect(isProcessAlive(unrelated.pid)).toBe(true);
			} finally {
				try {
					unrelated.kill("SIGKILL");
				} catch {
					// ignore cleanup races
				}
				await unrelated.exited.catch(() => undefined);
				await disposeAllKernelSessions();
			}
		},
		LIFECYCLE_TEST_TIMEOUT_MS,
	);

	it(
		"retires a cancelled initializer before an uncancelled successor acquires a replacement",
		async () => {
			Bun.env.PI_PYTHON_SKIP_CHECK = "1";
			using tempDir = TempDir.createSync("@gjc-python-lifecycle-redteam-");
			const controller = new AbortController();
			const listeners = countAbortListeners(controller.signal);
			const startup = Promise.withResolvers<void>();
			const startupCalled = Promise.withResolvers<void>();
			const firstKernel = new FakeKernel();
			const secondKernel = new FakeKernel();
			let startCalls = 0;
			PythonKernel.start = async () => {
				startCalls += 1;
				if (startCalls === 1) {
					startupCalled.resolve();
					await startup.promise;
					return firstKernel as unknown as PythonKernel;
				}
				return secondKernel as unknown as PythonKernel;
			};
			try {
				const cancelled = executePython("print('cancelled')", {
					cwd: tempDir.path(),
					sessionId: "redteam-cancelled-initializer",
					kernelMode: "session",
					signal: controller.signal,
				});
				await startupCalled.promise;
				controller.abort(new DOMException("Python execution timed out", "TimeoutError"));
				expect(listeners.count()).toBe(0);

				const successor = executePython("print('successor')", {
					cwd: tempDir.path(),
					sessionId: "redteam-cancelled-initializer",
					kernelMode: "session",
				});
				startup.resolve();
				const [cancelledResult, successorResult] = await Promise.all([cancelled, successor]);
				expect(cancelledResult.cancelled).toBe(true);
				expect(successorResult.cancelled).toBe(false);
				expect(startCalls).toBe(2);
				expect(firstKernel.shutdownCalls).toBe(1);
				expect(secondKernel.executeCalls).toEqual(["print('successor')"]);
			} finally {
				startup.resolve();
				await disposeAllKernelSessions();
				listeners.restore();
			}
			expect(secondKernel.shutdownCalls).toBe(1);
		},
		LIFECYCLE_TEST_TIMEOUT_MS,
	);

	it(
		"settles an in-flight cell during shutdown without leaked abort listeners",
		async () => {
			Bun.env.PI_PYTHON_SKIP_CHECK = "1";
			using tempDir = TempDir.createSync("@gjc-python-lifecycle-redteam-");
			const controller = new AbortController();
			const listeners = countAbortListeners(controller.signal);
			const kernelStarted = Promise.withResolvers<void>();
			let shutdown: (() => Promise<KernelShutdownResult>) | undefined;
			let execution: Promise<PythonResult> | undefined;
			try {
				PythonKernel.start = async () => {
					try {
						const kernel = await originalStart({ cwd: tempDir.path() });
						shutdown = () => kernel.shutdown({ timeoutMs: 100 });
						kernelStarted.resolve();
						return kernel;
					} catch (error) {
						kernelStarted.reject(error);
						throw error;
					}
				};

				const executionReadyFile = `${tempDir.path()}/kernel-executing`;
				execution = executePython(
					`from pathlib import Path\nPath(${JSON.stringify(executionReadyFile)}).touch()\nimport time\ntime.sleep(60)`,
					{
						cwd: tempDir.path(),
						sessionId: "redteam-inflight-shutdown",
						kernelMode: "session",
						signal: controller.signal,
						timeoutMs: 60_000,
					},
				);
				await kernelStarted.promise;
				await waitForFile(executionReadyFile);
				expect(listeners.count()).toBe(1);
				if (!shutdown) throw new Error("Python kernel did not expose shutdown after startup");

				await shutdown();
				await execution;
				expect(listeners.count()).toBe(0);
			} finally {
				await shutdown?.().catch(() => undefined);
				await execution?.catch(() => undefined);
				listeners.restore();
			}
		},
		LIFECYCLE_TEST_TIMEOUT_MS,
	);

	it(
		"bounds failed readiness cleanup before the fixture deadline",
		async () => {
			Bun.env.PI_PYTHON_SKIP_CHECK = "1";
			using tempDir = TempDir.createSync("@gjc-python-lifecycle-redteam-");
			const controller = new AbortController();
			const startup = Promise.withResolvers<void>();
			const startupCalled = Promise.withResolvers<void>();
			const kernel = new FakeKernel();
			kernel.shutdownResult = { confirmed: false };
			let startupFinished = false;
			let executionSettled = false;
			PythonKernel.start = async () => {
				startupCalled.resolve();
				await startup.promise;
				startupFinished = true;
				return kernel as unknown as PythonKernel;
			};
			const execution = executePython("import time\ntime.sleep(60)", {
				cwd: tempDir.path(),
				sessionId: "redteam-readiness-failure-cleanup",
				kernelMode: "session",
				signal: controller.signal,
			});
			void execution.then(() => {
				executionSettled = true;
			});
			await startupCalled.promise;
			try {
				await expect(waitForFile(`${tempDir.path()}/never-created`)).rejects.toThrow(
					"Timed out waiting for readiness file",
				);
			} finally {
				controller.abort(new DOMException("Python execution timed out", "TimeoutError"));
				await Bun.sleep(0);
				expect(executionSettled).toBe(false);
				startup.resolve();
				const settled = await settlesWithin(execution, CLEANUP_TIMEOUT_MS);
				try {
					expect(settled).toBe(true);
				} finally {
					await execution;
				}
			}
			expect(startupFinished).toBe(true);
			expect(kernel.shutdownCalls).toBe(1);
			await disposeAllKernelSessions();
			expect(kernel.shutdownCalls).toBe(2);
			kernel.shutdownResult = { confirmed: true };
			await disposeAllKernelSessions();
			expect(kernel.shutdownCalls).toBe(3);
		},
		LIFECYCLE_TEST_TIMEOUT_MS,
	);

	it("treats clean exit code 0 as confirmed and starts a fresh session instead of reinserting", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-redteam-");
		const firstKernel = new FakeKernel();
		const secondKernel = new FakeKernel();
		let startCalls = 0;
		PythonKernel.start = async () => {
			startCalls += 1;
			return (startCalls === 1 ? firstKernel : secondKernel) as unknown as PythonKernel;
		};

		await executePython("print('before clean shutdown')", {
			cwd: tempDir.path(),
			sessionId: "redteam-clean-exit-not-reinserted",
			kernelMode: "session",
		});
		await disposeAllKernelSessions();
		await executePython("print('after clean shutdown')", {
			cwd: tempDir.path(),
			sessionId: "redteam-clean-exit-not-reinserted",
			kernelMode: "session",
		});

		expect(firstKernel.shutdownCalls).toBe(1);
		expect(startCalls).toBe(2);
		expect(secondKernel.executeCalls).toEqual(["print('after clean shutdown')"]);
	});
});
