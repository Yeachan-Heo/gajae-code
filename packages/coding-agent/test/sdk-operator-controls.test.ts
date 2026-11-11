import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as pythonExecutor from "@gajae-code/coding-agent/eval/py/executor";
import * as bashExecutor from "@gajae-code/coding-agent/exec/bash-executor";
import {
	createSdkOperatorControls,
	isSdkOperatorOperation,
	isSdkOperatorQueryOperation,
	SDK_OPERATOR_LIMITS,
	type SdkOperatorControls,
	SdkOperatorError,
	type SdkOperatorSnapshot,
} from "@gajae-code/coding-agent/sdk/operator-controls";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

function bashResult(output = "done", overrides: Partial<bashExecutor.BashResult> = {}): bashExecutor.BashResult {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: output.length,
		outputLines: 1,
		outputBytes: output.length,
		...overrides,
	};
}

function pythonResult(output = "done", overrides: Partial<pythonExecutor.PythonResult> = {}): pythonExecutor.PythonResult {
	return { ...bashResult(output), displayOutputs: [], stdinRequested: false, ...overrides };
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function terminalSnapshot(controls: SdkOperatorControls, operationId: string): Promise<SdkOperatorSnapshot> {
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		const snapshot = controls.read({ operationId }).operation;
		if (snapshot.terminal) return snapshot;
		await Bun.sleep(0);
	}
	throw new Error(`Operator execution did not settle: ${JSON.stringify(controls.read({ operationId }).operation)}`);
}

