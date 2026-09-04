/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { AttemptScope } from "@gajae-code/agent-core/attempt-scope";
import type {
	AttemptScopeRef,
	CredentialDisabledEvent,
	ImageContent,
	Model,
	ProviderResponseMetadata,
} from "@gajae-code/ai/core";
import type { KeyId } from "@gajae-code/tui";
import { logger } from "@gajae-code/utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { WorkflowGateEmitter } from "../../modes/shared/agent-wire/workflow-gate-broker";
import { type Theme, theme } from "../../modes/theme/theme";
import type { AttemptRecordStore } from "../../session/attempt-record-store";
import { createReadonlySessionManager, type SessionManager } from "../../session/session-manager";
import {
	attenuateFunctionHookGrant,
	compatibilityPayloadForFunctionHook,
	createFunctionHookCapabilities,
	type FunctionHook,
	type FunctionHookAuditRecord,
	type FunctionHookCapabilityBindings,
	type FunctionHookGrant,
	type FunctionHookInvocation,
	type FunctionHookNext,
	type FunctionHookRegistration,
	type FunctionHookResult,
	functionHookDenyAllowed,
	functionHookGrantHash,
	functionHookPayloadHash,
	functionHookTransformAllowed,
	getFunctionHookRegistration,
	intersectFunctionHookGrants,
	isPlainFunctionHookData,
	isSafeFunctionHookValue,
	isValidFunctionHookEventValue,
	readConstrainedFunctionHookFile,
	redactFunctionHookValue,
	sanitizeFunctionHookReason,
} from "./function-hooks";
import type {
	AfterProviderResponseEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	MessageRenderer,
	RegisteredCommand,
	RegisteredTool,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
	UserPythonEvent,
	UserPythonEventResult,
} from "./types";
import { createExtensionSettings } from "./types";

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string[];
}

const BEFORE_AGENT_START_RESULT_KEYS = new Set(["message", "systemPrompt"]);
const MAX_UNSUPPORTED_RESULT_FIELDS = 8;
const MAX_RESULT_FIELD_NAME_LENGTH = 80;

function unsupportedBeforeAgentStartResultFields(result: unknown): string[] {
	if (result === null || typeof result !== "object" || Array.isArray(result)) return [];
	const fields = Object.keys(result).filter(key => !BEFORE_AGENT_START_RESULT_KEYS.has(key));
	const bounded = fields
		.slice(0, MAX_UNSUPPORTED_RESULT_FIELDS)
		.map(key => key.replace(/[^\x20-\x7e]/gu, "?").slice(0, MAX_RESULT_FIELD_NAME_LENGTH));
	if (fields.length > MAX_UNSUPPORTED_RESULT_FIELDS)
		bounded.push(`…and ${fields.length - MAX_UNSUPPORTED_RESULT_FIELDS} more`);
	return bounded;
}

export type ExtensionErrorListener = (error: ExtensionError) => void;

/** Bounded timeout for session_shutdown handlers — generous but never infinite. */
export const SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS = 60_000;
export const EXTENSION_HANDLER_TIMEOUT_MS = 30_000;
let extensionHandlerTimeoutMs = EXTENSION_HANDLER_TIMEOUT_MS;
let sessionShutdownHandlerTimeoutMs = SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS;

export function testSetExtensionHandlerTimeoutMs(timeoutMs: number): void {
	extensionHandlerTimeoutMs = timeoutMs;
}
export function testSetSessionShutdownHandlerTimeoutMs(timeoutMs: number): void {
	sessionShutdownHandlerTimeoutMs = timeoutMs;
}

const EXTENSION_HANDLER_TIMEOUT = Symbol("extensionHandlerTimeout");

const MAX_PENDING_CREDENTIAL_DISABLED = 32;
function createHandlerContext(ctx: ExtensionContext, signal: AbortSignal): ExtensionContext {
	const descriptors = Object.getOwnPropertyDescriptors(ctx);
	descriptors.signal = {
		configurable: true,
		enumerable: true,
		writable: true,
		value: signal,
	};
	return Object.defineProperties({}, descriptors) as ExtensionContext;
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_branch" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeBranchResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_branch" }
		? SessionBeforeBranchResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: TEvent extends { type: "session.compacting" }
					? SessionCompactingResult | undefined
					: undefined;
type Handler = Extension["handlers"] extends Map<string, Array<infer T>> ? T : never;
type IndexedHandler = { ext: Extension; handler: Handler; registrationOrder: number };
type IndexedFunctionHook = IndexedHandler & { registration: FunctionHookRegistration };

export type FunctionHookDispatchResult<TEvent extends ExtensionEvent> =
	| { action: "continue"; event: TEvent }
	| { action: "deny"; reason: string }
	| { action: "return"; value: unknown };

export type FunctionHookAuditSink = (record: FunctionHookAuditRecord) => void;

export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type BranchHandler = (entryId: string) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (sessionPath: string) => Promise<{ cancelled: boolean }>;

