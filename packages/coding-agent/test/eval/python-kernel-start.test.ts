import { afterEach, describe, expect, it, vi } from "bun:test";
import { disposeAllKernelSessions, executePython } from "../../src/eval/py/executor";
import type {
	KernelExecuteResult,
	KernelShutdownResult,
	PythonKernel as PythonKernelInstance,
} from "../../src/eval/py/kernel";
import * as pythonKernel from "../../src/eval/py/kernel";

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

class FakeKernel {
	alive = true;
	#exitCode: number | null = null;
	execute = vi.fn(async () => OK_RESULT);
	shutdown = vi.fn(async (): Promise<KernelShutdownResult> => ({ confirmed: true }));

	isAlive(): boolean {
		return this.alive;
	}

	getExitCode(): number | null {
		return this.#exitCode;
	}

	setExitCode(code: number | null): void {
		this.#exitCode = code;
	}
}

afterEach(async () => {
	await disposeAllKernelSessions();
	vi.restoreAllMocks();
});

describe("PythonExecutorOptions.onKernelStart", () => {
	it("reports one stable instance id across retained-kernel executes", async () => {
		const kernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);
		const started: string[] = [];
		const options = {
			cwd: "/tmp/python-kernel-start-stable",
			sessionId: "kernel-start-stable",
			kernelMode: "session" as const,
			onKernelStart: (id: string) => started.push(id),
		};

		await executePython("first", options);
		await executePython("second", options);

		expect(started).toHaveLength(2);
		expect(started[0]).toBe(started[1]);
		expect(kernel.execute).toHaveBeenCalledTimes(2);
	});

	it("reports a fresh instance id when a dead retained kernel is transparently replaced", async () => {
		const firstKernel = new FakeKernel();
		const replacementKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(firstKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(replacementKernel as unknown as PythonKernelInstance);
		const started: string[] = [];
		const options = {
			cwd: "/tmp/python-kernel-start-replace",
			sessionId: "kernel-start-replace",
			kernelMode: "session" as const,
			onKernelStart: (id: string) => started.push(id),
		};

		await executePython("before replacement", options);
		firstKernel.alive = false;
		await executePython("after replacement", options);

		// The second invocation first observes the retained instance, then reports the
		// replacement before retrying code on it.
		expect(started).toHaveLength(3);
		expect(started[1]).toBe(started[0]);
		expect(started[2]).not.toBe(started[0]);
		expect(firstKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
	});

	it("reports the replacement id before the retry when the kernel dies mid-execute", async () => {
		const dyingKernel = new FakeKernel();
		const replacementKernel = new FakeKernel();
		// The retained kernel throws from execute() and is dead by the time the
		// executor inspects it, driving the mid-execute replace-and-retry branch.
		dyingKernel.execute = vi.fn(async () => {
			dyingKernel.alive = false;
			throw new Error("kernel died mid-execute");
		});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(dyingKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(replacementKernel as unknown as PythonKernelInstance);
		const started: string[] = [];
		const onKernelStart = vi.fn((id: string) => started.push(id));
		const options = {
			cwd: "/tmp/python-kernel-start-mid-execute",
			sessionId: "kernel-start-mid-execute",
			kernelMode: "session" as const,
			onKernelStart,
		};

		const result = await executePython("dies then retries", options);

		// Acquisition reports the dying kernel's id, then the replacement id is
		// reported BEFORE the retry executes on the fresh kernel.
		expect(started).toHaveLength(2);
		expect(started[1]).not.toBe(started[0]);
		expect(dyingKernel.execute).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
		expect(result.exitCode).toBe(0);
		const replacementCallbackOrder = onKernelStart.mock.invocationCallOrder[1];
		const replacementExecuteOrder = replacementKernel.execute.mock.invocationCallOrder[0];
		if (replacementCallbackOrder === undefined) throw new Error("replacement identity was never reported");
		if (replacementExecuteOrder === undefined) throw new Error("replacement kernel never executed");
		expect(replacementCallbackOrder).toBeLessThan(replacementExecuteOrder);
	});

	it("does not invoke onKernelStart for execute-per-call mode", async () => {
		const kernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start").mockImplementation(async options => {
			const created = kernel as unknown as PythonKernelInstance;
			options.onKernelCreated?.(created);
			return created;
		});
		const onKernelStart = vi.fn();

		await executePython("per call", {
			cwd: "/tmp/python-kernel-start-per-call",
			kernelMode: "per-call",
			onKernelStart,
		});

		expect(onKernelStart).not.toHaveBeenCalled();
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("preserves the existing result contract when no callback is supplied", async () => {
		const kernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		const result = await executePython("no callback", {
			cwd: "/tmp/python-kernel-start-absent",
			sessionId: "kernel-start-absent",
			kernelMode: "session",
		});

		expect(result).toEqual({
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 0,
			totalBytes: 0,
			outputLines: 0,
			outputBytes: 0,
			output: "",
			displayOutputs: [],
			stdinRequested: false,
		});
	});
});