function failure(action: () => unknown, code: SdkOperatorError["code"]): void {
	try {
		action();
		throw new Error(`Expected ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(SdkOperatorError);
		if (!(error instanceof SdkOperatorError)) throw error;
		expect(error.code).toBe(code);
	}
}

describe("session-bound SDK operator controls", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let controls: SdkOperatorControls;
	const restores: Array<() => void> = [];

	beforeEach(async () => {
		dir = TempDir.createSync("sdk-operator-");
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		session = new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(dir.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(auth),
		});
		controls = createSdkOperatorControls(session);
	});

	afterEach(async () => {
		controls.dispose();
		for (const restore of restores.splice(0)) restore();
		await session.dispose();
		auth.close();
		dir.removeSync();
	});

	it("accepts immediately, exposes callback deltas while running, and settles from the real session result", async () => {
		const pending = Promise.withResolvers<bashExecutor.BashResult>();
		let emit: ((text: string) => void) | undefined;
		const execute = spyOn(session, "executeBash").mockImplementation((_source, onChunk) => {
			emit = onChunk;
			return pending.promise;
		});
		restores.push(() => execute.mockRestore());
		const accepted = controls.execute({ text: " !! printf hello " });
		const ref = { operationId: accepted.operation.operationId };
		expect(accepted.admission).toBe("accepted");
		expect(accepted.operation).toMatchObject({ status: "running", terminal: false, output: "", excludeFromContext: true });
		expect(execute).toHaveBeenCalledWith("printf hello", expect.any(Function), { excludeFromContext: true, signal: expect.any(AbortSignal) });
		if (!emit) throw new Error("Missing callback");
		emit("hel");
		emit("lo");
		const live = controls.read(ref);
		expect(live.operation.output).toBe("hello");
		expect(live.operation.terminal).toBe(false);
		expect(live.deltas).toEqual([{ cursor: 1, text: "hel" }, { cursor: 2, text: "lo" }]);
		expect(controls.read({ ...ref, cursor: 1 }).deltas).toEqual([{ cursor: 2, text: "lo" }]);
		live.deltas[0]!.text = "mutated";
		live.operation.output = "mutated";
		expect(controls.read(ref).operation.output).toBe("hello");
		pending.resolve(bashResult("final minimized output", { exitCode: 7, signal: "SIGTERM" }));
		await settle();
		expect(controls.read({ ...ref, cursor: 2 })).toMatchObject({
			operation: { status: "completed", terminal: true, output: "final minimized output", exitCode: 7, signal: "SIGTERM" },
			deltas: [],
			nextCursor: 2,
		});
		emit("late callback");
		expect(controls.read(ref).nextCursor).toBe(2);
		expect(controls.isBusy()).toBe(false);
	});

	it("routes every prefix to Bash or Python and preserves context inclusion", async () => {
		const bash = spyOn(session, "executeBash").mockResolvedValue(bashResult());
		const python = spyOn(session, "executePython").mockResolvedValue(pythonResult());
		restores.push(() => bash.mockRestore(), () => python.mockRestore());
		for (const [text, kind, source, excluded] of [
			["! echo one", "bash", "echo one", false],
			["!! echo two", "bash", "echo two", true],
			["$ print(1)", "python", "print(1)", false],
			["$$ print(2)", "python", "print(2)", true],
		] as const) {
			const accepted = controls.execute({ text });
			expect(accepted.operation.kind).toBe(kind);
			expect(kind === "bash" ? bash : python).toHaveBeenLastCalledWith(source, expect.any(Function), { excludeFromContext: excluded, signal: expect.any(AbortSignal) });
			await settle();
			expect(controls.read({ operationId: accepted.operation.operationId }).operation.terminal).toBe(true);
		}
	});

	it("cancels only the owned active ID and retains busy admission until actual settlement", async () => {
		const pending = Promise.withResolvers<pythonExecutor.PythonResult>();
		const execute = spyOn(session, "executePython").mockReturnValue(pending.promise);
		const abortPython = spyOn(session, "abortEval").mockImplementation(() => {});
		const abortBash = spyOn(session, "abortBash").mockImplementation(() => {});
		restores.push(() => execute.mockRestore(), () => abortPython.mockRestore(), () => abortBash.mockRestore());
		const second = createSdkOperatorControls(session);
		try {
			const admitted = controls.execute({ text: "$ print('pending')" });
			const ref = { operationId: admitted.operation.operationId };
			failure(() => controls.cancel({ operationId: "foreign" }), "not_found");
			failure(() => second.cancel(ref), "not_found");
			expect(abortPython).toHaveBeenCalledTimes(0);
			expect(controls.cancel(ref)).toMatchObject({ status: "cancel_requested", terminal: false });
			expect(controls.cancel(ref).status).toBe("cancel_requested");
			expect(execute.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
			expect(abortPython).toHaveBeenCalledTimes(0);
			expect(abortBash).toHaveBeenCalledTimes(0);
			failure(() => second.execute({ text: "! successor" }), "busy");
			pending.resolve(pythonResult("cancelled", { cancelled: true, exitCode: undefined }));
			await settle();
			expect(controls.read(ref).operation).toMatchObject({ status: "cancelled", terminal: true });
			failure(() => controls.cancel(ref), "already_terminal");
			expect(abortPython).toHaveBeenCalledTimes(0);
		} finally {
			second.dispose();
		}
	});

	it("does not let an old ID cancel a successor", async () => {
		const first = Promise.withResolvers<bashExecutor.BashResult>();
		const next = Promise.withResolvers<bashExecutor.BashResult>();
		const execute = spyOn(session, "executeBash").mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
		const abort = spyOn(session, "abortBash").mockImplementation(() => {});
		restores.push(() => execute.mockRestore(), () => abort.mockRestore());
		const old = controls.execute({ text: "! old" }).operation;
		first.resolve(bashResult());
		await settle();
		const successor = controls.execute({ text: "! successor" }).operation;
		failure(() => controls.cancel({ operationId: old.operationId }), "already_terminal");
		expect(abort).toHaveBeenCalledTimes(0);
		expect(execute.mock.calls[1]?.[2]?.signal?.aborted).toBe(false);
		expect(controls.cancel({ operationId: successor.operationId }).status).toBe("cancel_requested");
		expect(execute.mock.calls[1]?.[2]?.signal?.aborted).toBe(true);
		expect(abort).toHaveBeenCalledTimes(0);
		next.resolve(bashResult("cancelled", { cancelled: true }));
		await settle();
	});

	it("retirement cancels once, withholds late output, and does not release a predecessor's lease", async () => {
		const pending = Promise.withResolvers<bashExecutor.BashResult>();
		const execute = spyOn(session, "executeBash").mockReturnValue(pending.promise);
		const abort = spyOn(session, "abortBash").mockImplementation(() => {});
		restores.push(() => execute.mockRestore(), () => abort.mockRestore());
		const ref = { operationId: controls.execute({ text: "! pending" }).operation.operationId };
		controls.dispose();
		controls.dispose();
		expect(abort).toHaveBeenCalledTimes(0);
		expect(execute.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
		expect(controls.isBusy()).toBe(true);
		failure(() => controls.read(ref), "disposed");
		const next = createSdkOperatorControls(session);
		try {
			failure(() => next.execute({ text: "! successor" }), "busy");
			pending.resolve(bashResult("private late output"));
			await settle();
			expect(next.isBusy()).toBe(false);
			failure(() => next.read(ref), "not_found");
		} finally {
			next.dispose();
		}
	});

	it("retires from actual AgentSession disposal", async () => {
		const pending = Promise.withResolvers<bashExecutor.BashResult>();
		const execute = spyOn(session, "executeBash").mockReturnValue(pending.promise);
		const abort = spyOn(session, "abortBash").mockImplementation(() => {});
		restores.push(() => execute.mockRestore(), () => abort.mockRestore());
		controls.execute({ text: "! pending" });
		await session.dispose();
		expect(controls.disposed).toBe(true);
		expect(execute.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
		expect(abort).toHaveBeenCalledTimes(0);
		pending.resolve(bashResult());
		await settle();
		failure(() => controls.execute({ text: "! closed" }), "disposed");
	});

	it("revokes on lifecycle cleanup, and refuses aborting after manager identity replacement", async () => {
		const register = spyOn(session, "registerToolSessionTransitionCleanup");
		const bound = createSdkOperatorControls(session);
		const cleanup = register.mock.calls[0]?.[0];
		if (!cleanup) throw new Error("Missing transition cleanup");
		await cleanup();
		expect(bound.disposed).toBe(true);
		failure(() => bound.execute({ text: "! old" }), "stale_session");
		register.mockRestore();
		const pending = Promise.withResolvers<bashExecutor.BashResult>();
		const execute = spyOn(session, "executeBash").mockReturnValue(pending.promise);
		const abort = spyOn(session, "abortBash").mockImplementation(() => {});
		restores.push(() => execute.mockRestore(), () => abort.mockRestore());
		const ref = { operationId: controls.execute({ text: "! old identity" }).operation.operationId };
		const original = session.sessionManager;
		session.sessionManager = SessionManager.inMemory(dir.path());
		failure(() => controls.cancel(ref), "stale_session");
		expect(abort).toHaveBeenCalledTimes(0);
		session.sessionManager = original;
		failure(() => controls.cancel(ref), "stale_session");
		pending.resolve(bashResult());
		await settle();
	});

	it("bounds snapshots and callback retention, rejecting expired and malformed cursors", async () => {
		const pending = Promise.withResolvers<bashExecutor.BashResult>();
		let emit: ((text: string) => void) | undefined;
		const execute = spyOn(session, "executeBash").mockImplementation((_source, onChunk) => {
			emit = onChunk;
			return pending.promise;
		});
		restores.push(() => execute.mockRestore());
		const ref = { operationId: controls.execute({ text: "! noisy" }).operation.operationId };
		if (!emit) throw new Error("Missing callback");
		for (let index = 0; index < SDK_OPERATOR_LIMITS.deltaChunks + 1; index++) emit("x");
		failure(() => controls.read({ ...ref, cursor: 0 }), "stale_cursor");
		expect(controls.read(ref).deltas).toHaveLength(SDK_OPERATOR_LIMITS.deltaChunks);
		emit("z".repeat(SDK_OPERATOR_LIMITS.outputChars + 1));
		const retained = controls.read(ref);
		expect(retained.operation.output).toHaveLength(SDK_OPERATOR_LIMITS.outputChars);
		expect(retained.operation.outputTruncated).toBe(true);
		expect(retained.deltasTruncated).toBe(true);
		expect(retained.deltas.reduce((count, delta) => count + delta.text.length, 0)).toBeLessThanOrEqual(SDK_OPERATOR_LIMITS.outputChars);
		failure(() => controls.read({ ...ref, cursor: retained.nextCursor - 1 }), "stale_cursor");
		for (const cursor of [-1, 0.5, NaN, Infinity, "0", retained.nextCursor + 1])
			failure(() => controls.read({ ...ref, cursor }), "invalid_input");
		pending.resolve(bashResult("final".repeat(SDK_OPERATOR_LIMITS.outputChars)));
		await settle();
		expect(controls.read(ref).operation.output).toHaveLength(SDK_OPERATOR_LIMITS.outputChars);
	});

	it("returns exact non-foldability without touching unrelated managed foreground tools", async () => {
		const bashPending = Promise.withResolvers<bashExecutor.BashResult>();
		const pythonPending = Promise.withResolvers<pythonExecutor.PythonResult>();
		const bash = spyOn(session, "executeBash").mockReturnValue(bashPending.promise);
		const python = spyOn(session, "executePython").mockReturnValue(pythonPending.promise);
		const fold = spyOn(session, "requestForegroundBashBackgroundOutcome").mockResolvedValue({ status: "folded", jobId: "unrelated" });
		restores.push(() => bash.mockRestore(), () => python.mockRestore(), () => fold.mockRestore());
		const ref = { operationId: controls.execute({ text: "! managed by user executor" }).operation.operationId };
		expect(controls.background(ref)).toMatchObject({ status: "not_foldable", reason: "user_bash_execution", operation: { terminal: false } });
		failure(() => controls.background({ operationId: "other" }), "not_found");
		bashPending.resolve(bashResult());
		await settle();
		failure(() => controls.background(ref), "already_terminal");
		const pythonRef = { operationId: controls.execute({ text: "$ pass" }).operation.operationId };
		expect(controls.background(pythonRef).reason).toBe("python_execution");
		expect(fold).toHaveBeenCalledTimes(0);
		pythonPending.resolve(pythonResult());
		await settle();
	});

	it("maps executor failures without leaking backend details", async () => {
		const execute = spyOn(session, "executeBash").mockRejectedValue(new Error("secret internal path"));
		restores.push(() => execute.mockRestore());
		const ref = { operationId: controls.execute({ text: "! fail" }).operation.operationId };
		await settle();
		expect(controls.read(ref).operation).toMatchObject({ status: "failed", terminal: true, error: { code: "backend_failure" } });
		expect(JSON.stringify(controls.read(ref))).not.toContain("secret internal path");
	});

	it("scoped Bash cancellation leaves an unrelated real session invocation untouched; global abort still reaches it", async () => {
		const signals: AbortSignal[] = [];
		const execute = spyOn(bashExecutor, "executeBash").mockImplementation((_source, options) => {
			const pending = Promise.withResolvers<bashExecutor.BashResult>();
			const signal = options?.signal;
			if (!signal) throw new Error("Missing invocation signal");
			signals.push(signal);
			signal.addEventListener("abort", () => pending.resolve(bashResult("cancelled", { cancelled: true, exitCode: undefined })), { once: true });
			return pending.promise;
		});
		restores.push(() => execute.mockRestore());
		const ref = { operationId: controls.execute({ text: "! owned" }).operation.operationId };
		const unrelated = session.executeBash("unrelated", undefined, { excludeFromContext: true });
		expect(signals).toHaveLength(2);
		expect(controls.cancel(ref)).toMatchObject({ status: "cancel_requested", terminal: false });
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		await settle();
		expect(controls.read(ref).operation.status).toBe("cancelled");
		failure(() => controls.cancel(ref), "already_terminal");
		expect(signals[1]?.aborted).toBe(false);
		session.abortBash();
		expect(signals[1]?.aborted).toBe(true);
		expect((await unrelated).cancelled).toBe(true);
	});

	it("scoped Python cancellation leaves unrelated retained-kernel requests untouched; global abort still reaches them", async () => {
		const signals: AbortSignal[] = [];
		const execute = spyOn(pythonExecutor, "executePython").mockImplementation((_source, options) => {
			const pending = Promise.withResolvers<pythonExecutor.PythonResult>();
			const signal = options?.signal;
			if (!signal) throw new Error("Missing invocation signal");
			signals.push(signal);
			signal.addEventListener("abort", () => pending.resolve(pythonResult("cancelled", { cancelled: true, exitCode: undefined })), { once: true });
			return pending.promise;
		});
		restores.push(() => execute.mockRestore());
		const ref = { operationId: controls.execute({ text: "$ owned()" }).operation.operationId };
		const unrelated = session.executePython("unrelated()", undefined, { excludeFromContext: true });
		await settle();
		expect(signals).toHaveLength(2);
		controls.cancel(ref);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		expect((await terminalSnapshot(controls, ref.operationId)).status).toBe("cancelled");
		session.abortEval();
		expect(signals[1]?.aborted).toBe(true);
		expect((await unrelated).cancelled).toBe(true);
	});

	it("the real deferred Python promise rejects with the scoped cancellation reason before backend admission", async () => {
		const execute = spyOn(pythonExecutor, "executePython");
		restores.push(() => execute.mockRestore());
		const controller = new AbortController();
		const execution = session.executePython("must_not_execute()", undefined, { signal: controller.signal });
		expect(session.isEvalRunning).toBe(true);
		controller.abort();
		await expect(execution).rejects.toBe(controller.signal.reason);
		expect(session.isEvalRunning).toBe(false);
		expect(execute).toHaveBeenCalledTimes(0);
	});

	it("settles an immediate Python cancellation before backend admission without executing code", async () => {
		const execute = spyOn(pythonExecutor, "executePython");
		restores.push(() => execute.mockRestore());
		const ref = { operationId: controls.execute({ text: "$ must_not_execute()" }).operation.operationId };
		expect(controls.cancel(ref)).toMatchObject({ status: "cancel_requested", terminal: false });
		// AgentSession.executePython has a deferred async body and an awaited tracking
		// promise; settlement is observable through polling, not a fixed microtask count.
		expect(await terminalSnapshot(controls, ref.operationId)).toMatchObject({ status: "cancelled", terminal: true });
		expect(execute).toHaveBeenCalledTimes(0);
	});

	it("rejects admission while an existing session-owned Python execution is running", async () => {
		const pending = Promise.withResolvers<void>();
		const tracked = session.trackEvalExecution(pending.promise, new AbortController());
		try {
			failure(() => controls.execute({ text: "! cannot overlap" }), "busy");
			failure(() => controls.execute({ text: "$ cannot_overlap()" }), "busy");
		} finally {
			pending.resolve();
			await tracked;
		}
	});

	it("rejects malformed input and closed-operation aliases before executing", () => {
		const execute = spyOn(session, "executeBash");
		restores.push(() => execute.mockRestore());
		for (const value of [null, [], {}, { text: "echo unprefixed" }, { text: "!" }, { text: "$$ " }, { text: "! a\0b" }, { text: `!${"x".repeat(SDK_OPERATOR_LIMITS.inputChars)}` }, { text: "! ok", extra: true }, Object.create({ text: "! inherited" })])
			failure(() => controls.execute(value), "invalid_input");
		const accessor = Object.defineProperty({}, "text", { enumerable: true, get: () => { throw new Error("must not invoke"); } });
		failure(() => controls.execute(accessor), "invalid_input");
		expect(execute).toHaveBeenCalledTimes(0);
		expect(isSdkOperatorOperation("bash.execute")).toBe(false);
		expect(isSdkOperatorOperation("operator.read")).toBe(true);
		expect(isSdkOperatorQueryOperation("operator.execute")).toBe(false);
		expect(isSdkOperatorQueryOperation("operator.read")).toBe(true);
	});

	it("evicts only settled history and rejects retired IDs", async () => {
		const execute = spyOn(session, "executeBash").mockResolvedValue(bashResult());
		restores.push(() => execute.mockRestore());
		let first = "";
		for (let index = 0; index <= SDK_OPERATOR_LIMITS.operations; index++) {
			const accepted = controls.execute({ text: "! bounded history" });
			if (index === 0) first = accepted.operation.operationId;
			await settle();
		}
		failure(() => controls.read({ operationId: first }), "not_found");
	});
});
