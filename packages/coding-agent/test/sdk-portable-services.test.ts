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
