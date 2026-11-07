import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as pythonExecutor from "@gajae-code/coding-agent/eval/py/executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "@gajae-code/coding-agent/eval/py/kernel";
import * as pythonKernel from "@gajae-code/coding-agent/eval/py/kernel";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { BashTool } from "@gajae-code/coding-agent/tools/bash";
import {
	createDesktopOperatorController,
	DESKTOP_OPERATOR_LIMITS,
	type DesktopOperatorController,
	type DesktopOperatorOptions,
	type DesktopOperatorStreamRedactor,
} from "../src/operator-controls";
import type { DesktopOperatorEvent, DesktopOperatorOperation } from "../src/operator-protocol";

const cleanups: Array<() => Promise<void>> = [];
const OK: KernelExecuteResult = { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
const secret = "operator-private-token";
const redact = (text: string): string => text.replaceAll(secret, "[redacted]");

/** Host policy seam: retain every suffix that could be the beginning of a known secret. */
function streamRedactor(): DesktopOperatorStreamRedactor {
	let pending = "";
	return {
		push(chunk) {
			const safe = redact(pending + chunk);
			let retained = 0;
			for (let length = 1; length < secret.length; length++) {
				if (safe.endsWith(secret.slice(0, length))) retained = length;
			}
			pending = retained ? safe.slice(-retained) : "";
			return retained ? safe.slice(0, -retained) : safe;
		},
		finish() {
			const result = redact(pending);
			pending = "";
			return result;
		},
	};
}

/** Real public Agent/AgentSession and scoped resource owners, with no provider transport. */
async function fixture(options: { persisted?: boolean; streaming?: boolean; redact?: (text: string) => string } = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-operator-"));
	await setModelPresetRegistryDisabled({ agentDir: directory, disabled: true });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"bash.autoBackground.enabled": false,
		"python.kernelMode": "session",
		shellPath: "/bin/sh",
	});
	const auth = await AuthStorage.create(path.join(directory, "auth.db"));
	const registry = new ModelRegistry(auth, path.join(directory, "models.yml"), settings, { agentDir: directory });
	const manager = options.persisted
		? SessionManager.create(directory, SessionManager.explicitDestination(path.join(directory, "sessions")))
		: SessionManager.inMemory(directory);
	const jobs = new AsyncJobManager({ onJobComplete: () => {} });
	const ownerId = crypto.randomUUID();
	const agent = new Agent({
		initialState: { messages: [], tools: [], systemPrompt: [] },
		getApiKey: () => {
			throw new Error("No provider turns in operator tests");
		},
		streamFn: () => {
			throw new Error("No provider turns in operator tests");
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		agentDir: directory,
		ownedAsyncJobManager: jobs,
		agentId: ownerId,
	});
	const events: DesktopOperatorEvent[] = [];
	const controllerOptions: DesktopOperatorOptions = {
		connectionGeneration: crypto.randomUUID(),
		redact: options.redact ?? redact,
		emit: event => {
			events.push(event);
		},
		...(options.streaming ? { createStreamRedactor: streamRedactor } : {}),
	};
	const controller = createDesktopOperatorController(session, controllerOptions);
	cleanups.push(async () => {
		controller.dispose();
		await session.dispose();
		await registry.dispose();
		await settings.close();
		auth.close();
		await fs.rm(directory, { recursive: true, force: true });
	});
	return { directory, settings, manager, jobs, ownerId, agent, session, events, controller, controllerOptions };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Operator condition did not settle within the test deadline");
}

async function settled(
	controller: DesktopOperatorController,
	operation: DesktopOperatorOperation,
): Promise<DesktopOperatorOperation> {
	await waitFor(() => {
		const status = controller.getOperation({ operationId: operation.operationId }).status;
		return status !== "running" && status !== "cancel_requested";
	});
	return controller.getOperation({ operationId: operation.operationId });
}

/** Exercise AgentSession's real persistence/cancellation plus the SDK's actual output sink. */
function pythonSeam(execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>) {
	const ownedCalls: pythonExecutor.PythonExecutorOptions[] = [];
	const spy = vi.spyOn(pythonExecutor, "executePython").mockImplementation((code, options) => {
		if (!options?.kernelOwnerId || !options.signal)
			throw new Error("AgentSession did not pass its real Python owner and signal");
		ownedCalls.push(options);
		return pythonExecutor.executePythonWithKernel({ execute }, code, options);
	});
	return { ownedCalls, restore: () => spy.mockRestore() };
}

afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	vi.restoreAllMocks();
});

describe("desktop real session operator controls", () => {
	test("! and !! run real owned shell commands and preserve TUI context exclusion", async () => {
		const f = await fixture();
		const first = await settled(f.controller, f.controller.execute({ text: "! printf 'included-output\\n'" }));
		expect(first).toMatchObject({ kind: "bash", status: "completed", exitCode: 0, excludeFromContext: false });
		expect(first.output).toContain("included-output");
		const second = await settled(f.controller, f.controller.execute({ text: "  !! printf 'excluded-output\\n'  " }));
		expect(second).toMatchObject({ kind: "bash", status: "completed", exitCode: 0, excludeFromContext: true });
		expect(second.output).toContain("excluded-output");
		const messages = f.agent.state.messages.filter(message => message.role === "bashExecution");
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ command: "printf 'included-output\\n'", excludeFromContext: false });
		expect(messages[1]).toMatchObject({ command: "printf 'excluded-output\\n'", excludeFromContext: true });
		const context = JSON.stringify(convertToLlm(f.agent.state.messages));
		expect(context).toContain("included-output");
		expect(context).not.toContain("excluded-output");
		expect(f.manager.getEntries().filter(entry => entry.type === "message")).toHaveLength(2);
	}, 20_000);

	test("nonzero shell exit is actual completion with its error output, never fabricated success", async () => {
		const f = await fixture();
		const result = await settled(
			f.controller,
			f.controller.execute({ text: "! printf 'command-error\\n' >&2; exit 7" }),
		);
		expect(result).toMatchObject({ status: "completed", exitCode: 7 });
		expect(result.output).toContain("command-error");
		expect(f.agent.state.messages.at(-1)).toMatchObject({ role: "bashExecution", exitCode: 7 });
	}, 20_000);

	test("real shell abort stays reachable while execute attempts fail explicitly", async () => {
		const f = await fixture({ streaming: true });
		expect(f.controller.isBusy()).toBe(false);
		const running = f.controller.execute({
			text: "! printf 'ready-to-cancel\\n'; sleep 30; printf 'must-not-finish\\n'",
		});
		expect(f.controller.isBusy()).toBe(true);
		await waitFor(() => f.events.some(event => event.operation.output.includes("ready-to-cancel")));
		expect(() => f.controller.execute({ text: "$ print('another')" })).toThrow(
			expect.objectContaining({ code: "busy" }),
		);
		const second = createDesktopOperatorController(f.session, {
			...f.controllerOptions,
			connectionGeneration: "second-connection",
		});
		try {
			expect(second.isBusy()).toBe(true);
			expect(() => second.execute({ text: "! true" })).toThrow(expect.objectContaining({ code: "busy" }));
			expect(() => second.abort({ operationId: running.operationId })).toThrow(
				expect.objectContaining({ code: "not_found" }),
			);
			expect(await f.controller.fold({})).toEqual({ target: "current_foreground_tool", status: "unsupported" });
			expect(f.controller.getOperation({ operationId: running.operationId }).status).toBe("running");
			expect(f.controller.abort({ operationId: running.operationId }).status).toBe("cancel_requested");
			expect(f.controller.isBusy()).toBe(true);
			const result = await settled(f.controller, running);
			expect(result.status).toBe("cancelled");
			expect(f.controller.isBusy()).toBe(false);
			expect(second.isBusy()).toBe(false);
			expect(result.output).not.toContain("must-not-finish");
			expect(f.session.isBashRunning).toBe(false);
			expect(f.agent.state.messages.at(-1)).toMatchObject({ role: "bashExecution", cancelled: true });
			expect(() => f.controller.abort({ operationId: running.operationId })).toThrow(
				expect.objectContaining({ code: "already_terminal" }),
			);
		} finally {
			second.dispose();
		}
	}, 20_000);

	test("$ and $$ call the real Python session path, owned executor sink and context semantics", async () => {
		const calls = pythonSeam(async (code, options) => {
			await options?.onChunk?.(`executed:${code}\n`);
			return OK;
		});
		const f = await fixture();
		const executeSpy = vi.spyOn(f.session, "executePython");
		const first = await settled(f.controller, f.controller.execute({ text: "$ included_python()" }));
		const second = await settled(f.controller, f.controller.execute({ text: "$$ excluded_python()" }));
		expect(executeSpy.mock.calls.map(call => [call[0], call[2]])).toEqual([
			["included_python()", { excludeFromContext: false }],
			["excluded_python()", { excludeFromContext: true }],
		]);
		expect(first).toMatchObject({ kind: "python", status: "completed", exitCode: 0, excludeFromContext: false });
		expect(second).toMatchObject({ kind: "python", status: "completed", exitCode: 0, excludeFromContext: true });
		expect(second.output).toContain("executed:excluded_python()");
		expect(calls.ownedCalls).toHaveLength(2);
		expect(calls.ownedCalls[0]?.kernelOwnerId).toBe(calls.ownedCalls[1]?.kernelOwnerId);
		expect(f.agent.state.messages.at(-1)).toMatchObject({ role: "pythonExecution", excludeFromContext: true });
		const context = JSON.stringify(convertToLlm(f.agent.state.messages));
		expect(context).toContain("included_python()");
		expect(context).not.toContain("excluded_python()");
	});

	test("Python abort uses abortEval and real executor cancellation rather than assuming acknowledgement is settlement", async () => {
		const entered = Promise.withResolvers<void>();
		pythonSeam(async (_code, options) => {
			const done = Promise.withResolvers<KernelExecuteResult>();
			const cancel = () => done.resolve({ ...OK, cancelled: true });
			if (options?.signal?.aborted) cancel();
			else options?.signal?.addEventListener("abort", cancel, { once: true });
			entered.resolve();
			return done.promise;
		});
		const f = await fixture();
		const abort = vi.spyOn(f.session, "abortEval");
		const running = f.controller.execute({ text: "$$ blocking_python()" });
		await entered.promise;
		expect(f.controller.abort({ operationId: running.operationId }).status).toBe("cancel_requested");
		expect(abort).toHaveBeenCalledTimes(1);
		const result = await settled(f.controller, running);
		expect(result.status).toBe("cancelled");
		expect(result.exitCode).toBeUndefined();
		expect(f.session.isEvalRunning).toBe(false);
		expect(f.agent.state.messages.at(-1)).toMatchObject({
			role: "pythonExecution",
			cancelled: true,
			excludeFromContext: true,
		});
	});

	test("Python errors retain nonzero exit and unavailable kernels are not completion", async () => {
		const seam = pythonSeam(async (_code, options) => {
			await options?.onChunk?.("ValueError: invalid value\n");
			return { ...OK, status: "error", error: { name: "ValueError", value: "invalid value", traceback: [] } };
		});
		const f = await fixture();
		const error = await settled(f.controller, f.controller.execute({ text: "$ raise ValueError()" }));
		expect(error).toMatchObject({ status: "completed", exitCode: 1 });
		expect(error.output).toContain("ValueError");
		expect(seam.ownedCalls).toHaveLength(1);
		seam.restore();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: false, reason: secret });
		const unavailable = await settled(f.controller, f.controller.execute({ text: "$ print(1)" }));
		expect(unavailable).toMatchObject({ status: "failed", error: { code: "backend_failure" } });
		expect(unavailable.exitCode).toBeUndefined();
		expect(JSON.stringify(f.events)).not.toContain(secret);
		expect(f.agent.state.messages.filter(message => message.role === "pythonExecution")).toHaveLength(1);
	});

	test("redacts cross-chunk secrets before streaming and bounds detached final DTOs", async () => {
		const release = Promise.withResolvers<void>();
		const streamed = Promise.withResolvers<void>();
		pythonSeam(async (_code, options) => {
			await options?.onChunk?.("safe-prefix\noperator-private-");
			await options?.onChunk?.("token\nsafe-tail\n");
			streamed.resolve();
			await release.promise;
			await options?.onChunk?.(`${"x".repeat(100)}\n`.repeat(400) + secret + "\x1b[31mEND\x1b[0m");
			return OK;
		});
		const f = await fixture({ streaming: true });
		cleanups.push(async () => {
			release.resolve();
		});
		const running = f.controller.execute({ text: "$ private_code_not_echoed()" });
		await streamed.promise;
		const stream = f.controller.getOperation({ operationId: running.operationId });
		expect(stream.status).toBe("running");
		expect(stream.output).toContain("safe-prefix");
		expect(stream.output).toContain("[redacted]");
		expect(JSON.stringify(f.events)).not.toContain("operator-private-");
		release.resolve();
		const result = await settled(f.controller, running);
		expect(result.output).toContain("[redacted]");
		expect(result.output).toEndWith("END");
		expect(result.output).not.toContain("\x1b");
		expect(result.output.length).toBeLessThanOrEqual(DESKTOP_OPERATOR_LIMITS.outputChars);
		expect(result.outputTruncated).toBe(true);
		expect(JSON.stringify(f.events)).not.toContain(secret);
		expect(JSON.stringify(f.events)).not.toContain("private_code_not_echoed()");
		result.output = "tampered";
		result.operationId = "forged";
		expect(f.controller.getOperation({ operationId: running.operationId }).output).toContain("END");
	});

	test("without a streaming redactor content is withheld; redaction failures fail closed", async () => {
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		pythonSeam(async (_code, options) => {
			await options?.onChunk?.("operator-private-");
			entered.resolve();
			await release.promise;
			await options?.onChunk?.("token\n");
			return OK;
		});
		const f = await fixture();
		cleanups.push(async () => {
			release.resolve();
		});
		const running = f.controller.execute({ text: "$ private_output()" });
		await entered.promise;
		expect(f.controller.getOperation({ operationId: running.operationId })).toMatchObject({
			output: "",
			liveOutput: "withheld",
			status: "running",
		});
		expect(JSON.stringify(f.events)).not.toContain("operator-private-");
		release.resolve();
		expect((await settled(f.controller, running)).output).toContain("[redacted]");
		const closed = createDesktopOperatorController(f.session, {
			connectionGeneration: "closed",
			redact: () => {
				throw new Error(secret);
			},
			emit: event => {
				f.events.push(event);
			},
		});
		try {
			const result = await settled(closed, closed.execute({ text: "$ private_output()" }));
			expect(result).toMatchObject({ status: "failed", output: "", error: { code: "redaction_failed" } });
			expect(JSON.stringify(f.events)).not.toContain(secret);
		} finally {
			closed.dispose();
		}
	});

	test("a failing streaming redactor withholds output without pretending the SDK executor has settled", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		pythonSeam(async (_code, options) => {
			await options?.onChunk?.(secret);
			entered.resolve();
			await release.promise;
			return OK;
		});
		const f = await fixture();
		const controller = createDesktopOperatorController(f.session, {
			...f.controllerOptions,
			createStreamRedactor: () => ({
				push: () => {
					throw new Error(secret);
				},
				finish: () => "",
			}),
		});
		cleanups.push(async () => {
			release.resolve();
			controller.dispose();
		});
		const running = controller.execute({ text: "$ stream_error()" });
		await entered.promise;
		expect(controller.getOperation({ operationId: running.operationId })).toMatchObject({
			status: "running",
			output: "",
			liveOutput: "withheld",
		});
		expect(() => controller.execute({ text: "! true" })).toThrow(expect.objectContaining({ code: "busy" }));
		release.resolve();
		expect(await settled(controller, running)).toMatchObject({
			status: "failed",
			output: "",
			error: { code: "redaction_failed" },
		});
		expect(JSON.stringify(f.events)).not.toContain(secret);
	});

	test("expired operation references cannot access retained output", async () => {
		pythonSeam(async (code, options) => {
			await options?.onChunk?.(code);
			return OK;
		});
		const f = await fixture();
		const first = await settled(f.controller, f.controller.execute({ text: "$ first_output()" }));
		for (let index = 0; index < DESKTOP_OPERATOR_LIMITS.operations; index++) {
			await settled(f.controller, f.controller.execute({ text: `$ retained_output_${index}()` }));
		}
		expect(() => f.controller.getOperation({ operationId: first.operationId })).toThrow(
			expect.objectContaining({ code: "not_found" }),
		);
	});

	test("strict JSON inputs reject extra fields, empty sources, non-JSON objects and foreign IDs", async () => {
		const f = await fixture();
		const execute = vi.spyOn(f.session, "executeBash");
		for (const value of [
			null,
			[],
			"! true",
			{},
			{ text: "plain prompt" },
			{ text: "!! " },
			{ text: "$$\n" },
			{ text: "! true", cwd: "/" },
			{ text: "! true", timeout: 1 },
			{ text: "! true", excludeFromContext: true },
			{ text: `!${"x".repeat(DESKTOP_OPERATOR_LIMITS.inputChars)}` },
			{ text: "! echo\0" },
			Object.create({ text: "! true" }),
			Object.defineProperty({}, "text", { get: () => "! true", enumerable: true }),
		]) {
			expect(() => f.controller.execute(value)).toThrow(expect.objectContaining({ code: "invalid_input" }));
		}
		expect(execute).not.toHaveBeenCalled();
		expect(() => f.controller.getOperation({ operationId: "foreign" })).toThrow(
			expect.objectContaining({ code: "not_found" }),
		);
		expect(() => f.controller.abort({ operationId: "foreign" })).toThrow(
			expect.objectContaining({ code: "not_found" }),
		);
		expect(() => f.controller.getOperation({ operationId: "foreign", ownerId: f.ownerId })).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		await expect(f.controller.fold({ operationId: "foreign" })).rejects.toMatchObject({ code: "invalid_input" });
	});

	test("identity notifications are not authority; committed generation invalidates permanently even after ABA", async () => {
		const f = await fixture({ persisted: true });
		await f.session.notifySessionIdentityChanged();
		const first = await settled(f.controller, f.controller.execute({ text: "! printf 'before-transition\\n'" }));
		const previousFile = f.manager.getSessionFile();
		if (!previousFile) throw new Error("Expected the fixture's owned persisted session");
		await f.manager.ensureOnDisk();
		await f.manager.flush();
		const unobserved = createDesktopOperatorController(f.session, {
			...f.controllerOptions,
			connectionGeneration: "unobserved-aba",
		});
		cleanups.push(async () => {
			unobserved.dispose();
		});
		const previousId = f.session.sessionId;
		const generation = f.session.sessionLifecycle.generation;
		expect(await f.session.newSession()).toBe(true);
		expect(f.session.sessionLifecycle.generation).toBeGreaterThan(generation);
		expect(() => f.controller.getOperation({ operationId: first.operationId })).toThrow(
			expect.objectContaining({ code: "stale_session" }),
		);
		expect(await f.session.switchSession(previousFile)).toBe(true);
		expect(f.session.sessionId).toBe(previousId);
		expect(() => unobserved.execute({ text: "! true" })).toThrow(expect.objectContaining({ code: "stale_session" }));
		expect(() => f.controller.execute({ text: "! true" })).toThrow(
			expect.objectContaining({ code: "stale_session" }),
		);
		expect(() => f.controller.abort({ operationId: first.operationId })).toThrow(
			expect.objectContaining({ code: "stale_session" }),
		);
		await expect(f.controller.fold({})).rejects.toMatchObject({ code: "stale_session" });
	}, 20_000);

	test("failed transition preparation preserves the settled operation and captured generation", async () => {
		const f = await fixture();
		const completed = await settled(f.controller, f.controller.execute({ text: "! printf 'transition-ready\\n'" }));
		expect(completed).toMatchObject({ status: "completed", exitCode: 0 });
		expect(completed.output).toContain("transition-ready");
		expect(f.controller.isBusy()).toBe(false);
		const prepared = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(f.manager, "prepareNewSession").mockImplementation(async () => {
			prepared.resolve();
			await release.promise;
			throw new Error("fixture preparation failure");
		});
		cleanups.push(async () => {
			release.resolve();
		});
		const generation = f.session.sessionLifecycle.generation;
		const transition = f.session.newSession();
		// Observe rejection immediately without starting an async assertion before
		// the held checkpoint. Matchers run only after the preparation is released.
		const outcome = transition.then(
			value => ({ status: "fulfilled" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		try {
			await Promise.race([
				prepared.promise,
				outcome.then(result => {
					throw new Error(`Session transition settled before the preparation checkpoint (${result.status})`);
				}),
			]);
			expect(f.session.sessionLifecycle.transitioning).toBe(true);
			expect(f.controller.isBusy()).toBe(false);
			expect(() => f.controller.execute({ text: "! true" })).toThrow(
				expect.objectContaining({ code: "session_transitioning" }),
			);
			expect(() => f.controller.getOperation({ operationId: completed.operationId })).toThrow(
				expect.objectContaining({ code: "session_transitioning" }),
			);
			expect(() => f.controller.abort({ operationId: completed.operationId })).toThrow(
				expect.objectContaining({ code: "session_transitioning" }),
			);
			await expect(f.controller.fold({})).rejects.toMatchObject({ code: "session_transitioning" });
		} finally {
			release.resolve();
			await outcome;
		}
		const result = await outcome;
		expect(result.status).toBe("rejected");
		if (result.status !== "rejected") throw new Error("Expected genuine session preparation failure");
		expect(result.error).toBeInstanceOf(Error);
		expect(result.error instanceof Error ? result.error.message : "").toBe("fixture preparation failure");
		await waitFor(() => !f.session.sessionLifecycle.transitioning);
		expect(f.session.sessionLifecycle.generation).toBe(generation);
		expect(f.controller.getOperation({ operationId: completed.operationId })).toEqual(completed);
		expect(
			(await settled(f.controller, f.controller.execute({ text: "! printf 'still-current\\n'" }))).output,
		).toContain("still-current");
	}, 20_000);

	test("controller teardown neither releases unsettled SDK work nor publishes success", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<KernelExecuteResult>();
		pythonSeam(async () => {
			entered.resolve();
			return release.promise;
		});
		const f = await fixture();
		const running = f.controller.execute({ text: "$ ignores_cancel_until_released()" });
		await entered.promise;
		f.controller.dispose();
		expect(f.controller.isBusy()).toBe(true);
		expect(() => f.controller.getOperation({ operationId: running.operationId })).toThrow(
			expect.objectContaining({ code: "disposed" }),
		);
		const replacement = createDesktopOperatorController(f.session, {
			...f.controllerOptions,
			connectionGeneration: "replacement",
		});
		try {
			expect(replacement.isBusy()).toBe(true);
			expect(() => replacement.execute({ text: "! true" })).toThrow(expect.objectContaining({ code: "busy" }));
			expect(f.events.every(event => event.operation.status === "running")).toBe(true);
			release.resolve(OK);
			await waitFor(() => !replacement.isBusy());
			expect(f.session.isEvalRunning).toBe(false);
			expect(f.controller.isBusy()).toBe(false);
			expect(f.events.every(event => event.operation.status === "running")).toBe(true);
			expect(
				(await settled(replacement, replacement.execute({ text: "! printf 'new-owner\\n'" }))).output,
			).toContain("new-owner");
		} finally {
			release.resolve(OK);
			replacement.dispose();
		}
	}, 20_000);

	test("session disposal authority fences controls immediately, before cleanup settles", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.session.registerToolSessionCleanup(async () => {
			entered.resolve();
			await release.promise;
		});
		const disposal = f.session.dispose();
		await entered.promise;
		expect(f.session.sessionLifecycle.disposed).toBe(true);
		expect(() => f.controller.execute({ text: "! true" })).toThrow(expect.objectContaining({ code: "disposed" }));
		await expect(f.controller.fold({})).rejects.toMatchObject({ code: "disposed" });
		release.resolve();
		await disposal;
	});

	test("fold uses the actual managed foreground BashTool and leaves its owned command running", async () => {
		const f = await fixture();
		const toolSession: ToolSession = {
			cwd: f.directory,
			hasUI: false,
			settings: f.settings,
			getSessionFile: () => null,
			getSessionId: () => f.session.sessionId,
			getSessionSpawns: () => "*",
			getAgentId: () => f.ownerId,
			getAsyncJobManager: () => f.jobs,
			registerForegroundFoldParticipant: adapter => f.session.registerForegroundFoldParticipant(adapter),
		};
		const tool = new BashTool(toolSession);
		const foreground = tool.execute("operator-fold-tool", {
			command: "printf 'before-fold\\n'; sleep 0.5; printf 'after-fold\\n'",
			timeout: 10,
		});
		await waitFor(() => f.session.hasForegroundBashBackgroundRequestHandler());
		expect(await f.controller.fold({})).toEqual({ target: "current_foreground_tool", status: "folded" });
		const result = await foreground;
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("The real managed BashTool did not return its job identity");
		const job = f.jobs.getJob(jobId);
		expect(job?.ownerId).toBe(f.ownerId);
		expect(job?.metadata?.foldReason).toBe("sdk_control");
		expect(job?.status).toBe("running");
		await job?.promise;
		expect(f.jobs.getJob(jobId)?.status).toBe("completed");
		expect(f.jobs.readOutputSince(jobId, 0, { ownerId: f.ownerId })?.text).toContain("after-fold");
	}, 20_000);
});
