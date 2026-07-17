import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { CustomTool } from "@gajae-code/coding-agent/extensibility/custom-tools/types";
import { AgentSession, DefaultModelSelectionRecoveryError } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorageWriter,
	type SessionStorageWriterCloseState,
	type SessionStorageWriterOpenOptions,
	SessionStorageWriterRetryableCloseError,
} from "@gajae-code/coding-agent/session/session-storage";
import { logger } from "@gajae-code/utils";
import { z } from "zod";
import {
	DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE,
	type DefaultModelSelectionRecovery,
} from "../src/session/default-model-selection";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const INITIAL_MODEL: Model = {
	id: "initial",
	name: "Initial",
	api: "anthropic-messages",
	provider: "initial-provider",
	baseUrl: "https://example.invalid",
	reasoning: true,
	thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 2_048,
};

function targetModel(options?: { reasoning?: boolean; minLevel?: Effort; maxLevel?: Effort }): Model {
	return {
		...INITIAL_MODEL,
		id: options?.reasoning === false ? "plain" : "reasoning",
		name: "Target",
		provider: "target-provider",
		reasoning: options?.reasoning ?? true,
		thinking:
			options?.reasoning === false
				? undefined
				: { mode: "effort", minLevel: options?.minLevel ?? Effort.Low, maxLevel: options?.maxLevel ?? Effort.High },
	};
}

class AppendWriterTrackingStorage extends MemorySessionStorage {
	readonly #appendWriterStates: { closed: boolean }[] = [];

	get openAppendWriterCount(): number {
		return this.#appendWriterStates.filter(state => !state.closed).length;
	}

	override openWriter(filePath: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		const writer = super.openWriter(filePath, options);
		if (options?.flags === "w") return writer;
		const state = { closed: false };
		this.#appendWriterStates.push(state);
		return {
			writeLine: line => writer.writeLine(line),
			writeLineSync: line => writer.writeLineSync(line),
			flush: () => writer.flush(),
			fsync: () => writer.fsync(),
			async close(): Promise<void> {
				await writer.close();
				state.closed = true;
			},
			closeSync(): void {
				writer.closeSync();
				state.closed = true;
			},
			getError: () => writer.getError(),
			getCloseState: () => writer.getCloseState(),
			getCloseError: () => writer.getCloseError(),
		};
	}
}

class PromotionRenameFailureStorage extends MemorySessionStorage {
	#failNextRename = false;

	failNextPromotion(): void {
		this.#failNextRename = true;
	}

	override renameSync(source: string, destination: string): void {
		if (this.#failNextRename) {
			this.#failNextRename = false;
			throw new Error("injected session promotion failure");
		}
		super.renameSync(source, destination);
	}
}

class EpermRestoredPromotionStorage extends MemorySessionStorage {
	#promotionRenameAttempt = 0;
	#promotionArmed = false;
	#backupRestoreSucceeded = false;

	get backupRestoreSucceeded(): boolean {
		return this.#backupRestoreSucceeded;
	}

	failPromotionAfterEpermFallback(): void {
		this.#promotionRenameAttempt = 0;
		this.#promotionArmed = true;
	}

	override renameSync(source: string, destination: string): void {
		if (this.#promotionArmed && source.endsWith(".default-selection.tmp") && destination.endsWith(".jsonl")) {
			this.#promotionRenameAttempt++;
			if (this.#promotionRenameAttempt === 1) {
				const error = new Error("EPERM primary promotion rename failure");
				Object.assign(error, { code: "EPERM" });
				throw error;
			}
			if (this.#promotionRenameAttempt === 2) {
				throw new Error("secondary promotion rename failure");
			}
		}
		super.renameSync(source, destination);
		if (this.#promotionArmed && source.endsWith(".bak") && destination.endsWith(".jsonl")) {
			this.#backupRestoreSucceeded = true;
		}
	}
}

class RetryablePromotionCloseStorage extends MemorySessionStorage {
	#failNextAppendWriterClose = false;

	failNextAppendWriterClose(): void {
		this.#failNextAppendWriterClose = true;
	}

	override openWriter(filePath: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		const writer = super.openWriter(filePath, options);
		if (options?.flags === "w") return writer;
		const storage = this;
		let closeState: SessionStorageWriterCloseState = "open";
		let closeError: Error | undefined;
		return {
			writeLine: line => writer.writeLine(line),
			writeLineSync: line => writer.writeLineSync(line),
			flush: () => writer.flush(),
			fsync: () => writer.fsync(),
			async close(): Promise<void> {
				this.closeSync();
			},
			closeSync(): void {
				if (closeState === "closed") return;
				if (storage.#failNextAppendWriterClose) {
					storage.#failNextAppendWriterClose = false;
					closeState = "close_failed_retryable";
					closeError = new SessionStorageWriterRetryableCloseError("injected retryable writer close failure");
					throw closeError;
				}
				writer.closeSync();
				closeState = "closed";
				closeError = undefined;
			},
			getError: () => writer.getError(),
			getCloseState: () => closeState,
			getCloseError: () => closeError,
		};
	}
}

class StagedWriteGateStorage extends MemorySessionStorage {
	#stageWriteEntered: PromiseWithResolvers<void> | undefined;
	#releaseStageWrite: PromiseWithResolvers<void> | undefined;
	#stageWriteArmed = false;

	blockNextDefaultSelectionStage(): void {
		this.#stageWriteEntered = Promise.withResolvers<void>();
		this.#releaseStageWrite = Promise.withResolvers<void>();
		this.#stageWriteArmed = true;
	}

