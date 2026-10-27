import { afterEach, describe, expect, it } from "bun:test";
import { disposeAllKernelSessions, executePython } from "@gajae-code/coding-agent/eval/py/executor";
import {
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelShutdownResult,
	PythonKernel,
} from "@gajae-code/coding-agent/eval/py/kernel";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

class FakeKernel {
	#result: KernelExecuteResult;
	#onExecute?: (options?: KernelExecuteOptions) => void;
	#alive: boolean;
	#exitCode: number | null = null;
	readonly executeCalls: string[] = [];
	shutdownCalls = 0;

	constructor(
		result: KernelExecuteResult,
		options: { alive?: boolean; onExecute?: (options?: KernelExecuteOptions) => void } = {},
	) {
		this.#result = result;
		this.#onExecute = options.onExecute;
		this.#alive = options.alive ?? true;
	}

	isAlive(): boolean {
		return this.#alive;
	}

	async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.executeCalls.push(code);
		this.#onExecute?.(options);
		return this.#result;
	}

	async shutdown(): Promise<KernelShutdownResult> {
		this.shutdownCalls += 1;
		this.#alive = false;
		return { confirmed: true };
	}

	getExitCode(): number | null {
		return this.#exitCode;
	}

	setExitCode(code: number | null): void {
		this.#exitCode = code;
	}

	async ping(): Promise<boolean> {
		return this.#alive;
	}
}

const okResult: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

describe("executePython session lifecycle", () => {
	const originalStart = PythonKernel.start;

	afterEach(async () => {
		PythonKernel.start = originalStart;
		await disposeAllKernelSessions();
	});

	it("reuses a session kernel across calls", async () => {
		let startCount = 0;
		const kernel = new FakeKernel(okResult, { onExecute: options => options?.onChunk?.("ok\n") });
		PythonKernel.start = async () => {
			startCount += 1;
			return kernel as unknown as PythonKernel;
		};

		const first = await executePython("print('one')", { sessionId: "session-1" });
		const second = await executePython("print('two')", { sessionId: "session-1" });

		expect(startCount).toBe(1);
		expect(kernel.executeCalls).toEqual(["print('one')", "print('two')"]);
		expect(first.output).toContain("ok");
		expect(second.output).toContain("ok");
	});

	it("restarts the session kernel when not alive", async () => {
		const deadKernel = new FakeKernel(okResult, { alive: false });
		const liveKernel = new FakeKernel(okResult, { onExecute: options => options?.onChunk?.("live\n") });
		const kernels = [deadKernel, liveKernel];
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			return kernels.shift() as unknown as PythonKernel;
		};

		const result = await executePython("print('restart')", { sessionId: "session-restart" });

		expect(startCount).toBe(2);
		expect(deadKernel.shutdownCalls).toBe(1);
		expect(deadKernel.executeCalls).toEqual([]);
		expect(liveKernel.executeCalls).toEqual(["print('restart')"]);
		expect(result.output).toContain("live");
	});

	it("resets the session kernel when requested", async () => {
		const firstKernel = new FakeKernel(okResult);
		const secondKernel = new FakeKernel(okResult);
		const kernels = [firstKernel, secondKernel];
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			return kernels.shift() as unknown as PythonKernel;
		};

		await executePython("print('one')", { sessionId: "session-reset" });
		await executePython("print('two')", { sessionId: "session-reset", reset: true });

		expect(startCount).toBe(2);
		expect(firstKernel.shutdownCalls).toBe(1);
		expect(secondKernel.executeCalls).toEqual(["print('two')"]);
	});

	it("cancels queued session execution before it reaches the kernel", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const kernel = new FakeKernel(okResult);
		kernel.execute = async (code, options) => {
			kernel.executeCalls.push(code);
			if (kernel.executeCalls.length === 1) {
				options?.onChunk?.("first\n");
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return okResult;
		};
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			return kernel as unknown as PythonKernel;
		};

		const firstPromise = executePython("print('one')", { sessionId: "session-queue" });
		await firstStarted.promise;

		const abortController = new AbortController();
		const secondPromise = executePython("print('two')", {
			sessionId: "session-queue",
			signal: abortController.signal,
		});
		abortController.abort(Object.assign(new Error("queue wait cancelled"), { name: "AbortError" }));

		const second = await secondPromise;
		expect(second.cancelled).toBe(true);
		expect(second.exitCode).toBeUndefined();
		expect(second.output).toBe("");
		expect(kernel.executeCalls).toEqual(["print('one')"]);

		releaseFirst.resolve();
		const first = await firstPromise;

		expect(first.cancelled).toBe(false);
		expect(first.output).toContain("first");
		expect(startCount).toBe(1);
		expect(kernel.executeCalls).toEqual(["print('one')"]);
	});

	it("uses per-call kernels when configured", async () => {
		const kernelA = new FakeKernel(okResult);
		const kernelB = new FakeKernel(okResult);
		const kernels = [kernelA, kernelB];
		let startCount = 0;
		let shutdownCount = 0;

		PythonKernel.start = async options => {
			startCount += 1;
			const kernel = kernels.shift() as unknown as PythonKernel;
			options.onKernelCreated?.(kernel);
			return kernel;
		};

		kernelA.shutdown = async (): Promise<KernelShutdownResult> => {
			shutdownCount += 1;
			return { confirmed: true };
		};
		kernelB.shutdown = async (): Promise<KernelShutdownResult> => {
			shutdownCount += 1;
			return { confirmed: true };
		};

		await executePython("print('one')", { kernelMode: "per-call" });
		await executePython("print('two')", { kernelMode: "per-call" });

		expect(startCount).toBe(2);
		expect(shutdownCount).toBe(2);
	});
});
