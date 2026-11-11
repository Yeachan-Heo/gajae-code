import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import {
	type CreateAgentSessionResult,
	createAgentSession,
	type ExtensionFactory,
	ExtensionInteractionService,
	initializeExtensions,
	JobObservation,
	Settings,
} from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async/job-manager";
import { BROKER_RUNTIME_REVISE_CAPABILITY_FIELD } from "../src/sdk/host/control/runtime-gate";

async function fixture(extensions: ExtensionFactory[] = [], parentTaskPrefix?: string) {
	const temp = TempDir.createSync("@gjc-sdk-portable-");
	const priorManager = AsyncJobManager.instance();
	let auth: AuthStorage | undefined;
	let result: CreateAgentSessionResult | undefined;
	let interaction: ExtensionInteractionService | undefined;
	const dispose = async () => {
		try {
			// Host-owned shutdown ordering: late session cleanup cannot unblock shutdown handlers.
			interaction?.dispose();
			await result?.session.dispose();
		} finally {
			AsyncJobManager.setInstance(priorManager);
			auth?.close();
			temp.removeSync();
		}
	};
	try {
		auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
		const owner = `portable-owner-${crypto.randomUUID()}`;
		result = await createAgentSession({
			cwd: temp.path(),
			agentDir: temp.path(),
			authStorage: auth,
			modelRegistry: new ModelRegistry(auth, path.join(temp.path(), "models.yml")),
			settings: Settings.isolated({
				"bash.autoBackground.enabled": false,
			}),
			agentId: owner,
			parentTaskPrefix,
			agentRegistry: new AgentRegistry(),
			sessionManager: SessionManager.inMemory(temp.path()),
			disableExtensionDiscovery: true,
			extensions,
			toolNames: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: temp.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			deferOptionalModelRefresh: true,
		});
		interaction = new ExtensionInteractionService(result.session.sessionManager.getSessionId());
		const bridge = interaction;
		result.session.registerToolSessionCleanup(() => bridge.dispose());
		return { result, owner, interaction, dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}

function pendingMonitor(manager: AsyncJobManager, ownerId: string) {
	const id = manager.register(
		"bash",
		"portable fixture",
		({ signal }) => {
			const completion = Promise.withResolvers<string>();
			if (signal.aborted) completion.resolve("cancelled");
			else signal.addEventListener("abort", () => completion.resolve("cancelled"), { once: true });
			return completion.promise;
		},
		{ ownerId, metadata: { monitor: true } },
	);
	// Suppress completion delivery before any cancellation can settle the pending fixture.
	manager.acknowledgeDeliveries([id]);
	return { id, generation: manager.getJob(id)!.generation };
}

describe("portable services through the real SDK factory", () => {
	it("wires real noninteractive message, transcript, SDK and command actions before session start", async () => {
		const runtimeErrors: unknown[] = [];
		let transcriptText: string | undefined;
		let controlResult: unknown;
		let deniedLifecycle: unknown;
		let commandResult: unknown;
		const messagePersisted = Promise.withResolvers<void>();
		const extension: ExtensionFactory = api => {
			api.on("session_start", async (_event, ctx) => {
				api.appendEntry("headless-start", { initialized: true });
				api.sendMessage({
					customType: "headless-message",
					content: "headless message",
					display: false,
					attribution: "agent",
				});
				const transcript = ctx.getTranscript();
				const user = transcript.find(entry => entry.role === "user");
				if (user) transcriptText = ctx.getTranscriptBody(user.id);
				controlResult = await ctx.sdkControl?.("permission_mode.set", { mode: "deny" });
				try {
					await ctx.sdkControl?.("session.new", {});
				} catch (error) {
					deniedLifecycle = error;
				}
			});
			api.registerCommand("headless-probe", {
				description: "Exercise initialized command context without provider work",
				handler: async (_args, ctx) => {
					await ctx.waitForIdle();
					commandResult = await ctx.sdkControl?.("permission_mode.set", { mode: "prompt" });
					api.appendEntry("headless-command", { completed: true });
				},
			});
		};
		const env = await fixture([extension]);
		const { session } = env.result;
		const manager = session.sessionManager;
		manager.appendMessage({ role: "user", content: "persisted before headless initialization", timestamp: 1 });
		const unsubscribe = session.subscribe(event => {
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "headless-message"
			)
				messagePersisted.resolve();
		});
		try {
			await initializeExtensions(session, {
				reportSendError: (_action, error) => runtimeErrors.push(error),
				reportRuntimeError: error => runtimeErrors.push(error),
			});
			await Promise.race([messagePersisted.promise, Bun.sleep(1000)]);
			expect(runtimeErrors).toEqual([]);
			expect(transcriptText).toContain("persisted before headless initialization");
			expect(controlResult).toEqual({ changed: true, mode: "deny" });
			expect(session.sdkPermissionMode).toBe("deny");
			expect(deniedLifecycle).toMatchObject({ code: "operation_prohibited" });
			expect(manager.getEntries()).toContainEqual(
				expect.objectContaining({ type: "custom", customType: "headless-start", data: { initialized: true } }),
			);
			expect(session.messages).toContainEqual(
				expect.objectContaining({ role: "custom", customType: "headless-message", content: "headless message" }),
			);
			await session.prompt("/headless-probe");
			expect(commandResult).toEqual({ changed: true, mode: "prompt" });
			expect(session.sdkPermissionMode).toBe("prompt");
			expect(manager.getEntries()).toContainEqual(
				expect.objectContaining({ type: "custom", customType: "headless-command", data: { completed: true } }),
			);
			expect(session.isStreaming).toBe(false);
			expect(runtimeErrors).toEqual([]);
		} finally {
			unsubscribe();
			await env.dispose();
		}
	});
	it("routes process-bound Broker revision selection through the real initialized context", async () => {
		if (process.env.GJC_HEADLESS_REVISION_PROBE !== "1") {
			const child = Bun.spawn(
				[
					process.execPath,
					"test",
					import.meta.path,
					"--test-name-pattern",
					"routes process-bound Broker revision selection",
				],
				{
					env: {
						...process.env,
						GJC_HEADLESS_REVISION_PROBE: "1",
						GJC_LIFECYCLE_REQUEST_ID: "headless-selection-private-authority",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
			if (code !== 0) throw new Error(stdout + stderr);
			return;
		}
		let selection: unknown;
		let untrusted: unknown;
		let originalUser = "";
		const errors: unknown[] = [];
		const env = await fixture([
			api => {
				api.on("session_start", async (_event, ctx) => {
					const request = { sessionId: env.result.session.sessionId, entryId: originalUser, action: "select" };
					try {
						await ctx.sdkControl?.("session.revise", request);
					} catch (error) {
						untrusted = error;
					}
					selection = await ctx.sdkControl?.("session.revise", {
						...request,
						[BROKER_RUNTIME_REVISE_CAPABILITY_FIELD]: process.env.GJC_LIFECYCLE_REQUEST_ID,
					});
				});
			},
		]);
		const { session } = env.result;
		const manager = session.sessionManager;
		originalUser = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		const assistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "retained answer" }],
			api: "openai-responses",
			provider: "openai",
			model: "fixture",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 2,
		};
		const originalLeaf = manager.appendMessage(assistant);
		manager.resetLeaf();
		manager.appendMessage({ role: "user", content: "replacement", timestamp: 3 });
		manager.appendMessage({ ...assistant, timestamp: 4 });
		session.agent.replaceMessages(manager.buildSessionContext().messages);
		const entries = manager.getEntries();
		try {
			await initializeExtensions(session, {
				reportSendError: (_action, error) => errors.push(error),
				reportRuntimeError: error => errors.push(error),
			});
			expect(errors).toEqual([]);
			expect(untrusted).toMatchObject({ code: "operation_prohibited" });
			expect(selection).toEqual({
				selected: true,
				status: "selected",
				sessionId: session.sessionId,
				entryId: originalUser,
				leafEntryId: originalLeaf,
			});
			expect(manager.getLeafId()).toBe(originalLeaf);
			expect(manager.getEntries()).toEqual(entries);
			expect(session.messages).toContainEqual(expect.objectContaining({ role: "user", content: "original" }));
			expect(session.isStreaming).toBe(false);
		} finally {
			await env.dispose();
		}
	});

	it("initializes extension context separately from tool UI and validates portable replies", async () => {
		const ready = Promise.withResolvers<void>();
		let answer: string | undefined;
		let contextCwd: string | undefined;
		let contextHasUI: boolean | undefined;
		const extension: ExtensionFactory = api => {
			api.on("session_start", async (_event, ctx) => {
				contextCwd = ctx.cwd;
				contextHasUI = ctx.hasUI;
				const pending = ctx.ui.input("Embedding label");
				ready.resolve();
				answer = await pending;
			});
		};
		const env = await fixture([extension]);
		const { session } = env.result;
		const { interaction } = env;
		let initialization: Promise<void> | undefined;
		try {
			const { connectionId } = interaction.connect();
			env.result.setToolUIContext(interaction.ui, true);
			expect(contextCwd).toBeUndefined();
			const errors: unknown[] = [];
			initialization = initializeExtensions(session, {
				uiContext: interaction.ui,
				reportSendError: (_action, error) => errors.push(error),
				reportRuntimeError: error => errors.push(error),
			});
			await Promise.race([ready.promise, initialization]);
			expect(contextCwd).toBe(session.sessionManager.getCwd());
			expect(contextHasUI).toBe(true);
			const [request] = interaction.snapshot().pending;
			expect(request?.payload).toEqual({ kind: "input", title: "Embedding label", placeholder: undefined });
			const address = { sessionId: request!.sessionId, requestId: request!.requestId, connectionId };
			expect(() => interaction.respond(address, true)).toThrow(expect.objectContaining({ code: "invalid-result" }));
			expect(interaction.snapshot().pending).toHaveLength(1);
			expect(interaction.respond(address, "portable response")).toEqual({ grantsExecutionPermission: false });
			await initialization;
			expect(answer).toBe("portable response");
			expect(errors).toEqual([]);
			const pending = interaction.ui.input("Cancelled before session shutdown");
			interaction.dispose();
			await session.dispose();
			expect(await pending).toBeUndefined();
			expect(interaction.snapshot().disposed).toBe(true);
		} finally {
			interaction.dispose();
			try {
				await initialization;
			} finally {
				await env.dispose();
			}
		}
	});

	it("disposes portable UI before real shutdown handlers without waiting for renderer replies", async () => {
		const shutdownErrors: unknown[] = [];
		const runtimeErrors: unknown[] = [];
		let shutdownFinished = false;
		const extension: ExtensionFactory = api => {
			api.on("session_shutdown", async (_event, ctx) => {
				for (const request of [
					() => ctx.ui.confirm("Shutdown", "Continue?"),
					() => ctx.ui.input("Shutdown note"),
				]) {
					try {
						await request();
					} catch (error) {
						shutdownErrors.push(error);
					}
				}
				shutdownFinished = true;
			});
		};
		const env = await fixture([extension]);
		const { interaction, result } = env;
		try {
			const { connectionId } = interaction.connect();
			result.setToolUIContext(interaction.ui, true);
			await initializeExtensions(result.session, {
				uiContext: interaction.ui,
				reportSendError: (_action, error) => runtimeErrors.push(error),
				reportRuntimeError: error => runtimeErrors.push(error),
			});
			const pendingInput = interaction.ui.input("Pending before shutdown");
			const pendingConfirm = interaction.ui.confirm("Pending confirmation", "Continue?");
			interaction.disconnect(connectionId);
			interaction.dispose();
			await result.session.dispose();
			expect(await pendingInput).toBeUndefined();
			expect(await pendingConfirm).toBe(false);
			expect(shutdownFinished).toBe(true);
			expect(shutdownErrors).toEqual([
				expect.objectContaining({ code: "disposed" }),
				expect.objectContaining({ code: "disposed" }),
			]);
			expect(runtimeErrors).toEqual([]);
			expect(interaction.snapshot()).toMatchObject({ disposed: true, connected: false, pending: [] });
		} finally {
			await env.dispose();
		}
	});

	it("captures the trusted agent owner and disposes the stable lazy view with its session", async () => {
		const env = await fixture();
		try {
			const { session } = env.result;
			const sessionId = session.sessionManager.getSessionId();
			expect(sessionId).not.toBe(env.owner);
			const manager = AsyncJobManager.forEndpoint(sessionId)!;
			expect(manager).toBeDefined();
			const owned = pendingMonitor(manager, env.owner);
			const foreign = pendingMonitor(manager, "foreign-owner");
			const sessionScoped = pendingMonitor(manager, sessionId);
			const subscribe = spyOn(manager, "onChange");
			let view: JobObservation;
			try {
				expect(subscribe).not.toHaveBeenCalled();
				view = env.result.jobObservation!;
				expect(view).toBeInstanceOf(JobObservation);
				expect(env.result.jobObservation).toBe(view);
				expect(subscribe).toHaveBeenCalledTimes(1);
			} finally {
				subscribe.mockRestore();
			}
			expect(view.getSnapshot().jobs.map(job => job.id)).toEqual([owned.id]);
			for (const target of [foreign, sessionScoped]) {
				expect(() => view.getMonitorOutput(target)).toThrow(expect.objectContaining({ code: "not_found" }));
				expect(() => view.cancelMonitor(target)).toThrow(expect.objectContaining({ code: "not_found" }));
			}
			manager.appendOutput(owned.id, "owned output");
			expect(view.getMonitorOutput(owned)).toBe("owned output");
			await session.dispose();
			expect(env.result.jobObservation).toBe(view);
			expect(() => view.getSnapshot()).toThrow(expect.objectContaining({ code: "disposed" }));
			expect(AsyncJobManager.forEndpoint(sessionId)).toBeUndefined();
		} finally {
			await env.dispose();
		}
	});

	it("never constructs a view after disposal or replaces a manually disposed view", async () => {
		for (const accessBeforeDisposal of [false, true]) {
			const env = await fixture();
			try {
				const view = accessBeforeDisposal ? env.result.jobObservation : undefined;
				if (view) {
					view.dispose();
					expect(env.result.jobObservation).toBe(view);
					expect(() => view.getSnapshot()).toThrow(expect.objectContaining({ code: "disposed" }));
				}
				await env.result.session.dispose();
				expect(env.result.jobObservation).toBe(view);
			} finally {
				await env.dispose();
			}
		}
	});

	it("does not borrow the global manager for a child without an inherited manager", async () => {
		const env = await fixture([], "isolated-child");
		const globalManager = new AsyncJobManager({ onJobComplete: () => {} });
		try {
			AsyncJobManager.setInstance(globalManager);
			expect(env.result.jobObservation).toBeUndefined();
			await env.result.session.dispose();
			expect(env.result.jobObservation).toBeUndefined();
		} finally {
			await globalManager.dispose();
			await env.dispose();
		}
	});
});
