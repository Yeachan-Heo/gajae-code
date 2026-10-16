import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	disposeAllKernelSessions,
	disposeKernelSessionsByOwner,
	executePython,
} from "@gajae-code/coding-agent/eval/py/executor";
import type { KernelExecuteResult } from "@gajae-code/coding-agent/eval/py/kernel";
import * as pythonKernel from "@gajae-code/coding-agent/eval/py/kernel";
import { getProjectDir } from "@gajae-code/utils";

class FakeKernel {
	execute = vi.fn(async () => this.result);
	shutdown = vi.fn(async () => {
		return { confirmed: true };
	});
	ping = vi.fn(async () => true);
	alive = true;
	#exitCode: number | null = null;

	constructor(private readonly result: KernelExecuteResult) {}

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

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeAllKernelSessions();
});

describe("executePython lifecycle", () => {
	it("starts and shuts down per-call kernels", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(pythonKernel.PythonKernel, "start").mockImplementation(async options => {
			const created = kernel as unknown as pythonKernel.PythonKernel;
			options.onKernelCreated?.(created);
			return created;
		});

		await executePython("print('hi')", { kernelMode: "per-call", cwd: getProjectDir() });

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(1);
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("reuses session kernels until reset", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as pythonKernel.PythonKernel);

		await executePython("1 + 1", { kernelMode: "session", sessionId: "test-session", cwd: getProjectDir() });
		await executePython("2 + 2", { kernelMode: "session", sessionId: "test-session", cwd: getProjectDir() });

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(2);
	});

	it("resets session kernels when requested", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		const kernelNext = new FakeKernel(OK_RESULT);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(kernel as unknown as pythonKernel.PythonKernel)
			.mockResolvedValueOnce(kernelNext as unknown as pythonKernel.PythonKernel);

		await executePython("1 + 1", { kernelMode: "session", sessionId: "reset-session", cwd: getProjectDir() });
		await executePython("2 + 2", {
			kernelMode: "session",
			sessionId: "reset-session",
			reset: true,
			cwd: getProjectDir(),
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
		expect(kernelNext.execute).toHaveBeenCalledTimes(1);
	});

	it("restarts session kernels when they are dead", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		const kernelNext = new FakeKernel(OK_RESULT);
		kernel.alive = false;
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(kernel as unknown as pythonKernel.PythonKernel)
			.mockResolvedValueOnce(kernelNext as unknown as pythonKernel.PythonKernel);

		await executePython("1 + 1", { kernelMode: "session", sessionId: "dead-session", cwd: getProjectDir() });

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(0);
		expect(kernelNext.execute).toHaveBeenCalledTimes(1);
	});

	it("restarts dead retained sessions even when shutdown confirmation is missing", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		const kernelNext = new FakeKernel(OK_RESULT);
		kernel.alive = false;
		kernel.shutdown.mockResolvedValueOnce({ confirmed: false });
		// Simulate process exit even though shutdown is unconfirmed
		kernel.setExitCode(0);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(kernel as unknown as pythonKernel.PythonKernel)
			.mockResolvedValueOnce(kernelNext as unknown as pythonKernel.PythonKernel);

		await executePython("1 + 1", { kernelMode: "session", sessionId: "retry-dead-session", cwd: getProjectDir() });
		await executePython("2 + 2", { kernelMode: "session", sessionId: "retry-dead-session", cwd: getProjectDir() });

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(0);
		expect(kernelNext.execute).toHaveBeenCalledTimes(2);
	});

	it("retains unconfirmed dead-kernel cleanup for owner disposal after replacement", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		const replacement = new FakeKernel(OK_RESULT);
		kernel.alive = false;
		kernel.shutdown.mockResolvedValueOnce({ confirmed: false });
		// Simulate process exit even though shutdown is unconfirmed
		kernel.setExitCode(0);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(kernel as unknown as pythonKernel.PythonKernel)
			.mockResolvedValueOnce(replacement as unknown as pythonKernel.PythonKernel);

		const result = await executePython("recover", {
			kernelMode: "session",
			sessionId: "dead-owned-session",
			kernelOwnerId: "dead-kernel-owner",
			cwd: getProjectDir(),
		});

		expect(result.exitCode).toBe(0);
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
		await disposeKernelSessionsByOwner("dead-kernel-owner");
		expect(kernel.shutdown).toHaveBeenCalledTimes(2);
		expect(replacement.shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not replace a dead retained kernel when shutdown rejects", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		kernel.alive = false;
		const failure = new Error("shutdown transport failed");
		kernel.shutdown.mockRejectedValueOnce(failure);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as pythonKernel.PythonKernel);

		await expect(
			executePython("recover", {
				kernelMode: "session",
				sessionId: "dead-rejected-session",
				cwd: getProjectDir(),
			}),
		).rejects.toBe(failure);
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).not.toHaveBeenCalled();
	});
});
