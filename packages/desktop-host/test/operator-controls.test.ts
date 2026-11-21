import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createAgentSession, Settings } from "@gajae-code/coding-agent/sdk";
import {
	createDesktopOperatorController,
	DESKTOP_OPERATOR_LIMITS,
	type DesktopOperatorController,
	type DesktopOperatorOptions,
} from "../src/operator-controls";
import type { DesktopOperatorEvent, DesktopOperatorOperation } from "../src/operator-protocol";
import { createDesktopStreamRedactor } from "../src/stream-redactor";

const cleanups: Array<() => void | Promise<void>> = [];
const secret = "operator-private-token";
afterEach(async () => {
	const failures: unknown[] = [];
	while (cleanups.length) {
		try {
			await cleanups.pop()?.();
		} catch (error) {
			failures.push(error);
		}
	}
	vi.restoreAllMocks();
	if (failures.length) throw new AggregateError(failures, "Operator fixture cleanup failed");
});

/** Factory-owned session and real SDK controls; no internal runtime constructors/imports. */
async function fixture(options: Partial<DesktopOperatorOptions> = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-operator-sdk-"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"bash.autoBackground.enabled": false,
		"async.enabled": false,
		shellPath: "/bin/sh",
	});
	const created = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		settings,
		model: createMockModel(),
		agentId: `operator-${crypto.randomUUID()}`,
		systemPrompt: [],
		toolNames: [],
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: directory, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		enableMcpAutoload: false,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
		deferModelProfileActivation: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
	});
	const events: DesktopOperatorEvent[] = [];
	const controllerOptions: DesktopOperatorOptions = {
		connectionGeneration: crypto.randomUUID(),
		redact: text => text.replaceAll(secret, "[redacted]"),
		emit: event => {
			events.push(structuredClone(event));
		},
		...options,
	};
	const controller = createDesktopOperatorController(created.session, controllerOptions);
	cleanups.push(async () => {
		controller.dispose();
		try {
			await created.session.dispose();
			await created.session.awaitDisposeCompletion();
		} finally {
			await settings.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	return { session: created.session, controller, events, controllerOptions };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Operator did not settle");
		await Bun.sleep(10);
	}
}

async function settled(
	controller: DesktopOperatorController,
	operation: DesktopOperatorOperation,
): Promise<DesktopOperatorOperation> {
	await waitFor(
		() =>
			!["running", "cancel_requested"].includes(
				controller.getOperation({ operationId: operation.operationId }).status,
			),
	);
	return controller.getOperation({ operationId: operation.operationId });
}

function result(output = "", cancelled = false) {
	const lines = output ? output.split("\n").length : 0;
	const bytes = new TextEncoder().encode(output).byteLength;
	return {
		output,
		cancelled,
		truncated: false,
		exitCode: cancelled ? undefined : 0,
		totalLines: lines,
		totalBytes: bytes,
		outputLines: lines,
		outputBytes: bytes,
		displayOutputs: [],
		stdinRequested: false,
	};
}

describe("desktop public SDK operator projection", () => {
	test("real Bash SDK execution preserves prefixes, context flags, nonzero exits and event settlement", async () => {
		const f = await fixture();
		const included = f.controller.execute({ text: "! printf 'included\\n'" });
		expect(included).toMatchObject({ kind: "bash", status: "running", excludeFromContext: false, output: "" });
		const first = await settled(f.controller, included);
		expect(first).toMatchObject({ status: "completed", exitCode: 0, output: "included\n" });
		const excluded = await settled(f.controller, f.controller.execute({ text: "!! printf 'excluded\\n'; exit 7" }));
		expect(excluded).toMatchObject({
			status: "completed",
			exitCode: 7,
			excludeFromContext: true,
			output: "excluded\n",
		});
		expect(f.session.agent.state.messages.filter(message => message.role === "bashExecution")).toMatchObject([
			{ command: "printf 'included\\n'", excludeFromContext: false },
			{ command: "printf 'excluded\\n'; exit 7", excludeFromContext: true },
		]);
		await waitFor(() =>
			f.events.some(
				event => event.operation.operationId === excluded.operationId && event.operation.status === "completed",
			),
		);
		first.output = "client mutation";
		expect(f.controller.getOperation({ operationId: included.operationId }).output).toBe("included\n");
	}, 20_000);

	test("SDK cancellation reaches real Bash and admission is shared across controllers", async () => {
		const f = await fixture({ createStreamRedactor: () => createDesktopStreamRedactor([secret], text => text) });
		const running = f.controller.execute({
			text: "! printf 'ready-with-long-public-output-line\\n'; sleep 30; printf 'must-not-finish\\n'",
		});
		await waitFor(() => f.events.some(event => event.operation.output.includes("ready")));
		const replacement = createDesktopOperatorController(f.session, {
			...f.controllerOptions,
			connectionGeneration: "second",
		});
		cleanups.push(() => replacement.dispose());
		expect(replacement.isBusy()).toBe(true);
		expect(() => replacement.execute({ text: "! true" })).toThrow(expect.objectContaining({ code: "busy" }));
		expect(() => replacement.abort({ operationId: running.operationId })).toThrow(
			expect.objectContaining({ code: "not_found" }),
		);
		expect(f.controller.abort({ operationId: running.operationId }).status).toBe("cancel_requested");
		const done = await settled(f.controller, running);
		expect(done.status).toBe("cancelled");
		expect(done.output).not.toContain("must-not-finish");
		expect(f.controller.isBusy()).toBe(false);
		expect(replacement.isBusy()).toBe(false);
		expect(() => f.controller.abort({ operationId: running.operationId })).toThrow(
			expect.objectContaining({ code: "already_terminal" }),
		);
	}, 20_000);

	test("Python mapping delegates to SDK admission, context flags and operation-owned abort signal", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<AbortSignal | undefined>();
		const release = Promise.withResolvers<void>();
		cleanups.push(() => release.resolve());
		const execute = vi.spyOn(f.session, "executePython").mockImplementation(async (_source, onChunk, options) => {
			const signal = options?.signal;
			onChunk?.("python-output");
			entered.resolve(signal);
			await release.promise;
			return result("python-output", signal?.aborted);
		});
		const mainAbort = vi.spyOn(f.session, "abort");
		const running = f.controller.execute({ text: "$$ print('python')" });
		// Keep the executor's actual signal; spy call metadata need not preserve native object state.
		const signal = await entered.promise;
		if (!signal) throw new Error("SDK Python admission did not supply its operation-owned abort signal");
		const aborted = vi.fn();
		signal.addEventListener("abort", aborted, { once: true });
		expect(signal.aborted).toBe(false);
		expect(execute.mock.calls[0]?.[0]).toBe("print('python')");
		expect(execute.mock.calls[0]?.[2]).toMatchObject({ excludeFromContext: true, signal: expect.any(AbortSignal) });
		expect(f.controller.getOperation({ operationId: running.operationId })).toMatchObject({
			kind: "python",
			output: "",
			liveOutput: "withheld",
		});
		expect(f.controller.abort({ operationId: running.operationId }).status).toBe("cancel_requested");
		expect(signal.aborted).toBe(true);
		expect(aborted).toHaveBeenCalledTimes(1);
		expect(f.controller.getOperation({ operationId: running.operationId }).status).toBe("cancel_requested");
		expect(mainAbort).not.toHaveBeenCalled();
		expect(f.controller.isBusy()).toBe(true);
		release.resolve();
		expect((await settled(f.controller, running)).status).toBe("cancelled");
	});

	test("teardown cannot release an unsettled SDK execution or publish terminal success", async () => {
		const f = await fixture();
		const release = Promise.withResolvers<void>();
		cleanups.push(() => release.resolve());
		vi.spyOn(f.session, "executePython").mockImplementation(async () => {
			await release.promise;
			return result("private");
		});
		const running = f.controller.execute({ text: "$ held()" });
		f.controller.dispose();
		const replacement = createDesktopOperatorController(f.session, {
			...f.controllerOptions,
			connectionGeneration: "replacement",
		});
		cleanups.push(() => replacement.dispose());
		expect(replacement.isBusy()).toBe(true);
		expect(() => replacement.execute({ text: "! true" })).toThrow(expect.objectContaining({ code: "busy" }));
		expect(() => f.controller.getOperation({ operationId: running.operationId })).toThrow(
			expect.objectContaining({ code: "disposed" }),
		);
		release.resolve();
		await waitFor(() => !replacement.isBusy());
		expect(f.events.every(event => event.operation.status === "running")).toBe(true);
		expect((await settled(replacement, replacement.execute({ text: "! printf 'new-owner'" }))).output).toBe(
			"new-owner",
		);
	});

	test("host overlay redacts split SDK deltas and independently replays final output", async () => {
		const f = await fixture({
			redact: text => text,
			createStreamRedactor: () => createDesktopStreamRedactor([secret], text => text),
		});
		const release = Promise.withResolvers<void>();
		cleanups.push(() => release.resolve());
		vi.spyOn(f.session, "executePython").mockImplementation(async (_source, chunk) => {
			chunk?.("public-prefix operator-private-");
			chunk?.("token public-suffix");
			await release.promise;
			return result("final operator-private-\x1b[31mtokenEND\x1b[0m");
		});
		const running = f.controller.execute({ text: "$ private_code()" });
		const live = f.controller.getOperation({ operationId: running.operationId });
		expect(live.output).toContain("public-prefix");
		expect(live.output).not.toContain("operator-private-");
		release.resolve();
		const done = await settled(f.controller, running);
		expect(done.output).toBe("final [redacted]END");
		expect(JSON.stringify(f.events)).not.toContain(secret);
		expect(JSON.stringify(f.events)).not.toContain("private_code()");
	});

	for (const [name, first, second] of [
		["CSI", "alpha-\x1b[3", "1msecret"],
		["OSC BEL", "alpha-\x1b]private title", "\x07secret"],
		["OSC ST", "alpha-\x1b]private title\x1b", "\\secret"],
		["C0", "alpha-\x00", "\x08\rsecret"],
	] as const) {
		test(`normalizes split ${name} before masking live events and final SDK snapshots`, async () => {
			const key = "alpha-secret";
			const f = await fixture({
				redact: text => text.replaceAll(key, "[redacted]"),
				createStreamRedactor: () => createDesktopStreamRedactor([key], text => text),
			});
			const next = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			cleanups.push(() => {
				next.resolve();
				release.resolve();
			});
			const prefix = "visible prefix\n\t";
			const suffix = "\nvisible suffix that releases overlap\n";
			vi.spyOn(f.session, "executePython").mockImplementation(async (_source, chunk) => {
				chunk?.(prefix + first);
				await next.promise;
				chunk?.(second + suffix);
				await release.promise;
				return result(prefix + first + second + suffix);
			});
			const running = f.controller.execute({ text: "$ normalized_output()" });
			await waitFor(() => f.events.some(event => event.operation.output.includes("visible")));
			expect(f.controller.getOperation({ operationId: running.operationId }).status).toBe("running");
			next.resolve();
			await waitFor(() => f.events.some(event => event.operation.output.includes("[redacted]")));
			const live = f.controller.getOperation({ operationId: running.operationId });
			expect(live).toMatchObject({ status: "running", liveOutput: "redacted" });
			expect(live.output).toContain(`${prefix}[redacted]`);
			release.resolve();
			const done = await settled(f.controller, running);
			expect(done).toMatchObject({ status: "completed", exitCode: 0, output: `${prefix}[redacted]${suffix}` });
			await waitFor(() => f.events.some(event => event.operation.status === "completed"));
			for (const dto of [done, live, ...f.events.map(event => event.operation)]) {
				expect(dto.output).not.toContain(key);
				expect(dto.output).not.toContain("alpha-");
				expect(dto.output).not.toContain("secret");
				expect(dto.output).not.toContain("private title");
				expect(dto.output).not.toContain("\x1b");
			}
		});
	}

	test("normalizes final snapshots before the whole-text redactor when live output is withheld", async () => {
		const f = await fixture({ redact: text => text.replaceAll("alpha-secret", "[redacted]") });
		const execute = vi
			.spyOn(f.session, "executePython")
			.mockResolvedValue(result("alpha-\x1b[31msecret alpha-\x1b]title\x07secret alpha-\x00secret\n"));
		const done = await settled(f.controller, f.controller.execute({ text: "$ final_only()" }));
		expect(done).toMatchObject({ status: "completed", output: "[redacted] [redacted] [redacted]\n" });
		execute.mockResolvedValue(result("alpha-\x1b]unfinished"));
		expect(await settled(f.controller, f.controller.execute({ text: "$ incomplete_final()" }))).toMatchObject({
			status: "failed",
			output: "",
			liveOutput: "withheld",
			error: { code: "redaction_failed" },
		});
		expect(JSON.stringify(f.events)).not.toContain("alpha-");
	});

	test("whole-text-only redaction preserves raw and normalized evidence until actual SDK settlement", async () => {
		const key = "31mvery-private-sdk-credential";
		const keys = [key, "alpha-secret", "abc", "cdef", "defg"];
		const f = await fixture({
			redact: text => {
				for (const literal of keys) text = text.replaceAll(literal, "[redacted]");
				return text;
			},
		});
		const execute = vi.spyOn(f.session, "executePython");
		for (const [raw, expected] of [
			[`\x1b[${key}`, "[redacted]"],
			[`\x1b[${key} alpha-\x1b[0msecret`, "[redacted]"],
			["abc\x1b[31mdefg", "[redacted]"],
			["alpha-\x1b[31msecret", "[redacted]"],
			["\x1b[31mpublic\x1b[0m\n\toutput", "public\n\toutput"],
		] as const) {
			const release = Promise.withResolvers<void>();
			cleanups.push(() => release.resolve());
			execute.mockImplementation(async (_source, chunk) => {
				chunk?.(raw);
				await release.promise;
				return result(raw);
			});
			const running = f.controller.execute({ text: "$ raw_and_normalized_final()" });
			expect(f.controller.getOperation({ operationId: running.operationId })).toMatchObject({
				status: "running",
				output: "",
				liveOutput: "withheld",
			});
			expect(f.controller.isBusy()).toBe(true);
			release.resolve();
			expect(await settled(f.controller, running)).toMatchObject({
				status: "completed",
				exitCode: 0,
				output: expected,
			});
			expect(f.controller.isBusy()).toBe(false);
		}
		expect(JSON.stringify(f.events)).not.toContain("very-private-sdk-");
		expect(JSON.stringify(f.events)).not.toContain("alpha-");
		expect(JSON.stringify(f.events)).not.toContain("defg");
	});

	test("raw credentials crossing stripped controls fail closed without settling the SDK early", async () => {
		const key = "31mvery-private-sdk-credential";
		const f = await fixture({
			redact: text => text.replaceAll(key, "[redacted]"),
			createStreamRedactor: () => createDesktopStreamRedactor([key], text => text),
		});
		const next = Promise.withResolvers<void>();
		const received = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		cleanups.push(() => {
			next.resolve();
			release.resolve();
		});
		vi.spyOn(f.session, "executePython").mockImplementation(async (_source, chunk) => {
			chunk?.("\x1b[31mvery-private-sdk-");
			await next.promise;
			chunk?.("credential");
			received.resolve();
			await release.promise;
			return result(`\x1b[${key}`);
		});
		const running = f.controller.execute({ text: "$ raw_boundary()" });
		expect(f.controller.getOperation({ operationId: running.operationId })).toMatchObject({
			status: "running",
			output: "",
		});
		next.resolve();
		await received.promise;
		expect(f.controller.getOperation({ operationId: running.operationId })).toMatchObject({
			status: "running",
			output: "",
			liveOutput: "withheld",
		});
		expect(f.controller.isBusy()).toBe(true);
		release.resolve();
		expect(await settled(f.controller, running)).toMatchObject({
			status: "failed",
			output: "",
			liveOutput: "withheld",
			error: { code: "redaction_failed" },
		});
		expect(f.controller.isBusy()).toBe(false);
		expect(JSON.stringify(f.events)).not.toContain("very-private-sdk-");
	});

	test("unfinished and overlong controls cannot turn native completion into public success", async () => {
		const f = await fixture({
			redact: text => text.replaceAll("alpha-secret", "[redacted]"),
			createStreamRedactor: () => createDesktopStreamRedactor(["alpha-secret"], text => text),
		});
		const execute = vi.spyOn(f.session, "executePython");
		for (const control of ["\x1b[31", `\x1b]${"x".repeat(4_096)}`, "\x1b[1 2m"]) {
			const release = Promise.withResolvers<void>();
			cleanups.push(() => release.resolve());
			execute.mockImplementation(async (_source, chunk) => {
				chunk?.(`alpha-${control}`);
				await release.promise;
				return result(`alpha-${control}`);
			});
			const running = f.controller.execute({ text: "$ unsafe_controls()" });
			expect(f.controller.getOperation({ operationId: running.operationId }).status).toBe("running");
			expect(f.controller.isBusy()).toBe(true);
			release.resolve();
			expect(await settled(f.controller, running)).toMatchObject({
				status: "failed",
				output: "",
				liveOutput: "withheld",
				error: { code: "redaction_failed" },
			});
			expect(f.controller.isBusy()).toBe(false);
		}
		expect(JSON.stringify(f.events)).not.toContain("alpha-");
	});

	test("SDK-truncated raw output is withheld without changing execution status", async () => {
		const f = await fixture({ createStreamRedactor: () => createDesktopStreamRedactor([secret], text => text) });
		vi.spyOn(f.session, "executePython").mockImplementation(async (_source, chunk) => {
			const output = `${"x".repeat(DESKTOP_OPERATOR_LIMITS.outputChars)}${secret}`;
			chunk?.(output);
			return { ...result(output), truncated: true };
		});
		const done = await settled(f.controller, f.controller.execute({ text: "$ huge_output()" }));
		expect(done).toMatchObject({
			status: "completed",
			exitCode: 0,
			output: "",
			outputTruncated: true,
			liveOutput: "withheld",
		});
		expect(JSON.stringify(f.events)).not.toContain(secret);
	});

	test("lost SDK delta cursors withhold live text and still recover terminal snapshots", async () => {
		const f = await fixture({ createStreamRedactor: () => createDesktopStreamRedactor([secret], text => text) });
		const release = Promise.withResolvers<void>();
		cleanups.push(() => release.resolve());
		vi.spyOn(f.session, "executePython").mockImplementation(async (_source, chunk) => {
			for (let index = 0; index < 200; index++) chunk?.("x");
			await release.promise;
			return result("authoritative final");
		});
		const running = f.controller.execute({ text: "$ callbacks()" });
		expect(f.controller.getOperation({ operationId: running.operationId })).toMatchObject({
			status: "running",
			output: "",
			liveOutput: "withheld",
		});
		release.resolve();
		expect((await settled(f.controller, running)).output).toBe("authoritative final");
	});

	test("stream policy failures withhold content but cannot claim executor settlement", async () => {
		const f = await fixture({
			createStreamRedactor: () => ({
				push() {
					throw new Error(secret);
				},
				finish: () => "",
			}),
		});
		const release = Promise.withResolvers<void>();
		cleanups.push(() => release.resolve());
		vi.spyOn(f.session, "executePython").mockImplementation(async (_source, chunk) => {
			chunk?.(secret);
			await release.promise;
			return result(secret);
		});
		const running = f.controller.execute({ text: "$ private()" });
		expect(f.controller.getOperation({ operationId: running.operationId })).toMatchObject({
			status: "running",
			output: "",
			liveOutput: "withheld",
		});
		expect(f.controller.isBusy()).toBe(true);
		release.resolve();
		expect(await settled(f.controller, running)).toMatchObject({
			status: "failed",
			output: "",
			error: { code: "redaction_failed" },
		});
		expect(JSON.stringify(f.events)).not.toContain(secret);
	});

	test("strict SDK input validation and static backend errors cross the wire unchanged in meaning", async () => {
		const f = await fixture();
		const getter = vi.fn(() => "! true");
		for (const input of [
			null,
			[],
			{},
			{ text: "plain" },
			{ text: "!" },
			{ text: "! true", extra: 1 },
			{ text: "! x\0" },
			Object.create({ text: "! true" }),
			Object.defineProperty({}, "text", { get: getter }),
			{ text: "! true", [Symbol()]: true },
		]) {
			expect(() => f.controller.execute(input)).toThrow(expect.objectContaining({ code: "invalid_input" }));
		}
		expect(getter).not.toHaveBeenCalled();
		vi.spyOn(f.session, "executePython").mockRejectedValue(new Error(`PRIVATE_PROVIDER ${secret}`));
		const done = await settled(f.controller, f.controller.execute({ text: "$ broken()" }));
		expect(done).toMatchObject({ status: "failed", error: { code: "backend_failure" } });
		expect(JSON.stringify(f.events)).not.toContain("PRIVATE_PROVIDER");
		expect(JSON.stringify(done)).not.toContain(secret);
	});

	test("SDK generation fences old controls after committed session replacement", async () => {
		const f = await fixture();
		const done = await settled(f.controller, f.controller.execute({ text: "! true" }));
		await f.session.newSession();
		expect(() => f.controller.getOperation({ operationId: done.operationId })).toThrow(
			expect.objectContaining({ code: "stale_session" }),
		);
		expect(() => f.controller.execute({ text: "! true" })).toThrow(
			expect.objectContaining({ code: "stale_session" }),
		);
		await expect(f.controller.fold({})).rejects.toMatchObject({ code: "stale_session" });
	});

	test("failed lifecycle preparation leaves SDK operation references current after the transition settles", async () => {
		const f = await fixture();
		const done = await settled(f.controller, f.controller.execute({ text: "! true" }));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(f.session.sessionManager, "prepareNewSession").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			throw new Error("fixture preparation failure");
		});
		cleanups.push(() => release.resolve());
		const generation = f.session.sessionLifecycle.generation;
		const transition = f.session.newSession();
		const outcome = transition.then(
			() => undefined,
			(error: unknown) => error,
		);
		await Promise.race([
			entered.promise,
			outcome.then(() => {
				throw new Error("Transition settled before its preparation checkpoint");
			}),
		]);
		expect(() => f.controller.getOperation({ operationId: done.operationId })).toThrow(
			expect.objectContaining({ code: "session_transitioning" }),
		);
		expect(() => f.controller.execute({ text: "! true" })).toThrow(
			expect.objectContaining({ code: "session_transitioning" }),
		);
		await expect(f.controller.fold({})).rejects.toMatchObject({ code: "session_transitioning" });
		release.resolve();
		expect(await outcome).toBeInstanceOf(Error);
		expect(f.session.sessionLifecycle.generation).toBe(generation);
		expect(f.controller.getOperation({ operationId: done.operationId })).toEqual(done);
	});

	test("fold explicitly delegates to the factory-result foreground control until the SDK exposes it", async () => {
		const f = await fixture();
		const supported = vi.spyOn(f.session, "hasForegroundBashBackgroundRequestHandler").mockReturnValue(false);
		const fold = vi
			.spyOn(f.session, "requestForegroundBashBackgroundOutcome")
			.mockResolvedValue({ status: "folded", jobId: "fixture-folded-job" });
		expect(await f.controller.fold({})).toEqual({ target: "current_foreground_tool", status: "unsupported" });
		expect(fold).not.toHaveBeenCalled();
		supported.mockReturnValue(true);
		expect(await f.controller.fold({})).toEqual({ target: "current_foreground_tool", status: "folded" });
		expect(fold).toHaveBeenCalledWith("sdk_control");
		fold.mockResolvedValue({ status: "already_backgrounded" });
		expect(await f.controller.fold({})).toEqual({
			target: "current_foreground_tool",
			status: "already_backgrounded",
		});
		fold.mockResolvedValue({ status: "no_active_bash" });
		expect(await f.controller.fold({})).toEqual({ target: "current_foreground_tool", status: "unsupported" });
		fold.mockResolvedValue({ status: "not_foldable", reason: "fixture" });
		expect(await f.controller.fold({})).toEqual({ target: "current_foreground_tool", status: "unsupported" });
		fold.mockRejectedValue(new Error(secret));
		await expect(f.controller.fold({})).rejects.toMatchObject({ code: "backend_failure" });
		await expect(f.controller.fold({ extra: true })).rejects.toMatchObject({ code: "invalid_input" });
	});
});
