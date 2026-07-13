import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, AgentBusyError, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, type Message, type Model } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { CustomTool } from "@gajae-code/coding-agent/extensibility/custom-tools/types";
import { ExtensionRuntime } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import type { Extension, ExtensionUIContext } from "@gajae-code/coding-agent/extensibility/extensions/types";
import { ExtensionUiController } from "@gajae-code/coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { AgentSession, DefaultModelSelectionRecoveryError } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
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
	let secondStreamCreated: PromiseWithResolvers<void> | undefined;
	let streamCount: number;
	let providerSignalAborted: boolean | undefined;
	const getActiveStream = (): AssistantMessageEventStream | undefined => activeStream;

	beforeEach(async () => {
		streamCreated = Promise.withResolvers<void>();
		secondStreamCreated = undefined;
		streamCount = 0;
		providerSignalAborted = undefined;
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-default-model-session-"));
		authStorage = await AuthStorage.create(path.join(tempRoot, "auth.db"));
		authStorage.setRuntimeApiKey(INITIAL_MODEL.provider, "initial-key");
		authStorage.setRuntimeApiKey("target-provider", "target-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempRoot, "models.yml"));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				providerSignalAborted = options?.signal?.aborted;
				activeStream = new AssistantMessageEventStream();
				streamCount++;
				if (streamCount === 1) streamCreated.resolve();
				if (streamCount === 2) secondStreamCreated?.resolve();
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
		const prompt = session.prompt("in flight");
		await streamCreated.promise;
		const entriesBeforeSelection = sessionManager.getEntries();
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		const durableCommit = vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			return originalDurableCommit(...args);
		});

		// When
		const selection = session.setDefaultModelSelection(model, Effort.XHigh);
		await new Promise<void>(resolve => setImmediate(resolve));
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

	it("[A] keeps selection validation and mutation behind an admitted before_agent_start prompt", async () => {
		// Given
		const contributorEntered = Promise.withResolvers<void>();
		const inspectSelection = Promise.withResolvers<void>();
		const contributorInspectionComplete = Promise.withResolvers<void>();
		const releaseContributor = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const unregister = session.registerBeforeAgentStartContributor(async () => {
			contributorEntered.resolve();
			await inspectSelection.promise;
			contributorInspectionComplete.resolve();
			await releaseContributor.promise;
			return undefined;
		});
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		const getApiKey = vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model.provider === "target-provider") await releaseSelectionValidation.promise;
			return originalGetApiKey(model, ...args);
		});
		const stageSelection = vi.spyOn(sessionManager, "stageDefaultModelSelection");
		const durableSelection = vi.spyOn(settings, "setGlobalModelRoleAndFlush");
		const setLiveModel = vi.spyOn(session.agent, "setModel");
		const entriesBefore = sessionManager.getEntries();
		const prompt = session.prompt("prompt admitted before selection");
		let selection: Promise<unknown> | undefined;

		try {
			await contributorEntered.promise;

			// When
			selection = session.setDefaultModelSelection(targetModel(), Effort.High);
			inspectSelection.resolve();
			await contributorInspectionComplete.promise;

			// Then
			expect(getApiKey.mock.calls.filter(([model]) => model.provider === "target-provider")).toHaveLength(0);
			expect(stageSelection).not.toHaveBeenCalled();
			expect(durableSelection).not.toHaveBeenCalled();
			expect(setLiveModel).not.toHaveBeenCalled();
			expect(settings.getGlobal("modelRoles")).toBeUndefined();
			expect(session.model).toBe(INITIAL_MODEL);
			expect(sessionManager.getEntries()).toEqual(entriesBefore);
		} finally {
			inspectSelection.resolve();
			releaseSelectionValidation.resolve();
			releaseContributor.resolve();
			unregister();
			await streamCreated.promise;
			const message = createAssistantMessage("case A cleanup");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await Promise.allSettled([prompt, ...(selection ? [selection] : [])]);
		}
	});

	it("[K] keeps selection mutation behind a real file-mention preflight read", async () => {
		// Given
		const mentionName = "preflight-default-selection-mention.txt";
		const mentionPath = path.join(tempRoot, mentionName);
		await Bun.write(mentionPath, "file mention body\n");
		const fileReadEntered = Promise.withResolvers<void>();
		const releaseFileRead = Promise.withResolvers<void>();
		const originalFile = Bun.file.bind(Bun);
		const fileSpy = vi.spyOn(Bun, "file").mockImplementation((filePath, options) => {
			const file =
				typeof filePath === "number"
					? originalFile(filePath, options)
					: typeof filePath === "string" || filePath instanceof URL
						? originalFile(filePath, options)
						: originalFile(filePath, options);
			if (filePath.toString() !== mentionPath) return file;
			return new Proxy(file, {
				get(target, property) {
					if (property === "text") {
						return async (): Promise<string> => {
							fileReadEntered.resolve();
							await releaseFileRead.promise;
							return target.text();
						};
					}
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		});
		const prepareSelection = vi.spyOn(session.agent, "setSystemPrompt");
		const stageSelection = vi.spyOn(sessionManager, "stageDefaultModelSelection");
		const durableSelection = vi.spyOn(settings, "setGlobalModelRoleAndFlush");
		const setLiveModel = vi.spyOn(session.agent, "setModel");
		const entriesBefore = sessionManager.getEntries();
		const prompt = session.prompt(`@${mentionName}`);
		let selection: Promise<unknown> | undefined;

		try {
			await fileReadEntered.promise;

			// When
			selection = session.setDefaultModelSelection(targetModel(), Effort.High);
			await new Promise<void>(resolve => setImmediate(resolve));

			// Then
			expect(prepareSelection).not.toHaveBeenCalled();
			expect(stageSelection).not.toHaveBeenCalled();
			expect(durableSelection).not.toHaveBeenCalled();
			expect(setLiveModel).not.toHaveBeenCalled();
			expect(settings.getGlobal("modelRoles")).toBeUndefined();
			expect(session.model).toBe(INITIAL_MODEL);
			expect(sessionManager.getEntries()).toEqual(entriesBefore);
		} finally {
			releaseFileRead.resolve();
			fileSpy.mockRestore();
			await streamCreated.promise;
			const message = createAssistantMessage("case K cleanup");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await Promise.allSettled([prompt, ...(selection ? [selection] : [])]);
			await fs.rm(mentionPath, { force: true });
		}
	});

	it("[B] blocks prompt caller-side mutation while selection owns drain-to-stage", async () => {
		// Given
		const selectionFlushEntered = Promise.withResolvers<void>();
		const releaseSelectionFlush = Promise.withResolvers<void>();
		const originalFlush = sessionManager.flush.bind(sessionManager);
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			selectionFlushEntered.resolve();
			await releaseSelectionFlush.promise;
			return originalFlush();
		});
		const refreshSubskills = vi.spyOn(session, "refreshGjcSubskillTools");
		const appendWorkflowIntent = vi.spyOn(sessionManager, "appendCustomEntry");
		const entriesBefore = sessionManager.getEntries();
		const transcriptBefore = session.agent.state.messages;
		const toolChoicesBefore = session.toolChoiceQueue.inspect();
		const activeSkillBefore = session.getActiveSkillState();
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);
		let prompt: Promise<void> | undefined;

		try {
			await selectionFlushEntered.promise;

			// When
			prompt = session.prompt("plan an architecture migration regression");

			// Then
			expect(appendWorkflowIntent).not.toHaveBeenCalled();
			expect(sessionManager.getEntries()).toEqual(entriesBefore);
			expect(session.agent.state.messages).toEqual(transcriptBefore);
			expect(session.toolChoiceQueue.inspect()).toEqual(toolChoicesBefore);
			expect(refreshSubskills).not.toHaveBeenCalled();
			expect(session.getActiveSkillState()).toEqual(activeSkillBefore);
			expect(streamCount).toBe(0);
		} finally {
			releaseSelectionFlush.resolve();
			await selection.catch(() => {});
			if (prompt) {
				await streamCreated.promise;
				const message = createAssistantMessage("case B cleanup");
				activeStream?.push({ type: "done", reason: "stop", message });
				activeStream?.end(message);
				activeStream = undefined;
				await prompt.catch(() => {});
			}
		}
	});

	it("keeps plan-mode enforcement inside the outer prompt admission before a queued selector", async () => {
		// Given
		await session.dispose();
		settings.set("compaction.enabled", false);
		const requiredTools: AgentTool[] = ["ask", "resolve"].map(name => ({
			name,
			label: name,
			description: `${name} test tool`,
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: `${name} complete` }] }),
		}));
		const callMessages: Message[][] = [];
		const callToolChoices: unknown[] = [];
		const order: string[] = [];
		let firstStream: AssistantMessageEventStream | undefined;
		const firstCallCreated = Promise.withResolvers<void>();
		const planAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: requiredTools },
			convertToLlm,
			streamFn: (_model, context, options) => {
				callMessages.push([...context.messages]);
				callToolChoices.push(options?.toolChoice);
				const callNumber = callMessages.length;
				order.push(callNumber === 1 ? "outer provider call" : "enforcement provider call");
				const stream = new AssistantMessageEventStream();
				activeStream = stream;
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (callNumber === 1) {
						firstStream = stream;
						firstCallCreated.resolve();
						return;
					}
					const message = createAssistantMessage("plan decision requested");
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					if (activeStream === stream) activeStream = undefined;
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent: planAgent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(requiredTools.map(tool => [tool.name, tool])),
			thinkingLevel: Effort.Low,
		});
		session.setPlanModeState({ enabled: true, planFilePath: path.join(tempRoot, "PLAN.md") });
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model.provider === "target-provider") order.push("selector validate");
			return originalGetApiKey(model, ...args);
		});
		const originalStage = sessionManager.stageDefaultModelSelection.bind(sessionManager);
		vi.spyOn(sessionManager, "stageDefaultModelSelection").mockImplementation(async (...args) => {
			order.push("selector stage");
			return originalStage(...args);
		});
		const originalCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			order.push("selector commit");
			return originalCommit(...args);
		});
		const prompt = session.prompt("prepare the migration plan");
		let selection: Promise<unknown> | undefined;

		try {
			await firstCallCreated.promise;
			selection = session.setDefaultModelSelection(targetModel(), Effort.High);
			const firstMessage = createAssistantMessage("drafted a plan without asking or resolving");

			// When
			firstStream?.push({ type: "done", reason: "stop", message: firstMessage });
			firstStream?.end(firstMessage);
			firstStream = undefined;
			if (activeStream) activeStream = undefined;

			// Then
			let promptFailure: unknown;
			try {
				await prompt;
			} catch (error) {
				promptFailure = error;
			}
			await expect(selection).resolves.toEqual({
				provider: "target-provider",
				modelId: "reasoning",
				thinkingLevel: Effort.High,
			});
			expect({
				promptErrorName: promptFailure instanceof Error ? promptFailure.name : undefined,
				providerCallCount: callMessages.length,
			}).toEqual({ promptErrorName: undefined, providerCallCount: 2 });
			expect(callToolChoices).toEqual([undefined, "required"]);
			const secondCall = callMessages[1];
			if (!secondCall) throw new Error("Expected plan-mode enforcement provider call");
			expect(secondCall.slice(-3)).toMatchObject([
				{ role: "assistant", content: [{ type: "text", text: "drafted a plan without asking or resolving" }] },
				{ role: "user", content: [{ type: "text", text: expect.stringContaining("current working directory") }] },
				{
					role: "developer",
					content: [
						{
							type: "text",
							text: [
								"<system-reminder>",
								"Plan mode turn ended without a required tool call.",
								"",
								"You MUST choose exactly one next action now:",
								"1. Call `ask` to gather required clarification, OR",
								'2. Call `resolve` with `action: "apply"`, `reason`, and `extra: { title: "<PLAN_TITLE>" }` to finish planning and request approval',
								"",
								"You NEVER output plain text in this turn.",
								"</system-reminder>",
							].join("\n"),
						},
					],
				},
			]);
			expect(order).toEqual([
				"outer provider call",
				"enforcement provider call",
				"selector validate",
				"selector stage",
				"selector commit",
			]);
		} finally {
			if (firstStream) {
				const cleanupMessage = createAssistantMessage("plan enforcement cleanup");
				firstStream.push({ type: "done", reason: "stop", message: cleanupMessage });
				firstStream.end(cleanupMessage);
			}
			await Promise.allSettled([prompt, ...(selection ? [selection] : [])]);
		}
	});

	it("[C] preserves exact mixed FIFO order S1 then S2 then prompt", async () => {
		// Given
		const firstModel = { ...targetModel(), id: "matrix-s1" };
		const secondModel = { ...targetModel(), id: "matrix-s2" };
		const firstCommitEntered = Promise.withResolvers<void>();
		const releaseFirstCommit = Promise.withResolvers<void>();
		const promptContributorEntered = Promise.withResolvers<void>();
		const releasePromptContributor = Promise.withResolvers<void>();
		const order: string[] = [];
		const refreshSubskills = vi.spyOn(session, "refreshGjcSubskillTools");
		const originalCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (role, selector) => {
			if (selector === undefined) throw new Error("Expected durable model selector");
			if (selector.includes("matrix-s1")) {
				order.push("S1");
				firstCommitEntered.resolve();
				await releaseFirstCommit.promise;
			}
			if (selector.includes("matrix-s2")) order.push("S2");
			return originalCommit(role, selector);
		});
		const unregister = session.registerBeforeAgentStartContributor(async () => {
			order.push("P");
			promptContributorEntered.resolve();
			await releasePromptContributor.promise;
			return undefined;
		});
		const first = session.setDefaultModelSelection(firstModel, Effort.Low);
		void first.catch(() => {});
		let second: Promise<unknown> | undefined;
		let prompt: Promise<void> | undefined;

		try {
			await firstCommitEntered.promise;

			// When
			second = session.setDefaultModelSelection(secondModel, Effort.High);
			void second.catch(() => {});
			prompt = session.prompt("mixed FIFO prompt");
			void prompt.catch(() => {});

			// Then
			expect(refreshSubskills).not.toHaveBeenCalled();
			expect(order).toEqual(["S1"]);
			releaseFirstCommit.resolve();
			await Promise.all([first, second]);
			await promptContributorEntered.promise;
			expect(order).toEqual(["S1", "S2", "P"]);
		} finally {
			releaseFirstCommit.resolve();
			releasePromptContributor.resolve();
			unregister();
			if (prompt) await streamCreated.promise;
			const message = createAssistantMessage("case C cleanup");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await Promise.allSettled([first, ...(second ? [second] : []), ...(prompt ? [prompt] : [])]);
		}
	});

	it("[D] keeps one pending prompt claim behind a selector and rejects a second prompt as busy", async () => {
		// Given
		const selectionFlushEntered = Promise.withResolvers<void>();
		const releaseSelectionFlush = Promise.withResolvers<void>();
		const originalFlush = sessionManager.flush.bind(sessionManager);
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			selectionFlushEntered.resolve();
			await releaseSelectionFlush.promise;
			return originalFlush();
		});
		const refreshSubskills = vi.spyOn(session, "refreshGjcSubskillTools");
		const releaseRefresh = Promise.withResolvers<void>();
		const promptContributorEntered = Promise.withResolvers<void>();
		const releasePromptContributor = Promise.withResolvers<void>();
		refreshSubskills.mockImplementation(async () => {
			await releaseRefresh.promise;
		});
		const unregister = session.registerBeforeAgentStartContributor(async () => {
			promptContributorEntered.resolve();
			await releasePromptContributor.promise;
			return undefined;
		});
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);
		let firstPrompt: Promise<void> | undefined;
		let secondPrompt: Promise<void> | undefined;

		try {
			await selectionFlushEntered.promise;

			// When
			firstPrompt = session.prompt("first pending prompt");
			secondPrompt = session.prompt("second pending prompt");
			void firstPrompt.catch(() => {});
			void secondPrompt.catch(() => {});

			// Then
			expect(refreshSubskills).not.toHaveBeenCalled();
			await expect(secondPrompt).rejects.toBeInstanceOf(AgentBusyError);
		} finally {
			if (refreshSubskills.mock.calls.length > 0) {
				releaseRefresh.resolve();
				await promptContributorEntered.promise;
				await session.abort();
			} else {
				await session.abort();
				releaseRefresh.resolve();
			}
			releasePromptContributor.resolve();
			releaseSelectionFlush.resolve();
			unregister();
			await Promise.allSettled([
				selection,
				...(firstPrompt ? [firstPrompt] : []),
				...(secondPrompt ? [secondPrompt] : []),
			]);
		}
	});

	it("keeps an admitted preflight prompt claimed until its provider starts and admits an agent_end successor", async () => {
		// Given
		const preflightEntered = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		secondStreamCreated = Promise.withResolvers<void>();
		vi.spyOn(session, "refreshGjcSubskillTools").mockImplementation(async () => {
			preflightEntered.resolve();
			await releasePreflight.promise;
		});
		let successorPrompt: Promise<void> | undefined;
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "agent_end" || successorPrompt) return;
			successorPrompt = session.prompt("agent_end successor prompt");
		});
		const firstPrompt = session.prompt("admitted preflight owner");
		let secondPrompt: Promise<void> | undefined;

		try {
			await preflightEntered.promise;

			// When
			secondPrompt = session.prompt("same-tick competing prompt");
			const sameTickBoundary = Promise.withResolvers<"pending">();
			setImmediate(() => sameTickBoundary.resolve("pending"));
			const secondOutcome = await Promise.race([
				secondPrompt.then(
					() => "resolved" as const,
					error => error,
				),
				sameTickBoundary.promise,
			]);

			// Then
			expect(secondOutcome).toBeInstanceOf(AgentBusyError);
			releasePreflight.resolve();
			await streamCreated.promise;
			const firstMessage = createAssistantMessage("first provider complete");
			activeStream?.push({ type: "done", reason: "stop", message: firstMessage });
			activeStream?.end(firstMessage);
			activeStream = undefined;
			await firstPrompt;
			await secondStreamCreated.promise;
			const successorMessage = createAssistantMessage("successor provider complete");
			getActiveStream()?.push({ type: "done", reason: "stop", message: successorMessage });
			getActiveStream()?.end(successorMessage);
			activeStream = undefined;
			await successorPrompt;
			expect(streamCount).toBe(2);
		} finally {
			releasePreflight.resolve();
			unsubscribe();
			await session.abort();
			await Promise.allSettled([
				firstPrompt,
				...(secondPrompt ? [secondPrompt] : []),
				...(successorPrompt ? [successorPrompt] : []),
			]);
		}
	});

	it("[E] rejects same-session contributor reentrant selection with the stable busy contract", async () => {
		// Given
		let reentrantError: unknown;
		const reentrantSettled = Promise.withResolvers<void>();
		const entriesBefore = sessionManager.getEntries();
		const unregister = session.registerBeforeAgentStartContributor(async () => {
			try {
				await session.setDefaultModelSelection(targetModel(), Effort.High);
			} catch (error) {
				reentrantError = error;
			} finally {
				reentrantSettled.resolve();
			}
			return undefined;
		});
		const prompt = session.prompt("reentrant contributor prompt");

		try {
			// When
			await reentrantSettled.promise;

			// Then
			expect(reentrantError).toBeInstanceOf(AgentBusyError);
			expect(reentrantError).toMatchObject({
				name: "AgentBusyError",
				message: "Default model selection cannot run from a prompt callback in the same session.",
			});
			expect(reentrantError).not.toHaveProperty("code");
			expect(settings.getGlobal("modelRoles")).toBeUndefined();
			expect(session.model).toBe(INITIAL_MODEL);
			expect(sessionManager.getEntries()).toEqual(entriesBefore);
		} finally {
			unregister();
			await session.abort();
			await prompt.catch(() => {});
		}
	});

	it("[E event] marks only an awaited same-session extension model.set callback", async () => {
		// Given
		const initialModel = { ...INITIAL_MODEL, contextWindow: 1_000_000 };
		const reentrantModel = { ...targetModel(), id: "event-reentrant", contextWindow: 1_000_000 };
		const externalModel = { ...targetModel(), id: "event-external", contextWindow: 1_000_000 };
		const detachedModel = { ...targetModel(), id: "event-detached", contextWindow: 1_000_000 };
		const laterModel = { ...targetModel(), id: "event-later", contextWindow: 1_000_000 };
		modelRegistry.registerProvider("target-provider", {
			baseUrl: "https://example.invalid/v1",
			apiKey: "target-key",
			api: "anthropic-messages",
			models: [reentrantModel, externalModel, detachedModel, laterModel],
		});
		const handlerEntered = Promise.withResolvers<void>();
		const releaseHandler = Promise.withResolvers<void>();
		let reentrantError: unknown;
		let detachedCall: (() => Promise<unknown>) | undefined;
		const otherManager = SessionManager.inMemory(path.join(tempRoot, "other-session"));
		const otherSettings = Settings.isolated();
		const otherSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: initialModel, systemPrompt: ["Other"], tools: [] },
			}),
			sessionManager: otherManager,
			settings: otherSettings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		let otherResult: unknown;
		const handler = async (...args: unknown[]): Promise<unknown> => {
			const context = args[1];
			if (
				typeof context !== "object" ||
				context === null ||
				!("sdkControl" in context) ||
				typeof context.sdkControl !== "function"
			) {
				throw new Error("Expected extension SDK control context");
			}
			const sdkControl = context.sdkControl;
			handlerEntered.resolve();
			await releaseHandler.promise;
			const otherSelection = otherSession.setDefaultModelSelection(reentrantModel, Effort.Low);
			try {
				await sdkControl("model.set", { id: "target-provider/event-reentrant", thinkingLevel: "high" });
			} catch (error) {
				reentrantError = error;
			}
			otherResult = await otherSelection;
			detachedCall = () =>
				sdkControl("model.set", {
					id: "target-provider/event-detached",
					thinkingLevel: "low",
				});
			return undefined;
		};
		const extension: Extension = {
			path: "test:event-reentrant",
			resolvedPath: "test:event-reentrant",
			handlers: new Map([["before_agent_start", [handler]]]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		const extensionRunner = new ExtensionRunner(
			[extension],
			new ExtensionRuntime(),
			tempRoot,
			sessionManager,
			modelRegistry,
		);
		await session.dispose();
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: initialModel, systemPrompt: ["Test"], tools: [] },
				streamFn: () => {
					activeStream = new AssistantMessageEventStream();
					streamCount++;
					if (streamCount === 1) streamCreated.resolve();
					return activeStream;
				},
			}),
			sessionManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
			extensionRunner,
		});
		const controller = new ExtensionUiController({
			session,
			sessionManager,
			isBackgrounded: true,
			shutdownRequested: false,
		} as unknown as InteractiveModeContext);
		controller.initializeHookRunner({} as ExtensionUIContext, false);
		const stageSelection = vi.spyOn(sessionManager, "stageDefaultModelSelection");
		const durableSelection = vi.spyOn(settings, "setGlobalModelRoleAndFlush");
		const setLiveModel = vi.spyOn(session.agent, "setModel");
		const prompt = session.prompt("extension reentrant prompt");
		void prompt.catch(() => {});
		let externalSelection: Promise<unknown> | undefined;

		try {
			await handlerEntered.promise;
			externalSelection = session.setDefaultModelSelection(externalModel, Effort.High);
			void externalSelection.catch(() => {});

			// When
			releaseHandler.resolve();
			await streamCreated.promise;

			// Then
			expect(reentrantError).toBeInstanceOf(AgentBusyError);
			expect(reentrantError).toMatchObject({
				name: "AgentBusyError",
				message: "Default model selection cannot run from a prompt callback in the same session.",
			});
			expect(reentrantError).not.toHaveProperty("code");
			expect(stageSelection).not.toHaveBeenCalled();
			expect(durableSelection).not.toHaveBeenCalled();
			expect(setLiveModel).not.toHaveBeenCalled();
			expect(settings.getGlobal("modelRoles")).toBeUndefined();
			expect(session.model).toBe(initialModel);
			expect(otherResult).toEqual({
				provider: "target-provider",
				modelId: "event-reentrant",
				thinkingLevel: Effort.Low,
			});
			const message = createAssistantMessage("event prompt complete");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await expect(externalSelection).resolves.toEqual({
				provider: "target-provider",
				modelId: "event-external",
				thinkingLevel: Effort.High,
			});
			await prompt;
			expect(streamCount).toBe(1);
			const callDetached = detachedCall;
			if (!callDetached) throw new Error("Expected detached model selection callback");
			await expect(callDetached()).resolves.toEqual({
				provider: "target-provider",
				modelId: "event-detached",
				thinkingLevel: Effort.Low,
			});
			await expect(session.setDefaultModelSelection(laterModel, Effort.High)).resolves.toEqual({
				provider: "target-provider",
				modelId: "event-later",
				thinkingLevel: Effort.High,
			});
		} finally {
			releaseHandler.resolve();
			await session.abort();
			await Promise.allSettled([prompt, ...(externalSelection ? [externalSelection] : [])]);
			await otherSession.dispose();
		}
	});

	it("rejects same-session model.set from an awaited message_end extension handler", async () => {
		// Given
		const initialModel = { ...INITIAL_MODEL, contextWindow: 1_000_000 };
		const eventModel = { ...targetModel(), id: "message-end-reentrant", contextWindow: 1_000_000 };
		modelRegistry.registerProvider("target-provider", {
			baseUrl: "https://example.invalid/v1",
			apiKey: "target-key",
			api: "anthropic-messages",
			models: [eventModel],
		});
		const handlerEntered = Promise.withResolvers<void>();
		const handlerSettled = Promise.withResolvers<unknown>();
		const handler = async (...args: unknown[]): Promise<unknown> => {
			const event = args[0];
			if (
				typeof event !== "object" ||
				event === null ||
				!("message" in event) ||
				typeof event.message !== "object" ||
				event.message === null ||
				!("role" in event.message) ||
				event.message.role !== "assistant"
			) {
				return undefined;
			}
			const context = args[1];
			if (
				typeof context !== "object" ||
				context === null ||
				!("sdkControl" in context) ||
				typeof context.sdkControl !== "function"
			) {
				throw new Error("Expected extension SDK control context");
			}
			handlerEntered.resolve();
			try {
				await context.sdkControl("model.set", {
					id: "target-provider/message-end-reentrant",
					thinkingLevel: "high",
				});
				handlerSettled.resolve(undefined);
			} catch (error) {
				handlerSettled.resolve(error);
			}
			return undefined;
		};
		const extension: Extension = {
			path: "test:message-end-reentrant",
			resolvedPath: "test:message-end-reentrant",
			handlers: new Map([["message_end", [handler]]]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		const extensionRunner = new ExtensionRunner(
			[extension],
			new ExtensionRuntime(),
			tempRoot,
			sessionManager,
			modelRegistry,
		);
		await session.dispose();
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: initialModel, systemPrompt: ["Test"], tools: [] },
				streamFn: () => {
					activeStream = new AssistantMessageEventStream();
					streamCreated.resolve();
					return activeStream;
				},
			}),
			sessionManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
			extensionRunner,
		});
		const controller = new ExtensionUiController({
			session,
			sessionManager,
			isBackgrounded: true,
			shutdownRequested: false,
		} as unknown as InteractiveModeContext);
		controller.initializeHookRunner({} as ExtensionUIContext, false);
		const stageSelection = vi.spyOn(sessionManager, "stageDefaultModelSelection");
		const durableSelection = vi.spyOn(settings, "setGlobalModelRoleAndFlush");
		const setLiveModel = vi.spyOn(session.agent, "setModel");
		const prompt = session.prompt("awaited message_end selection");
		void prompt.catch(() => {});

		try {
			await streamCreated.promise;

			// When
			const message = createAssistantMessage("message_end selection attempt");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await handlerEntered.promise;
			const eventLoopBoundary = Promise.withResolvers<"pending">();
			setImmediate(() => eventLoopBoundary.resolve("pending"));
			const outcome = await Promise.race([handlerSettled.promise, eventLoopBoundary.promise]);

			// Then
			expect(outcome).toBeInstanceOf(AgentBusyError);
			expect(outcome).toMatchObject({
				name: "AgentBusyError",
				message: "Default model selection cannot run from a prompt callback in the same session.",
			});
			expect(outcome).not.toHaveProperty("code");
			expect(stageSelection).not.toHaveBeenCalled();
			expect(durableSelection).not.toHaveBeenCalled();
			expect(setLiveModel).not.toHaveBeenCalled();
			expect(settings.getGlobal("modelRoles")).toBeUndefined();
			expect(session.model).toBe(initialModel);
			await prompt;
		} finally {
			await session.dispose();
			await prompt.catch(() => {});
		}
	});

	it("[F] aborts an active preflight caller and releases its queued selector", async () => {
		// Given
		const contributorEntered = Promise.withResolvers<void>();
		const releaseContributor = Promise.withResolvers<void>();
		const stageEntered = Promise.withResolvers<void>();
		const releaseStage = Promise.withResolvers<void>();
		const unregister = session.registerBeforeAgentStartContributor(async () => {
			contributorEntered.resolve();
			await releaseContributor.promise;
			return undefined;
		});
		const originalStage = sessionManager.stageDefaultModelSelection.bind(sessionManager);
		const stageSelection = vi
			.spyOn(sessionManager, "stageDefaultModelSelection")
			.mockImplementation(async (...args) => {
				stageEntered.resolve();
				await releaseStage.promise;
				return originalStage(...args);
			});
		const prompt = session.sendUserMessage("abort active preflight", { onPreflightAccepted: () => {} });
		void prompt.catch(() => {});
		let selection: Promise<unknown> | undefined;

		try {
			await contributorEntered.promise;
			selection = session.setDefaultModelSelection({ ...targetModel(), id: "abort-successor" }, Effort.High);
			void selection.catch(() => {});
			await new Promise<void>(resolve => setImmediate(resolve));
			const stageCallsBeforeAbort = stageSelection.mock.calls.length;

			// When
			await session.abort();

			// Then
			await expect(prompt).rejects.toMatchObject({
				code: "busy",
				message: "Prompt preflight was cancelled before execution.",
			});
			await stageEntered.promise;
			expect(stageCallsBeforeAbort).toBe(0);
			releaseStage.resolve();
			await expect(selection).resolves.toEqual({
				provider: "target-provider",
				modelId: "abort-successor",
				thinkingLevel: Effort.High,
			});
		} finally {
			releaseContributor.resolve();
			releaseStage.resolve();
			unregister();
			await Promise.allSettled([prompt, ...(selection ? [selection] : [])]);
		}
	});

	for (const callbackAction of [
		{ verb: "aborts", invoke: (currentSession: AgentSession) => currentSession.abort() },
		{ verb: "disposes", invoke: (currentSession: AgentSession) => currentSession.dispose() },
	] as const) {
		it(`rejects an accepted preflight when its callback ${callbackAction.verb} the same session before provider transport`, async () => {
			// Given
			let callbackOperation: Promise<void> | undefined;
			const prompt = session.prompt(`${callbackAction.verb} from accepted preflight`, {
				onPreflightAccepted: () => {
					callbackOperation = callbackAction.invoke(session);
				},
			});
			const promptOutcome = prompt.then(
				() => ({ kind: "fulfilled" as const }),
				(error: unknown) => ({ kind: "rejected" as const, error }),
			);

			// When
			const firstOutcome = await Promise.race([
				promptOutcome,
				streamCreated.promise.then(() => ({
					kind: "provider_started" as const,
					signalAborted: providerSignalAborted,
				})),
			]);

			// Then
			if (firstOutcome.kind === "provider_started" && activeStream) {
				const message = createAssistantMessage("provider should not have started after callback cancellation");
				activeStream.push({ type: "done", reason: "stop", message });
				activeStream.end(message);
				activeStream = undefined;
			}
			await prompt.catch(() => {});
			await callbackOperation;
			expect(firstOutcome).toMatchObject({
				kind: "rejected",
				error: {
					code: "busy",
					message: "Prompt preflight was cancelled before execution.",
				},
			});
			expect(streamCount).toBe(0);
		});
	}

	it("[G] promptly cancels a prompt queued behind selection without mutation or overtaking", async () => {
		// Given
		const selectionFlushEntered = Promise.withResolvers<void>();
		const releaseSelectionFlush = Promise.withResolvers<void>();
		const originalFlush = sessionManager.flush.bind(sessionManager);
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			selectionFlushEntered.resolve();
			await releaseSelectionFlush.promise;
			return originalFlush();
		});
		const entriesBefore = sessionManager.getEntries();
		const transcriptBefore = session.agent.state.messages;
		const refreshSubskills = vi.spyOn(session, "refreshGjcSubskillTools");
		const terminalRuntimePersisted = Promise.withResolvers<void>();
		const originalWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (destination, input, options) => {
			const bytesWritten: number = await Reflect.apply(originalWrite, Bun, [destination, input, options]);
			if (
				typeof destination === "string" &&
				destination.startsWith(tempRoot) &&
				typeof input === "string" &&
				input.includes('"event":"agent_end"')
			) {
				terminalRuntimePersisted.resolve();
			}
			return bytesWritten;
		});
		const promptContributors: string[] = [];
		const order: string[] = [];
		const unregister = session.registerBeforeAgentStartContributor(async event => {
			promptContributors.push(event.prompt);
			return undefined;
		});
		const originalCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (role, selector) => {
			if (selector?.includes("cancel-owner")) order.push("S1");
			if (selector?.includes("cancel-successor")) order.push("S2");
			return originalCommit(role, selector);
		});
		const firstSelection = session.setDefaultModelSelection({ ...targetModel(), id: "cancel-owner" }, Effort.Low);
		let cancelledPrompt: Promise<void> | undefined;
		let laterSelection: Promise<unknown> | undefined;
		let laterPrompt: Promise<void> | undefined;

		try {
			await selectionFlushEntered.promise;
			cancelledPrompt = session.prompt("architecture migration queued cancellation");
			laterSelection = session.setDefaultModelSelection({ ...targetModel(), id: "cancel-successor" }, Effort.High);

			// When
			await session.abort();
			await cancelledPrompt;

			// Then
			expect(sessionManager.getEntries()).toEqual(entriesBefore);
			expect(session.agent.state.messages).toEqual(transcriptBefore);
			expect(refreshSubskills).not.toHaveBeenCalled();
			expect(promptContributors).toEqual([]);
			expect(streamCount).toBe(0);
			expect(order).toEqual([]);

			releaseSelectionFlush.resolve();
			await firstSelection;
			await laterSelection;
			expect(order).toEqual(["S1", "S2"]);
			expect(promptContributors).toEqual([]);

			laterPrompt = session.prompt("prompt after cancelled admission tombstone");
			await streamCreated.promise;
			const message = createAssistantMessage("case G later prompt complete");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await laterPrompt;
			await terminalRuntimePersisted.promise;
			expect(promptContributors).toEqual(["prompt after cancelled admission tombstone"]);
		} finally {
			releaseSelectionFlush.resolve();
			unregister();
			await firstSelection;
			if (cancelledPrompt) await cancelledPrompt;
			if (laterSelection) await laterSelection;
			if (laterPrompt) await laterPrompt;
		}
	});

	it("[L] keeps a selector behind its predecessor prompt's recovery continuation", async () => {
		// Given
		settings.set("compaction.enabled", false);
		settings.set("retry.baseDelayMs", 1);
		secondStreamCreated = Promise.withResolvers<void>();
		const retryBackoffEntered = Promise.withResolvers<void>();
		const releaseRetryBackoff = Promise.withResolvers<void>();
		const continuationDelayEntered = Promise.withResolvers<void>();
		const releaseContinuationDelay = Promise.withResolvers<void>();
		let schedulerCall = 0;
		vi.spyOn(scheduler, "wait").mockImplementation(async () => {
			schedulerCall++;
			if (schedulerCall === 1) {
				retryBackoffEntered.resolve();
				await releaseRetryBackoff.promise;
				return;
			}
			if (schedulerCall === 2) {
				continuationDelayEntered.resolve();
				await releaseContinuationDelay.promise;
				return;
			}
			throw new Error("Unexpected recovery scheduler wait");
		});
		const order: string[] = [];
		const originalContinue = session.agent.continue.bind(session.agent);
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			order.push("P1 recovery start");
			await originalContinue();
		});
		const unsubscribe = session.subscribe(event => {
			if (event.type === "auto_retry_start") order.push("P1 recovery scheduled");
			if (event.type === "auto_retry_end" && event.success) order.push("P1 recovery complete");
		});
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		let selectionValidationRecorded = false;
		const validateSelection = vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model.provider === "target-provider" && !selectionValidationRecorded) {
				selectionValidationRecorded = true;
				order.push("S1 validate");
			}
			return originalGetApiKey(model, ...args);
		});
		const originalStage = sessionManager.stageDefaultModelSelection.bind(sessionManager);
		const stageSelection = vi
			.spyOn(sessionManager, "stageDefaultModelSelection")
			.mockImplementation(async (...args) => {
				order.push("S1 stage");
				return originalStage(...args);
			});
		const originalCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		const commitSelection = vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			order.push("S1 commit");
			return originalCommit(...args);
		});
		const originalSetModel = session.agent.setModel.bind(session.agent);
		const publishSelection = vi.spyOn(session.agent, "setModel").mockImplementation(model => {
			order.push("S1 publish");
			originalSetModel(model);
		});
		const prompt = session.prompt("P1 schedules one recovery continuation");
		await streamCreated.promise;
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);
		const retryableMessage = createAssistantMessage("P1 retryable provider failure");
		retryableMessage.stopReason = "error";
		retryableMessage.errorMessage = "503 service unavailable: overloaded_error";

		try {
			// When
			activeStream?.push({ type: "error", reason: "error", error: retryableMessage });
			activeStream?.end(retryableMessage);
			activeStream = undefined;
			await retryBackoffEntered.promise;
			releaseRetryBackoff.resolve();
			await continuationDelayEntered.promise;
			releaseContinuationDelay.resolve();
			await secondStreamCreated.promise;

			// Then
			expect(order).toEqual(["P1 recovery scheduled", "P1 recovery start"]);
			expect(session.model).toBe(INITIAL_MODEL);
			expect(validateSelection.mock.calls.filter(([model]) => model.provider === "target-provider")).toHaveLength(0);
			expect(stageSelection).not.toHaveBeenCalled();
			expect(commitSelection).not.toHaveBeenCalled();
			expect(publishSelection).not.toHaveBeenCalled();

			const recoveredMessage = createAssistantMessage("P1 recovery complete");
			getActiveStream()?.push({ type: "done", reason: "stop", message: recoveredMessage });
			getActiveStream()?.end(recoveredMessage);
			activeStream = undefined;
			await prompt;
			await selection;
			expect(order).toEqual([
				"P1 recovery scheduled",
				"P1 recovery start",
				"P1 recovery complete",
				"S1 validate",
				"S1 stage",
				"S1 commit",
				"S1 publish",
			]);
		} finally {
			releaseRetryBackoff.resolve();
			releaseContinuationDelay.resolve();
			if (activeStream) {
				const message =
					streamCount === 1 ? retryableMessage : createAssistantMessage("case L recovery cleanup complete");
				if (message.stopReason === "error") {
					activeStream.push({ type: "error", reason: "error", error: message });
				} else {
					activeStream.push({ type: "done", reason: "stop", message });
				}
				activeStream.end(message);
				activeStream = undefined;
			}
			if (streamCount === 1) {
				await secondStreamCreated.promise;
				const message = createAssistantMessage("case L recovery cleanup complete");
				getActiveStream()?.push({ type: "done", reason: "stop", message });
				getActiveStream()?.end(message);
				activeStream = undefined;
			}
			await prompt;
			await selection;
			unsubscribe();
		}
	});

	it("[H2] orders a failed selector before its queued prompt and later selector", async () => {
		// Given
		const failureEntered = Promise.withResolvers<void>();
		const releaseFailure = Promise.withResolvers<void>();
		const failure = new Error("matrix selector failure");
		const promptContributorEntered = Promise.withResolvers<void>();
		const releasePromptContributor = Promise.withResolvers<void>();
		const order: string[] = [];
		const refreshSubskills = vi.spyOn(session, "refreshGjcSubskillTools");
		const originalCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush")
			.mockImplementationOnce(async () => {
				order.push("S1 failure");
				failureEntered.resolve();
				await releaseFailure.promise;
				throw failure;
			})
			.mockImplementation(async (role, selector) => {
				order.push("S2");
				return originalCommit(role, selector);
			});
		const unregister = session.registerBeforeAgentStartContributor(async () => {
			order.push("P");
			promptContributorEntered.resolve();
			await releasePromptContributor.promise;
			return undefined;
		});
		const first = session.setDefaultModelSelection({ ...targetModel(), id: "failure-owner" }, Effort.Low);
		void first.catch(() => {});
		let prompt: Promise<void> | undefined;
		let second: Promise<unknown> | undefined;

		try {
			await failureEntered.promise;
			prompt = session.prompt("prompt after failed selector");
			second = session.setDefaultModelSelection({ ...targetModel(), id: "failure-successor" }, Effort.High);
			void prompt.catch(() => {});
			void second.catch(() => {});

			// When / Then
			expect(refreshSubskills).not.toHaveBeenCalled();
			expect(order).toEqual(["S1 failure"]);
			releaseFailure.resolve();
			await expect(first).rejects.toBe(failure);
			await promptContributorEntered.promise;
			expect(order).toEqual(["S1 failure", "P"]);
			releasePromptContributor.resolve();
			await streamCreated.promise;
			const message = createAssistantMessage("case H2 provider complete");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await second;
			expect(order).toEqual(["S1 failure", "P", "S2"]);
		} finally {
			releaseFailure.resolve();
			releasePromptContributor.resolve();
			unregister();
			if (prompt) await streamCreated.promise;
			const message = createAssistantMessage("case H2 cleanup");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await Promise.allSettled([first, ...(prompt ? [prompt] : []), ...(second ? [second] : [])]);
		}
	});

	it("keeps a queued selector behind promotion recovery until staged discard settles", async () => {
		// Given
		const recoveryEntered = Promise.withResolvers<void>();
		const releaseRecovery = Promise.withResolvers<void>();
		const promotionError = new Error("S1 promotion failed");
		const order: string[] = [];
		const originalDiscard = sessionManager.discardDefaultModelSelectionStage.bind(sessionManager);
		vi.spyOn(sessionManager, "discardDefaultModelSelectionStage").mockImplementation(async stage => {
			order.push("S1 recovery start");
			recoveryEntered.resolve();
			await releaseRecovery.promise;
			await originalDiscard(stage);
			order.push("S1 recovery settled");
		});
		vi.spyOn(sessionManager, "promoteDefaultModelSelection").mockReturnValueOnce({
			kind: "not_promoted",
			error: promotionError,
		});
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model.id === "recovery-successor") order.push("S2 validate");
			return originalGetApiKey(model, ...args);
		});
		const first = session.setDefaultModelSelection({ ...targetModel(), id: "recovery-owner" }, Effort.Low);
		void first.catch(() => {});
		let second: Promise<unknown> | undefined;

		try {
			await recoveryEntered.promise;

			// When
			second = session.setDefaultModelSelection({ ...targetModel(), id: "recovery-successor" }, Effort.High);
			void second.catch(() => {});
			await new Promise<void>(resolve => setImmediate(resolve));

			// Then
			expect(order).toEqual(["S1 recovery start"]);
			releaseRecovery.resolve();
			await expectPostDurableSelectionRecovery(first, {
				message: promotionError.message,
				rollback: { disposition: "restored", failures: [] },
			});
			await second;
			expect(order).toEqual(["S1 recovery start", "S1 recovery settled", "S2 validate"]);
		} finally {
			releaseRecovery.resolve();
			await Promise.allSettled([first, ...(second ? [second] : [])]);
		}
	});

	it("[I] preserves public waitForIdle semantics while selection owns admission", async () => {
		// Given
		const selectionFlushEntered = Promise.withResolvers<void>();
		const releaseSelectionFlush = Promise.withResolvers<void>();
		const refreshEntered = Promise.withResolvers<void>();
		const releaseRefresh = Promise.withResolvers<void>();
		const promptContributorEntered = Promise.withResolvers<void>();
		const releasePromptContributor = Promise.withResolvers<void>();
		const originalFlush = sessionManager.flush.bind(sessionManager);
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			selectionFlushEntered.resolve();
			await releaseSelectionFlush.promise;
			return originalFlush();
		});
		vi.spyOn(session, "refreshGjcSubskillTools").mockImplementation(async () => {
			refreshEntered.resolve();
			await releaseRefresh.promise;
		});
		const unregister = session.registerBeforeAgentStartContributor(async () => {
			promptContributorEntered.resolve();
			await releasePromptContributor.promise;
			return undefined;
		});
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);
		let prompt: Promise<void> | undefined;

		try {
			await selectionFlushEntered.promise;
			prompt = session.prompt("queued prompt ignored by public idle waiter");

			// When / Then
			await session.waitForIdle();
			expect(streamCount).toBe(0);
		} finally {
			releaseSelectionFlush.resolve();
			await refreshEntered.promise;
			releaseRefresh.resolve();
			await promptContributorEntered.promise;
			await session.abort();
			releasePromptContributor.resolve();
			unregister();
			await Promise.allSettled([selection, ...(prompt ? [prompt] : [])]);
		}
	});

	it("[J1] drains an earlier streaming steer before committing a later selector", async () => {
		// Given
		secondStreamCreated = Promise.withResolvers<void>();
		const order: string[] = [];
		const originalCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			order.push("selection committed");
			return originalCommit(...args);
		});
		const providerPrompt = session.prompt("provider stream owner");
		await streamCreated.promise;

		// When
		await session.prompt("streaming steer before selector", { streamingBehavior: "steer" });
		order.push("steer diverted");
		const selection = session.setDefaultModelSelection({ ...targetModel(), id: "after-steer" }, Effort.High);

		// Then
		expect(session.getQueuedMessages()).toEqual({
			steering: ["streaming steer before selector"],
			followUp: [],
		});
		expect(order).toEqual(["steer diverted"]);
		const firstMessage = createAssistantMessage("first stream complete");
		activeStream?.push({ type: "done", reason: "stop", message: firstMessage });
		activeStream?.end(firstMessage);
		activeStream = undefined;
		await secondStreamCreated.promise;
		expect(order).toEqual(["steer diverted"]);
		const steeredMessage = createAssistantMessage("steer complete");
		getActiveStream()?.push({ type: "done", reason: "stop", message: steeredMessage });
		getActiveStream()?.end(steeredMessage);
		activeStream = undefined;
		await providerPrompt;
		await expect(selection).resolves.toEqual({
			provider: "target-provider",
			modelId: "after-steer",
			thinkingLevel: Effort.High,
		});
		expect(order).toEqual(["steer diverted", "selection committed"]);
	});

	it("[J2] keeps a later streaming follow-up outside selector admission and drains it before commit", async () => {
		// Given
		secondStreamCreated = Promise.withResolvers<void>();
		const order: string[] = [];
		const originalCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			order.push("selection committed");
			return originalCommit(...args);
		});
		const providerPrompt = session.prompt("provider stream owner");
		await streamCreated.promise;
		const selection = session.setDefaultModelSelection({ ...targetModel(), id: "after-follow-up" }, Effort.High);

		// When
		await session.prompt("streaming follow-up after selector", { streamingBehavior: "followUp" });
		order.push("follow-up diverted");

		// Then
		expect(session.getQueuedMessages()).toEqual({
			steering: [],
			followUp: ["streaming follow-up after selector"],
		});
		expect(order).toEqual(["follow-up diverted"]);
		const firstMessage = createAssistantMessage("first stream complete");
		activeStream?.push({ type: "done", reason: "stop", message: firstMessage });
		activeStream?.end(firstMessage);
		activeStream = undefined;
		await secondStreamCreated.promise;
		expect(order).toEqual(["follow-up diverted"]);
		const followUpMessage = createAssistantMessage("follow-up complete");
		getActiveStream()?.push({ type: "done", reason: "stop", message: followUpMessage });
		getActiveStream()?.end(followUpMessage);
		activeStream = undefined;
		await providerPrompt;
		await expect(selection).resolves.toEqual({
			provider: "target-provider",
			modelId: "after-follow-up",
			thinkingLevel: Effort.High,
		});
		expect(order).toEqual(["follow-up diverted", "selection committed"]);
	});

	it("keeps an idle follow-up queued behind an earlier selector", async () => {
		// Given
		session.agent.appendMessage(createAssistantMessage("idle follow-up predecessor"));
		const stageEntered = Promise.withResolvers<void>();
		const releaseStage = Promise.withResolvers<void>();
		const originalStage = sessionManager.stageDefaultModelSelection.bind(sessionManager);
		vi.spyOn(sessionManager, "stageDefaultModelSelection").mockImplementation(async (...args) => {
			stageEntered.resolve();
			await releaseStage.promise;
			return originalStage(...args);
		});
		const selection = session.setDefaultModelSelection(
			{ ...targetModel(), id: "idle-follow-up-selector-owner" },
			Effort.High,
		);

		try {
			await stageEntered.promise;

			// When
			await session.followUp("idle follow-up after selector");
			await new Promise<void>(resolve => setImmediate(resolve));

			// Then
			expect(streamCount).toBe(0);
			releaseStage.resolve();
			await selection;
			await streamCreated.promise;
			const message = createAssistantMessage("idle follow-up after selector complete");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await session.waitForIdle();
		} finally {
			releaseStage.resolve();
			if (activeStream) {
				const message = createAssistantMessage("idle follow-up selector-first cleanup");
				activeStream.push({ type: "done", reason: "stop", message });
				activeStream.end(message);
				activeStream = undefined;
			}
			await Promise.allSettled([selection]);
		}
	});

	it("coalesces an idle follow-up behind a prompt already queued after a selector", async () => {
		// Given
		session.agent.appendMessage(createAssistantMessage("pending prompt queue predecessor"));
		secondStreamCreated = Promise.withResolvers<void>();
		const stageEntered = Promise.withResolvers<void>();
		const releaseStage = Promise.withResolvers<void>();
		const order: string[] = [];
		const originalStage = sessionManager.stageDefaultModelSelection.bind(sessionManager);
		vi.spyOn(sessionManager, "stageDefaultModelSelection").mockImplementation(async (...args) => {
			stageEntered.resolve();
			await releaseStage.promise;
			return originalStage(...args);
		});
		const originalCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			order.push("selector");
			return originalCommit(...args);
		});
		const selection = session.setDefaultModelSelection(
			{ ...targetModel(), id: "selector-before-prompt-and-follow-up" },
			Effort.High,
		);
		let prompt: Promise<void> | undefined;

		try {
			await stageEntered.promise;
			prompt = session.prompt("normal prompt behind selector");
			void prompt.catch(() => {});

			// When
			const followUpOutcome = await Promise.allSettled([session.followUp("idle follow-up behind pending prompt")]);

			// Then
			expect(streamCount).toBe(0);
			expect(session.getQueuedMessages()).toEqual({
				steering: [],
				followUp: ["idle follow-up behind pending prompt"],
			});

			releaseStage.resolve();
			await selection;
			await streamCreated.promise;
			order.push("prompt");
			expect(streamCount).toBe(1);
			const promptMessage = createAssistantMessage("normal prompt complete");
			activeStream?.push({ type: "done", reason: "stop", message: promptMessage });
			activeStream?.end(promptMessage);
			activeStream = undefined;
			await secondStreamCreated.promise;
			order.push("follow-up");
			expect(streamCount).toBe(2);
			const followUpMessage = createAssistantMessage("idle follow-up complete");
			getActiveStream()?.push({ type: "done", reason: "stop", message: followUpMessage });
			getActiveStream()?.end(followUpMessage);
			activeStream = undefined;
			await prompt;
			expect(followUpOutcome).toEqual([{ status: "fulfilled", value: undefined }]);
			expect(order).toEqual(["selector", "prompt", "follow-up"]);
			expect(
				session.agent.state.messages.filter(message => message.role === "user").map(message => message.content),
			).toEqual([
				[{ type: "text", text: "normal prompt behind selector" }],
				[{ type: "text", text: "idle follow-up behind pending prompt" }],
			]);
		} finally {
			releaseStage.resolve();
			if (activeStream) {
				const message = createAssistantMessage("pending prompt coalescing cleanup");
				activeStream.push({ type: "done", reason: "stop", message });
				activeStream.end(message);
				activeStream = undefined;
			}
			await Promise.allSettled([selection, ...(prompt ? [prompt] : [])]);
		}
	});

	it("transfers a coalesced follow-up before a later selector when its pending prompt is cancelled", async () => {
		// Given
		session.agent.appendMessage(createAssistantMessage("transferred follow-up predecessor"));
		const firstStageEntered = Promise.withResolvers<void>();
		const releaseFirstStage = Promise.withResolvers<void>();
		const promptPreflightEntered = Promise.withResolvers<void>();
		const releasePromptPreflight = Promise.withResolvers<void>();
		const unregister = session.registerBeforeAgentStartContributor(async () => {
			promptPreflightEntered.resolve();
			await releasePromptPreflight.promise;
			return undefined;
		});
		const originalStage = sessionManager.stageDefaultModelSelection.bind(sessionManager);
		vi.spyOn(sessionManager, "stageDefaultModelSelection").mockImplementation(async (...args) => {
			firstStageEntered.resolve();
			await releaseFirstStage.promise;
			return originalStage(...args);
		});
		const laterSelectionValidationEntered = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation((model, ...args) => {
			if (model.id === "later-selector-after-transferred-follow-up") {
				laterSelectionValidationEntered.resolve();
			}
			return originalGetApiKey(model, ...args);
		});
		const firstSelection = session.setDefaultModelSelection(
			{ ...targetModel(), id: "selector-holding-prompt-admission" },
			Effort.Low,
		);
		let prompt: Promise<void> | undefined;
		let laterSelection: Promise<unknown> | undefined;

		try {
			await firstStageEntered.promise;
			prompt = session.prompt("normal prompt carrying an idle follow-up");
			void prompt.catch(() => {});
			await session.followUp("follow-up submitted before later selector");
			laterSelection = session.setDefaultModelSelection(
				{ ...targetModel(), id: "later-selector-after-transferred-follow-up" },
				Effort.High,
			);
			void laterSelection.catch(() => {});
			releaseFirstStage.resolve();
			await firstSelection;
			await promptPreflightEntered.promise;

			// When
			await session.abort();
			await prompt;
			const firstSuccessor = await Promise.race([
				streamCreated.promise.then(() => "follow-up-provider" as const),
				laterSelectionValidationEntered.promise.then(() => "later-selector-validation" as const),
			]);
			await streamCreated.promise;
			const followUpMessage = createAssistantMessage("transferred follow-up complete");
			activeStream?.push({ type: "done", reason: "stop", message: followUpMessage });
			activeStream?.end(followUpMessage);
			activeStream = undefined;
			await laterSelection;

			// Then
			expect(firstSuccessor).toBe("follow-up-provider");
			expect(streamCount).toBe(1);
		} finally {
			releaseFirstStage.resolve();
			releasePromptPreflight.resolve();
			unregister();
			if (activeStream) {
				const message = createAssistantMessage("transferred follow-up cleanup");
				activeStream.push({ type: "done", reason: "stop", message });
				activeStream.end(message);
				activeStream = undefined;
			}
			await Promise.allSettled([
				firstSelection,
				...(prompt ? [prompt] : []),
				...(laterSelection ? [laterSelection] : []),
			]);
		}
	});

	it("transfers idle follow-up delivery when its pending prompt is cancelled", async () => {
		// Given
		session.agent.appendMessage(createAssistantMessage("cancelled pending prompt predecessor"));
		const stageEntered = Promise.withResolvers<void>();
		const releaseStage = Promise.withResolvers<void>();
		const originalStage = sessionManager.stageDefaultModelSelection.bind(sessionManager);
		vi.spyOn(sessionManager, "stageDefaultModelSelection").mockImplementation(async (...args) => {
			stageEntered.resolve();
			await releaseStage.promise;
			return originalStage(...args);
		});
		const selection = session.setDefaultModelSelection(
			{ ...targetModel(), id: "selector-before-cancelled-prompt" },
			Effort.High,
		);
		let prompt: Promise<void> | undefined;

		try {
			await stageEntered.promise;
			prompt = session.prompt("pending prompt cancelled before admission");
			void prompt.catch(() => {});
			await session.followUp("follow-up surviving pending prompt cancellation");

			// When
			await session.abort();
			await prompt;
			releaseStage.resolve();
			await selection;
			await streamCreated.promise;

			// Then
			expect(streamCount).toBe(1);
			const message = createAssistantMessage("surviving follow-up complete");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await session.waitForIdle();
			expect(
				session.agent.state.messages.filter(message => message.role === "user").map(message => message.content),
			).toEqual([[{ type: "text", text: "follow-up surviving pending prompt cancellation" }]]);
		} finally {
			releaseStage.resolve();
			if (activeStream) {
				const message = createAssistantMessage("pending prompt cancellation cleanup");
				activeStream.push({ type: "done", reason: "stop", message });
				activeStream.end(message);
				activeStream = undefined;
			}
			await Promise.allSettled([selection, ...(prompt ? [prompt] : [])]);
		}
	});

	it("keeps a later selector behind an idle follow-up reservation", async () => {
		// Given
		session.agent.appendMessage(createAssistantMessage("idle follow-up predecessor"));
		const continueEntered = Promise.withResolvers<void>();
		const continueSettled = Promise.withResolvers<void>();
		const originalContinue = session.agent.continue.bind(session.agent);
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueEntered.resolve();
			await originalContinue();
			continueSettled.resolve();
		});
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		const validateSelection = vi
			.spyOn(modelRegistry, "getApiKey")
			.mockImplementation((model, ...args) => originalGetApiKey(model, ...args));

		// When
		await session.followUp("idle follow-up before selector");
		const selection = session.setDefaultModelSelection(
			{ ...targetModel(), id: "idle-follow-up-selector-successor" },
			Effort.Low,
		);
		void selection.catch(() => {});

		try {
			await continueEntered.promise;
			await streamCreated.promise;

			// Then
			expect(validateSelection.mock.calls.filter(([model]) => model.provider === "target-provider")).toHaveLength(0);
			const message = createAssistantMessage("idle follow-up before selector complete");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await continueSettled.promise;
			await expect(selection).resolves.toEqual({
				provider: "target-provider",
				modelId: "idle-follow-up-selector-successor",
				thinkingLevel: Effort.Low,
			});
		} finally {
			if (activeStream) {
				const message = createAssistantMessage("idle follow-up-first cleanup");
				activeStream.push({ type: "done", reason: "stop", message });
				activeStream.end(message);
				activeStream = undefined;
			}
			await Promise.allSettled([selection]);
		}
	});

	it("coalesces rapid idle follow-ups behind one continuation reservation", async () => {
		// Given
		session.agent.appendMessage(createAssistantMessage("rapid idle follow-up predecessor"));
		secondStreamCreated = Promise.withResolvers<void>();
		const continuationSettled = Promise.withResolvers<void>();
		const order: string[] = [];
		const originalContinue = session.agent.continue.bind(session.agent);
		const continueCall = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			order.push("continuation start");
			await originalContinue();
			order.push("continuation complete");
			continuationSettled.resolve();
		});
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation((model, ...args) => {
			if (model.provider === "target-provider") order.push("selector validate");
			return originalGetApiKey(model, ...args);
		});

		// When
		const firstFollowUp = session.followUp("rapid idle follow-up one");
		const secondFollowUp = session.followUp("rapid idle follow-up two");
		const selection = session.setDefaultModelSelection(
			{ ...targetModel(), id: "selector-after-rapid-idle-follow-ups" },
			Effort.High,
		);
		void selection.catch(() => {});
		const followUpOutcomes = await Promise.allSettled([firstFollowUp, secondFollowUp]);

		try {
			await streamCreated.promise;

			// Then
			expect(streamCount).toBe(1);
			expect(order).toEqual(["continuation start"]);
			const firstMessage = createAssistantMessage("rapid idle follow-up one complete");
			activeStream?.push({ type: "done", reason: "stop", message: firstMessage });
			activeStream?.end(firstMessage);
			activeStream = undefined;
			await secondStreamCreated.promise;
			expect(streamCount).toBe(2);
			expect(order).toEqual(["continuation start"]);
			const secondMessage = createAssistantMessage("rapid idle follow-up two complete");
			getActiveStream()?.push({ type: "done", reason: "stop", message: secondMessage });
			getActiveStream()?.end(secondMessage);
			activeStream = undefined;
			await continuationSettled.promise;
			await expect(selection).resolves.toEqual({
				provider: "target-provider",
				modelId: "selector-after-rapid-idle-follow-ups",
				thinkingLevel: Effort.High,
			});
			expect(followUpOutcomes).toEqual([
				{ status: "fulfilled", value: undefined },
				{ status: "fulfilled", value: undefined },
			]);
			expect(continueCall).toHaveBeenCalledTimes(1);
			expect(
				session.agent.state.messages
					.filter(message => message.role === "user")
					.map(message => ({ role: message.role, content: message.content, attribution: message.attribution })),
			).toEqual([
				{
					role: "user",
					content: [{ type: "text", text: "rapid idle follow-up one" }],
					attribution: "user",
				},
				{
					role: "user",
					content: [{ type: "text", text: "rapid idle follow-up two" }],
					attribution: "user",
				},
			]);
			expect(order).toEqual(["continuation start", "continuation complete", "selector validate"]);
		} finally {
			if (activeStream) {
				const message = createAssistantMessage("rapid idle follow-up cleanup");
				activeStream.push({ type: "done", reason: "stop", message });
				activeStream.end(message);
				activeStream = undefined;
			}
			await Promise.allSettled([selection]);
		}
	});

	it("[Y] serializes idle async-result delivery with selector admission in both arrival orders", async () => {
		// Given
		const idleFlushDelayEntered = Promise.withResolvers<void>();
		const releaseIdleFlushDelay = Promise.withResolvers<void>();
		vi.spyOn(scheduler, "wait").mockImplementation(async () => {
			idleFlushDelayEntered.resolve();
			await releaseIdleFlushDelay.promise;
		});
		const unregisterYield = session.yieldQueue.register<string>("selection-admission-async-result", {
			build: entries => ({
				role: "custom",
				customType: "async-result",
				content: entries.join("\n"),
				display: true,
				attribution: "agent",
				timestamp: 0,
			}),
		});
		const firstStageEntered = Promise.withResolvers<void>();
		const releaseFirstStage = Promise.withResolvers<void>();
		const originalStage = sessionManager.stageDefaultModelSelection.bind(sessionManager);
		let stageCall = 0;
		const stageSelection = vi
			.spyOn(sessionManager, "stageDefaultModelSelection")
			.mockImplementation(async (...args) => {
				stageCall++;
				if (stageCall === 1) {
					firstStageEntered.resolve();
					await releaseFirstStage.promise;
				}
				return originalStage(...args);
			});
		const durableSelection = vi.spyOn(settings, "setGlobalModelRoleAndFlush");
		const publishSelection = vi.spyOn(session.agent, "setModel");
		const transcriptBefore = session.agent.state.messages;
		const entriesBefore = sessionManager.getEntries();
		const firstSelection = session.setDefaultModelSelection(
			{ ...targetModel(), id: "yield-selector-owner" },
			Effort.High,
		);
		let inverseSelection: Promise<unknown> | undefined;

		try {
			await firstStageEntered.promise;

			// When
			session.yieldQueue.enqueue("selection-admission-async-result", "async result after selector idle sample");
			await idleFlushDelayEntered.promise;
			releaseIdleFlushDelay.resolve();
			await new Promise<void>(resolve => setImmediate(resolve));

			// Then
			expect(streamCount).toBe(0);
			expect(session.agent.state.messages).toEqual(transcriptBefore);
			expect(sessionManager.getEntries()).toEqual(entriesBefore);
			expect(durableSelection).not.toHaveBeenCalled();
			expect(publishSelection).not.toHaveBeenCalled();

			releaseFirstStage.resolve();
			await firstSelection;
			await streamCreated.promise;
			expect(stageSelection).toHaveBeenCalledTimes(1);
			expect(durableSelection).toHaveBeenCalledTimes(1);
			expect(publishSelection).toHaveBeenCalledTimes(1);
			const firstYieldMessage = createAssistantMessage("selector-first idle yield complete");
			activeStream?.push({ type: "done", reason: "stop", message: firstYieldMessage });
			activeStream?.end(firstYieldMessage);
			activeStream = undefined;
			await session.waitForIdle();

			secondStreamCreated = Promise.withResolvers<void>();
			session.yieldQueue.enqueue("selection-admission-async-result", "async result before selector");
			await secondStreamCreated.promise;
			inverseSelection = session.setDefaultModelSelection(
				{ ...targetModel(), id: "yield-selector-successor" },
				Effort.Low,
			);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(stageSelection).toHaveBeenCalledTimes(1);
			expect(durableSelection).toHaveBeenCalledTimes(1);
			expect(publishSelection).toHaveBeenCalledTimes(1);

			const inverseYieldMessage = createAssistantMessage("yield-first idle turn complete");
			getActiveStream()?.push({ type: "done", reason: "stop", message: inverseYieldMessage });
			getActiveStream()?.end(inverseYieldMessage);
			activeStream = undefined;
			await expect(inverseSelection).resolves.toEqual({
				provider: "target-provider",
				modelId: "yield-selector-successor",
				thinkingLevel: Effort.Low,
			});
			expect(stageSelection).toHaveBeenCalledTimes(2);
			expect(durableSelection).toHaveBeenCalledTimes(2);
			expect(publishSelection).toHaveBeenCalledTimes(2);
		} finally {
			releaseIdleFlushDelay.resolve();
			releaseFirstStage.resolve();
			unregisterYield();
			if (activeStream) {
				const message = createAssistantMessage("case Y cleanup");
				activeStream.push({ type: "done", reason: "stop", message });
				activeStream.end(message);
				activeStream = undefined;
			}
			await Promise.allSettled([firstSelection, ...(inverseSelection ? [inverseSelection] : [])]);
		}
	});

	it("[R] keeps a public retry continuation ahead of a later selector", async () => {
		// Given
		const retryDelayEntered = Promise.withResolvers<void>();
		const releaseRetryDelay = Promise.withResolvers<void>();
		vi.spyOn(scheduler, "wait").mockImplementation(async () => {
			retryDelayEntered.resolve();
			await releaseRetryDelay.promise;
		});
		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "retry predecessor" }],
			timestamp: 0,
		});
		const failedMessage = createAssistantMessage("retryable predecessor failure");
		failedMessage.stopReason = "error";
		failedMessage.errorMessage = "retry predecessor failed";
		session.agent.appendMessage(failedMessage);
		const retryContinueEntered = Promise.withResolvers<void>();
		const retryContinueCompleted = Promise.withResolvers<void>();
		const order: string[] = [];
		const originalContinue = session.agent.continue.bind(session.agent);
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			order.push("retry start");
			retryContinueEntered.resolve();
			await originalContinue();
			order.push("retry complete");
			retryContinueCompleted.resolve();
		});
		const selectionFlushEntered = Promise.withResolvers<void>();
		const releaseSelectionFlush = Promise.withResolvers<void>();
		const originalFlush = sessionManager.flush.bind(sessionManager);
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			order.push("selector flush");
			selectionFlushEntered.resolve();
			await releaseSelectionFlush.promise;
			return originalFlush();
		});
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		let selectionValidationRecorded = false;
		const validateSelection = vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model.provider === "target-provider" && !selectionValidationRecorded) {
				selectionValidationRecorded = true;
				order.push("selector validate");
			}
			return originalGetApiKey(model, ...args);
		});
		const originalStage = sessionManager.stageDefaultModelSelection.bind(sessionManager);
		const stageSelection = vi
			.spyOn(sessionManager, "stageDefaultModelSelection")
			.mockImplementation(async (...args) => {
				order.push("selector stage");
				return originalStage(...args);
			});
		const originalCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		const durableSelection = vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			order.push("selector durable");
			return originalCommit(...args);
		});
		const originalSetModel = session.agent.setModel.bind(session.agent);
		const publishSelection = vi.spyOn(session.agent, "setModel").mockImplementation(model => {
			order.push("selector live");
			originalSetModel(model);
		});
		expect(await session.retry()).toBe(true);
		await retryDelayEntered.promise;
		const selection = session.setDefaultModelSelection({ ...targetModel(), id: "after-public-retry" }, Effort.High);

		try {
			// When
			await new Promise<void>(resolve => setImmediate(resolve));

			// Then
			expect(order).toEqual([]);
			expect(validateSelection.mock.calls.filter(([model]) => model.provider === "target-provider")).toHaveLength(0);
			expect(stageSelection).not.toHaveBeenCalled();
			expect(durableSelection).not.toHaveBeenCalled();
			expect(publishSelection).not.toHaveBeenCalled();

			releaseRetryDelay.resolve();
			await retryContinueEntered.promise;
			await streamCreated.promise;
			expect(order).toEqual(["retry start"]);
			expect(stageSelection).not.toHaveBeenCalled();
			expect(durableSelection).not.toHaveBeenCalled();
			expect(publishSelection).not.toHaveBeenCalled();

			const retryMessage = createAssistantMessage("public retry continuation complete");
			activeStream?.push({ type: "done", reason: "stop", message: retryMessage });
			activeStream?.end(retryMessage);
			activeStream = undefined;
			await retryContinueCompleted.promise;
			await selectionFlushEntered.promise;
			expect(order).toEqual(["retry start", "retry complete", "selector validate", "selector flush"]);
			expect(stageSelection).not.toHaveBeenCalled();
			expect(durableSelection).not.toHaveBeenCalled();
			expect(publishSelection).not.toHaveBeenCalled();

			releaseSelectionFlush.resolve();
			await expect(selection).resolves.toEqual({
				provider: "target-provider",
				modelId: "after-public-retry",
				thinkingLevel: Effort.High,
			});
			expect(order).toEqual([
				"retry start",
				"retry complete",
				"selector validate",
				"selector flush",
				"selector stage",
				"selector durable",
				"selector live",
			]);
		} finally {
			releaseRetryDelay.resolve();
			releaseSelectionFlush.resolve();
			if (!activeStream) {
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			if (activeStream) {
				const message = createAssistantMessage("case R cleanup");
				activeStream.push({ type: "done", reason: "stop", message });
				activeStream.end(message);
				activeStream = undefined;
			}
			await Promise.allSettled([selection]);
		}
	});

	it("drops a failed assistant tail before retry preflight estimates context", async () => {
		// Given
		settings.set("compaction.thresholdTokens", 5_000);
		session.setResourceSampler(() => ({ heapUsedBytes: 0, providerBytes: 0, messageCount: 0, imageBytes: 0 }));
		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "retry this request" }],
			timestamp: 0,
		});
		const failedMessage = createAssistantMessage("failed retry tail ".repeat(2_000));
		failedMessage.stopReason = "error";
		failedMessage.errorMessage = "retryable failure";
		session.agent.appendMessage(failedMessage);
		const compactionReasons: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "auto_compaction_start") compactionReasons.push(event.reason);
		});

		try {
			// When
			expect(await session.retry()).toBe(true);
			await streamCreated.promise;

			// Then
			expect(compactionReasons).toEqual([]);
			const message = createAssistantMessage("retry completed without unnecessary compaction");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await session.waitForIdle();
		} finally {
			unsubscribe();
		}
	});

	it("releases a public retry admission when abort cancels its delayed continuation", async () => {
		// Given
		const retryDelayEntered = Promise.withResolvers<void>();
		const originalWait = scheduler.wait.bind(scheduler);
		vi.spyOn(scheduler, "wait").mockImplementation(async (_delay, options) => {
			retryDelayEntered.resolve();
			await originalWait(60_000, options);
		});
		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "retry predecessor before abort" }],
			timestamp: 0,
		});
		const failedMessage = createAssistantMessage("retry failure before abort");
		failedMessage.stopReason = "error";
		failedMessage.errorMessage = "retry failed before abort";
		session.agent.appendMessage(failedMessage);
		const continueCall = vi.spyOn(session.agent, "continue");
		expect(await session.retry()).toBe(true);
		await retryDelayEntered.promise;

		// When
		await session.abort();
		const laterPrompt = session.prompt("prompt after aborted public retry");
		void laterPrompt.catch(() => {});
		const laterSelection = session.setDefaultModelSelection(
			{ ...targetModel(), id: "selector-after-aborted-public-retry" },
			Effort.High,
		);
		void laterSelection.catch(() => {});
		const promptOutcome = await Promise.race([
			streamCreated.promise.then(() => "streaming" as const),
			laterPrompt.then(
				() => "settled" as const,
				error => error,
			),
		]);

		// Then
		expect(continueCall).not.toHaveBeenCalled();
		expect(promptOutcome).toBe("streaming");
		const message = createAssistantMessage("prompt after aborted retry complete");
		activeStream?.push({ type: "done", reason: "stop", message });
		activeStream?.end(message);
		activeStream = undefined;
		await laterPrompt;
		await expect(laterSelection).resolves.toEqual({
			provider: "target-provider",
			modelId: "selector-after-aborted-public-retry",
			thinkingLevel: Effort.High,
		});
	});

	it("keeps persisted-history continuation ahead of a later selector", async () => {
		// Given
		session.agent.appendMessage({ role: "user", content: "persisted continuation", timestamp: 0 });
		const continueEntered = Promise.withResolvers<void>();
		const releaseContinue = Promise.withResolvers<void>();
		const originalContinue = session.agent.continue.bind(session.agent);
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueEntered.resolve();
			await releaseContinue.promise;
			await originalContinue();
		});
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		const validateSelection = vi
			.spyOn(modelRegistry, "getApiKey")
			.mockImplementation((model, ...args) => originalGetApiKey(model, ...args));
		const continuation = session.continuePersistedHistory();
		void continuation.catch(() => {});
		await continueEntered.promise;

		// When
		const selection = session.setDefaultModelSelection(
			{ ...targetModel(), id: "persisted-continuation-successor" },
			Effort.High,
		);
		void selection.catch(() => {});

		try {
			await new Promise<void>(resolve => setImmediate(resolve));

			// Then
			expect(validateSelection.mock.calls.filter(([model]) => model.provider === "target-provider")).toHaveLength(0);
			releaseContinue.resolve();
			await streamCreated.promise;
			const message = createAssistantMessage("persisted continuation complete");
			activeStream?.push({ type: "done", reason: "stop", message });
			activeStream?.end(message);
			activeStream = undefined;
			await continuation;
			await expect(selection).resolves.toEqual({
				provider: "target-provider",
				modelId: "persisted-continuation-successor",
				thinkingLevel: Effort.High,
			});
		} finally {
			releaseContinue.resolve();
			await Promise.race([streamCreated.promise, continuation]);
			if (activeStream) {
				const message = createAssistantMessage("persisted continuation cleanup");
				activeStream.push({ type: "done", reason: "stop", message });
				activeStream.end(message);
				activeStream = undefined;
			}
			await Promise.allSettled([continuation, selection]);
		}
	});

	it("[X] dispose cancels hidden next-turn admission queued behind a selector", async () => {
		// Given
		const selectionValidationEntered = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model.provider === "target-provider") {
				selectionValidationEntered.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		const appendCustomEntry = vi.spyOn(sessionManager, "appendCustomMessageEntry");
		const transcriptBefore = session.agent.state.messages;
		const closeEntered = Promise.withResolvers<void>();
		const originalClose = sessionManager.close.bind(sessionManager);
		vi.spyOn(sessionManager, "close").mockImplementation(async () => {
			closeEntered.resolve();
			return originalClose();
		});
		const selection = session.setDefaultModelSelection(
			{ ...targetModel(), id: "dispose-selector-owner" },
			Effort.High,
		);
		void selection.catch(() => {});
		await selectionValidationEntered.promise;
		session.queueDeferredMessageForTests(
			{
				role: "custom",
				customType: "dispose-hidden-next-turn",
				content: "must be cancelled during dispose",
				display: false,
				attribution: "agent",
				timestamp: 0,
			},
			true,
		);
		expect(session.hasPostPromptWork).toBe(true);
		const disposal = session.dispose();
		void disposal.catch(() => {});

		try {
			// When
			const checkpoint = Promise.withResolvers<void>();
			setImmediate(checkpoint.resolve);
			const disposeProgress = await Promise.race([
				closeEntered.promise.then(() => "queued task settled" as const),
				checkpoint.promise.then(() => "checkpoint reached" as const),
			]);

			// Then
			expect(disposeProgress).toBe("queued task settled");
			expect(session.hasPostPromptWork).toBe(false);
			expect(streamCount).toBe(0);
			expect(session.agent.state.messages).toEqual(transcriptBefore);
			expect(
				appendCustomEntry.mock.calls.filter(([customType]) => customType === "dispose-hidden-next-turn"),
			).toHaveLength(0);

			releaseSelectionValidation.resolve();
			await Promise.allSettled([selection]);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(streamCount).toBe(0);
			expect(session.agent.state.messages).toEqual(transcriptBefore);
			expect(
				appendCustomEntry.mock.calls.filter(([customType]) => customType === "dispose-hidden-next-turn"),
			).toHaveLength(0);
			await disposal;
		} finally {
			releaseSelectionValidation.resolve();
			await Promise.allSettled([selection]);
			const lateWork = await Promise.race([
				streamCreated.promise.then(() => "provider started" as const),
				closeEntered.promise.then(() => "dispose advanced" as const),
			]);
			if (lateWork === "provider started" && activeStream) {
				const message = createAssistantMessage("case X cleanup");
				activeStream.push({ type: "done", reason: "stop", message });
				activeStream.end(message);
				activeStream = undefined;
			}
			await Promise.allSettled([disposal]);
		}
	});

	it("settles recursive same-session dispose inside session_shutdown without self-waiting", async () => {
		// Given
		await session.dispose();
		const recursiveDisposeOutcome = Promise.withResolvers<"recursive dispose settled" | "checkpoint reached">();
		const runDetachedDispose = Promise.withResolvers<void>();
		const detachedDisposeCalled = Promise.withResolvers<void>();
		const secondHandlerEntered = Promise.withResolvers<void>();
		const releaseSecondHandler = Promise.withResolvers<void>();
		let detachedDisposal: Promise<void> | undefined;
		const firstHandler = async (): Promise<unknown> => {
			const recursiveDisposal = session.dispose();
			const checkpoint = Promise.withResolvers<void>();
			setImmediate(checkpoint.resolve);
			recursiveDisposeOutcome.resolve(
				await Promise.race([
					recursiveDisposal.then(() => "recursive dispose settled" as const),
					checkpoint.promise.then(() => "checkpoint reached" as const),
				]),
			);
			void (async () => {
				await runDetachedDispose.promise;
				detachedDisposal = session.dispose();
				detachedDisposeCalled.resolve();
			})();
			return undefined;
		};
		const secondHandler = async (): Promise<unknown> => {
			secondHandlerEntered.resolve();
			await releaseSecondHandler.promise;
			return undefined;
		};
		const extension: Extension = {
			path: "test:recursive-session-shutdown-dispose",
			resolvedPath: "test:recursive-session-shutdown-dispose",
			handlers: new Map([["session_shutdown", [firstHandler, secondHandler]]]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		const extensionRunner = new ExtensionRunner(
			[extension],
			new ExtensionRuntime(),
			tempRoot,
			sessionManager,
			modelRegistry,
		);
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
			extensionRunner,
		});

		// When
		const disposal = session.dispose();
		await secondHandlerEntered.promise;
		const concurrentDisposal = session.dispose();
		runDetachedDispose.resolve();
		await detachedDisposeCalled.promise;
		if (!detachedDisposal) throw new Error("Expected detached disposal call");
		const shutdownCheckpoint = Promise.withResolvers<void>();
		setImmediate(shutdownCheckpoint.resolve);

		// Then
		try {
			expect(concurrentDisposal).toBe(disposal);
			expect(detachedDisposal).toBe(disposal);
			expect(await recursiveDisposeOutcome.promise).toBe("recursive dispose settled");
			expect(
				await Promise.race([
					detachedDisposal.then(() => "disposed" as const),
					shutdownCheckpoint.promise.then(() => "shutdown handler pending" as const),
				]),
			).toBe("shutdown handler pending");
		} finally {
			releaseSecondHandler.resolve();
			await Promise.all([disposal, detachedDisposal]);
		}
	});

	it("dispose waits for staged selection cleanup before closing the session", async () => {
		// Given
		const agentDir = path.join(tempRoot, "dispose-stage-agent");
		const configPath = path.join(agentDir, "config.yml");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(configPath, "modelRoles:\n  default: initial-provider/initial:low\n");
		resetSettingsForTest();
		const durableSettings = await Settings.init({ cwd: tempRoot, agentDir });
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "dispose-stage-sessions"));
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings: durableSettings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		persistentManager.appendMessage({ role: "user", content: "persisted transcript", timestamp: 0 });
		await persistentManager.rewriteEntries();
		const entriesBefore = persistentManager.getEntries();
		let stagedTempPath: string | undefined;
		const originalStage = persistentManager.stageDefaultModelSelection.bind(persistentManager);
		vi.spyOn(persistentManager, "stageDefaultModelSelection").mockImplementation(async (...args) => {
			const stage = await originalStage(...args);
			stagedTempPath = stage.tempPath;
			return stage;
		});
		const durableEntered = Promise.withResolvers<void>();
		const releaseDurable = Promise.withResolvers<void>();
		const disposalError = new AgentBusyError("Agent session has been disposed.");
		vi.spyOn(durableSettings, "setGlobalModelRoleAndFlush").mockImplementation(async () => {
			durableEntered.resolve();
			await releaseDurable.promise;
			throw disposalError;
		});
		const closeEntered = Promise.withResolvers<void>();
		const originalClose = persistentManager.close.bind(persistentManager);
		vi.spyOn(persistentManager, "close").mockImplementation(async () => {
			closeEntered.resolve();
			await originalClose();
		});
		const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.High);
		void selection.catch(() => {});
		await durableEntered.promise;
		if (!stagedTempPath) throw new Error("Expected staged default selection path");
		expect(await Bun.file(stagedTempPath).exists()).toBeTrue();

		try {
			// When
			const disposal = persistentSession.dispose();
			void disposal.catch(() => {});
			const checkpoint = Promise.withResolvers<void>();
			setImmediate(checkpoint.resolve);

			// Then
			expect(
				await Promise.race([
					closeEntered.promise.then(() => "closed" as const),
					checkpoint.promise.then(() => "cleanup pending" as const),
				]),
			).toBe("cleanup pending");
			releaseDurable.resolve();
			await expectPostDurableSelectionRecovery(selection, {
				message: disposalError.message,
				rollback: { disposition: "restored", failures: [] },
			});
			await disposal;
			expect(await Bun.file(stagedTempPath).exists()).toBeFalse();
			expect(durableSettings.getGlobal("modelRoles")).toEqual({ default: "initial-provider/initial:low" });
			expect(await Bun.file(configPath).text()).toContain("default: initial-provider/initial:low");
			expect(persistentSession.model).toBe(INITIAL_MODEL);
			expect(persistentSession.thinkingLevel).toBe(Effort.Low);
			expect(persistentManager.getEntries()).toEqual(entriesBefore);
		} finally {
			releaseDurable.resolve();
			await Promise.allSettled([selection, persistentSession.dispose()]);
			await persistentManager.close();
			resetSettingsForTest();
		}
	});

	it("dispose restores an applied durable selection before closing the session", async () => {
		// Given
		const agentDir = path.join(tempRoot, "dispose-durable-agent");
		const configPath = path.join(agentDir, "config.yml");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(configPath, "modelRoles:\n  default: initial-provider/initial:low\n");
		resetSettingsForTest();
		const durableSettings = await Settings.init({ cwd: tempRoot, agentDir });
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "dispose-durable-sessions"));
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings: durableSettings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		persistentManager.appendMessage({ role: "user", content: "persisted transcript", timestamp: 0 });
		await persistentManager.rewriteEntries();
		const entriesBefore = persistentManager.getEntries();
		let stagedTempPath: string | undefined;
		const originalStage = persistentManager.stageDefaultModelSelection.bind(persistentManager);
		vi.spyOn(persistentManager, "stageDefaultModelSelection").mockImplementation(async (...args) => {
			const stage = await originalStage(...args);
			stagedTempPath = stage.tempPath;
			return stage;
		});
		const durableApplied = Promise.withResolvers<void>();
		const releaseDurableResult = Promise.withResolvers<void>();
		const originalCommit = durableSettings.setGlobalModelRoleAndFlush.bind(durableSettings);
		vi.spyOn(durableSettings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			const commit = await originalCommit(...args);
			durableApplied.resolve();
			await releaseDurableResult.promise;
			return commit;
		});
		const closeEntered = Promise.withResolvers<void>();
		const originalClose = persistentManager.close.bind(persistentManager);
		vi.spyOn(persistentManager, "close").mockImplementation(async () => {
			closeEntered.resolve();
			await originalClose();
		});
		const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.High);
		void selection.catch(() => {});
		await durableApplied.promise;
		if (!stagedTempPath) throw new Error("Expected staged default selection path");
		expect(await Bun.file(stagedTempPath).exists()).toBeTrue();
		expect(await Bun.file(configPath).text()).toContain("default: target-provider/reasoning:high");

		try {
			// When
			const disposal = persistentSession.dispose();
			void disposal.catch(() => {});
			const checkpoint = Promise.withResolvers<void>();
			setImmediate(checkpoint.resolve);

			// Then
			expect(
				await Promise.race([
					closeEntered.promise.then(() => "closed" as const),
					checkpoint.promise.then(() => "recovery pending" as const),
				]),
			).toBe("recovery pending");
			releaseDurableResult.resolve();
			await expectPostDurableSelectionRecovery(selection, {
				message: "Agent session has been disposed.",
				rollback: { disposition: "restored", failures: [] },
			});
			await disposal;
			expect(await Bun.file(stagedTempPath).exists()).toBeFalse();
			expect(durableSettings.getGlobal("modelRoles")).toEqual({ default: "initial-provider/initial:low" });
			expect(await Bun.file(configPath).text()).toContain("default: initial-provider/initial:low");
			expect(persistentSession.model).toBe(INITIAL_MODEL);
			expect(persistentSession.thinkingLevel).toBe(Effort.Low);
			expect(persistentManager.getEntries()).toEqual(entriesBefore);
		} finally {
			releaseDurableResult.resolve();
			await Promise.allSettled([selection, persistentSession.dispose()]);
			await persistentManager.close();
			resetSettingsForTest();
		}
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

	it("[H1] continues the selector-only queue after a durable failure", async () => {
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
