import { afterEach, describe, expect, it, vi } from "bun:test";
import { disposeAllKernelSessions, executePython } from "@gajae-code/coding-agent/eval/py/executor";
import * as pythonKernel from "@gajae-code/coding-agent/eval/py/kernel";
import { disposePyToolBridge } from "@gajae-code/coding-agent/eval/py/tool-bridge";
import type { ToolSession } from "@gajae-code/coding-agent/tools";

class FakeKernel {
	#onExecute?: () => Promise<void>;
	executeCalls = 0;
	shutdownCalls = 0;
	alive = true;
	#exitCode: number | null = null;
	constructor(
		private readonly shouldThrow: boolean = false,
		onExecute?: () => Promise<void>,
	) {
		this.#onExecute = onExecute;
	}

	isAlive(): boolean {
		return this.alive;
	}

	async execute(): Promise<{ status: "ok"; cancelled: false; timedOut: false; stdinRequested: false }> {
		this.executeCalls += 1;
		await this.#onExecute?.();
		if (this.shouldThrow) {
			this.alive = false;
			throw new Error("kernel crashed");
		}
		return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
	}

	async ping(): Promise<boolean> {
		return this.alive;
	}

	async shutdown(): Promise<pythonKernel.KernelShutdownResult> {
		this.shutdownCalls += 1;
		this.alive = false;
		return { confirmed: true };
	}

	getExitCode(): number | null {
		return this.#exitCode;
	}

	setExitCode(code: number | null): void {
		this.#exitCode = code;
	}
}

describe("executePython session lifecycle", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await disposeAllKernelSessions();
		await disposePyToolBridge();
	});

	it("restarts session when kernel is not alive", async () => {
		const kernel1 = new FakeKernel();
		kernel1.alive = false;
		const kernel2 = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(kernel1 as unknown as pythonKernel.PythonKernel)
			.mockResolvedValueOnce(kernel2 as unknown as pythonKernel.PythonKernel);

		await executePython("print('hi')", { cwd: "/tmp", sessionId: "session-1", kernelMode: "session" });

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel1.executeCalls).toBe(0);
		expect(kernel1.shutdownCalls).toBe(1);
		expect(kernel2.executeCalls).toBe(1);
	});

	it("restarts after an execution failure when kernel is dead", async () => {
		const kernel1 = new FakeKernel(true);
		const kernel2 = new FakeKernel();
		const starts = [kernel1, kernel2];
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(pythonKernel.PythonKernel, "start").mockImplementation(async () => {
			const next = starts.shift();
			if (!next) {
				throw new Error("No kernel available");
			}
			return next as unknown as pythonKernel.PythonKernel;
		});

		await executePython("raise", { cwd: "/tmp", sessionId: "session-2", kernelMode: "session" });

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel1.executeCalls).toBe(1);
		expect(kernel2.executeCalls).toBe(1);
	});

	it("resets existing session when requested", async () => {
		const kernel1 = new FakeKernel();
		const kernel2 = new FakeKernel();
		const starts = [kernel1, kernel2];
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(pythonKernel.PythonKernel, "start").mockImplementation(async () => {
			const next = starts.shift();
			if (!next) {
				throw new Error("No kernel available");
			}
			return next as unknown as pythonKernel.PythonKernel;
		});

		await executePython("print('one')", { cwd: "/tmp", sessionId: "session-3", kernelMode: "session" });
		await executePython("print('two')", {
			cwd: "/tmp",
			sessionId: "session-3",
			kernelMode: "session",
			reset: true,
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel1.shutdownCalls).toBe(1);
		expect(kernel2.executeCalls).toBe(1);
	});

	it("rotates the session capability when replacing a dead kernel automatically", async () => {
		const kernel1 = new FakeKernel();
		const bridgeEnvironments: Array<Record<string, string | undefined>> = [];
		const kernel2 = new FakeKernel(false, async () => {
			const bridgeUrl = bridgeEnvironments[1]!.PI_TOOL_BRIDGE_URL;
			const firstCapability = bridgeEnvironments[0]!.PI_TOOL_BRIDGE_CAPABILITY;
			const rotatedCapability = bridgeEnvironments[1]!.PI_TOOL_BRIDGE_CAPABILITY;
			const callBridge = async (capability: string): Promise<Response> =>
				await fetch(`${bridgeUrl}/v1/tool`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${capability}` },
					body: JSON.stringify({}),
				});
			expect((await callBridge(firstCapability!)).status).toBe(403);
			expect((await callBridge(rotatedCapability!)).status).toBe(400);
		});
		const starts = [kernel1, kernel2];
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start").mockImplementation(async options => {
			bridgeEnvironments.push(options.env ?? {});
			const next = starts.shift();
			if (!next) throw new Error("No kernel available");
			return next as unknown as pythonKernel.PythonKernel;
		});
		const toolSession = { getToolByName: () => undefined } as unknown as ToolSession;

		await executePython("print('one')", {
			cwd: "/tmp",
			sessionId: "bridge-session",
			kernelMode: "session",
			toolSession,
		});
		kernel1.alive = false;
		await executePython("print('two')", {
			cwd: "/tmp",
			sessionId: "bridge-session",
			kernelMode: "session",
			toolSession,
		});

		expect(bridgeEnvironments).toHaveLength(2);
		const firstCapability = bridgeEnvironments[0]!.PI_TOOL_BRIDGE_CAPABILITY;
		const rotatedCapability = bridgeEnvironments[1]!.PI_TOOL_BRIDGE_CAPABILITY;
		expect(firstCapability).toBeString();
		expect(rotatedCapability).toBeString();
		expect(rotatedCapability).not.toBe(firstCapability);
		expect(bridgeEnvironments[0]!.PI_TOOL_BRIDGE_TOKEN).toBeUndefined();
		expect(bridgeEnvironments[0]!.PI_TOOL_BRIDGE_SESSION).toBe("bridge-session");
		expect(kernel1.shutdownCalls).toBe(1);
		expect(kernel2.executeCalls).toBe(1);
	});
});
