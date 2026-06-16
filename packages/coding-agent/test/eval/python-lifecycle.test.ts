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

async function waitForExit(pid: number, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await Bun.sleep(25);
	}
	return !isProcessAlive(pid);
}

describe("python eval lifecycle", () => {
	afterEach(async () => {
		PythonKernel.start = originalStart;
		await disposeAllKernelSessions();
	});

	it("coalesces concurrent first acquires for the same session into one kernel", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-");
		const startup = Promise.withResolvers<void>();
		let startCalls = 0;
		const kernel = new FakeKernel();
		PythonKernel.start = async () => {
			startCalls += 1;
			await startup.promise;
			return kernel as unknown as PythonKernel;
		};

		const first = executePython("print('first')", {
			cwd: tempDir.path(),
			sessionId: "concurrent-session",
			kernelMode: "session",
		});
		const second = executePython("print('second')", {
			cwd: tempDir.path(),
			sessionId: "concurrent-session",
			kernelMode: "session",
		});
		await Bun.sleep(0);
		expect(startCalls).toBe(1);

		startup.resolve();
		await Promise.all([first, second]);

		expect(startCalls).toBe(1);
		expect(kernel.executeCalls).toEqual(["print('first')", "print('second')"]);
	});

	it("settles pending executions and releases abort listeners during shutdown", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-");
		const controller = new AbortController();
		let abortListeners = 0;
		const originalAdd = controller.signal.addEventListener.bind(controller.signal);
		const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
		controller.signal.addEventListener = ((
			type: string,
			listener: Parameters<typeof originalAdd>[1],
			options?: AddEventListenerOptions | boolean,
		) => {
			if (type === "abort") abortListeners += 1;
			return originalAdd(type, listener, options);
		}) as typeof controller.signal.addEventListener;
		controller.signal.removeEventListener = ((
			type: string,
			listener: Parameters<typeof originalRemove>[1],
			options?: EventListenerOptions | boolean,
		) => {
			if (type === "abort") abortListeners -= 1;
			return originalRemove(type, listener, options);
		}) as typeof controller.signal.removeEventListener;

		const kernel = await originalStart({ cwd: tempDir.path() });
		try {
			const execution = kernel.execute("import time\ntime.sleep(60)", {
				signal: controller.signal,
				timeoutMs: 60_000,
			});
			for (let i = 0; i < 40 && abortListeners === 0; i += 1) {
				await Bun.sleep(50);
			}
			expect(abortListeners).toBe(1);

			await kernel.shutdown({ timeoutMs: 100 });
			const result = await execution;
			expect(result.status).toBe("error");
			expect(result.cancelled).toBe(true);
			expect(result.kernelKilled).toBe(true);
			expect(abortListeners).toBe(0);
		} finally {
			await kernel.shutdown({ timeoutMs: 100 }).catch(() => undefined);
		}
	});

	it("treats clean exit code 0 as confirmed shutdown and does not reinsert the session", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-");
		const firstKernel = new FakeKernel();
		const secondKernel = new FakeKernel();
		let startCalls = 0;
		PythonKernel.start = async () => {
			startCalls += 1;
			return (startCalls === 1 ? firstKernel : secondKernel) as unknown as PythonKernel;
		};

		await executePython("print('one')", {
			cwd: tempDir.path(),
			sessionId: "clean-exit-session",
			kernelMode: "session",
		});
		await disposeAllKernelSessions();
		await executePython("print('two')", {
			cwd: tempDir.path(),
			sessionId: "clean-exit-session",
			kernelMode: "session",
		});

		expect(firstKernel.shutdownCalls).toBe(1);
		expect(startCalls).toBe(2);
		expect(secondKernel.executeCalls).toEqual(["print('two')"]);
	});

	it("kills background descendants owned by a bash cell interrupt while an unrelated sibling survives", async () => {
		if (process.platform === "win32") return;
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-");
		const unrelated = Bun.spawn(["/bin/sh", "-c", "sleep 30"], { stdout: "ignore", stderr: "ignore" });
		let childPid: number | undefined;
		try {
			const resultPromise = executePython("%%bash\n(sleep 30) &\necho child:$!\nwait", {
				cwd: tempDir.path(),
				sessionId: "bash-descendant-session",
				kernelMode: "session",
				timeoutMs: 500,
			});
			const result = await resultPromise;
			const match = result.output.match(/child:(\d+)/);
			expect(match).not.toBeNull();
			childPid = Number(match?.[1]);
			expect(result.cancelled).toBe(true);
			expect(await waitForExit(childPid)).toBe(true);
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
});
