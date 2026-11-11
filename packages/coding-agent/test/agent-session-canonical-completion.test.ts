import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { type AssistantMessage, type ToolResultMessage, z } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { initializeLocalRoot } from "@gajae-code/coding-agent/internal-urls/local-protocol";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@gajae-code/utils";

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "terminal" }],
		api: "anthropic-messages",
		provider: "github-copilot",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage: "GitHub Copilot authentication failed",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("AgentSession canonical completion", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		try {
			await session?.dispose();
			await session?.modelRegistry.dispose();
		} finally {
			vi.restoreAllMocks();
			authStorage?.close();
			tempDir?.removeSync();
		}
	});

	async function setup(options?: {
		spill?: boolean;
		onAuthRemoval?: () => void;
		streamFn?: Agent["streamFn"];
		tools?: AgentTool[];
		sharedManaged?: boolean;
	}) {
		tempDir = TempDir.createSync("@gjc-canonical-completion-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		if (options?.onAuthRemoval) {
			vi.spyOn(authStorage, "remove").mockImplementation(async () => options.onAuthRemoval?.());
		}
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		if (options?.streamFn) authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: options?.tools ?? [], messages: [] },
			...(options?.streamFn ? { streamFn: options.streamFn, getApiKey: () => "test-key" } : {}),
		});
		const manager = options?.sharedManaged
			? SessionManager.create(tempDir.path(), SessionManager.managedDestination(tempDir.path(), tempDir.path()))
			: SessionManager.inMemory(tempDir.path());
		const settings = Settings.isolated({
			"tools.preAdmissionArtifactSpill": options?.spill ?? false,
			"compaction.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			rootInteractiveSharedAppend: options?.sharedManaged === true,
		});
		if (options?.sharedManaged) {
			// A managed prompt resolves local:// synchronously; settle the real legacy
			// migration gate before entering the accepted-prompt path.
			await initializeLocalRoot({
				getSessionId: () => manager.getSessionId(),
				getArtifactsDir: () => manager.getArtifactsDir(),
				isManagedDestination: () => manager.isManagedDestination(),
				getManagedLegacyLocalMigrationSource: () => manager.getManagedLegacyLocalMigrationSource(),
			});
		}
		return { agent, manager, session };
	}

	it("stops before provider on uncertain shared workflow admission without reappending", async () => {
		let providerCalls = 0;
		const mock = createMockModel({ handler: { content: ["unexpected provider call"] } });
		const { manager, session } = await setup({
			sharedManaged: true,
			streamFn: (...args) => {
				providerCalls++;
				return mock.stream(...args);
			},
		});
		const original = new Error("uncertain workflow publication");
		const attempt = { kind: "unknown" as const, id: "attempted-custom-id", error: original };
		const publication = Promise.withResolvers<typeof attempt>();
		const enteredPublication = Promise.withResolvers<void>();
		const shared = vi.spyOn(manager, "appendCustomEntrySharingSession").mockImplementation(() => {
			enteredPublication.resolve();
			return publication.promise;
		});
		const legacy = vi.spyOn(manager, "appendCustomEntry");
		const prompt = session.prompt("second ordinary user prompt");
		void prompt.catch(() => {});
		let cleanupFailure: unknown;
		try {
			await withTimeout(enteredPublication.promise, 5_000, "Workflow publication was not requested");
			expect(providerCalls).toBe(0);
			publication.resolve(attempt);
			await expect(withTimeout(prompt, 5_000, "Workflow admission did not settle")).rejects.toMatchObject({
				message: expect.stringContaining(attempt.id),
				cause: attempt,
			});
			expect(shared).toHaveBeenCalledTimes(1);
			expect(legacy).not.toHaveBeenCalled();
			expect(providerCalls).toBe(0);
			expect(
				manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "workflow-intent-diff"),
			).toHaveLength(0);
		} finally {
			publication.resolve(attempt);
			try {
				await withTimeout(Promise.allSettled([prompt]), 5_000, "Workflow prompt cleanup did not settle");
			} catch (error) {
				cleanupFailure = error;
			}
		}
		if (cleanupFailure !== undefined) throw cleanupFailure;
	});

	for (const failure of ["stale", "rejected", "acquisition"] as const) {
		it(`does not run or retry a provider after ${failure} workflow publication`, async () => {
			let providerCalls = 0;
			const mock = createMockModel({ handler: { content: ["unexpected provider call"] } });
			const { manager, session } = await setup({
				sharedManaged: true,
				streamFn: (...args) => {
					providerCalls++;
					return mock.stream(...args);
				},
			});
			const original = new Error("original publication failure");
			const append = vi.spyOn(manager, "appendCustomEntrySharingSession");
			if (failure === "stale") append.mockResolvedValue({ kind: "stale", reason: "cursor_not_committed" });
			else if (failure === "rejected") append.mockResolvedValue({ kind: "rejected", error: original });
			else append.mockRejectedValue(original);
			await expect(
				withTimeout(session.prompt("ordinary workflow prompt"), 5_000, "Failure did not settle"),
			).rejects.toMatchObject({
				cause:
					failure === "acquisition"
						? original
						: failure === "stale"
							? { kind: "stale", reason: "cursor_not_committed" }
							: { kind: "rejected", error: original },
			});
			expect(append).toHaveBeenCalledTimes(1);
			expect(providerCalls).toBe(0);
		});
	}

	for (const behavior of ["steer", "followUp"] as const) {
		it(`publishes one busy ${behavior} workflow record before queueing, even when the run becomes idle`, async () => {
			const entered = Promise.withResolvers<void>();
			const releaseTool = Promise.withResolvers<void>();
			const releasePublication = Promise.withResolvers<void>();
			const enteredPublication = Promise.withResolvers<void>();
			const queuedUser = Promise.withResolvers<void>();
			const queuedAssistant = Promise.withResolvers<void>();
			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", id: "held-tool", name: "probe", arguments: {} }] },
					{ content: ["first complete"] },
					{ content: ["queued complete"] },
				],
			});
			const tool: AgentTool = {
				name: "probe",
				label: "Probe",
				description: "Probe",
				parameters: z.object({}),
				execute: async () => {
					entered.resolve();
					await releaseTool.promise;
					return { content: [{ type: "text", text: "ok" }] };
				},
			};
			const { agent, manager, session } = await setup({ sharedManaged: true, streamFn: mock.stream, tools: [tool] });
			const unsubscribe = session.subscribe(event => {
				if (event.type !== "message_end") return;
				if (event.message.role === "user" && JSON.stringify(event.message.content).includes("busy queued input"))
					queuedUser.resolve();
				if (event.message.role === "assistant" && JSON.stringify(event.message.content).includes("queued complete"))
					queuedAssistant.resolve();
			});
			let first: Promise<void> | undefined;
			let queued: Promise<void> | undefined;
			let cleanupFailure: unknown;
			try {
				first = session.prompt("first ordinary prompt");
				void first.catch(() => {});
				await withTimeout(entered.promise, 5_000, "First turn did not enter its tool");
				const original = manager.appendCustomEntrySharingSession.bind(manager);
				const shared = vi.spyOn(manager, "appendCustomEntrySharingSession").mockImplementation(async (...args) => {
					enteredPublication.resolve();
					await releasePublication.promise;
					return original(...args);
				});
				queued = session.prompt("busy queued input", { streamingBehavior: behavior });
				void queued.catch(() => {});
				await withTimeout(enteredPublication.promise, 5_000, "Busy workflow publication was not requested");
				expect(agent.hasQueuedMessages()).toBe(false);
				expect(
					manager
						.getBranch()
						.filter(entry => entry.type === "custom" && entry.customType === "workflow-intent-diff"),
				).toHaveLength(1);
				releaseTool.resolve();
				await withTimeout(first, 5_000, "First turn did not become idle");
				releasePublication.resolve();
				await withTimeout(queued, 5_000, "Busy submission was not accepted");
				await withTimeout(queuedUser.promise, 5_000, "Queued user message was not published");
				await withTimeout(queuedAssistant.promise, 5_000, "Queued assistant did not complete");
				await withTimeout(session.waitForIdle(), 5_000, "Queued turn did not become idle");
				expect(mock.calls).toHaveLength(3);
				expect(shared).toHaveBeenCalledTimes(1);
				expect(
					manager
						.getBranch()
						.filter(entry => entry.type === "custom" && entry.customType === "workflow-intent-diff"),
				).toHaveLength(2);
				const branch = manager.getBranch();
				const custom = branch.findLast(
					entry => entry.type === "custom" && entry.customType === "workflow-intent-diff",
				);
				const user = branch.find(
					entry =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						JSON.stringify(entry.message.content).includes("busy queued input"),
				);
				expect(custom?.type).toBe("custom");
				expect(user?.type).toBe("message");
				const byId = new Map(branch.map(entry => [entry.id, entry]));
				let cursor = user?.parentId;
				const ancestors = new Set<string>();
				while (cursor && !ancestors.has(cursor)) {
					ancestors.add(cursor);
					cursor = byId.get(cursor)?.parentId;
				}
				expect(ancestors.has(custom!.id)).toBe(true);
			} finally {
				releaseTool.resolve();
				releasePublication.resolve();
				unsubscribe();
				try {
					await withTimeout(
						Promise.allSettled([first, queued].filter((run): run is Promise<void> => run !== undefined)),
						5_000,
						"Busy success prompt cleanup did not settle",
					);
				} catch (error) {
					cleanupFailure = error;
				}
			}
			if (cleanupFailure !== undefined) throw cleanupFailure;
		});
	}

	for (const failure of ["unknown", "stale", "rejected", "acquisition"] as const) {
		it(`refuses busy input before queue/provider when shared workflow append is ${failure}`, async () => {
			const entered = Promise.withResolvers<void>();
			const releaseTool = Promise.withResolvers<void>();
			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", id: "held-tool", name: "probe", arguments: {} }] },
					{ content: ["first complete"] },
				],
			});
			const tool: AgentTool = {
				name: "probe",
				label: "Probe",
				description: "Probe",
				parameters: z.object({}),
				execute: async () => {
					entered.resolve();
					await releaseTool.promise;
					return { content: [{ type: "text", text: "ok" }] };
				},
			};
			const { agent, manager, session } = await setup({ sharedManaged: true, streamFn: mock.stream, tools: [tool] });
			const releasePublication = Promise.withResolvers<void>();
			const enteredPublication = Promise.withResolvers<void>();
			let first: Promise<void> | undefined;
			let queued: Promise<void> | undefined;
			let cleanupFailure: unknown;
			try {
				const firstRun = session.prompt("first ordinary prompt");
				first = firstRun;
				void firstRun.catch(() => {});
				await withTimeout(entered.promise, 5_000, "First turn did not become busy");
				const original = new Error("original busy publication failure");
				const outcome =
					failure === "unknown"
						? { kind: "unknown" as const, id: "busy-attempt-id", error: original }
						: failure === "stale"
							? { kind: "stale" as const, reason: "cursor_not_committed" as const }
							: { kind: "rejected" as const, error: original };
				const shared = vi.spyOn(manager, "appendCustomEntrySharingSession").mockImplementation(async () => {
					enteredPublication.resolve();
					await releasePublication.promise;
					if (failure === "acquisition") throw original;
					return outcome;
				});
				const queuedRun = session.prompt("busy refused input", { streamingBehavior: "followUp" });
				queued = queuedRun;
				void queuedRun.catch(() => {});
				await withTimeout(enteredPublication.promise, 5_000, "Busy publication did not start");
				expect(agent.hasQueuedMessages()).toBe(false);
				expect(mock.calls).toHaveLength(1);
				releasePublication.resolve();
				await expect(withTimeout(queuedRun, 5_000, "Busy refusal did not settle")).rejects.toMatchObject({
					cause: failure === "acquisition" ? original : outcome,
				});
				expect(shared).toHaveBeenCalledTimes(1);
				expect(agent.hasQueuedMessages()).toBe(false);
				expect(mock.calls).toHaveLength(1);
				releaseTool.resolve();
				await withTimeout(firstRun, 5_000, "First turn did not settle");
				await withTimeout(session.waitForIdle(), 5_000, "Session did not become idle");
				expect(mock.calls).toHaveLength(2);
				expect(
					manager
						.getBranch()
						.filter(entry => entry.type === "custom" && entry.customType === "workflow-intent-diff"),
				).toHaveLength(1);
			} finally {
				releasePublication.resolve();
				releaseTool.resolve();
				try {
					await withTimeout(
						Promise.allSettled([first, queued].filter((run): run is Promise<void> => run !== undefined)),
						5_000,
						"Busy failure prompt cleanup did not settle",
					);
				} catch (error) {
					cleanupFailure = error;
				}
			}
			if (cleanupFailure !== undefined) throw cleanupFailure;
		});
	}

	it("keeps the legacy synchronous workflow entry for a non-opted-in session", async () => {
		const mock = createMockModel({ handler: { content: ["completed"] } });
		const { manager, session } = await setup({ streamFn: mock.stream });
		const shared = vi.spyOn(manager, "appendCustomEntrySharingSession");
		await withTimeout(session.prompt("ordinary user prompt"), 5_000, "Legacy prompt did not settle");
		expect(shared).not.toHaveBeenCalled();
		expect(
			manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "workflow-intent-diff"),
		).toHaveLength(1);
	});

	it("does not treat a released predecessor as the terminal assistant's failed append", async () => {
		const removed: string[] = [];
		const { agent, manager, session } = await setup({ onAuthRemoval: () => removed.push("removed") });
		const originalAppend = manager.appendMessage.bind(manager);
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role === "assistant") throw new Error("assistant publication failed");
			return originalAppend(message);
		});
		agent.emitExternalEvent({
			type: "message_end",
			message: { role: "user", content: "committed", timestamp: Date.now() },
		});
		const terminal = assistant();
		agent.emitExternalEvent({ type: "message_end", message: terminal });
		agent.emitExternalEvent({ type: "agent_end", messages: [terminal] });
		await withTimeout(session.awaitSessionSettlement(), 5_000, "Failed terminal admission did not settle");
		expect(removed).toEqual([]);
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message.role),
		).toEqual(["user"]);
	});

	it("releases scheduling after a failed predecessor without treating the successor as failed", async () => {
		const removed: string[] = [];
		const { agent, manager, session } = await setup({ onAuthRemoval: () => removed.push("removed") });
		const originalAppend = manager.appendMessage.bind(manager);
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role === "user") throw new Error("predecessor publication failed");
			return originalAppend(message);
		});
		agent.emitExternalEvent({
			type: "message_end",
			message: { role: "user", content: "failed", timestamp: Date.now() },
		});
		const terminal = assistant();
		agent.emitExternalEvent({ type: "message_end", message: terminal });
		agent.emitExternalEvent({ type: "agent_end", messages: [terminal] });
		await withTimeout(session.awaitSessionSettlement(), 5_000, "Failed predecessor blocked its successor");
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message.role),
		).toEqual(["assistant"]);
		expect(removed).toEqual(["removed"]);
	});

	it("joins its own pending admission, not only the already released predecessor", async () => {
		const removed: string[] = [];
		const { agent, manager, session } = await setup({ spill: true, onAuthRemoval: () => removed.push("removed") });
		const spillGate = Promise.withResolvers<void>();
		const spillEntered = Promise.withResolvers<void>();
		vi.spyOn(manager, "saveArtifact").mockImplementation(async () => {
			spillEntered.resolve();
			await spillGate.promise;
			return { uri: "artifact://1", bytes: 4, sha256: "0".repeat(64) } as never;
		});
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "held",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(40_000) }],
			isError: false,
			timestamp: Date.now(),
		};
		agent.emitExternalEvent({ type: "message_end", message: toolResult });
		const terminal = assistant();
		agent.emitExternalEvent({ type: "message_end", message: terminal });
		agent.emitExternalEvent({ type: "agent_end", messages: [terminal] });
		try {
			await withTimeout(spillEntered.promise, 5_000, "Tool-result spill did not enter before terminal admission");
			expect(removed).toEqual([]);
		} finally {
			spillGate.resolve();
		}
		await withTimeout(session.awaitSessionSettlement(), 5_000, "Terminal admission did not settle");
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message.role),
		).toEqual(["toolResult", "assistant"]);
		expect(removed).toEqual(["removed"]);
	});

	it("settles an active auto-retry when its recovering assistant cannot be published", async () => {
		tempDir = TempDir.createSync("@gjc-canonical-retry-failure-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=5" },
				{ content: ["retry response that cannot be published"] },
			],
			handler: { content: ["later turn"] },
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const manager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		const retryStarted = Promise.withResolvers<void>();
		const retryEnds: Array<{ success: boolean; finalError?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarted.resolve();
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});
		const originalAppend = manager.appendMessage.bind(manager);
		const append = vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role === "assistant" && message.stopReason !== "error") {
				throw new Error("retry assistant publication failed");
			}
			return originalAppend(message);
		});

		const prompt = session.prompt("trigger retry");
		await withTimeout(retryStarted.promise, 5_000, "Provider failure did not start an auto-retry");
		await withTimeout(prompt, 5_000, "Failed retry admission stranded the owning prompt");
		await withTimeout(session.waitForIdle(), 5_000, "Failed retry admission stranded session idle");
		expect(
			append.mock.calls.some(([message]) => message.role === "assistant" && message.stopReason !== "error"),
		).toBe(true);
		expect(retryEnds).toContainEqual(
			expect.objectContaining({
				success: false,
				finalError: expect.stringContaining("retry assistant publication failed"),
			}),
		);
		expect(retryEnds.some(event => event.success)).toBe(false);
		expect(session.isRetrying).toBe(false);
		expect(session.isStreaming).toBe(false);
	}, 20_000);

	it("keeps retry ownership when an extension fails after a successful canonical append", async () => {
		tempDir = TempDir.createSync("@gjc-canonical-extension-failure-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=5" },
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=5" },
				{ content: ["recovered after extension failure"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const manager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		let assistantDeliveries = 0;
		let secondAppendVisible = false;
		const extensionRunner = {
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: () => false,
			emit: async (event: { type: string; message?: AssistantMessage }) => {
				if (event.type !== "message_end" || event.message?.role !== "assistant") return;
				if (++assistantDeliveries === 2) {
					secondAppendVisible =
						manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant")
							.length === 2;
					throw new Error("extension failed after append");
				}
			},
		} as never;
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			extensionRunner,
		});
		const retryEnds: Array<{ success: boolean; finalError?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});
		await withTimeout(session.prompt("retry through an extension error"), 20_000, "Retry did not settle");
		await withTimeout(session.waitForIdle(), 5_000, "Retry did not become idle");
		expect(assistantDeliveries).toBe(3);
		expect(secondAppendVisible).toBe(true);
		expect(
			manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant"),
		).toHaveLength(3);
		expect(retryEnds.filter(event => !event.success)).toEqual([]);
		expect(retryEnds.filter(event => event.success)).toHaveLength(1);
		expect(session.isRetrying).toBe(false);
	});

	it("holds accepted managed tools behind the emitted assistant's canonical predecessor", async () => {
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "first", name: "probe", arguments: {} }] },
				{ content: ["complete"] },
			],
		});
		let executions = 0;
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Probe",
			parameters: z.object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const { agent, manager, session } = await setup({ spill: true, streamFn: mock.stream, tools: [tool] });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(manager, "saveArtifact").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { uri: "artifact://1", bytes: 4, sha256: "0".repeat(64) } as never;
		});
		let injected = false;
		agent.subscribe(event => {
			if (injected || event.type !== "message_start" || event.message.role !== "assistant") return;
			injected = true;
			agent.emitExternalEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "prior",
					toolName: "probe",
					content: [{ type: "text", text: "x".repeat(40_000) }],
					isError: false,
					timestamp: Date.now(),
				},
			});
		});
		const run = session.prompt("test accepted tool");
		try {
			await withTimeout(entered.promise, 5_000, "Predecessor spill did not start");
			expect(executions).toBe(0);
			expect(mock.calls).toHaveLength(1);
		} finally {
			release.resolve();
		}
		await withTimeout(run, 5_000, "Managed run did not settle after publication");
		expect(executions).toBe(1);
		expect(mock.calls).toHaveLength(2);
	});

	it("stops a later exclusive tool and provider after the first result cannot publish", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "first", name: "probe", arguments: {} },
						{ type: "toolCall", id: "second", name: "probe", arguments: {} },
					],
				},
			],
		});
		const dispatched: string[] = [];
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Probe",
			concurrency: "exclusive",
			parameters: z.object({}),
			execute: async id => {
				dispatched.push(id);
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const { manager, session } = await setup({ streamFn: mock.stream, tools: [tool] });
		const append = manager.appendMessage.bind(manager);
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role === "toolResult" && message.toolCallId === "first")
				throw new Error("result publication failed");
			return append(message);
		});
		await withTimeout(session.prompt("execute"), 5_000, "Failed result stranded producer");
		await withTimeout(session.waitForIdle(), 5_000, "Failed result stranded session");
		expect(dispatched).toEqual(["first"]);
		expect(mock.calls).toHaveLength(1);
	});

	it("releases the canonical lane before a reentrant message observer publishes a successor", async () => {
		const { agent, manager, session } = await setup();
		const observed: string[][] = [];
		session.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			observed.push(manager.getBranch().flatMap(entry => (entry.type === "message" ? [entry.message.role] : [])));
			agent.emitExternalEvent({
				type: "message_end",
				message: { role: "user", content: "observer follow-up", timestamp: Date.now() },
			});
		});
		const terminal = assistant();
		agent.emitExternalEvent({ type: "message_end", message: terminal });
		await withTimeout(session.awaitSessionSettlement(), 5_000, "Reentrant observer blocked canonical admission");
		expect(observed).toEqual([["assistant"]]);
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message.role),
		).toEqual(["assistant", "user"]);
	});
});