	async waitForDefaultSelectionStageWrite(): Promise<void> {
		if (!this.#stageWriteEntered) throw new Error("Default selection stage write was not armed");
		await this.#stageWriteEntered.promise;
	}

	releaseDefaultSelectionStageWrite(): void {
		if (!this.#releaseStageWrite) throw new Error("Default selection stage write was not armed");
		this.#releaseStageWrite.resolve();
	}

	override openWriter(filePath: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		const writer = super.openWriter(filePath, options);
		const isStagedWrite = options?.flags === "w" && filePath.endsWith(".default-selection.tmp");
		if (!isStagedWrite || !this.#stageWriteArmed || !this.#stageWriteEntered || !this.#releaseStageWrite)
			return writer;
		const entered = this.#stageWriteEntered;
		const release = this.#releaseStageWrite;
		this.#stageWriteArmed = false;
		let firstWrite = true;
		return {
			async writeLine(line: string): Promise<void> {
				if (firstWrite) {
					firstWrite = false;
					entered.resolve();
					await release.promise;
				}
				await writer.writeLine(line);
			},
			writeLineSync: line => writer.writeLineSync(line),
			flush: () => writer.flush(),
			fsync: () => writer.fsync(),
			close: () => writer.close(),
			closeSync: () => writer.closeSync(),
			getError: () => writer.getError(),
			getCloseState: () => writer.getCloseState(),
			getCloseError: () => writer.getCloseError(),
		};
	}
}

class StageDiscardFailureStorage extends MemorySessionStorage {
	#failNextUnlink = false;

	failNextDiscard(): void {
		this.#failNextUnlink = true;
	}

	override unlink(filePath: string): Promise<void> {
		if (this.#failNextUnlink) {
			this.#failNextUnlink = false;
			return Promise.reject(new Error("injected stage discard failure"));
		}
		return super.unlink(filePath);
	}
}

function failDefaultSelectionPromotion(sessionManager: SessionManager, error: Error): void {
	vi.spyOn(sessionManager, "promoteDefaultModelSelection").mockReturnValue({ kind: "not_promoted", error });
}

async function expectPostDurableSelectionRecovery(
	selection: Promise<unknown>,
	recovery: DefaultModelSelectionRecovery,
): Promise<void> {
	let failure: unknown;
	try {
		await selection;
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(DefaultModelSelectionRecoveryError);
	if (!(failure instanceof DefaultModelSelectionRecoveryError))
		throw new Error("Expected default selection recovery error");
	const publicRecovery = { ...recovery, message: DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE };
	expect(failure.message).toBe(publicRecovery.message);
	expect(failure.recovery).toEqual(publicRecovery);
}

describe("AgentSession durable default model selection", () => {
	let tempRoot: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settings: Settings;
	let activeStream: AssistantMessageEventStream | undefined;
	let streamCreated: PromiseWithResolvers<void>;

	beforeEach(async () => {
		streamCreated = Promise.withResolvers<void>();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-default-model-session-"));
		authStorage = await AuthStorage.create(path.join(tempRoot, "auth.db"));
		authStorage.setRuntimeApiKey(INITIAL_MODEL.provider, "initial-key");
		authStorage.setRuntimeApiKey("target-provider", "target-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempRoot, "models.yml"));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				activeStream = new AssistantMessageEventStream();
				streamCreated.resolve();
				return activeStream;
			},
		});
		sessionManager = SessionManager.inMemory(tempRoot);
		settings = Settings.isolated({ defaultThinkingLevel: Effort.XHigh });
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		sessionManager.appendMessage({ role: "user", content: "existing transcript", timestamp: Date.now() });
	});

	afterEach(async () => {
		if (activeStream) {
			const message = createAssistantMessage("released during cleanup");
			activeStream.push({ type: "done", reason: "stop", message });
			activeStream.end(message);
			activeStream = undefined;
		}
		await session.dispose();
		authStorage.close();
		vi.restoreAllMocks();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("waits for an in-flight response before any durable or session mutation", async () => {
		// Given
		const model = targetModel({ minLevel: Effort.Medium, maxLevel: Effort.High });
		const preflightComplete = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (...args) => {
			const apiKey = await originalGetApiKey(...args);
			if (args[0] === model) preflightComplete.resolve();
			return apiKey;
		});
		settings.set("compaction.enabled", false);
		const prompt = session.prompt("in flight");
		await streamCreated.promise;
		const entriesBeforeSelection = sessionManager.getEntries();
		const idleBarrierEntered = Promise.withResolvers<"idle">();
		const originalWaitForIdle = session.waitForIdle.bind(session);
		vi.spyOn(session, "waitForIdle").mockImplementation(async () => {
			idleBarrierEntered.resolve("idle");
			await originalWaitForIdle();
		});
		const durableAttempted = Promise.withResolvers<"durable">();
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		const durableCommit = vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			durableAttempted.resolve("durable");
			return originalDurableCommit(...args);
		});

		// When
		const selection = session.setDefaultModelSelection(model, Effort.XHigh);
		await preflightComplete.promise;
		const firstMutationBoundary = await Promise.race([idleBarrierEntered.promise, durableAttempted.promise]);
		const durableCallsBeforeIdle = durableCommit.mock.calls.length;
		const modelBeforeIdle = session.model;
		const entriesWhileStreaming = sessionManager.getEntries();

		// Then
		const message = createAssistantMessage("complete");
		activeStream?.push({ type: "done", reason: "stop", message });
		activeStream?.end(message);
		activeStream = undefined;
		await prompt;
		const result = await selection;
		expect(firstMutationBoundary).toBe("idle");
		expect(durableCallsBeforeIdle).toBe(0);
		expect(modelBeforeIdle).toBe(INITIAL_MODEL);
		expect(entriesWhileStreaming).toEqual(entriesBeforeSelection);
		expect(result).toEqual({
			provider: "target-provider",
			modelId: "reasoning",
			thinkingLevel: Effort.High,
		});
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(Effort.High);
		const entriesAfterSelection = sessionManager.getEntries();
		expect(entriesAfterSelection.slice(0, entriesBeforeSelection.length)).toEqual(entriesBeforeSelection);
		expect(entriesAfterSelection.filter(entry => entry.type === "model_change" && entry.role === "default")).toEqual([
			expect.objectContaining({ model: "target-provider/reasoning" }),
		]);
		expect(entriesAfterSelection.filter(entry => entry.type === "thinking_level_change")).toEqual([
			expect.objectContaining({ thinkingLevel: Effort.High }),
		]);
		const completedAssistantIndex = entriesAfterSelection.findIndex(
			(entry, index) =>
				index >= entriesBeforeSelection.length && entry.type === "message" && entry.message.role === "assistant",
		);
		const defaultModelMarkerIndex = entriesAfterSelection.findIndex(
			entry => entry.type === "model_change" && entry.role === "default",
		);
		const thinkingMarkerIndex = entriesAfterSelection.findIndex(entry => entry.type === "thinking_level_change");
		expect(completedAssistantIndex).toBeGreaterThanOrEqual(entriesBeforeSelection.length);
		expect(thinkingMarkerIndex).toBeGreaterThan(completedAssistantIndex);
		expect(defaultModelMarkerIndex).toBeGreaterThan(thinkingMarkerIndex);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/reasoning:high" });
	});

	it("preserves explicit off for a reasoning model", async () => {
		// Given
		const model = targetModel();
		session.setThinkingLevel(ThinkingLevel.Off);
		const entriesBeforeSelection = sessionManager.getEntries();

		// When
		const result = await session.setDefaultModelSelection(model, ThinkingLevel.Off);

		// Then
		expect(result.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Off);
		const selectionEntries = sessionManager.getEntries().slice(entriesBeforeSelection.length);
		expect(selectionEntries.filter(entry => entry.type === "model_change" && entry.role === "default")).toEqual([
			expect.objectContaining({ model: "target-provider/reasoning" }),
		]);
		expect(selectionEntries.filter(entry => entry.type === "thinking_level_change")).toEqual([
			expect.objectContaining({ thinkingLevel: ThinkingLevel.Off }),
		]);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/reasoning:off" });
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.XHigh);
	});

	it("emits a thinking-level change without appending a duplicate staged marker", async () => {
		// Given
		const thinkingEvents: (ThinkingLevel | undefined)[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "thinking_level_changed") thinkingEvents.push(event.thinkingLevel);
		});
		const entriesBeforeSelection = sessionManager.getEntries();

		try {
			// When
			await session.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			expect(thinkingEvents).toEqual([Effort.High]);
			expect(
				sessionManager
					.getEntries()
					.slice(entriesBeforeSelection.length)
					.filter(entry => entry.type === "thinking_level_change"),
			).toHaveLength(1);
		} finally {
			unsubscribe();
		}
	});

	it("continues default selection without logging raw subscriber failure detail", async () => {
		// Given
		const model = targetModel();
		const subscriberPath = "/private/subscribers/default-selection.ts";
		const subscriberToken = "subscriber-failure-token";
		const unsubscribe = session.subscribe(event => {
			if (event.type === "thinking_level_changed") {
				throw new Error(`subscriber failed at ${subscriberPath} with token ${subscriberToken}`);
			}
		});
		const subscriberWarning = vi.spyOn(logger, "warn");

		try {
			// When
			const result = await session.setDefaultModelSelection(model, Effort.High);

			// Then
			expect(result).toEqual({ provider: "target-provider", modelId: "reasoning", thinkingLevel: Effort.High });
			expect(session.model).toBe(model);
			expect(session.thinkingLevel).toBe(Effort.High);
			expect(sessionManager.buildSessionContext().models.default).toBe("target-provider/reasoning");
			expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/reasoning:high" });
			expect(subscriberWarning).toHaveBeenCalledWith("Default model selection event listener failed", {
				code: "default_model_selection_listener_failed",
				disposition: "continue",
			});
			const warningOutput = JSON.stringify(subscriberWarning.mock.calls);
			expect(warningOutput).not.toContain(subscriberPath);
			expect(warningOutput).not.toContain(subscriberToken);
		} finally {
			unsubscribe();
		}
	});

	it("restores an unchanged explicit default thinking level on resume", async () => {
		// Given
		modelRegistry.registerProvider("target-provider", {
			baseUrl: "https://example.invalid/v1",
			apiKey: "resume-key",
			api: "openai-completions",
			models: [targetModel()],
		});
		const model = modelRegistry.find("target-provider", "reasoning");
		if (!model) throw new Error("Expected registered resume model");
		const sourceManager = SessionManager.create(tempRoot, tempRoot);
		const sourceSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: sourceManager,
			settings,
			modelRegistry,
			thinkingLevel: ThinkingLevel.Off,
		});
		const resumedSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: SessionManager.create(tempRoot, tempRoot),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});

		try {
			const sourceSessionFile = sourceSession.sessionFile;
			if (!sourceSessionFile) throw new Error("Expected persisted source session");

			// When
			await sourceSession.setDefaultModelSelection(model, ThinkingLevel.Off);
			await sourceManager.rewriteEntries();
			expect(await resumedSession.switchSession(sourceSessionFile)).toBe(true);

			// Then
			expect(resumedSession.model?.provider).toBe(model.provider);
			expect(resumedSession.model?.id).toBe(model.id);
			expect(resumedSession.thinkingLevel).toBe(ThinkingLevel.Off);
		} finally {
			await sourceSession.dispose();
			await resumedSession.dispose();
		}
	});

	it("normalizes an unspecified level to off for a non-reasoning model", async () => {
		// Given
		const model = targetModel({ reasoning: false });

		// When
		const result = await session.setDefaultModelSelection(model, undefined);

		// Then
		expect(result.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/plain:off" });
	});

	it("serializes concurrent selections so the FIFO last request owns durable, live, and resume defaults", async () => {
		// Given
		const firstModel = { ...targetModel(), id: "first" };
		const lastModel = { ...targetModel(), id: "last" };
		const firstDurableCommitEntered = Promise.withResolvers<void>();
		const releaseFirstDurableCommit = Promise.withResolvers<void>();
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (role, selector) => {
			if (selector === "target-provider/first:low") {
				firstDurableCommitEntered.resolve();
				await releaseFirstDurableCommit.promise;
			}
			return originalDurableCommit(role, selector);
		});
		const lastPreflightEntered = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model.id === lastModel.id) lastPreflightEntered.resolve();
			return originalGetApiKey(model, ...args);
		});

		// When
		const firstSelection = session.setDefaultModelSelection(firstModel, Effort.Low);
		await firstDurableCommitEntered.promise;
		const lastSelection = session.setDefaultModelSelection(lastModel, Effort.High);
		const preflightRace = Promise.withResolvers<boolean>();
		void lastPreflightEntered.promise.then(() => preflightRace.resolve(true));
		setImmediate(() => preflightRace.resolve(false));
		const lastRequestOvertookFirst = await preflightRace.promise;
		if (lastRequestOvertookFirst) await lastSelection;
		releaseFirstDurableCommit.resolve();
		await Promise.all([firstSelection, lastSelection]);

		// Then
		expect(lastRequestOvertookFirst).toBeFalse();
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/last:high" });
		expect(session.model).toBe(lastModel);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(sessionManager.buildSessionContext().models.default).toBe("target-provider/last");
	});

	it("rejects inherit before settings or session mutation", async () => {
		// Given
		const entriesBefore = sessionManager.getEntries();

		// When
		const selection = session.setDefaultModelSelection(targetModel(), ThinkingLevel.Inherit);

		// Then
		await expect(selection).rejects.toThrow(/inherit/i);
		expect(settings.getGlobal("modelRoles")).toBeUndefined();
		expect(session.model).toBe(INITIAL_MODEL);
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
	});

	it("rejects missing credentials before waiting or mutation", async () => {
		// Given
		const waitForIdle = vi.spyOn(session, "waitForIdle");
		const entriesBefore = sessionManager.getEntries();
		const model = { ...targetModel(), provider: "missing-provider" };

		// When
		const selection = session.setDefaultModelSelection(model, Effort.Medium);

		// Then
		await expect(selection).rejects.toThrow("No API key for missing-provider/reasoning");
		expect(waitForIdle).not.toHaveBeenCalled();
		expect(settings.getGlobal("modelRoles")).toBeUndefined();
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
	});

	it("does not materialize session JSONL when lazy default selection fails", async () => {
		// Given
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"));
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const sessionFile = persistentManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected lazy session file path");
		const selectionError = new Error("session promotion failed");
		failDefaultSelectionPromotion(persistentManager, selectionError);

		try {
			// When
			const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.Medium);

			// Then
			await expectPostDurableSelectionRecovery(selection, {
				message: selectionError.message,
				rollback: { disposition: "restored", failures: [] },
			});
			expect(await Bun.file(sessionFile).exists()).toBeFalse();
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("preserves the staged replacement when session promotion outcome is unknown", async () => {
		// Given
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"));
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		persistentManager.appendMessage({ role: "user", content: "persisted transcript", timestamp: Date.now() });
		await persistentManager.rewriteEntries();
		const promotionError = new Error("/private/sessions/secret/default-selection.tmp: promotion outcome unknown");
		let stagedTempPath: string | undefined;
		vi.spyOn(persistentManager, "promoteDefaultModelSelection").mockImplementation(stage => {
			stagedTempPath = stage.tempPath;
			return { kind: "unknown", error: promotionError };
		});

		try {
			// When
			const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			await expectPostDurableSelectionRecovery(selection, {
				message: "Session replacement outcome could not be determined.",
				rollback: {
					disposition: "unknown",
					failures: [{ stage: "session", message: "Session replacement outcome could not be determined." }],
				},
			});
			if (!stagedTempPath) throw new Error("Expected staged replacement path");
			expect(await Bun.file(stagedTempPath).exists()).toBeTrue();
			expect(promotionError.message).toContain("/private/sessions/secret");
			expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/reasoning:high" });
			expect(persistentSession.model).toBe(INITIAL_MODEL);
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("does not publish target live state when the real staged session promotion rejects", async () => {
		// Given
		const storage = new PromotionRenameFailureStorage();
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"), storage);
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		persistentManager.appendMessage({ role: "user", content: "persisted transcript", timestamp: Date.now() });
		await persistentManager.rewriteEntries();
		const entriesBeforeSelection = persistentManager.getEntries();
		storage.failNextPromotion();

		try {
			// When
			const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			await expect(selection).rejects.toThrow(DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE);
			expect(persistentSession.model).toBe(INITIAL_MODEL);
			expect(persistentSession.thinkingLevel).toBe(Effort.Low);
			expect(persistentManager.getEntries()).toEqual(entriesBeforeSelection);
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("restores the durable default after EPERM fallback restores the prior session file", async () => {
		// Given
		const storage = new EpermRestoredPromotionStorage();
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"), storage);
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		persistentManager.appendMessage({ role: "user", content: "persisted transcript", timestamp: Date.now() });
		await persistentManager.rewriteEntries();
		const sessionFile = persistentManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		const persistedBeforeSelection = storage.readTextSync(sessionFile);
		const entriesBeforeSelection = persistentManager.getEntries();
		storage.failPromotionAfterEpermFallback();

		try {
			// When
			const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			await expectPostDurableSelectionRecovery(selection, {
				message: "secondary promotion rename failure",
				rollback: { disposition: "restored", failures: [] },
			});
			expect(settings.getGlobal("modelRoles")).toBeUndefined();
			expect(storage.readTextSync(sessionFile)).toBe(persistedBeforeSelection);
			expect(storage.readTextSync(sessionFile)).not.toContain("target-provider/reasoning");
			expect(storage.backupRestoreSucceeded).toBeTrue();
			expect(persistentManager.getEntries()).toEqual(entriesBeforeSelection);
			expect(persistentSession.model).toBe(INITIAL_MODEL);
			expect(persistentSession.thinkingLevel).toBe(Effort.Low);
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("restores durable state without replacing the session after a retryable promotion-writer close failure", async () => {
		// Given
		const storage = new RetryablePromotionCloseStorage();
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"), storage);
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		persistentManager.appendMessage({ role: "user", content: "persisted transcript", timestamp: Date.now() });
		await persistentManager.rewriteEntries();
		persistentManager.appendMessage({ role: "user", content: "pending append writer", timestamp: Date.now() });
		const sessionFile = persistentManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		const persistedBeforeSelection = storage.readTextSync(sessionFile);
		const entriesBeforeSelection = persistentManager.getEntries();
		storage.failNextAppendWriterClose();

		try {
			// When
			const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			await expectPostDurableSelectionRecovery(selection, {
				message: "Session replacement could not be completed.",
				rollback: { disposition: "restored", failures: [] },
			});
			expect(settings.getGlobal("modelRoles")).toBeUndefined();
			expect(storage.readTextSync(sessionFile)).toBe(persistedBeforeSelection);
			expect(storage.readTextSync(sessionFile)).not.toContain("target-provider/reasoning");
			expect(persistentManager.getEntries()).toEqual(entriesBeforeSelection);
			expect(persistentSession.model).toBe(INITIAL_MODEL);
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("rejects a staged snapshot when a later append occurs while its temp write is pending", async () => {
		// Given
		const storage = new StagedWriteGateStorage();
		const manager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"), storage);
		manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
		await manager.rewriteEntries();
		storage.blockNextDefaultSelectionStage();

		try {
			// When
			const stagePromise = manager.stageDefaultModelSelection("target-provider/reasoning", Effort.High, {
				appendThinkingLevel: true,
			});
			await storage.waitForDefaultSelectionStageWrite();
			manager.appendMessage({ role: "user", content: "C", timestamp: Date.now() });
			storage.releaseDefaultSelectionStageWrite();
			const stage = await stagePromise;

			// Then
			expect(manager.promoteDefaultModelSelection(stage)).toEqual({ kind: "not_promoted" });
			expect(
				manager
					.getEntries()
					.some(
						entry => entry.type === "message" && entry.message.role === "user" && entry.message.content === "C",
					),
			).toBeTrue();
			await manager.discardDefaultModelSelectionStage(stage);
		} finally {
			await manager.close();
		}
	});

	it("rejects a staged persisted selection after a rename and preserves the renamed header", async () => {
		// Given
		const manager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"));
		manager.appendMessage({ role: "user", content: "persisted transcript", timestamp: Date.now() });
		await manager.rewriteEntries();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");

		try {
			const stage = await manager.stageDefaultModelSelection("target-provider/reasoning", Effort.High, {
				appendThinkingLevel: true,
			});
			await expect(manager.setSessionName("renamed", "user")).resolves.toBeTrue();

			// When
			const promotion = manager.promoteDefaultModelSelection(stage);

			// Then
			expect(promotion).toEqual({ kind: "not_promoted" });
			expect(manager.getSessionName()).toBe("renamed");
			await manager.discardDefaultModelSelectionStage(stage);
			await manager.close();
			const reopened = await SessionManager.open(sessionFile, tempRoot);
			try {
				expect(reopened.getSessionName()).toBe("renamed");
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("promotes a staged persisted selection when the header is unchanged", async () => {
		// Given
		const manager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"));
		manager.appendMessage({ role: "user", content: "persisted transcript", timestamp: Date.now() });
		await manager.rewriteEntries();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");

		try {
			const stage = await manager.stageDefaultModelSelection("target-provider/reasoning", Effort.High, {
				appendThinkingLevel: true,
			});

			// When
			const promotion = manager.promoteDefaultModelSelection(stage);

			// Then
			expect(promotion).toEqual({ kind: "promoted" });
			expect(manager.buildSessionContext().models.default).toBe("target-provider/reasoning");
			await manager.close();
			const reopened = await SessionManager.open(sessionFile, tempRoot);
			try {
				expect(reopened.buildSessionContext().models.default).toBe("target-provider/reasoning");
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("does not apply the live selection when the durable commit fails", async () => {
		// Given
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockRejectedValue(new Error("durable write failed"));
		const liveApply = vi.spyOn(session, "setModelTemporary");

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.Medium);

		// Then
		await expect(selection).rejects.toThrow("durable write failed");
		expect(liveApply).not.toHaveBeenCalled();
		expect(session.model).toBe(INITIAL_MODEL);
	});

	it("does not route a durably committed default through the temporary mutation path", async () => {
		// Given
		const temporaryMutation = vi.spyOn(session, "setModelTemporary");

		// When
		await session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		expect(temporaryMutation).not.toHaveBeenCalled();
		expect(session.model).toEqual(targetModel());
		expect(sessionManager.buildSessionContext().models.default).toBe("target-provider/reasoning");
	});

	it("does not overwrite a newer direct thinking mutation after durable selection commit", async () => {
		// Given
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (role, selector) => {
			const commit = await originalDurableCommit(role, selector);
			session.setThinkingLevel(Effort.Medium);
			return commit;
		});

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toThrow(DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE);
		expect(settings.getGlobal("modelRoles")).toBeUndefined();
		expect(session.model).toBe(INITIAL_MODEL);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("allows a staged default selection when an identical MCP refresh arrives", async () => {
		// Given
		const storage = new StagedWriteGateStorage();
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"), storage);
		const mcpTool: CustomTool = {
			name: "mcp__nucleus_search",
			label: "nucleus/search",
			description: "Search the Nucleus MCP server",
			parameters: z.object({}),
			mcpServerName: "nucleus",
			mcpToolName: "search",
			execute: async () => ({ content: [] }),
		};
		const initialMcpTool = mcpTool as unknown as AgentTool;
		const candidateSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [initialMcpTool] },
			}),
			sessionManager: persistentManager,
			settings: Settings.isolated({ defaultThinkingLevel: Effort.XHigh }),
			modelRegistry,
			toolRegistry: new Map([[mcpTool.name, initialMcpTool]]),
			thinkingLevel: Effort.Low,
		});
		const model = targetModel();
		await candidateSession.refreshMCPTools([mcpTool]);
		persistentManager.appendMessage({ role: "user", content: "persisted transcript", timestamp: Date.now() });
		await persistentManager.rewriteEntries();
		storage.blockNextDefaultSelectionStage();

		try {
			// When
			const selection = candidateSession.setDefaultModelSelection(model, Effort.High);
			await storage.waitForDefaultSelectionStageWrite();
			await candidateSession.refreshMCPTools([mcpTool]);
			storage.releaseDefaultSelectionStageWrite();

			// Then
			await expect(selection).resolves.toEqual({
				provider: model.provider,
				modelId: model.id,
				thinkingLevel: Effort.High,
			});
			expect(candidateSession.model).toBe(model);
		} finally {
			await candidateSession.dispose();
			await persistentManager.close();
		}
	});

	it("preserves a newer direct transcript mutation when an older selection stage is stale", async () => {
		// Given
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (role, selector) => {
			const commit = await originalDurableCommit(role, selector);
			sessionManager.appendMessage({ role: "user", content: "newer direct mutation", timestamp: Date.now() });
			return commit;
		});

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toThrow(DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE);
		expect(settings.getGlobal("modelRoles")).toBeUndefined();
		expect(session.model).toBe(INITIAL_MODEL);
		expect(sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({ content: "newer direct mutation" }),
			}),
		);
	});

	it("retains a successful lazy selection until its later explicit persistence", async () => {
		// Given
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"));
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const sessionFile = persistentManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected lazy session file path");

		try {
			// When
			await persistentSession.setDefaultModelSelection(targetModel(), Effort.High);
			expect(await Bun.file(sessionFile).exists()).toBeFalse();
			await persistentManager.ensureOnDisk();

			// Then
			const reopened = await SessionManager.open(sessionFile, tempRoot);
			try {
				expect(reopened.buildSessionContext().models.default).toBe("target-provider/reasoning");
			} finally {
				await reopened.close();
			}
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("does not restore live state when durable default persistence fails", async () => {
		// Given
		const priorModelRoles = { default: "initial-provider/initial:low", planner: "planner/model:medium" };
		const durableError = new Error("durable write failed");
		settings.set("modelRoles", priorModelRoles);
		const entriesBeforeSelection = sessionManager.getEntries();
		const contextBeforeSelection = sessionManager.buildSessionContext();
		const priorModel = session.model;
		const priorThinkingLevel = session.thinkingLevel;
		const setModel = vi.spyOn(session.agent, "setModel");
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockRejectedValue(durableError);

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toBe(durableError);
		expect(setModel).not.toHaveBeenCalled();
		expect(settings.getGlobal("modelRoles")).toEqual(priorModelRoles);
		expect(session.model).toBe(priorModel);
		expect(session.thinkingLevel).toBe(priorThinkingLevel);
		expect(sessionManager.getEntries()).toEqual(entriesBeforeSelection);
		expect(sessionManager.buildSessionContext()).toEqual(contextBeforeSelection);
	});

	it("continues the selection queue after a rejected operation", async () => {
		// Given
		const successfulModel = { ...targetModel(), id: "after-failure" };
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush")
			.mockImplementation(originalDurableCommit)
			.mockRejectedValueOnce(new Error("durable write failed"));

		// When
		const failedSelection = session.setDefaultModelSelection(targetModel(), Effort.Low);
		await expect(failedSelection).rejects.toThrow("durable write failed");
		const successfulSelection = await session.setDefaultModelSelection(successfulModel, Effort.High);

		// Then
		expect(successfulSelection).toEqual({
			provider: "target-provider",
			modelId: "after-failure",
			thinkingLevel: Effort.High,
		});
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/after-failure:high" });
		expect(session.model).toBe(successfulModel);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(sessionManager.buildSessionContext().models.default).toBe("target-provider/after-failure");
	});

	it("does not publish target selection effects when target edit prompt preparation rejects", async () => {
		// Given
		const selectionError = new Error("target edit prompt preparation failed");
		const agentDir = path.join(tempRoot, "selection-agent");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			[
				"edit:",
				"  modelVariants:",
				'    "initial-provider/initial": replace',
				'    "target-provider/reasoning": patch',
			].join("\n"),
		);
		resetSettingsForTest();
		const durableSettings = await Settings.init({ cwd: tempRoot, agentDir });
		const failingManager = SessionManager.inMemory(tempRoot);
		const editTool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Edit files",
			parameters: z.object({}),
			execute: async () => ({ content: [] }),
		};
		const failingAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [editTool] },
		});
		const model = targetModel();
		let preparedCandidateModel: Model | undefined;
		const failingSession = new AgentSession({
			agent: failingAgent,
			sessionManager: failingManager,
			settings: durableSettings,
			modelRegistry,
			toolRegistry: new Map([[editTool.name, editTool]]),
			thinkingLevel: Effort.Low,
			rebuildSystemPrompt: async (_toolNames, _tools, candidateModel) => {
				preparedCandidateModel = candidateModel;
				throw selectionError;
			},
		});
		const entriesBeforeSelection = failingManager.getEntries();

		try {
			const storage = durableSettings.getStorage();
			if (!storage) throw new Error("Expected durable agent storage");

			// When
			const selection = failingSession.setDefaultModelSelection(model, Effort.High);

			// Then
			await expect(selection).rejects.toBe(selectionError);
			expect(preparedCandidateModel).toBe(model);
			expect(failingSession.model).toBe(INITIAL_MODEL);
			expect(failingSession.thinkingLevel).toBe(Effort.Low);
			expect(failingManager.getEntries()).toEqual(entriesBeforeSelection);
			expect(storage.getModelUsageOrder()).not.toContain("target-provider/reasoning");
		} finally {
			await failingSession.dispose();
			resetSettingsForTest();
		}
	});

	it("restores the prior durable selection without publishing live state when staged promotion is rejected", async () => {
		// Given
		const priorModelRoles = { default: "initial-provider/initial:low", planner: "planner/model:medium" };
		const priorLiveModel = session.model;
		const priorThinkingLevel = session.thinkingLevel;
		const model = targetModel();
		const lateLiveApplyError = new Error("session promotion failed");
		settings.set("modelRoles", priorModelRoles);
		failDefaultSelectionPromotion(sessionManager, lateLiveApplyError);

		// When
		const selection = session.setDefaultModelSelection(model, Effort.High);

		// Then
		await expectPostDurableSelectionRecovery(selection, {
			message: lateLiveApplyError.message,
			rollback: { disposition: "restored", failures: [] },
		});
		expect(settings.getGlobal("modelRoles")).toEqual(priorModelRoles);
		expect(session.model).toBe(priorLiveModel);
		expect(session.thinkingLevel).toBe(priorThinkingLevel);
	});

	it("restores the prior durable default while retaining a planner helper update from rejected promotion", async () => {
		// Given: A is durable before B commits, then promotion makes an unrelated planner update before rejecting B.
		const priorModelRoles = { default: "initial-provider/initial:low", planner: "planner/original:medium" };
		const promotionError = new Error("session promotion failed");
		settings.set("modelRoles", priorModelRoles);
		vi.spyOn(sessionManager, "promoteDefaultModelSelection").mockImplementation(() => {
			settings.setModelRole("planner", "planner/newer:high");
			return { kind: "not_promoted", error: promotionError };
		});

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then: session recovery restores A but preserves the concurrent planner Q update.
		await expectPostDurableSelectionRecovery(selection, {
			message: promotionError.message,
			rollback: { disposition: "restored", failures: [] },
		});
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "initial-provider/initial:low",
			planner: "planner/newer:high",
		});
	});

	it("restores the exact prior model when the failed target shares its selector but changes API metadata", async () => {
		// Given
		const priorLiveModel = session.model;
		if (!priorLiveModel) throw new Error("Expected initial live model");
		const targetWithDifferentApi: Model = {
			...priorLiveModel,
			api: "openai-completions",
			baseUrl: "https://replacement.example.invalid/v1",
		};
		const lateLiveApplyError = new Error("session promotion failed");
		failDefaultSelectionPromotion(sessionManager, lateLiveApplyError);

		// When
		const selection = session.setDefaultModelSelection(targetWithDifferentApi, Effort.High);

		// Then
		await expectPostDurableSelectionRecovery(selection, {
			message: lateLiveApplyError.message,
			rollback: { disposition: "restored", failures: [] },
		});
		expect(session.model).toBe(priorLiveModel);
		expect(session.model?.api).toBe("anthropic-messages");
		expect(session.model?.baseUrl).toBe("https://example.invalid");
	});

	it("does not commit the durable default when session snapshot preflight flush fails", async () => {
		// Given
		const priorModelRoles = { default: "initial-provider/initial:low", planner: "planner/model:medium" };
		const entriesBeforeSelection = sessionManager.getEntries();
		const contextBeforeSelection = sessionManager.buildSessionContext();
		const flushError = new Error("session snapshot flush failed");
		settings.set("modelRoles", priorModelRoles);
		vi.spyOn(sessionManager, "flush").mockRejectedValue(flushError);

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toBe(flushError);
		expect(settings.getGlobal("modelRoles")).toEqual(priorModelRoles);
		expect(session.model).toBe(INITIAL_MODEL);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(sessionManager.getEntries()).toEqual(entriesBeforeSelection);
		expect(sessionManager.buildSessionContext()).toEqual(contextBeforeSelection);
	});

	it("closes an already-open persisted append writer before promoting the staged transcript", async () => {
		// Given
		const storage = new AppendWriterTrackingStorage();
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"), storage);
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		await persistentManager.ensureOnDisk();
		persistentManager.appendMessage({ role: "user", content: "open hot writer", timestamp: Date.now() });
		await persistentManager.flush();
		expect(storage.openAppendWriterCount).toBe(1);
		try {
			// When
			await persistentSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			expect(storage.openAppendWriterCount).toBe(0);
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("keeps the exact persisted transcript and context when staged promotion is rejected", async () => {
		// Given
		const persistentManager = SessionManager.create(tempRoot, tempRoot);
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const lateLiveApplyError = new Error("session promotion failed");
		persistentManager.appendMessage({ role: "user", content: "persisted transcript", timestamp: Date.now() });
		await persistentManager.rewriteEntries();
		const sessionFile = persistentSession.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		const entriesBeforeSelection = persistentManager.getEntries();
		const contextBeforeSelection = persistentManager.buildSessionContext();
		failDefaultSelectionPromotion(persistentManager, lateLiveApplyError);

		try {
			// When
			const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			await expectPostDurableSelectionRecovery(selection, {
				message: lateLiveApplyError.message,
				rollback: { disposition: "restored", failures: [] },
			});
			expect(persistentManager.getEntries()).toEqual(entriesBeforeSelection);
			expect(persistentManager.buildSessionContext()).toEqual(contextBeforeSelection);
			await persistentManager.flush();
			await persistentManager.close();
			const reopenedManager = await SessionManager.open(sessionFile, tempRoot);
			try {
				expect(reopenedManager.getEntries()).toEqual(entriesBeforeSelection);
				expect(reopenedManager.buildSessionContext()).toEqual(contextBeforeSelection);
			} finally {
				await reopenedManager.close();
			}
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("restores the durable default when staged cleanup fails after promotion rejection", async () => {
		// Given
		const storage = new StageDiscardFailureStorage();
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"), storage);
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const priorModelRoles = { default: "initial-provider/initial:low", planner: "planner/model:medium" };
		const promotionError = new Error("session promotion rejected");
		settings.set("modelRoles", priorModelRoles);
		persistentManager.appendMessage({ role: "user", content: "persisted transcript", timestamp: Date.now() });
		await persistentManager.rewriteEntries();
		failDefaultSelectionPromotion(persistentManager, promotionError);
		storage.failNextDiscard();

		try {
			// When
			const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			await expectPostDurableSelectionRecovery(selection, {
				message: promotionError.message,
				rollback: {
					disposition: "partial",
					failures: [{ stage: "session", message: "Session replacement recovery could not be completed." }],
				},
			});
			expect(settings.getGlobal("modelRoles")).toEqual(priorModelRoles);
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("restores the durable default when staged cleanup fails after the stage becomes stale", async () => {
		// Given
		const storage = new StageDiscardFailureStorage();
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"), storage);
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const priorModelRoles = { default: "initial-provider/initial:low", planner: "planner/model:medium" };
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		settings.set("modelRoles", priorModelRoles);
		persistentManager.appendMessage({ role: "user", content: "persisted transcript", timestamp: Date.now() });
		await persistentManager.rewriteEntries();
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (role, selector) => {
			const commit = await originalDurableCommit(role, selector);
			persistentManager.appendMessage({ role: "user", content: "newer transcript mutation", timestamp: Date.now() });
			return commit;
		});
		storage.failNextDiscard();

		try {
			// When
			const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			await expect(selection).rejects.toThrow(DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE);
			expect(settings.getGlobal("modelRoles")).toEqual(priorModelRoles);
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("keeps a model-less session's live model, thinking, entries, and context when staged promotion is rejected", async () => {
		// Given
		const modelLessManager = SessionManager.inMemory(tempRoot);
		const modelLessSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: undefined, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: modelLessManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const priorModelRoles = { planner: "planner/model:medium" };
		const priorThinkingLevel = modelLessSession.thinkingLevel;
		const lateLiveApplyError = new Error("session promotion failed");
		settings.set("modelRoles", priorModelRoles);
		modelLessManager.appendMessage({ role: "user", content: "model-less transcript", timestamp: Date.now() });
		const entriesBeforeSelection = modelLessManager.getEntries();
		const contextBeforeSelection = modelLessManager.buildSessionContext();
		failDefaultSelectionPromotion(modelLessManager, lateLiveApplyError);

		try {
			// When
			const selection = modelLessSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			await expectPostDurableSelectionRecovery(selection, {
				message: lateLiveApplyError.message,
				rollback: { disposition: "restored", failures: [] },
			});
			expect(settings.getGlobal("modelRoles")).toEqual(priorModelRoles);
			expect(modelLessSession.model).toBeUndefined();
			expect(modelLessSession.thinkingLevel).toBe(priorThinkingLevel);
			expect(modelLessManager.getEntries()).toEqual(entriesBeforeSelection);
			expect(modelLessManager.buildSessionContext()).toEqual(contextBeforeSelection);
		} finally {
			await modelLessSession.dispose();
		}
	});

	it("preserves the session promotion error without attempting a live rollback", async () => {
		// Given
		const priorLiveModel = session.model;
		const model = targetModel();
		const lateLiveApplyError = new Error("session promotion failed");
		failDefaultSelectionPromotion(sessionManager, lateLiveApplyError);
		const setModel = vi.spyOn(session.agent, "setModel");

		// When
		const selection = session.setDefaultModelSelection(model, Effort.High);

		// Then
		await expectPostDurableSelectionRecovery(selection, {
			message: lateLiveApplyError.message,
			rollback: { disposition: "restored", failures: [] },
		});
		expect(setModel).not.toHaveBeenCalled();
		expect(session.model).toBe(priorLiveModel);
	});

	it.each([
		[
			"the prior session default",
			"initial-provider/initial",
			{ default: "initial-provider/initial:low", planner: "planner/model:medium" },
		],
		["no prior session default", undefined, { planner: "planner/model:medium" }],
	])("restores %s when live apply fails after a partial session mutation", async (_description, previousSessionDefault, previousModelRoles) => {
		// Given
		if (previousSessionDefault) {
			sessionManager.appendModelChange(previousSessionDefault, "default");
		}
		settings.set("modelRoles", previousModelRoles);
		const entriesBeforeSelection = sessionManager.getEntries();
		const defaultEntriesBeforeSelection = entriesBeforeSelection.filter(
			entry => entry.type === "model_change" && entry.role === "default",
		);
		const liveApplyError = new Error("session promotion failed");
		failDefaultSelectionPromotion(sessionManager, liveApplyError);

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expectPostDurableSelectionRecovery(selection, {
			message: liveApplyError.message,
			rollback: { disposition: "restored", failures: [] },
		});
		expect(settings.getGlobal("modelRoles")).toEqual(previousModelRoles);
		expect(
			sessionManager.getEntries().filter(entry => entry.type === "model_change" && entry.role === "default"),
		).toEqual(defaultEntriesBeforeSelection);
		expect(sessionManager.buildSessionContext().models.default === previousSessionDefault).toBeTrue();
	});

	it.each([
		["the previous default", { default: "original-provider/original:low", planner: "planner/model:medium" }],
		["no previous default", { planner: "planner/model:medium" }],
	])("restores %s when post-commit live apply fails", async (_description, previousModelRoles) => {
		// Given
		settings.set("modelRoles", previousModelRoles);
		failDefaultSelectionPromotion(sessionManager, new Error("session promotion failed"));

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toThrow(DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE);
		expect(settings.getGlobal("modelRoles")).toEqual(previousModelRoles);
		expect(session.model).toBe(INITIAL_MODEL);
	});

	it("logs stable durable recovery diagnostics without raw restore error detail", async () => {
		// Given
		const liveApplyError = new Error("session promotion failed");
		const restorePath = "/private/sessions/default-selection.json";
		const restoreToken = "durable-restore-token";
		const rollbackError = new Error(`durable rollback failed at ${restorePath} with token ${restoreToken}`);
		vi.spyOn(settings, "restoreGlobalDefaultModelRoleIfCurrent").mockRejectedValue(rollbackError);
		failDefaultSelectionPromotion(sessionManager, liveApplyError);
		const rollbackWarning = vi.spyOn(logger, "warn");

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expectPostDurableSelectionRecovery(selection, {
			message: liveApplyError.message,
			rollback: {
				disposition: "partial",
				failures: [{ stage: "durable", message: "Durable default selection recovery could not be completed." }],
			},
		});
		expect(rollbackWarning).toHaveBeenCalled();
		const warningOutput = JSON.stringify(rollbackWarning.mock.calls);
		expect(warningOutput).not.toContain(restorePath);
		expect(warningOutput).not.toContain(restoreToken);
		expect(rollbackWarning).toHaveBeenCalledWith(
			"Failed to restore durable default model selection after session promotion failure",
			{ code: "default_model_selection_recovery_failed", rollbackStage: "durable" },
		);
	});
});