export type ShutdownHandler = () => void;

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(extensionRunner: ExtensionRunner | undefined): Promise<boolean> {
	if (extensionRunner?.hasHandlers("session_shutdown")) {
		await extensionRunner.emit({
			type: "session_shutdown",
		});
		return true;
	}
	return false;
}

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	setEditorComponent: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: (_theme: string | Theme) => Promise.resolve({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

export class ExtensionRunner {
	#uiContext: ExtensionUIContext;
	#errorListeners: Set<ExtensionErrorListener> = new Set();
	#handlersByEvent: Map<string, IndexedHandler[]> = new Map();
	#attemptRecordStore: AttemptRecordStore | undefined;
	#functionHookAuditSequence = 0;
	#functionHookAudit: FunctionHookAuditRecord[] = [];
	#functionHookAuditSink: FunctionHookAuditSink | undefined;
	#functionHookDepth = 0;

	#getModel: () => Model | undefined = () => undefined;
	#getCredentialSessionId: () => string = () => "";
	#isIdleFn: () => boolean = () => true;
	#getActivePromptHandleFn: () => string | undefined = () => undefined;
	#waitForIdleFn: () => Promise<void> = async () => {};
	#abortFn: () => void | Promise<void> = () => {};
	#abortPromptAndWaitFn: NonNullable<ExtensionContextActions["abortPromptAndWait"]> = async () => {
		throw new Error("abortPromptAndWait binding is unavailable");
	};
	#hasPendingMessagesFn: () => boolean = () => false;
	#getPendingMessageCountsFn: () => { steering: number; followUp: number; nextTurn: number } = () => ({
		steering: 0,
		followUp: 0,
		nextTurn: 0,
	});
	#getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	#compactFn: (instructionsOrOptions?: string | CompactOptions) => Promise<void> = async () => {};
	#getSystemPromptFn: () => string[] = () => [];
	#getWorkflowGateFn: () => WorkflowGateEmitter | undefined = () => undefined;
	#clearContextFn: () => Promise<boolean> = async () => false;
	#getTranscriptFn: ExtensionContext["getTranscript"] = () => [];
	#getTranscriptBodyFn: ExtensionContext["getTranscriptBody"] = () => undefined;
	#getGoalStateFn: ExtensionContext["getGoalState"] = () => undefined;
	#getTodoStateFn: ExtensionContext["getTodoState"] = () => undefined;
	#getQueuedMessagesFn: ExtensionContext["getQueuedMessages"] = () => [];
	#getActiveToolsFn: ExtensionContext["getActiveTools"] = () => [];
	#getAllToolsFn: ExtensionContext["getAllTools"] = () => [];
	#getResolveToolFn: ExtensionContext["resolveTool"] = () => undefined;
	#cycleModelFn: ExtensionContextActions["cycleModel"] = undefined;
	#setModelProfileFn: ExtensionContextActions["setModelProfile"] = undefined;
	#setDefaultModelProfileFn: ExtensionContextActions["setDefaultModelProfile"] = undefined;
	#getActiveModelProfileFn: ExtensionContextActions["getActiveModelProfile"] = undefined;
	#withSdkControlMutationFn: ExtensionContextActions["withSdkControlMutation"] = undefined;
	#cycleThinkingLevelFn: ExtensionContextActions["cycleThinkingLevel"] = undefined;
	#setQueueModeFn: ExtensionContextActions["setQueueMode"] = undefined;
	#getSkillStateFn: ExtensionContextActions["getSkillState"] = undefined;
	#getConfigItemsFn: ExtensionContextActions["getConfigItems"] = undefined;
	#getBranchCandidatesFn: ExtensionContextActions["getBranchCandidates"] = undefined;
	#getExtensionsFn: ExtensionContextActions["getExtensions"] = undefined;
	#getArtifactFn: ExtensionContextActions["getArtifact"] = undefined;
	#getArtifactRangeFn: ExtensionContextActions["getArtifactRange"] = undefined;

	#getJobsFn: ExtensionContextActions["getJobs"] = undefined;
	#onJobFoldFn: ExtensionContextActions["onJobFold"] = undefined;
	#onSessionEventFn: ExtensionContextActions["onSessionEvent"] = undefined;
	#sdkControlFn: ExtensionContextActions["sdkControl"] = undefined;
	#setSdkPermissionProviderFn: ExtensionContextActions["setSdkPermissionProvider"] = undefined;
	#setSdkClientBridgeFn: ExtensionContextActions["setSdkClientBridge"] = undefined;

	#invokeSkillFn: ExtensionContextActions["invokeSkill"] = undefined;
	#setPlanModeFn: ExtensionContextActions["setPlanMode"] = undefined;
	#operateGoalFn: ExtensionContextActions["operateGoal"] = undefined;

	#newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	#branchHandler: BranchHandler = async () => ({ cancelled: false });
	#navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	#switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	#reloadHandler: () => Promise<void> = async () => {};
	#shutdownHandler: ShutdownHandler = () => {};
	#commandDiagnostics: Array<{ type: string; message: string; path: string }> = [];
	#initialized = false;
	/**
	 * Buffer for `credential_disabled` events received via {@link emitCredentialDisabled}
	 * before {@link initialize} has run. Drained through {@link emit} once initialize sets
	 * up the runtime context, so extension handlers see a populated UI/runtime context
	 * rather than the constructor's no-op default. Bounded at
	 * {@link MAX_PENDING_CREDENTIAL_DISABLED}; oldest entries are dropped under pressure.
	 */
	#pendingCredentialDisabled: CredentialDisabledEvent[] = [];

	constructor(
		private readonly extensions: Extension[],
		private readonly runtime: ExtensionRuntime,
		private readonly cwd: string,
		private readonly sessionManager: SessionManager,
		private readonly modelRegistry: ModelRegistry,
		private readonly sessionMetadata?: ExtensionContext["sessionMetadata"],
		private readonly settings?: Settings,
		credentialSessionIdGetter?: () => string,
	) {
		this.#uiContext = noOpUIContext;
		this.#getCredentialSessionId = credentialSessionIdGetter ?? (() => "");
		this.#handlersByEvent = ExtensionRunner.#indexHandlers(extensions);
	}

	static #indexHandlers(extensions: Extension[]): Map<string, IndexedHandler[]> {
		const handlersByEvent = new Map<string, IndexedHandler[]>();
		let registrationOrder = 0;
		for (const ext of extensions) {
			const extensionHandlers: Array<{ eventType: string; handler: Handler; index: number }> = [];
			let index = 0;
			for (const [eventType, handlers] of ext.handlers) {
				for (const handler of handlers) extensionHandlers.push({ eventType, handler, index: index++ });
			}
			extensionHandlers.sort((a, b) => {
				const aRegistration = getFunctionHookRegistration(a.handler);
				const bRegistration = getFunctionHookRegistration(b.handler);
				if (aRegistration?.registrationOrder !== undefined && bRegistration?.registrationOrder !== undefined)
					return aRegistration.registrationOrder - bRegistration.registrationOrder;
				return a.index - b.index;
			});
			for (const { eventType, handler } of extensionHandlers) {
				let indexedHandlers = handlersByEvent.get(eventType);
				if (!indexedHandlers) {
					indexedHandlers = [];
					handlersByEvent.set(eventType, indexedHandlers);
				}
				indexedHandlers.push({ ext, handler, registrationOrder });
				registrationOrder += 1;
			}
		}
		return handlersByEvent;
	}

	initialize(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		commandContextActions?: ExtensionCommandContextActions,
		uiContext?: ExtensionUIContext,
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.resolveTool = actions.resolveTool ?? (() => undefined);
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;
		this.runtime.getThinkingVisibility = actions.getThinkingVisibility;
		this.runtime.setThinkingVisibility = actions.setThinkingVisibility;
		this.runtime.cycleThinkingLevel = actions.cycleThinkingLevel;
		this.runtime.setThinkingLevelForControl = actions.setThinkingLevelForControl;
		this.runtime.setThinkingVisibilityForControl = actions.setThinkingVisibilityForControl;
		this.runtime.setModelTemporaryForControl = actions.setModelTemporaryForControl;
		this.runtime.fetchUsageReportsForControl = actions.fetchUsageReportsForControl;
		this.runtime.getThinkingScopeForControl = actions.getThinkingScopeForControl;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setSessionName = actions.setSessionName;

		// Context actions (required)
		this.#getModel = contextActions.getModel;
		this.#getCredentialSessionId = contextActions.getCredentialSessionId ?? (() => "");
		this.#isIdleFn = contextActions.isIdle;
		this.#getActivePromptHandleFn = contextActions.getActivePromptHandle ?? (() => undefined);
		this.#abortFn = contextActions.abort;
		this.#abortPromptAndWaitFn =
			contextActions.abortPromptAndWait ??
			(async () => {
				throw new Error("abortPromptAndWait binding is unavailable");
			});
		this.#hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.#getPendingMessageCountsFn =
			contextActions.getPendingMessageCounts ?? (() => ({ steering: 0, followUp: 0, nextTurn: 0 }));
		this.#shutdownHandler = contextActions.shutdown;
		this.#getSystemPromptFn = contextActions.getSystemPrompt;
		this.#getWorkflowGateFn = contextActions.getWorkflowGate ?? (() => undefined);
		this.#clearContextFn = contextActions.clearContext ?? (async () => false);
		this.#getTranscriptFn = contextActions.getTranscript ?? (() => []);
		this.#getTranscriptBodyFn = contextActions.getTranscriptBody ?? (() => undefined);
		this.#getGoalStateFn = contextActions.getGoalState ?? (() => undefined);
		this.#getTodoStateFn = contextActions.getTodoState ?? (() => undefined);
		this.#getQueuedMessagesFn = contextActions.getQueuedMessages ?? (() => []);
		this.#getActiveToolsFn = contextActions.getActiveTools ?? (() => []);
		this.#getAllToolsFn = contextActions.getAllTools ?? (() => []);
		this.#getResolveToolFn = contextActions.resolveTool ?? (() => undefined);
		this.#cycleModelFn = contextActions.cycleModel;
		this.#setModelProfileFn = contextActions.setModelProfile;
		this.#setDefaultModelProfileFn = contextActions.setDefaultModelProfile;
		this.#getActiveModelProfileFn = contextActions.getActiveModelProfile;
		this.#withSdkControlMutationFn = contextActions.withSdkControlMutation;
		this.#cycleThinkingLevelFn = contextActions.cycleThinkingLevel;
		this.#setQueueModeFn = contextActions.setQueueMode;
		this.#getSkillStateFn = contextActions.getSkillState;
		this.#invokeSkillFn = contextActions.invokeSkill;
		this.#setPlanModeFn = contextActions.setPlanMode;
		this.#operateGoalFn = contextActions.operateGoal;

		this.#getConfigItemsFn = contextActions.getConfigItems;
		this.#getBranchCandidatesFn = contextActions.getBranchCandidates;
		this.#getExtensionsFn = contextActions.getExtensions;
		this.#getArtifactFn = contextActions.getArtifact;
		this.#getArtifactRangeFn = contextActions.getArtifactRange;

		this.#getJobsFn = contextActions.getJobs;
		this.#onJobFoldFn = contextActions.onJobFold;
		this.#onSessionEventFn = contextActions.onSessionEvent;
		this.#sdkControlFn = contextActions.sdkControl;
		this.#setSdkPermissionProviderFn = contextActions.setSdkPermissionProvider;
		this.#setSdkClientBridgeFn = contextActions.setSdkClientBridge;

		// Command context actions (optional, only for interactive mode)
		if (commandContextActions) {
			this.#waitForIdleFn = commandContextActions.waitForIdle;
			this.#newSessionHandler = commandContextActions.newSession;
			this.#branchHandler = commandContextActions.branch;
			this.#navigateTreeHandler = commandContextActions.navigateTree;
			this.#switchSessionHandler = commandContextActions.switchSession;
			this.#reloadHandler = commandContextActions.reload;
			this.#getContextUsageFn = commandContextActions.getContextUsage;
			this.#compactFn = commandContextActions.compact;
		}

		this.#uiContext = uiContext ?? noOpUIContext;
		this.#initialized = true;

		// Drain events buffered by emitCredentialDisabled() before initialize ran. The
		// spread adds the `type` discriminator — `event` is the pi-ai shape (no `type`).
		// Deferred by one microtask so callers that register an onError listener
		// synchronously after initialize() see handler errors routed through it.
		const pending = this.#pendingCredentialDisabled.splice(0);
		queueMicrotask(() => {
			for (const event of pending) {
				this.emit({ type: "credential_disabled", ...event }).catch((error: unknown) => {
					logger.warn("credential_disabled handler threw during initialize flush", {
						provider: event.provider,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		});
	}

	/**
	 * Forward a `credential_disabled` event from `AuthStorage` to extension handlers.
	 *
	 * If {@link initialize} has not yet run, the event is buffered and replayed once
	 * initialize wires the runtime/UI context. This matters because session frontends
	 * (interactive, ACP, print, and subagent) call `initialize()` AFTER `createAgentSession`
	 * returns, but `AuthStorage` can fire `credential_disabled` during startup model probes
	 * inside `createAgentSession()`. Without deferral, extension handlers would observe
	 * `hasUI=false`, an unset model, and no-op runtime actions on exactly the headline
	 * "OAuth invalid_grant during startup" path the event was designed to surface.
	 *
	 * Always returns; never throws. Errors from handlers are routed through
	 * {@link onError} via {@link emit}'s normal isolation.
	 */
	async emitCredentialDisabled(event: CredentialDisabledEvent): Promise<void> {
		if (!this.#initialized) {
			if (this.#pendingCredentialDisabled.length >= MAX_PENDING_CREDENTIAL_DISABLED) {
				this.#pendingCredentialDisabled.shift();
			}
			this.#pendingCredentialDisabled.push(event);
			return;
		}
		await this.emit({ type: "credential_disabled", ...event });
	}

	getUIContext(): ExtensionUIContext {
		return this.#uiContext;
	}

	hasUI(): boolean {
		return this.#uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map(e => e.path);
	}

	/** Get all registered tools from all extensions. */
	getAllRegisteredTools(): RegisteredTool[] {
		const tools: RegisteredTool[] = [];
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				tools.push(tool);
			}
		}
		return tools;
	}

	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				allFlags.set(name, flag);
			}
		}
		return allFlags;
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	static readonly #RESERVED_SHORTCUTS = new Set([
		"ctrl+c",
		"ctrl+d",
		"ctrl+z",
		"ctrl+k",
		"ctrl+p",
		"ctrl+l",
		"ctrl+o",
		"ctrl+t",
		"ctrl+g",
		"shift+tab",
		"alt+n",
		"alt+shift+n",
		"ctrl+enter",
		"alt+enter",
		"escape",
		"enter",
	]);

	getShortcuts(): Map<KeyId, ExtensionShortcut> {
		const allShortcuts = new Map<KeyId, ExtensionShortcut>();
		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				if (ExtensionRunner.#RESERVED_SHORTCUTS.has(normalizedKey)) {
					logger.warn("Extension shortcut conflicts with built-in shortcut", {
						key,
						extensionPath: shortcut.extensionPath,
					});
					continue;
				}

				const existing = allShortcuts.get(normalizedKey);
				if (existing) {
					logger.warn("Extension shortcut conflict", {
						key,
						extensionPath: shortcut.extensionPath,
						existingExtensionPath: existing.extensionPath,
					});
				}
				allShortcuts.set(normalizedKey, shortcut);
			}
		}
		return allShortcuts;
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.#errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		return (
			(this.#handlersByEvent.get(eventType)?.length ?? 0) > 0 ||
			(this.#handlersByEvent.get("*")?.some(({ handler }) => getFunctionHookRegistration(handler) !== undefined) ??
				false)
		);
	}

	/** Return immutable registration metadata in authoritative registration order. */
	getFunctionHookRegistrations(): readonly FunctionHookRegistration[] {
		const registrations: Array<{ order: number; registration: FunctionHookRegistration }> = [];
		for (const handlers of this.#handlersByEvent.values()) {
			for (const indexed of handlers) {
				const registration = getFunctionHookRegistration(indexed.handler);
				if (registration) registrations.push({ order: indexed.registrationOrder, registration });
			}
		}
		registrations.sort((a, b) => a.order - b.order);
		return registrations.map(({ registration }) => registration);
	}

	/** Install the optional deterministic audit sink used by hosts and tests. */
	setFunctionHookAuditSink(sink: FunctionHookAuditSink | undefined): void {
		this.#functionHookAuditSink = sink;
	}

	getFunctionHookAudit(): readonly FunctionHookAuditRecord[] {
		return this.#functionHookAudit.map(record => ({ ...record, provenance: { ...record.provenance } }));
	}

	setAttemptRecordStore(store: AttemptRecordStore): void {
		this.#attemptRecordStore = store;
	}

	#markAttemptExecuted(scope: AttemptScopeRef | undefined): void {
		if (scope !== undefined) this.#attemptRecordStore?.markExecuted(scope as AttemptScope);
	}

	/**
	 * Scope-presence guard. When the AttemptScope facility is active but a
	 * handler-capable delivery lacks a scope, the handler is still delivered
	 * (backward-compatible) but NO mark is recorded. The record stays
	 * unknown/missing → `isClean` returns false → admission refuses
	 * (fail-closed at the decision point, not at delivery).
	 */
	#requireScopeOrFailClosed(_scope: AttemptScopeRef | undefined, _eventLabel: string): void {
		// No throw — handler is delivered (backward-compatible); mark is not
		// recorded when scope is absent. isClean returns false for an
		// unmarked scope → admission refuses (fail-closed at decision point).
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getRegisteredCommands(reserved?: Set<string>): RegisteredCommand[] {
		this.#commandDiagnostics = [];

		const commands = new Map<string, RegisteredCommand>();
		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				if (reserved?.has(command.name)) {
					const message = `Extension command '${command.name}' from ${ext.path} conflicts with built-in commands. Skipping.`;
					this.#commandDiagnostics.push({ type: "warning", message, path: ext.path });
					if (!this.hasUI()) {
						logger.warn(message);
					}
					continue;
				}

				commands.set(command.name, command);
			}
		}
		return [...commands.values()];
	}

	getCommandDiagnostics(): Array<{ type: string; message: string; path: string }> {
		return this.#commandDiagnostics;
	}

	getCommand(name: string): RegisteredCommand | undefined {
		for (let index = this.extensions.length - 1; index >= 0; index -= 1) {
			const command = this.extensions[index]?.commands.get(name);
			if (command) {
				return command;
			}
		}
		return undefined;
	}

	createContext(): ExtensionContext {
		const getModel = this.#getModel;
		const getCredentialSessionId = this.#getCredentialSessionId;
		return {
			ui: this.#uiContext,
			getContextUsage: () => this.#getContextUsageFn(),
			compact: instructionsOrOptions => this.#compactFn(instructionsOrOptions),
			hasUI: this.hasUI(),
			cwd: this.cwd,
			sessionManager: createReadonlySessionManager(this.sessionManager),
			sessionMetadata: this.sessionMetadata,
			modelRegistry: this.modelRegistry,
			settings: this.settings ? createExtensionSettings(this.settings) : undefined,
			get credentialSessionId() {
				return getCredentialSessionId();
			},
			get model() {
				return getModel();
			},
			getActivePromptHandle: () => this.#getActivePromptHandleFn(),
			isIdle: () => this.#isIdleFn(),
			abort: () => this.#abortFn(),
			abortPromptAndWait: (handle, options) => this.#abortPromptAndWaitFn(handle, options),
			hasPendingMessages: () => this.#hasPendingMessagesFn(),
			getPendingMessageCounts: () => this.#getPendingMessageCountsFn(),
			getTranscript: () => this.#getTranscriptFn(),
			getTranscriptBody: entryId => this.#getTranscriptBodyFn(entryId),
			getGoalState: () => this.#getGoalStateFn(),
			getTodoState: () => this.#getTodoStateFn(),
			getQueuedMessages: () => this.#getQueuedMessagesFn(),
			getActiveTools: () => this.#getActiveToolsFn(),
			getAllTools: () => this.#getAllToolsFn(),
			resolveTool: name => this.#getResolveToolFn(name),
			cycleModel: async () => await this.#cycleModelFn?.(),
			setModelProfile: async name => (await this.#setModelProfileFn?.(name)) ?? false,
			setDefaultModelProfile: async (name, options) =>
				(await this.#setDefaultModelProfileFn?.(name, options)) ?? { changed: false, id: name },
			getActiveModelProfile: () => this.#getActiveModelProfileFn?.(),
			withSdkControlMutation: body => this.#withSdkControlMutationFn?.(body) ?? body(),
			cycleThinkingLevel: () => this.#cycleThinkingLevelFn?.(),
			setQueueMode: (kind, mode) => this.#setQueueModeFn?.(kind, mode) ?? false,
			invokeSkill: async (name, args, options) => await this.#invokeSkillFn?.(name, args, options),

			setPlanMode: on => this.#setPlanModeFn?.(on),
			operateGoal: async (op, objective) => await this.#operateGoalFn?.(op, objective),

			getSkillState: () => this.#getSkillStateFn?.(),
			getConfigItems: () => this.#getConfigItemsFn?.(),
			getBranchCandidates: () => this.#getBranchCandidatesFn?.(),
			getExtensions: () => this.#getExtensionsFn?.(),
			getArtifact: id => this.#getArtifactFn?.(id),
			getArtifactRange: (id, offset, length) => this.#getArtifactRangeFn?.(id, offset, length),

			getJobs: () => this.#getJobsFn?.(),
			onJobFold: listener => this.#onJobFoldFn?.(listener) ?? (() => {}),
			onSessionEvent: listener => this.#onSessionEventFn?.(listener) ?? (() => {}),
			sdkControl: (operation, input) => this.#sdkControlFn?.(operation, input),
			setSdkPermissionProvider: provider => this.#setSdkPermissionProviderFn?.(provider),
			setSdkClientBridge: bridge => this.#setSdkClientBridgeFn?.(bridge),
			sdkBindings: () => [
				...(this.#cycleModelFn ? ["cycleModel"] : []),
				...(this.#setModelProfileFn ? ["setModelProfile"] : []),
				...(this.#setDefaultModelProfileFn ? ["setDefaultModelProfile"] : []),
				...(this.#getActiveModelProfileFn ? ["getActiveModelProfile"] : []),
				...(this.#withSdkControlMutationFn ? ["withSdkControlMutation"] : []),
				...(this.#cycleThinkingLevelFn ? ["cycleThinkingLevel"] : []),
				...(this.#setQueueModeFn ? ["setQueueMode"] : []),
				...(this.#getSkillStateFn ? ["getSkillState"] : []),
				...(this.#getConfigItemsFn ? ["getConfigItems"] : []),
				...(this.#getBranchCandidatesFn ? ["getBranchCandidates"] : []),
				...(this.#getExtensionsFn ? ["getExtensions"] : []),
				...(this.#getArtifactRangeFn ? ["getArtifactRange"] : []),
				...(this.#getJobsFn ? ["getJobs"] : []),
				...(this.#onJobFoldFn ? ["onJobFold"] : []),
				...(this.#sdkControlFn ? ["sdkControl"] : []),
				...(this.#invokeSkillFn ? ["invokeSkill"] : []),
				...(this.#setPlanModeFn ? ["setPlanMode"] : []),
				...(this.#operateGoalFn ? ["operateGoal"] : []),
			],
			shutdown: () => this.#shutdownHandler(),
			getSystemPrompt: () => [...this.#getSystemPromptFn()],
			hasQueuedMessages: () => this.#hasPendingMessagesFn(), // deprecated alias
			workflowGate: this.#getWorkflowGateFn(),
			clearContext: () => this.#clearContextFn(),
		};
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 */
	shutdown(): void {
		this.#shutdownHandler();
	}

	createCommandContext(): ExtensionCommandContext {
		return {
			...this.createContext(),
			getContextUsage: () => this.#getContextUsageFn(),
			waitForIdle: () => this.#waitForIdleFn(),
			newSession: options => this.#newSessionHandler(options),
			branch: entryId => this.#branchHandler(entryId),
			navigateTree: (targetId, options) => this.#navigateTreeHandler(targetId, options),
			switchSession: sessionPath => this.#switchSessionHandler(sessionPath),
			reload: () => this.#reloadHandler(),
			compact: instructionsOrOptions => this.#compactFn(instructionsOrOptions),
		};
	}

	#matchingFunctionHooks(event: ExtensionEvent): IndexedFunctionHook[] {
		const exact = this.#handlersByEvent.get(event.type) ?? [];
		const wildcard = this.#handlersByEvent.get("*") ?? [];
		const matches: IndexedFunctionHook[] = [];
		for (const indexed of [...exact, ...wildcard]) {
			const registration = getFunctionHookRegistration(indexed.handler);
			if (!registration) continue;
			if (registration.event !== "*" && registration.event !== event.type) continue;
			if (
				registration.target !== undefined &&
				registration.target !== "*" &&
				((event.type !== "tool_call" && event.type !== "tool_result") || event.toolName !== registration.target)
			) {
				continue;
			}
			matches.push({ ...indexed, registration });
		}
		matches.sort((a, b) => a.registrationOrder - b.registrationOrder);
		return matches;
	}

	#legacyHandlers(eventType: string): IndexedHandler[] {
		return (this.#handlersByEvent.get(eventType) ?? []).filter(
			({ handler }) => getFunctionHookRegistration(handler) === undefined,
		);
	}

	#functionHookAuditPath(registration: FunctionHookRegistration): string {
		return path.basename(registration.provenance.path).slice(0, 256);
	}

	#appendFunctionHookAudit(
		registration: FunctionHookRegistration,
		invocation: FunctionHookInvocation,
		action: FunctionHookAuditRecord["action"],
		reason?: string,
		effectiveGrant: FunctionHookGrant = registration.grant,
		evidence?: unknown,
	): void {
		const record: FunctionHookAuditRecord = {
			sequence: this.#functionHookAuditSequence,
			eventId: invocation.eventId,
			correlationId: invocation.correlationId,
			eventType: invocation.eventType,
			action,
			registrationOrder: invocation.registrationOrder,
			provenance: {
				source: registration.provenance.source,
				scope: registration.provenance.scope,
				plugin: registration.provenance.plugin,
				extensionId: registration.provenance.extensionId,
				path: this.#functionHookAuditPath(registration),
			},
			payloadHash: functionHookPayloadHash(invocation.payload),
			requestedCapabilities: [...registration.grant.capabilities],
			effectiveCapabilities: [...effectiveGrant.capabilities],
			capabilityHash: functionHookGrantHash(effectiveGrant),
			...(registration.provenance.activationGeneration === undefined
				? {}
				: { activationGeneration: registration.provenance.activationGeneration }),
			...(reason === undefined ? {} : { reason: sanitizeFunctionHookReason(reason, "Function hook decision") }),
			...(evidence === undefined ? {} : { evidence: redactFunctionHookValue(evidence) }),
		};
		this.#functionHookAuditSequence += 1;
		const frozenEvidence =
			record.evidence !== null && typeof record.evidence === "object"
				? Object.freeze(record.evidence)
				: record.evidence;
		const frozenRecord = Object.freeze({
			...record,
			provenance: Object.freeze(record.provenance),
			...(record.evidence === undefined ? {} : { evidence: frozenEvidence }),
		});
		this.#functionHookAudit.push(frozenRecord);
		if (this.#functionHookAudit.length > 1024) this.#functionHookAudit.shift();
		this.#functionHookAuditSink?.(frozenRecord);
	}

	#functionHookErrorResult(event: ExtensionEvent, reason: string): FunctionHookDispatchResult<ExtensionEvent> {
		if (
			event.type === "tool_call" ||
			event.type === "before_provider_request" ||
			event.type.startsWith("session_before_")
		) {
			return { action: "deny", reason };
		}
		return { action: "continue", event };
	}

	async #runFunctionHookWithTimeout(
		hook: FunctionHook,
		invocation: FunctionHookInvocation,
		capabilities: ReturnType<typeof createFunctionHookCapabilities>,
		next: FunctionHookNext,
		parentSignal: AbortSignal,
		ext: Extension,
		controller: AbortController,
	): Promise<
		{ status: "ok"; value: unknown } | { status: "timeout" } | { status: "error"; error: string; stack?: string }
	> {
		const abortFromParent = () => controller.abort(parentSignal.reason);
		if (parentSignal.aborted) abortFromParent();
		else parentSignal.addEventListener("abort", abortFromParent, { once: true });
		const childInvocation = Object.freeze({ ...invocation, signal: controller.signal });
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<"timeout">(resolve => {
			timer = setTimeout(() => {
				controller.abort(new Error("Function hook timed out"));
				resolve("timeout");
			}, extensionHandlerTimeoutMs);
		});
		const aborted = new Promise<"aborted">(resolve => {
			if (parentSignal.aborted) resolve("aborted");
			else parentSignal.addEventListener("abort", () => resolve("aborted"), { once: true });
		});
		try {
			const value = await Promise.race([
				Promise.resolve()
					.then(() => hook(childInvocation, capabilities, next))
					.then(result => ({ status: "ok" as const, value: result })),
				timeout.then(status => ({ status })),
				aborted.then(status => ({ status })),
			]);
			if (value.status === "timeout" || value.status === "aborted") {
				const error =
					value.status === "timeout"
						? `handler timed out after ${extensionHandlerTimeoutMs}ms`
						: "handler aborted";
				this.emitError({ extensionPath: ext.path, event: invocation.eventType, error });
				return { status: "timeout" };
			}
			return value;
		} catch (error) {
			const message = sanitizeFunctionHookReason(
				error instanceof Error ? error.message : String(error),
				"Function hook failed",
			);
			const stack = error instanceof Error ? error.stack : undefined;
			this.emitError({ extensionPath: ext.path, event: invocation.eventType, error: message, stack });
			return { status: "error", error: message, stack };
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			parentSignal.removeEventListener("abort", abortFromParent);
		}
	}

	/** Execute capability-scoped middleware stored in Extension.handlers. */
	async emitFunctionHooks<TEvent extends ExtensionEvent>(
		event: TEvent,
		options: { signal?: AbortSignal; correlationId?: string } = {},
	): Promise<FunctionHookDispatchResult<TEvent>> {
		const handlers = this.#matchingFunctionHooks(event);
		if (handlers.length === 0) return { action: "continue", event };
		if (this.#functionHookDepth >= 16) {
			const reason = "Function hook re-entry depth exceeded";
			this.emitError({ extensionPath: "<function-hooks>", event: event.type, error: reason });
			return this.#functionHookErrorResult(event, reason) as FunctionHookDispatchResult<TEvent>;
		}
		const parentSignal = options.signal ?? new AbortController().signal;
		const eventId = randomUUID();
		const correlationId = options.correlationId ?? eventId;
		this.#functionHookDepth += 1;
		try {
			const invoke = async (
				index: number,
				currentEvent: TEvent,
				allowedGrant: FunctionHookGrant | undefined,
				chainSignal: AbortSignal,
			): Promise<FunctionHookDispatchResult<TEvent>> => {
				if (index >= handlers.length) return { action: "continue", event: currentEvent };
				if (chainSignal.aborted)
					return this.#functionHookErrorResult(
						currentEvent,
						"Function hook chain aborted",
					) as FunctionHookDispatchResult<TEvent>;
				const indexed = handlers[index];
				if (!indexed) return { action: "continue", event: currentEvent };
				const registration = indexed.registration;
				const effectiveGrant = intersectFunctionHookGrants(registration.grant, allowedGrant);
				const downstreamGrant =
					registration.grant.attenuateDownstream && registration.grant.attenuateDownstream.length > 0
						? attenuateFunctionHookGrant(effectiveGrant, registration.grant.attenuateDownstream)
						: allowedGrant;
				const wildcard = registration.event === "*" || registration.target === "*";
				const failureResult = (reason: string): FunctionHookDispatchResult<TEvent> => {
					if (functionHookDenyAllowed(currentEvent, effectiveGrant)) return { action: "deny", reason };
					if (wildcard) return { action: "continue", event: currentEvent };
					return this.#functionHookErrorResult(currentEvent, reason) as FunctionHookDispatchResult<TEvent>;
				};
				const payload = Object.freeze(
					compatibilityPayloadForFunctionHook(currentEvent, effectiveGrant, wildcard),
				) as Readonly<TEvent>;
				const controller = new AbortController();
				const abortFromChain = () => controller.abort(chainSignal.reason);
				if (chainSignal.aborted) abortFromChain();
				else chainSignal.addEventListener("abort", abortFromChain, { once: true });
				const invocation = Object.freeze({
					eventId,
					correlationId,
					eventType: currentEvent.type,
					provenance: Object.freeze({ ...registration.provenance }),
					registrationOrder: indexed.registrationOrder,
					payload,
					signal: controller.signal,
				}) as FunctionHookInvocation<TEvent>;
				let active = true;
				const bindings: FunctionHookCapabilityBindings = {
					cwd: this.cwd,
					ui: this.#uiContext,
					sessionMetadata: this.sessionMetadata,
					isActive: () => active && !chainSignal.aborted && !controller.signal.aborted,
					emitMessage: (message, options) => {
						const { triggerTurn: _triggerTurn, deliverAs: _deliverAs, ...payload } = message;
						this.runtime.sendMessage(
							{
								...payload,
								display: message.display ?? false,
							},
							options,
						);
					},
					appendAudit: evidence => {
						this.#appendFunctionHookAudit(
							registration,
							invocation,
							"continue",
							undefined,
							effectiveGrant,
							evidence,
						);
					},
					fetch: (input, init) => fetch(input, init),
					readFile: (filePath, roots) => readConstrainedFunctionHookFile(filePath, this.cwd, roots),
				};
				const capabilities = createFunctionHookCapabilities(effectiveGrant, bindings);
				let nextCalled = false;
				let nextFailureReason: string | undefined;
				let nextPromise: Promise<FunctionHookDispatchResult<TEvent>> | undefined;
				const next: FunctionHookNext = async nextEvent => {
					if (nextCalled) throw new Error("Function hook next() may only be called once");
					nextCalled = true;
					const candidate = (nextEvent ?? currentEvent) as TEvent;
					if (
						nextEvent !== undefined &&
						(!isPlainFunctionHookData(candidate) ||
							candidate.type !== currentEvent.type ||
							!isValidFunctionHookEventValue(candidate) ||
							!functionHookTransformAllowed(currentEvent, effectiveGrant))
					) {
						nextFailureReason = "Function hook passed an invalid or unauthorized event to next()";
						throw new Error(nextFailureReason);
					}
					nextPromise = invoke(index + 1, candidate, downstreamGrant, controller.signal);
					return (await nextPromise) as FunctionHookResult;
				};
				const outcome = await this.#runFunctionHookWithTimeout(
					registration.handler,
					invocation,
					capabilities,
					next as FunctionHookNext,
					chainSignal,
					indexed.ext,
					controller,
				);
				if (outcome.status === "timeout") {
					controller.abort(new Error("Function hook invocation timed out"));
					active = false;
					chainSignal.removeEventListener("abort", abortFromChain);
					this.#appendFunctionHookAudit(registration, invocation, "timeout");
					return failureResult("Function hook timed out");
				}
				if (outcome.status === "error") {
					controller.abort(new Error("Function hook invocation failed"));
					active = false;
					chainSignal.removeEventListener("abort", abortFromChain);
					this.#appendFunctionHookAudit(registration, invocation, "error", outcome.error);
					return failureResult(outcome.error);
				}
				if (nextFailureReason) {
					controller.abort(new Error(nextFailureReason));
					active = false;
					chainSignal.removeEventListener("abort", abortFromChain);
					this.#appendFunctionHookAudit(registration, invocation, "error", nextFailureReason);
					return failureResult(nextFailureReason);
				}
				if (nextCalled) {
					const nextResult = (await nextPromise) as FunctionHookDispatchResult<TEvent>;
					controller.abort(new Error("Function hook invocation completed"));
					active = false;
					chainSignal.removeEventListener("abort", abortFromChain);
					return nextResult;
				}
				controller.abort(new Error("Function hook invocation completed"));
				active = false;
				chainSignal.removeEventListener("abort", abortFromChain);
				const rawResult = outcome.value;
				if (rawResult === undefined) {
					this.#appendFunctionHookAudit(registration, invocation, "continue");
					return await invoke(index + 1, currentEvent, downstreamGrant, chainSignal);
				}
				if (
					rawResult === null ||
					!isPlainFunctionHookData(rawResult) ||
					typeof rawResult !== "object" ||
					Array.isArray(rawResult)
				) {
					const reason = "Function hook returned a non-plain result";
					this.emitError({ extensionPath: indexed.ext.path, event: currentEvent.type, error: reason });
					this.#appendFunctionHookAudit(registration, invocation, "error", reason);
					return failureResult(reason);
				}
				const action = (rawResult as { action?: unknown }).action;
				const allowedResultKeys =
					action === "continue"
						? new Set(["action", "event"])
						: action === "deny"
							? new Set(["action", "reason"])
							: action === "return"
								? new Set(["action", "value"])
								: undefined;
				if (!allowedResultKeys || Object.keys(rawResult).some(key => !allowedResultKeys.has(key))) {
					const reason = "Function hook returned unknown result fields";
					this.emitError({ extensionPath: indexed.ext.path, event: currentEvent.type, error: reason });
					this.#appendFunctionHookAudit(registration, invocation, "error", reason);
					return failureResult(reason);
				}
				if (action === "continue") {
					const candidate = (rawResult as { event?: unknown }).event;
					let nextEvent = currentEvent;
					if (candidate !== undefined) {
						if (
							!isPlainFunctionHookData(candidate) ||
							(candidate as { type?: unknown }).type !== currentEvent.type ||
							!isValidFunctionHookEventValue(candidate as ExtensionEvent)
						) {
							const reason = "Function hook returned an invalid transformed event";
							this.emitError({ extensionPath: indexed.ext.path, event: currentEvent.type, error: reason });
							this.#appendFunctionHookAudit(registration, invocation, "error", reason);
							return failureResult(reason);
						}
						if (!functionHookTransformAllowed(currentEvent, effectiveGrant)) {
							const reason = "Function hook transform capability was not granted";
							this.emitError({ extensionPath: indexed.ext.path, event: currentEvent.type, error: reason });
							this.#appendFunctionHookAudit(registration, invocation, "error", reason);
							return failureResult(reason);
						}
						nextEvent = candidate as TEvent;
					}
					this.#appendFunctionHookAudit(registration, invocation, "continue");
					return await invoke(index + 1, nextEvent, downstreamGrant, chainSignal);
				}
				if (action === "deny") {
					const reason = sanitizeFunctionHookReason(
						(rawResult as { reason?: unknown }).reason,
						"Function hook denied the event",
					);
					if (!functionHookDenyAllowed(currentEvent, effectiveGrant)) {
						const invalidReason = "Function hook deny capability was not granted";
						this.emitError({ extensionPath: indexed.ext.path, event: currentEvent.type, error: invalidReason });
						this.#appendFunctionHookAudit(registration, invocation, "error", invalidReason);
						return failureResult(invalidReason);
					}
					this.#appendFunctionHookAudit(registration, invocation, "deny", reason);
					return { action: "deny", reason } as FunctionHookDispatchResult<TEvent>;
				}
				if (action === "return" && Object.hasOwn(rawResult, "value")) {
					if (!functionHookDenyAllowed(currentEvent, effectiveGrant)) {
						const reason = "Function hook short-circuit capability was not granted";
						this.emitError({ extensionPath: indexed.ext.path, event: currentEvent.type, error: reason });
						this.#appendFunctionHookAudit(registration, invocation, "error", reason);
						return failureResult(reason);
					}
					const value = (rawResult as { value: unknown }).value;
					if (value === undefined || !isSafeFunctionHookValue(value)) {
						const reason = "Function hook returned a non-plain terminal value";
						this.emitError({ extensionPath: indexed.ext.path, event: currentEvent.type, error: reason });
						this.#appendFunctionHookAudit(registration, invocation, "error", reason);
						return failureResult(reason);
					}
					this.#appendFunctionHookAudit(registration, invocation, "return");
					return { action: "return", value } as FunctionHookDispatchResult<TEvent>;
				}
				const reason = "Function hook returned an invalid action";
				this.emitError({ extensionPath: indexed.ext.path, event: currentEvent.type, error: reason });
				this.#appendFunctionHookAudit(registration, invocation, "error", reason);
				return failureResult(reason);
			};
			return await invoke(0, event, undefined, parentSignal);
		} finally {
			this.#functionHookDepth -= 1;
		}
	}

	#isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_branch" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}

	async #runHandlerWithTimeout<TEvent extends { type: string }, TResult>(
		handler: (event: TEvent, ctx: ExtensionContext) => Promise<TResult | undefined> | TResult | undefined,
		event: TEvent,
		ctx: ExtensionContext,
		ext: Extension,
		timeoutMs: number | undefined,
	): Promise<TResult | undefined> {
		let timeout: NodeJS.Timeout | undefined;
		const abortController = new AbortController();
		const handlerContext = createHandlerContext(ctx, abortController.signal);
		try {
			if (timeoutMs === undefined) return await handler(event, handlerContext);
			const timeoutPromise = new Promise<typeof EXTENSION_HANDLER_TIMEOUT>(resolve => {
				timeout = setTimeout(() => resolve(EXTENSION_HANDLER_TIMEOUT), timeoutMs);
			});
			const handlerResult = await Promise.race([Promise.resolve(handler(event, handlerContext)), timeoutPromise]);
			if (timeout !== undefined) {
				clearTimeout(timeout);
				timeout = undefined;
			}

			if (handlerResult === EXTENSION_HANDLER_TIMEOUT) {
				const error = `handler timed out after ${timeoutMs}ms`;
				abortController.abort(new Error(error));
				logger.warn("Extension handler timed out", {
					extensionPath: ext.path,
					event: event.type,
					timeoutMs,
				});
				this.emitError({
					extensionPath: ext.path,
					event: event.type,
					error,
				});
				return undefined;
			}
			return handlerResult as TResult | undefined;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			this.emitError({
				extensionPath: ext.path,
				event: event.type,
				error: message,
				stack,
			});
			return undefined;
		} finally {
			if (timeout !== undefined) {
				clearTimeout(timeout);
			}
		}
	}

	async emit<TEvent extends RunnerEmitEvent>(
		event: TEvent,
		continueWhile?: () => boolean,
		scope?: AttemptScopeRef,
	): Promise<RunnerEmitResult<TEvent>> {
		const functionDispatch = await this.emitFunctionHooks(event);
		if (functionDispatch.action === "deny") {
			if (this.#isSessionBeforeEvent(event)) return { cancel: true } as RunnerEmitResult<TEvent>;
			return undefined as RunnerEmitResult<TEvent>;
		}
		if (functionDispatch.action === "return") return functionDispatch.value as RunnerEmitResult<TEvent>;
		const functionEvent = functionDispatch.event;
		const handlers = this.#legacyHandlers(event.type);
		if (handlers.length === 0) return undefined as RunnerEmitResult<TEvent>;
		this.#requireScopeOrFailClosed(scope, event.type);

		const ctx = this.createContext();
		let result: SessionBeforeEventResult | SessionCompactingResult | undefined;
		let marked = false;

		for (const { ext, handler } of handlers) {
			if (continueWhile && !continueWhile()) return result as RunnerEmitResult<TEvent>;
			if (!marked) {
				this.#markAttemptExecuted(scope);
				marked = true;
			}
			const handlerResult = await this.#runHandlerWithTimeout(
				handler,
				functionEvent,
				ctx,
				ext,
				event.type === "session_shutdown" ? sessionShutdownHandlerTimeoutMs : extensionHandlerTimeoutMs,
			);
			if (continueWhile && !continueWhile()) return result as RunnerEmitResult<TEvent>;

			if (this.#isSessionBeforeEvent(event) && handlerResult) {
				result = handlerResult as SessionBeforeEventResult;
				if (result.cancel) {
					return result as RunnerEmitResult<TEvent>;
				}
			}

			if (event.type === "session.compacting" && handlerResult) {
				result = handlerResult as SessionCompactingResult;
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	async emitToolResult(
		event: ToolResultEvent,
		scope?: AttemptScopeRef,
		options: { signal?: AbortSignal; correlationId?: string } = {},
	): Promise<ToolResultEventResult | undefined> {
		const functionDispatch = await this.emitFunctionHooks(event, options);
		if (functionDispatch.action === "deny") {
			return {
				content: [{ type: "text", text: functionDispatch.reason }],
				details: event.details,
				isError: true,
			};
		}
		if (functionDispatch.action === "return") return functionDispatch.value as ToolResultEventResult;
		const functionEvent = functionDispatch.event;
		event.content = functionEvent.content;
		event.details = functionEvent.details;
		event.isError = functionEvent.isError;
		const handlers = this.#legacyHandlers("tool_result");
		if (handlers.length === 0) return undefined;
		this.#requireScopeOrFailClosed(scope, "tool_result");

		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;
		let marked = false;

		for (const { ext, handler } of handlers) {
			if (!marked) {
				this.#markAttemptExecuted(scope);
				marked = true;
			}
			const handlerResult = (await this.#runHandlerWithTimeout(
				handler,
				currentEvent,
				ctx,
				ext,
				extensionHandlerTimeoutMs,
			)) as ToolResultEventResult | undefined;
			if (!handlerResult) continue;

			if (handlerResult.content !== undefined) {
				currentEvent.content = handlerResult.content;
				modified = true;
			}
			if (handlerResult.details !== undefined) {
				currentEvent.details = handlerResult.details;
				modified = true;
			}
			if (handlerResult.isError !== undefined) {
				currentEvent.isError = handlerResult.isError;
				modified = true;
			}
		}

		if (!modified) return undefined;

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
		};
	}

	async emitToolCall(
		event: ToolCallEvent,
		scope?: AttemptScopeRef,
		options: { signal?: AbortSignal; correlationId?: string } = {},
	): Promise<ToolCallEventResult | undefined> {
		const functionDispatch = await this.emitFunctionHooks(event, options);
		if (functionDispatch.action === "deny") return { block: true, reason: functionDispatch.reason };
		if (functionDispatch.action === "return") return functionDispatch.value as ToolCallEventResult;
		event.input = functionDispatch.event.input;
		const handlers = this.#legacyHandlers("tool_call");
		if (handlers.length === 0) return undefined;
		this.#requireScopeOrFailClosed(scope, "tool_call");

		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;
		let marked = false;

		for (const { ext, handler } of handlers) {
			if (!marked) {
				this.#markAttemptExecuted(scope);
				marked = true;
			}
			try {
				const handlerResult = await handler(event, ctx);

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) {
						return result;
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					extensionPath: ext.path,
					event: "tool_call",
					error: message,
					stack,
				});
				return { block: true, reason: `Extension ${ext.path} failed: ${message}` };
			}
		}

		return result;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		return this.emitUserEvent<UserBashEventResult>(event, "user_bash");
	}

	async emitUserPython(event: UserPythonEvent): Promise<UserPythonEventResult | undefined> {
		return this.emitUserEvent<UserPythonEventResult>(event, "user_python");
	}

	private async emitUserEvent<R>(
		event: UserBashEvent | UserPythonEvent,
		eventName: "user_bash" | "user_python",
	): Promise<R | undefined> {
		const functionDispatch = await this.emitFunctionHooks(event);
		if (functionDispatch.action === "deny" || functionDispatch.action === "return") {
			return functionDispatch.action === "return" ? (functionDispatch.value as R) : undefined;
		}
		const functionEvent = functionDispatch.event;
		const handlers = this.#legacyHandlers(eventName);
		if (handlers.length === 0) return undefined;

		const ctx = this.createContext();

		for (const { ext, handler } of handlers) {
			const handlerResult = await this.#runHandlerWithTimeout(
				handler,
				functionEvent,
				ctx,
				ext,
				extensionHandlerTimeoutMs,
			);
			if (handlerResult) {
				return handlerResult as R;
			}
		}

		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		const functionDispatch = await this.emitFunctionHooks({ type: "resources_discover", cwd, reason });
		if (functionDispatch.action === "deny") return { skillPaths: [], promptPaths: [], themePaths: [] };
		if (functionDispatch.action === "return")
			return functionDispatch.value as {
				skillPaths: Array<{ path: string; extensionPath: string }>;
				promptPaths: Array<{ path: string; extensionPath: string }>;
				themePaths: Array<{ path: string; extensionPath: string }>;
			};
		const functionEvent = functionDispatch.event;
		const handlers = this.#legacyHandlers("resources_discover");
		if (handlers.length === 0) return { skillPaths: [], promptPaths: [], themePaths: [] };
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const { ext, handler } of handlers) {
			const handlerResult = await this.#runHandlerWithTimeout(
				handler,
				functionEvent,
				ctx,
				ext,
				extensionHandlerTimeoutMs,
			);
			const result = handlerResult as ResourcesDiscoverResult | undefined;

			if (result?.skillPaths?.length) {
				skillPaths.push(...result.skillPaths.map(path => ({ path, extensionPath: ext.path })));
			}
			if (result?.promptPaths?.length) {
				promptPaths.push(...result.promptPaths.map(path => ({ path, extensionPath: ext.path })));
			}
			if (result?.themePaths?.length) {
				themePaths.push(...result.themePaths.map(path => ({ path, extensionPath: ext.path })));
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: "interactive" | "sdk" | "extension",
	): Promise<InputEventResult> {
		const functionDispatch = await this.emitFunctionHooks({ type: "input", text, images, source });
		if (functionDispatch.action === "deny") return { handled: true };
		if (functionDispatch.action === "return") return functionDispatch.value as InputEventResult;
		const transformedInput = functionDispatch.event;
		const handlers = this.#legacyHandlers("input");
		if (handlers.length === 0)
			return transformedInput.text !== text || transformedInput.images !== images
				? { text: transformedInput.text, images: transformedInput.images }
				: {};

		const ctx = this.createContext();
		let currentText = transformedInput.text;
		let currentImages = transformedInput.images;

		for (const { ext, handler } of handlers) {
			const event: InputEvent = { type: "input", text: currentText, images: currentImages, source };
			const result = (await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs)) as
				| InputEventResult
				| undefined;
			if (result?.handled) return result;
			if (result?.text !== undefined) {
				currentText = result.text;
				currentImages = result.images ?? currentImages;
			}
		}

		return currentText !== text || currentImages !== images ? { text: currentText, images: currentImages } : {};
	}

	async emitContext(messages: AgentMessage[], scope?: AttemptScopeRef): Promise<AgentMessage[]> {
		const functionDispatch = await this.emitFunctionHooks({ type: "context", messages });
		if (functionDispatch.action === "deny") return messages;
		if (functionDispatch.action === "return") return functionDispatch.value as AgentMessage[];
		const transformedMessages = functionDispatch.event.messages;
		const handlers = this.#legacyHandlers("context");
		if (handlers.length === 0) return transformedMessages;
		this.#requireScopeOrFailClosed(scope, "context");

		const ctx = this.createContext();
		let currentMessages: AgentMessage[];
		try {
			currentMessages = structuredClone(transformedMessages);
		} catch {
			// Messages may contain non-cloneable objects (e.g. in ToolResultMessage.details
			// or ProviderPayload). Fall back to a shallow array clone — extensions should
			// return new message arrays rather than mutating in place.
			currentMessages = [...transformedMessages];
		}
		let marked = false;

		for (const { ext, handler } of handlers) {
			if (!marked) {
				this.#markAttemptExecuted(scope);
				marked = true;
			}
			const event: ContextEvent = { type: "context", messages: currentMessages };
			const handlerResult = await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs);

			if (handlerResult && (handlerResult as ContextEventResult).messages) {
				currentMessages = (handlerResult as ContextEventResult).messages!;
			}
		}

		return currentMessages;
	}

	async emitBeforeProviderRequest(
		payload: unknown,
		scope?: AttemptScopeRef,
	): Promise<BeforeProviderRequestEventResult> {
		const functionDispatch = await this.emitFunctionHooks({ type: "before_provider_request", payload });
		if (functionDispatch.action === "deny") throw new Error(functionDispatch.reason);
		if (functionDispatch.action === "return") return functionDispatch.value;
		const handlers = this.#legacyHandlers("before_provider_request");
		if (handlers.length === 0) return functionDispatch.event.payload;
		this.#requireScopeOrFailClosed(scope, "before_provider_request");

		const ctx = this.createContext();
		let currentPayload = functionDispatch.event.payload;
		let marked = false;

		for (const { ext, handler } of handlers) {
			if (!marked) {
				this.#markAttemptExecuted(scope);
				marked = true;
			}
			const event: BeforeProviderRequestEvent = {
				type: "before_provider_request",
				payload: currentPayload,
			};
			const handlerResult = await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs);
			if (handlerResult !== undefined) {
				currentPayload = handlerResult;
			}
		}

		return currentPayload;
	}

	async emitAfterProviderResponse(
		response: ProviderResponseMetadata,
		_model?: Model,
		scope?: AttemptScopeRef,
	): Promise<void> {
		const functionDispatch = await this.emitFunctionHooks({
			type: "after_provider_response",
			status: response.status,
			headers: response.headers,
			requestId: response.requestId,
			metadata: response.metadata,
		});
		if (functionDispatch.action !== "continue") return;
		const functionEvent = functionDispatch.event;
		const handlers = this.#legacyHandlers("after_provider_response");
		if (handlers.length === 0) return;
		this.#requireScopeOrFailClosed(scope, "after_provider_response");

		const ctx = this.createContext();
		let marked = false;

		for (const { ext, handler } of handlers) {
			if (!marked) {
				this.#markAttemptExecuted(scope);
				marked = true;
			}
			await this.#runHandlerWithTimeout(handler, functionEvent, ctx, ext, extensionHandlerTimeoutMs);
		}
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string[],
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		const functionDispatch = await this.emitFunctionHooks({
			type: "before_agent_start",
			prompt,
			images,
			systemPrompt,
		});
		if (functionDispatch.action === "deny") return undefined;
		if (functionDispatch.action === "return") return functionDispatch.value as BeforeAgentStartCombinedResult;
		const handlers = this.#legacyHandlers("before_agent_start");
		if (handlers.length === 0) return undefined;

		const ctx = this.createContext();
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let currentSystemPrompt = functionDispatch.event.systemPrompt;
		let systemPromptModified = false;

		for (const { ext, handler } of handlers) {
			const event: BeforeAgentStartEvent = {
				type: "before_agent_start",
				prompt,
				images,
				systemPrompt: currentSystemPrompt,
			};
			const handlerResult = await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs);

			if (handlerResult) {
				const unsupportedFields = unsupportedBeforeAgentStartResultFields(handlerResult);
				if (unsupportedFields.length > 0) {
					this.emitError({
						extensionPath: ext.path,
						event: "before_agent_start",
						error: `Unsupported before_agent_start result field(s): ${unsupportedFields.join(", ")}. Supported fields: message, systemPrompt.`,
					});
				}
				const result = handlerResult as BeforeAgentStartEventResult;
				if (result.message) {
					messages.push(result.message);
				}
				if (result.systemPrompt !== undefined) {
					currentSystemPrompt = result.systemPrompt;
					systemPromptModified = true;
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}
}
