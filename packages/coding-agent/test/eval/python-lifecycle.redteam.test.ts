import { afterEach, describe, expect, it } from "bun:test";
import { disposeAllKernelSessions, executePython } from "@gajae-code/coding-agent/eval/py/executor";
import type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelShutdownResult,
} from "@gajae-code/coding-agent/eval/py/kernel";
import { PythonKernel } from "@gajae-code/coding-agent/eval/py/kernel";
import { TempDir } from "@gajae-code/utils";

const originalStart = PythonKernel.start;

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

async function waitForProcessGone(pid: number, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await Bun.sleep(50);
	}
	return !isProcessAlive(pid);
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

	it("kills only the owned bash background descendant after timeout while an unrelated sibling survives", async () => {
		if (process.platform === "win32") return;
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-redteam-");
		const unrelated = Bun.spawn(["/bin/sh", "-c", "sleep 30"], { stdout: "ignore", stderr: "ignore" });
		let childPid: number | undefined;
		try {
			const result = await executePython("%%bash\n(sleep 30) &\necho owned_child:$!\nwait", {
				cwd: tempDir.path(),
				sessionId: "redteam-bash-descendant-timeout",
				kernelMode: "session",
				timeoutMs: 500,
			});
			const match = result.output.match(/owned_child:(\d+)/);
			expect(match).not.toBeNull();
			childPid = Number(match?.[1]);
			expect(result.cancelled).toBe(true);
			expect(await waitForProcessGone(childPid)).toBe(true);
			expect(isProcessAlive(unrelated.pid)).toBe(true);
		} finally {
			try {
				unrelated.kill("SIGKILL");
			} catch {
				// ignore cleanup races
			}
			await unrelated.exited.catch(() => undefined);
		}
	});

	it("settles an in-flight cell during shutdown without leaked abort listeners", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-redteam-");
		const controller = new AbortController();
		const listeners = countAbortListeners(controller.signal);
		let shutdown: (() => Promise<KernelShutdownResult>) | undefined;
		try {
			PythonKernel.start = async () => {
				const kernel = await originalStart({ cwd: tempDir.path() });
				shutdown = () => kernel.shutdown({ timeoutMs: 100 });
				return kernel;
			};

			const execution = executePython("import time\ntime.sleep(60)", {
				cwd: tempDir.path(),
				sessionId: "redteam-inflight-shutdown",
				kernelMode: "session",
				signal: controller.signal,
				timeoutMs: 60_000,
			});
			await Bun.sleep(250);
			expect(listeners.count()).toBe(1);
			expect(shutdown).toBeDefined();

			await shutdown?.();
			await execution;
			expect(listeners.count()).toBe(0);
		} finally {
			listeners.restore();
		}
	});

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
