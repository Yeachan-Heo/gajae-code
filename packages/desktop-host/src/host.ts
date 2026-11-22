import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { AttemptRunHandle } from "@gajae-code/agent-core/attempt-scope";
import { getOAuthProviders, type ImageContent, type Model } from "@gajae-code/ai/core";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	AuthorizationControls,
	type AuthorizationFlowState,
	type AuthorizationProviderStatus,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	captureSessionView,
	createAgentSession,
	createEmbeddedAgentSession,
	createSdkComposerObservation,
	createSdkDiffObservation,
	createSdkPreferenceControls,
	createSessionImageInput,
	deleteEmbeddedSession,
	type EmbeddedAgentSessionResult,
	type EmbeddedTranscriptTail,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	executeAcpBuiltinSlashCommand,
	forkEmbeddedSession,
	getEmbeddedAvailableModels,
	getSessionMessageEntryId,
	getSettingsCatalog,
	type InputEventResult,
	isEmbeddedAppendRefused,
	listEmbeddedProjectSessions,
	type QueuedInputSubmission,
	readEmbeddedTranscriptHistory,
	readEmbeddedTranscriptTail,
	resolveManagedSessionScope,
	restoreSessionView,
	type SdkComposerCompletionResult,
	type SdkComposerObservation,
	type SdkPreferenceOutcome,
	SdkRevisionError,
	type SdkSessionInfo,
	type SdkSessionView,
	type SettingCatalogItem,
	Settings,
	type SlashCommandRuntime,
	validateEmbeddedConfigPatch,
} from "@gajae-code/coding-agent/sdk";
import { getAgentDir, getSessionsDir, setAgentDir } from "@gajae-code/utils";
import { createDesktopActivityController, type DesktopActivityController } from "./activity-controls";
import type {
	DesktopActivityAcknowledgement,
	DesktopActivityGateAnswer,
	DesktopActivityOperation,
	DesktopActivityRef,
	DesktopActivityScope,
} from "./activity-protocol";
import { prepareDesktopAttachmentInput } from "./attachment-input";
import { createDesktopBtwController, type DesktopBtwController } from "./btw-controls";
import { DesktopComposerCompletion, projectDesktopCompletion, readDesktopCompletionInput } from "./composer-completion";
import { DeliveryJournal } from "./delivery-journal";
import { prepareDesktopEnvironment } from "./environment-policy";
import {
	createDesktopGatePresenter,
	DesktopGatePresentationError,
	type DesktopGatePresenter,
} from "./gate-presentation";
import { ManagedSession } from "./managed-session";
import { createDesktopMcpController, type DesktopMcpController } from "./mcp-controls";
import {
	type AnchoredNotice,
	anchorNotices,
	copyableMessageText,
	countVisibleMessages,
	fitDisplay,
	HISTORY_LIMIT,
	projectHistoryPage,
	projectMessages,
	TEXT_LIMIT,
} from "./message-projection";
import {
	projectDesktopModel,
	projectDesktopThinking,
	validateModelThinking,
	validateSessionThinking,
} from "./model-controls";
import { createDesktopOperatorController, type DesktopOperatorController } from "./operator-controls";
import {
	createDesktopPreferencesController,
	DesktopPreferenceError,
	type DesktopPreferencesController,
	projectPreferenceOutcome,
	requireAppliedPreference,
} from "./preferences-controls";
import type { DesktopPreferenceOutcome, DesktopPreferenceResult } from "./preferences-protocol";
import { PromptRevisions } from "./prompt-revisions";
import type {
	DesktopActivityUpdate,
	DesktopAuthProvider,
	DesktopAuthState,
	DesktopCapability,
	DesktopCommand,
	DesktopCommandResult,
	DesktopCompletionResult,
	DesktopDeliveryReceipt,
	DesktopDiff,
	DesktopDisconnectResult,
	DesktopForkResult,
	DesktopFrame,
	DesktopHistory,
	DesktopProject,
	DesktopQuestion,
	DesktopQueuedInput,
	DesktopRequest,
	DesktopSession,
	DesktopSessionConnection,
	DesktopSetting,
	DesktopSnapshot,
} from "./protocol";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from "./protocol";
import { projectDesktopSessionInfo, readDesktopPullRequest, readDesktopSessionInfo } from "./session-info";
import { projectGoal, projectTodos } from "./session-state";
import { createDesktopStreamRedactor } from "./stream-redactor";
import { projectToolCatalog } from "./tool-catalog";
import { observeToolEvent, projectLiveToolCalls, projectToolDetail } from "./tool-projection";

type AgentSession = CreateAgentSessionResult["session"];
type SessionManager = AgentSession["sessionManager"];
type ModelRegistry = AgentSession["modelRegistry"];
type AuthStorage = ModelRegistry["authStorage"];
type SettingPath = SettingCatalogItem["path"];
const SETTING_CATALOG = getSettingsCatalog(Settings.isolated());

const scopeKey = (scope: { lineage: string; generation: number; attemptId: string }): string =>
	JSON.stringify([scope.lineage, scope.generation, scope.attemptId]);
/**
 * Transcript evidence for a user turn: the SDK bound this exact message to a session entry, and
 * the session's transcript state still holds that entry. This proves the text is part of the
 * conversation, not that it was flushed to disk (an unpersisted session holds it in memory only).
 * Preflight acceptance is not this proof, because it commits before the message is appended.
 */
const persistedUserTurn = (sdk: AgentSession, message: AgentMessage | undefined): boolean => {
	const entryId = message === undefined ? undefined : getSessionMessageEntryId(message);
	return entryId !== undefined && sdk.sessionManager.getEntry(entryId) !== undefined;
};
/** Owned control DTOs are already redacted; completion draft replacements must remain exact. */
const PROJECTED_CONTROL_METHODS = new Set<DesktopRequest["method"]>([
	"composer.complete",
	"message.copyText",
	"activity.get",
	"activity.detail",
	"activity.operate",
	"activity.acknowledge",
	"gate.present",
	"operator.execute",
	"operator.get",
	"operator.abort",
	"operator.fold",
	"btw.open",
	"btw.get",
	"btw.submit",
	"btw.cancel",
	"btw.close",
	"mcp.get",
	"mcp.operate",
	"session.info",
	"tools.list",
	"tool.detail",
]);
const HISTORY_PAGE_LIMIT = 500;
const COMMAND_OUTPUT_LIMIT = 200_000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/**
 * Settings this host can display and edit generically. Free-form strings are
 * withheld because they can carry endpoints, paths or credentials, matching the
 * conservative portable-catalog rule. Values are validated against the schema
 * before writing, the same contract as `gjc config set`.
 */
const WITHHELD_SETTING = /token|secret|password|credential|apiKey|broker|oauth/i;
/**
 * Settings that only change the terminal UI. They are still readable so the app
 * shows the truth, but saving them from the desktop would promise an effect the
 * app cannot deliver.
 */
const TERMINAL_ONLY_SETTING =
	/^(statusLine\.|theme\.|clipboard\.|ui\.|notifications?\.|symbolPreset$|syntaxTheme|footer|header|editor\.)/i;
const EDITABLE_SETTING_TYPES = new Set(["boolean", "number", "enum"]);
/**
 * Session lifecycle belongs to the desktop catalog: these builtins would rotate
 * or relocate the transcript behind the catalog's back, leaving it unreopenable.
 * They stay visibly unavailable instead of half-applying.
 */
const DESKTOP_OWNED_COMMANDS = new Set(["move", "session", "star", "unstar", "handoff"]);
/** Refusal copy names the app control that does the job, because one generic hint fits none. */
const DESKTOP_OWNED_REFUSALS: Record<string, string> = {
	move: "/move changes the session file path, so it is not supported. Start a session with 'New conversation' in the project list.",
	session:
		"/session is not supported. Select a session in the conversation list, or use the 'Delete' button at the top.",
	star: "Use the star button in the conversation list to star a conversation.",
	unstar: "Use the star button in the conversation list to unstar a conversation.",
	handoff: "/handoff changes the session identity, so the app does not support it. Continue in a new conversation.",
};
const DESKTOP_UNAVAILABLE =
	"This command is not available in the desktop app. Send ordinary messages without a leading slash.";
/** Commands the palette advertises; everything else is refused before dispatch. */
const ADVERTISED_COMMANDS = new Set(
	ACP_BUILTIN_SLASH_COMMANDS.filter(command => !DESKTOP_OWNED_COMMANDS.has(command.name)).map(command => command.name),
);

export const CAPABILITIES: DesktopCapability[] = [
	{ id: "sessions", label: "Independent SDK sessions and streaming", available: true },
	{ id: "questions", label: "Select, confirm, input and editor questions", available: true },
	{ id: "settings", label: "Schema-validated boolean, number and enum settings", available: true },
	{ id: "slash-commands", label: "Builtin slash commands via the public SDK dispatcher", available: true },
	{
		id: "oauth",
		label: "App-owned account authorization",
		available: true,
	},
	{
		id: "provider-removal",
		label: "Disconnect a provider",
		available: false,
		reason: "The public SDK has no credential-removal operation yet.",
	},
	{
		id: "custom-provider-endpoints",
		label: "Custom OpenAI-compatible endpoints",
		available: false,
		reason: "The public SDK cannot register custom endpoints yet; add them to models.yml from the terminal app.",
	},
];

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
export function requiredString(params: Record<string, unknown>, key: string, max = 32_000): string {
	const value = params[key];
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new Error(`Invalid ${key}`);
	return value;
}
function identifier(params: Record<string, unknown>, key: string): string {
	const value = requiredString(params, key, 36);
	if (!ID.test(value)) throw new Error(`Invalid ${key}`);
	return value;
}
export function validateQuestionAnswer(
	question: DesktopQuestion,
	params: Record<string, unknown>,
): string | boolean | null {
	if (identifier(params, "sessionId") !== question.sessionId) throw new Error("Question does not belong to session");
	const value = params.value;
	if (value === null) return null;
	if (question.kind === "confirm") {
		if (typeof value !== "boolean") throw new Error("Invalid question answer");
		return value;
	}
	if (typeof value !== "string" || value.length > 32_000) throw new Error("Invalid question answer");
	if (question.kind === "select" && !question.options?.includes(value)) throw new Error("Invalid question option");
	return value;
}

function readActivityScope(value: unknown): DesktopActivityScope {
	const scope = record(value);
	if (!scope) throw new Error("Invalid activity scope");
	return {
		sessionGeneration: requiredString(scope, "sessionGeneration", 128),
		connectionGeneration: requiredString(scope, "connectionGeneration", 128),
	};
}
function readActivityAcknowledgement(value: unknown): DesktopActivityAcknowledgement {
	const scope = readActivityScope(value);
	return { ...scope, acknowledgement: requiredString(record(value)!, "acknowledgement", 128) };
}
function readActivityRef(value: unknown): DesktopActivityRef {
	const scope = readActivityScope(value);
	const reference = record(value)!;
	return { ...scope, key: requiredString(reference, "key", 128) };
}
function readActivityOperation(value: unknown): DesktopActivityOperation {
	switch (value) {
		case "cancel":
		case "delete":
		case "stop":
		case "pause":
		case "resume":
			return value;
		default:
			throw new Error("Invalid activity operation");
	}
}
function readGateAnswer(value: unknown): DesktopActivityGateAnswer {
	const answer = record(value);
	if (answer?.kind === "choice") return { kind: "choice", choiceKey: requiredString(answer, "choiceKey", 128) };
	if (answer?.kind === "json") return { kind: "json", json: requiredString(answer, "json", 64 * 1024) };
	throw new Error("Invalid gate answer");
}

export function desktopDataDir(): string {
	return path.resolve(
		process.env.GJC_DESKTOP_DATA_DIR ||
			path.join(os.homedir(), "Library", "Application Support", "Gajae Code Desktop"),
	);
}

/**
 * Settings the desktop host can read and write without a feature-specific
 * controller: schema-constrained scalars only. Free-form strings, arrays and
 * records are withheld rather than guessed at.
 */
export function desktopSettings(settings: Settings): DesktopSetting[] {
	return getSettingsCatalog(settings).items.flatMap(item => {
		const { path, type, ui } = item;
		if (!EDITABLE_SETTING_TYPES.has(type) || WITHHELD_SETTING.test(path)) return [];
		const choices = item.choices.source === "schema" ? item.choices.options.map(option => option.value) : undefined;
		return [
			{
				path,
				value: item.effectiveValue.status === "available" ? item.effectiveValue.value : undefined,
				type,
				description: TERMINAL_ONLY_SETTING.test(path)
					? `${ui?.description ?? ""} (Terminal only: does not affect the desktop app UI.)`.trim()
					: (ui?.description ?? "Application-wide setting; persisted to the desktop config."),
				...(choices && choices.length > 0 ? { choices } : {}),
				writable:
					settings.canPersistDurableConfig() &&
					!TERMINAL_ONLY_SETTING.test(path) &&
					item.mutation.owner !== "notification-atomic" &&
					!path.startsWith("modelProfile."),
			} satisfies DesktopSetting,
		];
	});
}

/** Validate one generic settings write against the schema before it is persisted. */
export function validateDesktopSetting(path: unknown, value: unknown): SettingPath {
	const definition = SETTING_CATALOG.items.find(item => item.path === path);
	if (!definition) throw new Error("Unknown setting path");
	const settingPath = definition.path;
	if (!EDITABLE_SETTING_TYPES.has(definition.type) || WITHHELD_SETTING.test(settingPath))
		throw new Error("Setting is not editable from the desktop host");
	if (TERMINAL_ONLY_SETTING.test(settingPath))
		throw new Error("Setting only affects the terminal UI and cannot be changed from the desktop host");
	if (definition.mutation.owner === "notification-atomic" || settingPath.startsWith("modelProfile."))
		throw new Error("Setting is not editable from the desktop host");
	if (definition.type === "boolean" && typeof value !== "boolean") throw new Error("Setting requires a boolean");
	if (definition.type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Setting requires a number");
		if (validateEmbeddedConfigPatch({ [settingPath]: value }).length)
			throw new Error("Setting value is out of range");
	}
	if (definition.type === "enum") {
		const values =
			definition.choices.source === "schema" ? definition.choices.options.map(option => option.value) : [];
		if (typeof value !== "string" || !values.includes(value)) throw new Error("Setting value is not a valid choice");
	}
	return settingPath;
}

/**
 * Storage root that `SavedSession.file` is relative to. `desktop` is the app's
 * own transcript directory; `managed` is the SDK store the terminal reads, so a
 * conversation written here is the same transcript the terminal resumes.
 */
type SessionScope = "desktop" | "managed";

interface SavedSession {
	id: string;
	projectId: string;
	title: string;
	starred: boolean;
	file?: string;
	/** Absent means the legacy private root, which existing catalogs already use. */
	scope?: SessionScope;
	/** SDK transcript identity. The catalog `id` is the desktop identity and stays stable. */
	sessionId?: string;
	/** App presentation only: an exact SDK cursor, never ownership or mutation authority. */
	view?: SdkSessionView;
	/**
	 * The transcript's newest entry this app held when `view` was saved. A different tail on
	 * reopen means another surface appended. Absent on rows saved before it was recorded.
	 */
	viewTail?: string | null;
	createdAt?: number;
	/** Read-only SDK inventory reference, not authority to open a shared transcript. */
	managed?: true;
	/** The user released the app's writer (Disconnect); it stays read-only until Connect. */
	disconnected?: true;
}
interface Catalog {
	version: 1;
	projects: DesktopProject[];
	sessions: SavedSession[];
	/**
	 * SDK transcript identities whose rows this app removed. Discovery never offers them again
	 * as another surface's conversations, including a transcript whose removal failed.
	 */
	released?: string[];
}
/** The store refused a write because another process (the terminal) changed the transcript first. */
const STALE_TRANSCRIPT =
	"This conversation was changed in another window, such as the terminal, after the app opened it.";
/** What became of the stale copy once the refused operation ended; the message names only that. */
type StaleReplacement = "reloaded" | "deferred" | "failed";
const STALE_OUTCOME: Record<StaleReplacement, string> = {
	reloaded: `${STALE_TRANSCRIPT} The app reloaded it with the latest messages. Try again.`,
	deferred: `${STALE_TRANSCRIPT} The app will reload it with the latest messages once the work still running in it finishes. Then try again.`,
	failed: `${STALE_TRANSCRIPT} The app could not reload it. Select the conversation again to retry.`,
};
/** Every writing request on a released conversation answers with this, before any work starts. */
const DISCONNECTED =
	"This conversation is disconnected from the app, so the terminal can continue it. Connect it to continue here.";
/** Activity for a conversation the app does not hold open; the Session work card shows the reason. */
const READ_ONLY_ACTIVITY = "Background work is shown only while the app is connected to this conversation.";
/** Released identities kept; the oldest are dropped first. */
const RELEASED_LIMIT = 1_000;
interface TrackedQueuedInput {
	dto: DesktopQueuedInput;
	submission: QueuedInputSubmission;
	deliveryId: string;
}
/** A queued input's search for its own user turn, which the SDK does not identify (see `#claimUserTurn`). */
interface UserTurnClaimant {
	/** The exact text the input was submitted with. */
	text: string;
	/** User turns appended after the input was admitted, in transcript order. */
	turns: AgentMessage[];
}
interface SessionCandidate {
	sdk: AgentSession;
	factory: EmbeddedAgentSessionResult;
	metadata: SavedSession;
	settings: Settings;
	registry: ModelRegistry;
	notices: AnchoredNotice[];
}
interface ExclusiveViewHandoff {
	/** No more SDK mutations remain in the exclusive operation. Receipt writes may still be pending. */
	ready: Promise<void>;
	settle: () => void;
	/** Retiring persistence remains the request's before-ACK barrier, including failure. */
	transferred?: Promise<void>;
	persistence?: Promise<void>;
}
interface LiveSession extends SessionCandidate {
	viewOwnerToken: symbol;
	completion?: DesktopComposerCompletion;
	observation?: SdkComposerObservation;
	serviceGeneration: number;
	titleAbort?: AbortController;
	unsubscribeActivity: () => void;
	unsubscribeIdentity: () => void;
	busy: boolean;
	/** A settled continuation arrived while the current catalog write still held admission. */
	viewPending?: boolean;
	viewPersistence?: Promise<void>;
	/** Retirement may take final-view persistence without claiming delivery completion. */
	exclusiveViewHandoff?: ExclusiveViewHandoff;
	error?: string;
	errorOwner?: string;
	queuedAdmissionOrder?: number;
	errorEpoch?: number;
	errorScopeGeneration?: number;
	errorScopeKey?: string;
	scopeOwners: Map<string, { id: string; order: number }>;
	startup?: Promise<void>;
	startupGeneration?: number;
	startupPending?: boolean;
	extensionRunner?: AgentSession["extensionRunner"];
	extensionUI?: ExtensionUIContext;
	timer?: Timer;
	unsubscribe: () => void;
	activity: DesktopActivityController;
	preferences: DesktopPreferencesController;
	mcp: DesktopMcpController;
	operator?: DesktopOperatorController;
	operatorCurrentId?: string;
	btw?: DesktopBtwController;
	gatePresenter?: DesktopGatePresenter;
	gateUnavailable?: string;
	/** Blocks new surfaces across retirement and a catalog-owned lifecycle mutation. */
	gateMutation?: boolean;
	activityRevision: number;
	activityPublishedRevision: number;
	activityUpdate?: DesktopActivityUpdate;
	activitySerialized?: string;
	activityTimer?: Timer;
	streamingMessage?: unknown;
	/** Explicitly queued steering/follow-up submissions, in admission order. */
	queued: Map<string, TrackedQueuedInput>;
	revisions?: PromptRevisions;
	/** User turns already attributed to one input; a turn is evidence for at most one. */
	claimedUserTurns: WeakSet<AgentMessage>;
	/** The exclusive request in flight; settles after its receipt and final view are written. */
	exclusiveDone?: Promise<void>;
}
/** A conversation the app shows without holding it open: its transcript's history only. */
interface ReadOnlyView {
	/** File identity the history was read from; an unchanged file is not parsed again. */
	stamp: string;
	messages: AgentMessage[];
}
interface PendingQuestion {
	ownerToken: symbol;
	question: DesktopQuestion;
	settle: (value: string | boolean | null) => void;
}
export interface HostOptions {
	dataDir?: string;
	emit: (frame: DesktopFrame) => void;
	createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}

/** A close stops its runs on a budget: a wedged abort must not strand the folder's queue. */
const CLOSE_ABORT_TIMEOUT_MS = 5_000;
const CLOSE_TEARDOWN_TIMEOUT_MS = 15_000;

/** Resolves like the promise, or rejects once the budget signal fires. */
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("Workspace close timed out"));
	const timedOut = Promise.withResolvers<never>();
	const onAbort = () => timedOut.reject(new Error("Workspace close timed out"));
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, timedOut.promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

export class DesktopHost {
	#dataDir: string;
	/** Resolved SDK transcript root shared with the terminal; empty until initialization. */
	#managedSessionsRoot = "";
	get dataDir(): string {
		return this.#dataDir;
	}
	get agentDir(): string {
		// Shared install by default: the app uses the same agent directory as the
		// terminal so credentials, model profiles and the default preset match. Tests
		// and QA opt into an isolated directory via GJC_DESKTOP_ISOLATED.
		const configured = process.env.GJC_CODING_AGENT_DIR?.trim();
		if (configured) return path.resolve(configured);
		return process.env.GJC_DESKTOP_ISOLATED === "1" ? path.join(this.#dataDir, "agent") : getAgentDir();
	}
	#emit: (frame: DesktopFrame, projected?: boolean, preferenceOutcome?: DesktopPreferenceOutcome) => void;
	#createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	#catalog: Catalog = { version: 1, projects: [], sessions: [] };
	#deliveries!: DeliveryJournal;
	/** Process-local only: receipts and snapshots never recreate completion intent. */
	#completedTasks = new Set<string>();
	/** Every request's place in arrival order, taken in `#handle` before any await. */
	#arrivals = 0;
	/**
	 * Per conversation, the arrival number of the latest Stop that went on to stop its run. Only an
	 * input that arrived before such a Stop can end `cancelled` or be handed back as not run.
	 */
	#runStops = new Map<string, number>();
	#live = new Map<string, LiveSession>();
	/** Publication tokens survive live-map removal without retaining disposed SDK owners. */
	#viewOwners = new WeakMap<SavedSession, symbol>();
	#managed = new Map<string, ManagedSession>();
	#managedControlEpoch = 0;
	#managedOpening = new Map<string, Promise<ManagedSession>>();
	#managedProjectEpochs = new Map<string, number>();
	/** Unpublished SDK ownership, retained until publication or proven disposal. */
	#candidates = new Set<SessionCandidate>();
	/** Retired publications remain owned even after their catalog/live entry is removed. */
	#retiredLive = new Set<LiveSession>();
	/** Failed publication callers own catalog compensation, including on later cleanup retries. */
	#rolledBackPublications = new WeakSet<LiveSession>();
	#cleanupRuns = new WeakMap<SessionCandidate, Promise<void>>();
	#cleanupOwners = new Map<SessionCandidate, Promise<void>>();
	#pendingForks = new Set<string>();
	/**
	 * Every transcript this process created or held, by SDK identity and resolved file. Discovery
	 * never lists them as another surface's conversations, including ones the app deliberately
	 * left uncataloged (a branch fork's ancestor, retained cleanup, a failed removal). In-run only.
	 */
	#heldTranscripts = new Set<string>();
	/** Catalog rows whose turn ended while this Host ran. Loading or opening a row never adds it. */
	#endedTurns = new Set<string>();
	/** History of conversations the app does not write, by catalog id; filled when they are shown. */
	#readOnly = new Map<string, ReadOnlyView>();
	#opening = new Map<string, Promise<LiveSession>>();
	/**
	 * One queue per workspace path. Open and close both mutate the same catalog entry, and the
	 * renderer can issue them together (close a workspace, immediately reopen the folder), so they
	 * are serialized: a reopen never observes a half-closed workspace, and a close never hides a
	 * workspace a racing reopen just made usable.
	 */
	#projectLocks = new Map<string, Promise<unknown>>();
	#questions = new Map<string, PendingQuestion>();
	#auth?: AuthStorage;
	#control?: EmbeddedAgentSessionResult;
	#authorization?: AuthorizationControls;
	#authState: DesktopAuthState | null = null;
	#authPoll?: Timer;
	#authEpoch = 0;
	#authStarting = false;
	readonly #authPolling = new Set<number>();
	#authCatalogRefresh?: { id: string; task: Promise<boolean> };
	#registry?: ModelRegistry;
	#failedCatalogRefreshes = new WeakSet<ModelRegistry>();
	#catalogRefreshTail: Promise<void> = Promise.resolve();
	#settings?: Settings;
	#init?: Promise<void>;
	#saving: Promise<void> = Promise.resolve();
	#saveFailures: unknown[] = [];
	#closed = false;
	readonly #connectionGeneration = crypto.randomUUID();
	#closing?: Promise<void>;
	#tasks = new Set<Promise<unknown>>();
	#deliveryObservers = new Set<Promise<void>>();
	#deliveryFailures: unknown[] = [];
	#secrets = new Set<string>();

	constructor(options: HostOptions) {
		this.#dataDir = path.resolve(options.dataDir ?? desktopDataDir());
		this.#emit = (frame, projected = false, preferenceOutcome) => {
			// Owned controller DTOs are already redacted. Rewriting them here would
			// corrupt opaque references/enums and invalidate exact gate display proofs.
			// Still clone at the boundary so a consumer cannot mutate a private ledger.
			const completeProjection =
				projected || frame.type === "activity" || frame.type === "gate" || frame.type === "operator";
			const redact = (text: string) => this.#redact(text);
			const serialized = completeProjection
				? JSON.stringify(frame)
				: JSON.stringify(frame, (key, value: unknown) => {
						return typeof value === "string" &&
							![
								"id",
								"entryId",
								"sessionId",
								"projectId",
								"deliveryId",
								"sdkSubmissionId",
								"errorOwner",
								"type",
								"status",
								"kind",
								"role",
								"provider",
							].includes(key)
							? redact(value)
							: value;
					});
			const detached = JSON.parse(serialized) as DesktopFrame;
			// Preference display strings still need redaction; only the allowlisted
			// receipt primitives are exact, even when a credential matches an enum.
			if (preferenceOutcome && detached.type === "response") {
				if (detached.ok && detached.result && typeof detached.result === "object")
					(detached.result as DesktopPreferenceResult).outcome = { ...preferenceOutcome };
				else if (!detached.ok) detached.preferenceOutcome = { ...preferenceOutcome };
			}
			options.emit(detached);
		};
		this.#createSession = options.createSession ?? createAgentSession;
	}
	#redact(text: string): string {
		for (const secret of this.#secrets) text = text.split(secret).join("[redacted]");
		return text;
	}
	#error(error: unknown): string {
		return this.#redact(error instanceof Error ? error.message : "Operation failed").slice(0, 1000);
	}
	initialize(): Promise<void> {
		this.#init ??= this.#initialize();
		return this.#init;
	}
	async #initialize(): Promise<void> {
		await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		this.#dataDir = await fs.realpath(this.#dataDir);
		await fs.chmod(this.dataDir, 0o700);
		this.#deliveries = new DeliveryJournal(this.dataDir);
		await this.#deliveries.initialize();
		const agentDir = prepareDesktopEnvironment(process.env, this.dataDir);
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		if (process.env.GJC_DESKTOP_ISOLATED === "1")
			await fs.mkdir(path.join(this.dataDir, "home"), { recursive: true, mode: 0o700 });
		setAgentDir(agentDir);
		// Ask the SDK where its store is instead of rebuilding the path: the default
		// agent directory can route sessions through the XDG data lane.
		const sessionsRoot = getSessionsDir(agentDir);
		// Resolve once so a symlinked agent directory cannot make an otherwise valid
		// managed transcript look like it escaped its root.
		this.#managedSessionsRoot = await fs.realpath(sessionsRoot).catch(() => sessionsRoot);
		const catalogFile = Bun.file(path.join(this.dataDir, "catalog.json"));
		if (await catalogFile.exists()) {
			const value: unknown = await catalogFile.json();
			const catalog = record(value);
			if (catalog?.version !== 1 || !Array.isArray(catalog.projects) || !Array.isArray(catalog.sessions))
				throw new Error("Invalid desktop catalog");
			const projects = catalog.projects.map(value => {
				const item = record(value);
				if (!item) throw new Error("Invalid desktop project");
				if (item.closed !== undefined && typeof item.closed !== "boolean")
					throw new Error("Invalid desktop project");
				return {
					id: identifier(item, "id"),
					name: requiredString(item, "name", 200),
					path: requiredString(item, "path"),
					...(item.closed === true ? { closed: true } : {}),
				};
			});
			const sessions = catalog.sessions.map(value => {
				const item = record(value);
				if (!item || typeof item.starred !== "boolean") throw new Error("Invalid desktop session");
				const session: SavedSession = {
					id: identifier(item, "id"),
					projectId: identifier(item, "projectId"),
					title: requiredString(item, "title", 200),
					starred: item.starred,
				};
				if (item.createdAt !== undefined) {
					if (typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt) || item.createdAt < 0)
						throw new Error("Invalid session creation time");
					session.createdAt = item.createdAt;
				}
				if (!projects.some(project => project.id === session.projectId)) throw new Error("Invalid session project");
				if (item.managed !== undefined) {
					if (item.managed !== true || item.file !== undefined)
						throw new Error("Invalid managed session reference");
					session.managed = true;
				}
				if (item.sessionId !== undefined) session.sessionId = identifier(item, "sessionId");
				if (item.scope !== undefined) {
					if (item.scope !== "desktop" && item.scope !== "managed") throw new Error("Invalid session scope");
					session.scope = item.scope;
				}
				if (item.file !== undefined) {
					session.file = requiredString(item, "file");
					this.#sessionPath(session.file, session.scope);
				} else {
					// A creation interrupted before its transcript was recorded leaves a scope
					// with no file. Drop the scope instead of failing the whole catalog.
					session.scope = undefined;
				}
				if (item.view !== undefined) {
					const view = record(item.view);
					if (!view || Object.keys(view).length !== 2 || session.managed || !session.file || !session.sessionId)
						throw new Error("Invalid saved session view");
					const sessionId = identifier(view, "sessionId");
					if (sessionId !== session.sessionId)
						throw new Error("Saved session view identity does not match transcript");
					session.view = {
						sessionId,
						leafEntryId: view.leafEntryId === null ? null : requiredString(view, "leafEntryId", 128),
					};
				}
				if (item.viewTail !== undefined) {
					if (!session.view || (item.viewTail !== null && typeof item.viewTail !== "string"))
						throw new Error("Invalid saved session view");
					session.viewTail = item.viewTail === null ? null : requiredString(item, "viewTail", 128);
				}
				if (item.disconnected !== undefined) {
					if (item.disconnected !== true || session.managed) throw new Error("Invalid session connection");
					session.disconnected = true;
				}
				return session;
			});
			if (
				new Set(projects.map(p => p.id)).size !== projects.length ||
				new Set(sessions.map(s => s.id)).size !== sessions.length
			)
				throw new Error("Duplicate desktop IDs");
			const released = catalog.released;
			if (
				released !== undefined &&
				(!Array.isArray(released) || released.some(id => typeof id !== "string" || !ID.test(id)))
			)
				throw new Error("Invalid desktop catalog");
			this.#catalog = { version: 1, projects, sessions, ...(released?.length ? { released } : {}) };
		}
		this.#control = await createEmbeddedAgentSession({
			cwd: this.dataDir,
			agentDir: this.agentDir,
			profileAuthority: "custom",
			storage: { persist: false },
			controlOnly: true,
		});
		this.#settings = this.#control.session.settings;
		this.#registry = this.#control.session.modelRegistry;
		this.#auth = this.#registry.authStorage;
		this.#authorization = new AuthorizationControls(this.#control.session);
		this.#rememberCredentials();
		// The terminal refreshes the model catalog before applying the default preset;
		// without it a configured profile such as cdx-lhigh cannot resolve models that
		// only exist in the online catalog, and the app silently falls back.
		try {
			await this.#control.refreshModels("online");
		} catch {
			await this.#control.refreshModels("offline");
		}
	}
	/** Credential persistence is already committed; catalog refresh is a separate outcome. */
	#refreshModelCatalogs(targets: readonly EmbeddedAgentSessionResult[]): Promise<boolean> {
		const refresh = this.#catalogRefreshTail.then(async () => {
			const outcomes = await Promise.allSettled(
				targets.map(async factory => {
					const registry = factory.session.modelRegistry;
					try {
						await factory.refreshModels("offline");
						this.#failedCatalogRefreshes.delete(registry);
					} catch {
						this.#failedCatalogRefreshes.add(registry);
						throw new Error("Model catalog refresh failed");
					}
				}),
			);
			return outcomes.every(outcome => outcome.status === "fulfilled");
		});
		// Serialize refreshes so an older failure cannot overwrite a later success.
		this.#catalogRefreshTail = refresh.then(
			() => {},
			() => {},
		);
		return refresh;
	}
	#assertModelCatalogReady(registry: ModelRegistry): void {
		if (this.#failedCatalogRefreshes.has(registry))
			throw new Error("Model list refresh failed. Retry by reloading the list; saved credentials are preserved.");
	}
	/**
	 * `getAvailable` reports registration and credential presence. A failed session
	 * credential pin is separate SDK policy (`isSessionCredentialPinBlocking`, which
	 * mirrors `getApiKey` precedence over runtime/models.yml keys), so a blocked pin
	 * must not advertise models or admit a selection for that scope.
	 */
	#sessionModels(session: AgentSession): Model[] {
		return getEmbeddedAvailableModels(session);
	}
	#rememberCredentials(): void {
		for (const entries of Object.values(this.#auth!.getAll())) {
			for (const credential of Array.isArray(entries) ? entries : [entries]) {
				if (credential.type === "api_key" && credential.key) this.#secrets.add(credential.key);
				if (credential.type === "oauth") {
					if (credential.access) this.#secrets.add(credential.access);
					if (credential.refresh) this.#secrets.add(credential.refresh);
				}
			}
		}
	}
	async #authorizationProviders(): Promise<AuthorizationProviderStatus[]> {
		const result = await this.#authorization!.execute("auth.providers.status", {});
		if (!Array.isArray(result)) throw new Error("Invalid authorization provider response");
		return result;
	}
	#publishAuthorization(state: AuthorizationFlowState): DesktopAuthState {
		this.#rememberCredentials();
		const projected: DesktopAuthState = {
			id: state.id,
			provider: state.provider,
			status: state.status === "stored" ? (state.catalogRefreshed === false ? "error" : "complete") : state.status,
			...(state.url ? { url: state.url } : {}),
			...(state.verificationCode
				? { instructions: `Verification code: ${state.verificationCode}`, verificationCode: state.verificationCode }
				: {}),
			// A warning is a pending answer with no prompt: dropping it leaves the flow waiting on
			// a confirmation the user was never shown. The SDK holds one pending answer at a time
			// and clears a confirmed warning a step after it resumes, so it is only answerable
			// while the flow waits without a prompt.
			...(state.warning && state.status === "waiting" && !state.prompt
				? { warning: { id: state.warning.id, message: this.#redact(state.warning.message) } }
				: {}),
			...(state.prompt ? { prompt: { ...state.prompt, message: this.#redact(state.prompt.message) } } : {}),
			...(state.error ? { error: this.#redact(state.error) } : {}),
			// Only this outcome says the flow saved credentials. The SDK's `stored` flag is current
			// presence (it also covers credentials that predate the flow), so it is never projected.
			...(state.status === "stored" && state.catalogRefreshed === false
				? { error: "Credentials were saved, but model catalog refresh failed", catalogRefreshed: false as const }
				: {}),
		};
		if (JSON.stringify(projected) !== JSON.stringify(this.#authState)) {
			this.#authState = projected;
			this.#emit({ type: "auth", auth: projected });
		}
		return structuredClone(projected);
	}
	async #authorizationFlow(
		operation: "auth.start" | "auth.read" | "auth.answer" | "auth.cancel",
		input: Record<string, unknown>,
	): Promise<DesktopAuthState> {
		let epoch = this.#authEpoch;
		if (operation === "auth.start" && this.#authStarting)
			throw new Error("An authorization flow is already starting");
		if (operation === "auth.start") this.#authStarting = true;
		let result: AuthorizationFlowState;
		try {
			const response = await this.#authorization!.execute(operation, input);
			if (Array.isArray(response) || !("id" in response)) throw new Error("Invalid authorization flow response");
			result = response;
			// A rejected start never revokes the accepted predecessor's poll/publication.
			if (operation === "auth.start") {
				epoch = ++this.#authEpoch;
				if (this.#authPoll) clearTimeout(this.#authPoll);
				this.#authPoll = undefined;
			}
		} finally {
			if (operation === "auth.start") this.#authStarting = false;
		}
		const assertCurrent = () => {
			if (this.#closed || epoch !== this.#authEpoch) throw new Error("Authorization flow was replaced");
		};
		assertCurrent();
		let observed = result;
		let settled = true;
		if (result.status === "stored" || result.status === "cancelled" || result.status === "error") {
			const status = await this.#authorization!.execute("auth.status", { provider: result.provider });
			assertCurrent();
			if (Array.isArray(status) || !("flow" in status)) throw new Error("Invalid authorization status response");
			settled = status.flow?.providerSettled !== false;
			// The SDK publishes credential commitment before its catalog-refresh task settles.
			if (result.status === "stored" && !settled) observed = { ...result, status: "authorizing" };
		}
		if (result.stored && settled && result.status !== "authorizing" && result.status !== "waiting") {
			if (this.#authCatalogRefresh?.id !== result.id) {
				this.#authCatalogRefresh = {
					id: result.id,
					task: this.#refreshModelCatalogs([...this.#live.values()].map(live => live.factory)),
				};
			}
			const refreshed = await this.#authCatalogRefresh.task;
			assertCurrent();
			if (result.status === "stored") {
				if (result.catalogRefreshed === false) this.#failedCatalogRefreshes.add(this.#registry!);
				else this.#failedCatalogRefreshes.delete(this.#registry!);
				observed = { ...result, catalogRefreshed: result.catalogRefreshed !== false && refreshed };
			}
			this.#publishSnapshot();
		}
		// Publish completion only after every borrowed live registry has recorded its own refresh outcome.
		const state = this.#publishAuthorization(observed);
		if (
			!this.#closed &&
			(!settled || state.status === "authorizing" || state.status === "waiting") &&
			!this.#authPoll
		) {
			this.#authPoll = setTimeout(() => {
				if (epoch !== this.#authEpoch) return;
				this.#authPoll = undefined;
				if (
					this.#closed ||
					epoch !== this.#authEpoch ||
					this.#authState?.id !== state.id ||
					this.#authPolling.has(epoch)
				)
					return;
				this.#authPolling.add(epoch);
				const task = this.#authorizationFlow("auth.read", { flowId: state.id });
				this.#tasks.add(task);
				void task
					.catch(() => {
						if (!this.#closed && epoch === this.#authEpoch && this.#authState?.id === state.id)
							this.#publishAuthorization({
								id: state.id,
								provider: state.provider,
								status: "error",
								stored: false,
								error: "Authorization state is no longer available",
							});
					})
					.finally(() => {
						this.#authPolling.delete(epoch);
						this.#tasks.delete(task);
					});
			}, 100);
		}
		return state;
	}
	#storageRoot(scope: SessionScope | undefined): string {
		return scope === "managed" ? this.#managedSessionsRoot : path.join(this.dataDir, "sessions");
	}
	#sessionPath(relative: string, scope?: SessionScope): string {
		const root = this.#storageRoot(scope);
		if (scope === "managed" && !this.#managedSessionsRoot)
			throw new Error("Managed session storage is not initialized");
		const resolved = path.resolve(root, relative);
		if (path.isAbsolute(relative) || !resolved.startsWith(`${root}${path.sep}`))
			throw new Error("Invalid session file");
		return resolved;
	}
	/** Read-only destination identity for owned-file checks; writer admission stays inside the SDK. */
	async #sessionDirectory(cwd: string, metadata: SavedSession): Promise<string> {
		if (metadata.scope !== "managed") return path.join(this.dataDir, "sessions", metadata.projectId);
		const result = await resolveManagedSessionScope({ cwd, agentDir: this.agentDir });
		if (result.kind !== "resolved")
			throw new Error(`Managed session storage is unavailable for this workspace: ${result.message}`);
		return result.scope.directoryPath;
	}
	#save(): Promise<void> {
		const content = JSON.stringify(this.#catalog);
		const save = this.#saving.then(async () => {
			const temporary = path.join(this.dataDir, `catalog.${crypto.randomUUID()}.tmp`);
			try {
				await Bun.write(temporary, content, { mode: 0o600 });
				await fs.rename(temporary, path.join(this.dataDir, "catalog.json"));
			} finally {
				await fs.rm(temporary, { force: true });
			}
		});
		// Keep the queue drain separate from failure history: a later successful
		// rollback or teardown write cannot erase an earlier persistence failure.
		this.#saving = save.catch(error => {
			this.#saveFailures.push(error);
		});
		return save;
	}
	#dto(metadata: SavedSession, messageBudget = 2_000_000): DesktopSession {
		const managed = this.#managed.get(metadata.id);
		if (managed) return managed.dto(messageBudget);
		const live = this.#live.get(metadata.id);
		const readOnly = live ? undefined : this.#readOnly.get(metadata.id);
		const question = [...this.#questions.values()].find(item => item.question.sessionId === metadata.id)?.question;
		const gates = live?.activityUpdate?.activity.sessionState?.gates;
		const awaitingGate = gates?.available && gates.pending.length > 0;
		// The real transcript. Notices and other Host-synthesized rows join only the display copy
		// below. Status never reads either list: it must not depend on whether a row is loaded.
		const transcript = live
			? projectMessages(
					live.streamingMessage ? [...live.sdk.messages, live.streamingMessage] : live.sdk.messages,
					text => this.#redact(text),
					messageBudget,
					{
						sessionGeneration: live.sdk.sessionLifecycle.generation,
						streamingMessage: live.streamingMessage,
						revision: entryId => this.#revisions(live).revision(live.sdk, entryId),
						secrets: this.#secrets,
					},
				)
			: readOnly
				? // Display only: no copy, edit or revision authority without a live writer.
					projectMessages(readOnly.messages, text => this.#redact(text), messageBudget)
				: [];
		const notices = (live?.notices ?? []).map(({ anchor, message }) => ({
			anchor,
			message: {
				...message,
				text: this.#redact(message.text),
				...(message.toolName === undefined ? {} : { toolName: this.#redact(message.toolName) }),
				...(message.blocks === undefined
					? {}
					: {
							blocks: message.blocks.map(block => {
								if (block.type === "text" || block.type === "thinking")
									return { ...block, text: this.#redact(block.text) };
								if (block.type === "image-unavailable") return { ...block, reason: this.#redact(block.reason) };
								return this.#redact(block.data) === block.data
									? block
									: {
											type: "image-unavailable" as const,
											reason: "Image preview is unavailable for security reasons.",
										};
							}),
						}),
			},
		}));
		// Notices sit where they were raised rather than after every later turn.
		// Calls still running join the display copy too; they never count as transcript
		// and never take a place in its window.
		const fitted = fitDisplay(
			anchorNotices(transcript, notices),
			projectLiveToolCalls(live?.sdk, live?.streamingMessage, text => this.#redact(text), this.#secrets),
			messageBudget,
		);
		return {
			id: metadata.id,
			projectId: metadata.projectId,
			title: metadata.title,
			starred: metadata.starred,
			status:
				question || awaitingGate
					? "waiting"
					: live && (live.busy || live.sdk.isStreaming || live.operator?.isBusy())
						? "running"
						: live?.error
							? "error"
							: this.#endedTurns.has(metadata.id)
								? "done"
								: "idle",
			...(live?.sdk.model ? { model: `${live.sdk.model.provider}/${live.sdk.model.id}` } : {}),
			thinking: projectDesktopThinking(live?.sdk),
			operatorRunning: live?.operator?.isBusy() ?? false,
			controlGeneration: live?.sdk.sessionLifecycle.generation ?? null,
			...(live ? { promptEditing: true as const } : {}),
			imageInput: live
				? {
						supported: live.sdk.model?.input.includes("image") === true,
						blocked: live.sdk.settings.get("images.blockImages"),
					}
				: null,
			messages: fitted.messages,
			...(readOnly && (fitted.truncated || countVisibleMessages(readOnly.messages) > HISTORY_LIMIT)
				? { historyTruncated: true }
				: {}),
			...(live &&
			(fitted.truncated ||
				countVisibleMessages(live.sdk.messages) +
					(live.streamingMessage ? countVisibleMessages([live.streamingMessage]) : 0) +
					live.notices.length >
					HISTORY_LIMIT)
				? { historyTruncated: true }
				: {}),
			...(question ? { question } : {}),
			...projectTodos(live?.sdk, text => this.#redact(text)),
			...projectGoal(live?.sdk, text => this.#redact(text)),
			...(live && live.queued.size > 0 ? { queued: [...live.queued.values()].map(item => ({ ...item.dto })) } : {}),
			...(live?.error ? { error: live.error, errorOwner: live.errorOwner } : {}),
			connection: { state: this.#connection(metadata) },
		};
	}
	#connection(metadata: SavedSession): DesktopSessionConnection["state"] {
		return metadata.disconnected ? "disconnected" : "connected";
	}
	/** The app may open its own writer for this conversation. */
	#writable(metadata: SavedSession): boolean {
		return this.#connection(metadata) === "connected";
	}
	#notWritable(_metadata: SavedSession): Error {
		return new Error(DISCONNECTED);
	}
	snapshot(): DesktopSnapshot {
		return {
			protocolVersion: PROTOCOL_VERSION,
			projects: this.#catalog.projects.filter(project => !project.closed).map(project => ({ ...project })),
			sessions: this.#catalog.sessions
				.filter(
					session =>
						!this.#pendingForks.has(session.id) &&
						this.#catalog.projects.some(project => project.id === session.projectId && !project.closed),
				)
				.map(session => this.#dto(session, Math.floor(500_000 / Math.max(1, this.#catalog.sessions.length)))),
			models: this.#registry?.getAvailable().map(projectDesktopModel) ?? [],
			capabilities: CAPABILITIES.map(capability => ({ ...capability })),
			deliveries: this.#deliveries.list(),
		};
	}
	#publishSnapshot(): void {
		this.#emit({ type: "snapshot", snapshot: this.snapshot() });
	}
	#publish(live: LiveSession): void {
		if (live.timer) clearTimeout(live.timer);
		live.timer = undefined;
		if (!this.#live.has(live.metadata.id)) return;
		this.#refreshSessionServices(live);
		this.#emit({ type: "session", session: this.#dto(live.metadata) });
	}
	#activityUpdate(live: LiveSession, publish = false): DesktopActivityUpdate {
		this.#refreshSessionServices(live);
		const activity = live.activity.getSnapshot();
		if (!live.gatePresenter && activity.sessionState?.gates.available) {
			activity.sessionState.gates.pending = activity.sessionState.gates.pending.map(gate => ({
				...gate,
				answerable: false,
				reason: live.gateUnavailable ?? "No approval UI controller is connected to this session.",
			}));
		}
		const serialized = JSON.stringify(activity);
		if (serialized !== live.activitySerialized || !live.activityUpdate) {
			live.activitySerialized = serialized;
			live.activityUpdate = { sessionId: live.metadata.id, revision: ++live.activityRevision, activity };
		}
		if (publish && live.activityPublishedRevision < live.activityUpdate.revision) {
			this.#emit({ type: "activity", update: live.activityUpdate });
			live.activityPublishedRevision = live.activityUpdate.revision;
		}
		return live.activityUpdate;
	}
	#scheduleActivity(live: LiveSession): void {
		if (this.#closed || this.#live.get(live.metadata.id) !== live) return;
		live.activityTimer ??= setTimeout(() => {
			live.activityTimer = undefined;
			if (this.#closed || this.#live.get(live.metadata.id) !== live) return;
			this.#activityUpdate(live, true);
			this.#publish(live);
		}, 75);
	}
	#schedule(live: LiveSession): void {
		if (this.#closed || this.#live.get(live.metadata.id) !== live) return;
		live.timer ??= setTimeout(() => this.#publish(live), 75);
	}
	#metadata(params: Record<string, unknown>): SavedSession {
		const id = identifier(params, "sessionId");
		const metadata = this.#catalog.sessions.find(session => session.id === id);
		if (!metadata) throw new Error("Session not found");
		// A closed workspace's conversations stay on disk but are not addressable until it reopens.
		if (this.#catalog.projects.find(project => project.id === metadata.projectId)?.closed)
			throw new Error("Workspace is closed. Open the folder again to use this conversation.");
		return metadata;
	}
	async #open(metadata: SavedSession, manager?: SessionManager): Promise<LiveSession> {
		// A discovered terminal conversation stays attach-only: inventory membership is not
		// a writer lease, so only an SDK-owned lifecycle may admit that writer. A conversation
		// this host created in the same store opens the way the terminal opens its own
		// transcripts, with no exclusivity the terminal itself does not provide.
		if (metadata.managed)
			throw new Error("This terminal conversation requires SDK ownership admission before desktop resume.");
		// Every path that would open the app's own writer passes here; reads of a released
		// conversation are answered from its transcript before they reach it.
		if (!this.#writable(metadata)) throw this.#notWritable(metadata);
		const pending = this.#opening.get(metadata.id);
		if (pending) return pending;
		const existing = this.#live.get(metadata.id);
		if (existing) {
			this.#refreshSessionServices(existing);
			return existing;
		}
		const promise = this.#load(metadata, manager);
		this.#opening.set(metadata.id, promise);
		try {
			return await promise;
		} finally {
			this.#opening.delete(metadata.id);
		}
	}
	async #load(metadata: SavedSession, manager?: SessionManager): Promise<LiveSession> {
		// A conversation this load creates has no catalog transcript yet; if it never
		// publishes, its transcript must not survive as a conversation the user never got.
		const createdHere = metadata.file === undefined;
		let candidate: SessionCandidate;
		try {
			candidate = await this.#constructCandidate(metadata, manager);
		} catch (error) {
			// An AggregateError means the candidate's disposal is unproven; the SDK may still
			// own that transcript, so it must be left alone.
			if (!createdHere || error instanceof AggregateError) throw error;
			try {
				await this.#discardUnpublishedTranscript(metadata);
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "Session construction and owned cleanup failed");
			}
			throw error;
		}
		const previousTitle = metadata.title;
		try {
			const live = this.#publishCandidate(candidate);
			const title = live.sdk.sessionManager.getSessionName();
			if (title) metadata.title = title.slice(0, 200);
			await this.#save();
			if (metadata.title !== previousTitle) this.#publishSnapshot();
			return live;
		} catch (error) {
			metadata.title = previousTitle;
			const live = this.#live.get(metadata.id);
			if (live) {
				this.#rolledBackPublications.add(live);
				this.#retiredLive.add(live);
			}
			this.#live.delete(metadata.id);
			const failures: unknown[] = [error];
			let released = false;
			try {
				if (live) {
					this.#candidates.delete(candidate);
					await this.#disposeLive(live);
				} else await this.#disposeCandidate(candidate);
				released = true;
			} catch (cleanup) {
				failures.push(cleanup);
			}
			// Only a proven-stopped writer may have its unpublished transcript removed.
			if (createdHere && released) {
				try {
					await this.#discardUnpublishedTranscript(metadata);
				} catch (cleanup) {
					failures.push(cleanup);
				}
			}
			if (failures.length > 1) throw new AggregateError(failures, "Session publication and owned cleanup failed");
			throw error;
		}
	}
	/** Remove the transcript this host created for a conversation that never published. */
	async #discardUnpublishedTranscript(metadata: SavedSession): Promise<void> {
		const file = metadata.file;
		const scope = metadata.scope;
		if (!file) return;
		metadata.file = undefined;
		metadata.scope = undefined;
		metadata.sessionId = undefined;
		await this.#deleteTranscript(file, scope);
	}
	/**
	 * Remove one transcript plus its artifacts. A managed transcript is deleted through
	 * the SDK's own contract, which verifies identity and refuses a stale path instead of
	 * unlinking whatever now sits at that name.
	 */
	async #deleteTranscript(file: string, scope?: SessionScope): Promise<void> {
		await deleteEmbeddedSession(this.#sessionPath(file, scope), scope === "managed" ? { managed: true } : undefined);
	}
	/** A catalog row whose transcript was removed by another surface. */
	async #transcriptMissing(metadata: SavedSession): Promise<boolean> {
		if (!metadata.file) return false;
		try {
			await fs.stat(this.#sessionPath(metadata.file, metadata.scope));
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw error;
		}
	}
	/** Only a successful inventory that no longer lists the transcript proves it is gone. */
	async #discoveredTranscriptGone(metadata: SavedSession): Promise<boolean> {
		const project = this.#catalog.projects.find(item => item.id === metadata.projectId);
		if (!project || this.#managedOpening.has(metadata.id)) return false;
		try {
			const { managed, local } = await listEmbeddedProjectSessions({
				cwd: project.path,
				agentDir: this.agentDir,
				directory: path.join(this.dataDir, "sessions", project.id),
			});
			return ![...managed, ...local].some(session => session.id === metadata.id);
		} catch {
			return false;
		}
	}
	/** Detach any stale SDK attachment, then forget the reference; its transcript is already gone. */
	async #forgetDiscovered(metadata: SavedSession): Promise<null> {
		const attachment = this.#managed.get(metadata.id);
		if (attachment) {
			this.#managed.delete(metadata.id);
			await attachment.close();
		}
		// An inventory can come back empty without failing, so absence is not proof enough to
		// release the identity: a transcript that is truly gone never lists again anyway.
		return this.#forgetMissingSession(metadata, false);
	}
	/** Remove the unowned catalog reference durably, then clean SDK-owned sidecars/artifacts. */
	async #forgetMissingSession(metadata: SavedSession, release = true): Promise<null> {
		const index = this.#catalog.sessions.indexOf(metadata);
		this.#catalog.sessions = this.#catalog.sessions.filter(item => item !== metadata);
		const restoreReleased = release ? this.#release(metadata) : () => {};
		try {
			await this.#save();
		} catch (error) {
			this.#catalog.sessions.splice(index, 0, metadata);
			restoreReleased();
			throw error;
		}
		await this.#forgetDeliveries(metadata);
		if (metadata.file) await this.#deleteTranscript(metadata.file, metadata.scope);
		this.#publishSnapshot();
		return null;
	}
	/**
	 * A removed conversation keeps no delivery receipts, so its recovery cards never outlive it as
	 * orphans. The row is already durably gone; a journal failure is logged, not reported as a
	 * failed delete, and any receipt left behind surfaces as an orphan the app can discard.
	 */
	async #forgetDeliveries(metadata: SavedSession): Promise<void> {
		try {
			await this.#deliveries.forget(metadata.id);
		} catch (error) {
			console.error(`Desktop could not forget a removed conversation's deliveries: ${String(error)}`);
		}
	}
	/** No catalog insertion, host subscriptions, UI binding or live controllers before publication. */
	async #constructCandidate(metadata: SavedSession, manager?: SessionManager): Promise<SessionCandidate> {
		const project = this.#catalog.projects.find(item => item.id === metadata.projectId);
		if (!project || !(await fs.stat(project.path)).isDirectory()) throw new Error("Project directory unavailable");
		const directory = await this.#sessionDirectory(project.path, metadata);
		if (metadata.scope !== "managed") await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		let existingFile: string | undefined;
		if (metadata.file) {
			// A recorded transcript that is gone must fail rather than let the SDK
			// initialize a fresh session at the same reserved path.
			existingFile = await fs.realpath(this.#sessionPath(metadata.file, metadata.scope));
			const root = await fs.realpath(this.#storageRoot(metadata.scope));
			if (!existingFile.startsWith(`${root}${path.sep}`) || !(await fs.stat(existingFile)).isFile())
				throw new Error("Invalid saved session file");
		}
		const result = await createEmbeddedAgentSession({
			cwd: project.path,
			agentDir: this.agentDir,
			profileAuthority: "custom",
			authStorage: this.#auth,
			storage: {
				...(metadata.scope === "managed" ? { managed: true as const } : { directory }),
				...(existingFile ? { file: existingFile } : {}),
				...(manager ? { manager } : {}),
			},
			createSession: this.#createSession,
			hasUI: true,
			notificationHostModeSupported: false,
			sdkHostModeSupported: false,
		});
		this.#holdTranscript(result.session.sessionManager);
		const candidate: SessionCandidate = {
			sdk: result.session,
			factory: result,
			metadata,
			settings: result.session.settings,
			registry: result.session.modelRegistry,
			// Anchored after restore below, once the transcript they follow is known.
			notices: result.extensionsResult.errors.map(error => ({
				anchor: 0,
				message: {
					id: crypto.randomUUID(),
					role: "system" as const,
					text: `Extension discovery failed: ${this.#redact(error.error).slice(0, TEXT_LIMIT)}`,
					isError: true,
				},
			})),
		};
		this.#candidates.add(candidate);
		try {
			if (result.modelProfileWarning)
				candidate.notices.push({
					anchor: 0,
					message: {
						id: `profile:${metadata.id}`,
						role: "system",
						text: result.modelProfileWarning,
						isError: true,
					},
				});
			// Restore before publication or metadata reconciliation. A stale/foreign cursor
			// must leave the saved intent intact, not silently publish the file's latest branch.
			if (metadata.view) {
				// A tail other than the one saved with the view means another surface (the terminal)
				// continued this transcript: stay at its new tail, where the transcript opened, so
				// those turns are visible and the next prompt continues them. Rows saved before tails
				// were recorded, and an unreadable tail, keep restoring the exact view.
				const tail = metadata.viewTail === undefined ? undefined : await this.#transcriptTail(candidate);
				if (!tail || tail.committed === metadata.viewTail) await restoreSessionView(result.session, metadata.view);
				else if (result.session.sessionId !== metadata.view.sessionId)
					throw new Error("Saved session view identity does not match transcript");
			}
			// Construction notices were raised as the conversation opened: after its restored history.
			for (const notice of candidate.notices) notice.anchor = result.session.messages.length;
			// Materialization remains behind the SDK factory's owned manager.
			await result.session.sessionManager.ensureOnDisk();
			await this.#flushSession(candidate);
			return candidate;
		} catch (error) {
			const failures: unknown[] = [error];
			const attempt = async (operation: () => unknown | Promise<unknown>) => {
				try {
					await operation();
				} catch (failure) {
					failures.push(failure);
				}
			};
			await attempt(() => this.#disposeCandidate(candidate));
			if (failures.length > 1) throw new AggregateError(failures, "Session initialization and owned cleanup failed");
			throw error;
		}
	}
	#publishCandidate(candidate: SessionCandidate): LiveSession {
		if (this.#closed) throw new Error("Host is closed");
		// A close can land while this session is still being constructed. Publishing it here would
		// leave a live conversation (and its runs) inside a workspace the user just closed.
		if (this.#catalog.projects.find(project => project.id === candidate.metadata.projectId)?.closed)
			throw new Error("Workspace is closed. Open the folder again to use this conversation.");
		const live: LiveSession = {
			...candidate,
			viewOwnerToken: Symbol("desktop view owner"),
			serviceGeneration: candidate.sdk.sessionLifecycle.generation,
			unsubscribeActivity: () => {},
			unsubscribeIdentity: () => {},
			unsubscribe: () => {},
			activity: createDesktopActivityController(candidate.factory, {
				connectionGeneration: this.#connectionGeneration,
				redact: text => this.#redact(text),
			}),
			preferences: createDesktopPreferencesController(candidate.sdk),
			mcp: createDesktopMcpController(candidate.factory, {
				connectionGeneration: this.#connectionGeneration,
				redact: text => this.#redact(text),
			}),
			activityRevision: 0,
			activityPublishedRevision: 0,
			busy: false,
			queued: new Map(),
			scopeOwners: new Map(),
			claimedUserTurns: new WeakSet(),
		};
		this.#live.set(live.metadata.id, live);
		this.#viewOwners.set(live.metadata, live.viewOwnerToken);
		this.#attachGatePresenter(live);
		this.#attachOperatorController(live);
		this.#attachBtwController(live);
		live.unsubscribe = live.sdk.subscribe(event => {
			if (event.type === "agent_end") this.#endedTurns.add(live.metadata.id);
			if (event.type === "message_update") live.streamingMessage = event.message;
			if (event.type === "message_end" || event.type === "agent_end") live.streamingMessage = undefined;
			if (event.type === "agent_end")
				this.#observeDelivery(
					live.sdk.waitForIdle().then(async () => {
						// The exclusive owner persists its own operation before ACK. This joins
						// later queued/extension continuations without capturing an in-flight turn.
						if (this.#closed || this.#live.get(live.metadata.id) !== live) return;
						live.viewPending = true;
						if (live.busy) return;
						// Hold the same admission fence as mutations while asynchronous persistence
						// runs, so a new revision cannot invalidate this background flush.
						live.busy = true;
						const persistence = this.#persistLive(live);
						live.viewPersistence = persistence;
						try {
							await persistence;
						} finally {
							live.viewPersistence = undefined;
							live.busy = false;
							if (this.#live.get(live.metadata.id) === live) this.#publish(live);
						}
					}),
				);
			this.#schedule(live);
			observeToolEvent(live.sdk, event);
		});
		live.unsubscribeActivity = live.activity.onChange(() => this.#scheduleActivity(live));
		live.unsubscribeIdentity = live.sdk.subscribeSessionIdentityChanges(() => this.#schedule(live));
		this.#initializeLiveExtensions(live);
		this.#candidates.delete(candidate);
		return live;
	}
	#initializeLiveExtensions(live: LiveSession): void {
		const generation = live.sdk.sessionLifecycle.generation;
		const currentUI = this.#ui(live, generation);
		live.extensionUI = currentUI;
		const runner = live.sdk.extensionRunner;
		if (live.startup && live.extensionRunner === runner) {
			void live.factory
				.initializeUI({
					uiContext: currentUI,
					reportSendError: (action, error) => currentUI.notify(`Extension ${action}: ${error.message}`, "error"),
					reportRuntimeError: error => currentUI.notify(`Extension ${error.event}: ${error.error}`, "error"),
				})
				.catch(() => {});
			live.startupGeneration = generation;
			return;
		}
		live.extensionRunner = runner;
		// Install the fence synchronously, but let publication and the transport response
		// proceed: session_start is allowed to wait for an interactive answer.
		live.startupPending = true;
		const initialization = live.factory.initializeUI({
			uiContext: currentUI,
			reportSendError: (action, error) => live.extensionUI?.notify(`Extension ${action}: ${error.message}`, "error"),
			reportRuntimeError: error => live.extensionUI?.notify(`Extension ${error.event}: ${error.error}`, "error"),
		});
		void initialization.catch(() => {});
		const startup = Promise.resolve()
			.then(async () => {
				if (live.sdk.sessionLifecycle.generation !== generation)
					throw new Error("Session changed before extension initialization");
				if (this.#closed || this.#live.get(live.metadata.id) !== live || this.#retiredLive.has(live))
					throw new Error("Session retired before extension initialization");
				await initialization;
			})
			.catch(error => {
				if (
					!this.#closed &&
					this.#live.get(live.metadata.id) === live &&
					!this.#retiredLive.has(live) &&
					live.sdk.sessionLifecycle.generation === generation
				) {
					live.error = this.#error(error);
					live.errorOwner = undefined;
					currentUI.notify(`Extension initialization failed: ${this.#error(error)}`, "error");
				}
				throw error;
			})
			.finally(() => {
				if (live.extensionRunner === runner) live.startupPending = false;
			});
		live.startup = startup;
		live.startupGeneration = generation;
		void startup.catch(() => {});
	}
	async #awaitStartup(live: LiveSession): Promise<void> {
		const generation = live.sdk.sessionLifecycle.generation;
		await live.startup;
		if (
			this.#closed ||
			this.#live.get(live.metadata.id) !== live ||
			this.#retiredLive.has(live) ||
			live.gateMutation ||
			live.sdk.sessionLifecycle.generation !== generation ||
			live.startupGeneration !== generation
		)
			throw new Error("Session changed during extension initialization");
	}
	async #disposeCandidate(candidate: SessionCandidate): Promise<void> {
		// dispose() has a caller deadline, not a lifetime guarantee. Start and observe
		// both promises immediately; only the retained actual owner may release dependencies.
		const bounded = candidate.sdk.dispose();
		void bounded.catch(() => {});
		let completion = this.#cleanupRuns.get(candidate);
		if (!completion) {
			completion = (async () => {
				await candidate.sdk.awaitDisposeCompletion();
				await candidate.factory.releaseResources();
				this.#candidates.delete(candidate);
			})();
			this.#cleanupRuns.set(candidate, completion);
			this.#cleanupOwners.set(candidate, completion);
			void completion.then(
				() => this.#cleanupOwners.delete(candidate),
				() => {
					this.#cleanupRuns.delete(candidate);
				},
			);
		}
		await Promise.all([bounded, completion]);
	}
	#revisions(live: LiveSession): PromptRevisions {
		live.revisions ??= new PromptRevisions();
		return live.revisions;
	}
	/** The SDK owns exact revision selection, remembered continuations and rollback. */
	async #showRevision(live: LiveSession, params: Record<string, unknown>): Promise<null> {
		try {
			await live.factory.revise({ entryId: requiredString(params, "entryId", 128), action: "select" });
		} catch (error) {
			if (error instanceof SdkRevisionError && error.code === "invalid_input")
				throw new Error("Invalid entry ID for a prompt revision");
			throw error;
		}
		return null;
	}
	async #fork(live: LiveSession, params: Record<string, unknown>): Promise<DesktopForkResult> {
		const source = live.sdk.sessionManager;
		const sourceId = live.sdk.sessionId;
		const sourceFile = source.getSessionFile();
		const generation = live.sdk.sessionLifecycle.generation;
		const assertSource = () => {
			const lifecycle = live.sdk.sessionLifecycle;
			if (
				this.#closed ||
				this.#live.get(live.metadata.id) !== live ||
				lifecycle.disposed ||
				lifecycle.transitioning ||
				lifecycle.generation !== generation ||
				live.sdk.sessionManager !== source ||
				live.sdk.sessionId !== sourceId ||
				source.getSessionFile() !== sourceFile
			)
				throw new Error("Source session changed while forking");
		};
		assertSource();
		const entryId = params.entryId === undefined ? undefined : requiredString(params, "entryId", 128);
		if (entryId !== undefined) {
			const entry = source.getEntry(entryId);
			if (entry?.type !== "message" || entry.message.role !== "user")
				throw new Error("Invalid entry ID for branching");
		}
		await this.#flushSession(live, live);
		assertSource();
		if (!sourceFile) throw new Error("Session has no persisted transcript");
		const project = this.#catalog.projects.find(item => item.id === live.metadata.projectId)!;
		const directory = await this.#sessionDirectory(project.path, live.metadata);
		if (live.metadata.scope !== "managed") await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const fork: SavedSession = {
			id: crypto.randomUUID(),
			projectId: live.metadata.projectId,
			title: `${live.metadata.title.slice(0, 190)} (fork)`,
			starred: false,
			...(live.metadata.scope === "managed" ? { scope: "managed" as const } : {}),
			createdAt: Date.now(),
		};
		let manager: SessionManager | undefined;
		let candidate: SessionCandidate | undefined;
		let published: LiveSession | undefined;
		let publication: PromiseWithResolvers<LiveSession> | undefined;
		const ownedFiles = new Set<string>();
		const rememberOwnedFile = (file: string | undefined) => {
			if (!file) throw new Error("Fork has no persistent transcript");
			if (
				path.dirname(file) !== directory ||
				file === sourceFile ||
				this.#catalog.sessions.some(
					item => item !== fork && item.file && this.#sessionPath(item.file, item.scope) === file,
				)
			)
				throw new Error("Fork cleanup cannot claim an existing session file");
			ownedFiles.add(file);
		};
		try {
			manager = await forkEmbeddedSession({
				file: sourceFile,
				cwd: project.path,
				...(live.metadata.scope === "managed"
					? { agentDir: this.agentDir, managed: true as const }
					: { directory }),
			});
			this.#holdTranscript(manager);
			const copiedId = manager.getSessionId();
			rememberOwnedFile(manager.getSessionFile());
			assertSource();
			candidate = await this.#constructCandidate(fork, manager);
			assertSource();
			let selectedText = "";
			if (entryId !== undefined) {
				const entry = candidate.sdk.sessionManager.getEntry(entryId);
				if (entry?.type !== "message" || entry.message.role !== "user")
					throw new Error("Invalid entry ID for branching");
				const result = await candidate.factory.branch(entryId);
				// The SDK may rotate identity even when later cleanup or hooks throw.
				this.#holdTranscript(candidate.sdk.sessionManager);
				rememberOwnedFile(candidate.sdk.sessionManager.getSessionFile());
				assertSource();
				if (result.cancelled) {
					await this.#disposeCandidate(candidate);
					candidate = undefined;
					for (const file of ownedFiles)
						await deleteEmbeddedSession(file, fork.scope === "managed" ? { managed: true } : undefined);
					return { cancelled: true };
				}
				selectedText = result.selectedText;
			}
			await this.#flushSession(candidate);
			assertSource();
			// A is deliberately retained as B's private parentSession lineage ancestor.
			// Only the uncancelled, materialized current successor B enters the catalog.
			publication = Promise.withResolvers<LiveSession>();
			void publication.promise.catch(() => {});
			this.#opening.set(fork.id, publication.promise);
			this.#pendingForks.add(fork.id);
			this.#catalog.sessions.push(fork);
			// A branch keeps the full copy it was cut from as private lineage. Release that copy in
			// this same save, so deleting the branch later never surfaces it as a conversation.
			if (candidate.sdk.sessionId !== copiedId) this.#releaseId(copiedId);
			await this.#save();
			assertSource();
			published = this.#publishCandidate(candidate);
			this.#pendingForks.delete(fork.id);
			candidate = undefined;
			// Durable catalog and live-owner publication are committed. Transport or
			// DTO failures must not compensate a child that another caller can select.
			publication.resolve(published);
			this.#publishSnapshot();
			const session = this.#dto(fork);
			return { cancelled: false, session, selectedText };
		} catch (error) {
			if (published) throw error;
			const failures: unknown[] = [error];
			candidate ??= [...this.#candidates].find(item => item.metadata === fork);
			// Read actual identity before disposal: branch can reject after committing B.
			let identityKnown = true;
			try {
				if (candidate) rememberOwnedFile(candidate.sdk.sessionManager.getSessionFile());
			} catch (failure) {
				identityKnown = false;
				failures.push(failure);
			}
			let disposed = false;
			try {
				const liveCandidate = published ?? this.#live.get(fork.id);
				if (liveCandidate) {
					this.#rolledBackPublications.add(liveCandidate);
					this.#retiredLive.add(liveCandidate);
					this.#live.delete(fork.id);
					if (candidate) this.#candidates.delete(candidate);
					await this.#disposeLive(liveCandidate);
				} else if (candidate) await this.#disposeCandidate(candidate);
				else if (manager) {
					const outcome = await manager.closeStrict();
					if (outcome.kind !== "closed") throw outcome.error;
				}
				disposed = true;
			} catch (failure) {
				failures.push(failure);
			}
			this.#catalog.sessions = this.#catalog.sessions.filter(item => item !== fork);
			let rollbackSaved = false;
			try {
				await this.#save();
				rollbackSaved = true;
			} catch (failure) {
				failures.push(failure);
			}
			// A settled writer is insufficient when the durable catalog may still reference B.
			if (disposed && identityKnown && rollbackSaved) {
				for (const file of ownedFiles) {
					try {
						await deleteEmbeddedSession(file, fork.scope === "managed" ? { managed: true } : undefined);
					} catch (failure) {
						failures.push(failure);
					}
				}
			}
			if (failures.length > 1) throw new AggregateError(failures, "Session fork and owned cleanup failed");
			throw error;
		} finally {
			publication?.reject(new Error("Session fork was not published"));
			if (publication && this.#opening.get(fork.id) === publication.promise) this.#opening.delete(fork.id);
			this.#pendingForks.delete(fork.id);
		}
	}
	#attachOperatorController(live: LiveSession): void {
		live.operatorCurrentId = undefined;
		live.operator = createDesktopOperatorController(live.sdk, {
			connectionGeneration: this.#connectionGeneration,
			redact: text => this.#redact(text),
			createStreamRedactor: () => createDesktopStreamRedactor([...this.#secrets], text => this.#redact(text)),
			emit: event => {
				if (this.#closed || this.#live.get(live.metadata.id) !== live) return;
				live.operatorCurrentId = event.operation.operationId;
				this.#emit({ type: "operator", sessionId: live.metadata.id, event });
				this.#schedule(live);
			},
		});
	}
	#attachBtwController(live: LiveSession): void {
		const generation = live.sdk.sessionLifecycle.generation;
		const controller = createDesktopBtwController(live.sdk, {
			redact: text => this.#redact(text),
			createStreamRedactor: () => createDesktopStreamRedactor([...this.#secrets], text => this.#redact(text)),
			emit: event => {
				if (this.#closed || this.#live.get(live.metadata.id) !== live || live.btw !== controller) return;
				this.#emit({ type: "btw", sessionId: live.metadata.id, sessionGeneration: generation, event }, true);
			},
		});
		live.btw = controller;
	}
	#attachGatePresenter(live: LiveSession): void {
		live.gatePresenter = undefined;
		live.gateUnavailable = undefined;
		try {
			live.gatePresenter = createDesktopGatePresenter({
				session: live.sdk,
				activity: live.activity,
				connectionGeneration: this.#connectionGeneration,
				catalogSessionId: live.metadata.id,
				isCurrent: (connection, catalog) =>
					!this.#closed &&
					connection === this.#connectionGeneration &&
					catalog === live.metadata.id &&
					this.#live.get(catalog) === live,
				emit: event => this.#emit({ type: "gate", sessionId: live.metadata.id, event }),
			});
		} catch (error) {
			if (!(error instanceof DesktopGatePresentationError)) throw error;
			live.gateUnavailable = this.#error(error);
		}
	}
	#refreshSessionServices(live: LiveSession): void {
		if (this.#closed || this.#live.get(live.metadata.id) !== live) return;
		const lifecycle = live.sdk.sessionLifecycle;
		if (lifecycle.disposed || lifecycle.transitioning || lifecycle.generation <= live.serviceGeneration) return;
		live.unsubscribeActivity();
		live.observation?.dispose();
		live.observation = undefined;
		live.completion = undefined;
		live.btw?.dispose();
		live.operator?.dispose();
		live.gatePresenter?.dispose();
		live.preferences.dispose();
		live.mcp.dispose();
		live.activity.dispose();
		live.activity = createDesktopActivityController(live.factory, {
			connectionGeneration: this.#connectionGeneration,
			redact: text => this.#redact(text),
		});
		live.preferences = createDesktopPreferencesController(live.sdk);
		live.mcp = createDesktopMcpController(live.factory, {
			connectionGeneration: this.#connectionGeneration,
			redact: text => this.#redact(text),
		});
		this.#cancelQuestions(live);
		live.titleAbort?.abort();
		live.titleAbort = undefined;
		live.serviceGeneration = lifecycle.generation;
		this.#initializeLiveExtensions(live);
		live.activityUpdate = undefined;
		live.activitySerialized = undefined;
		this.#attachGatePresenter(live);
		this.#attachOperatorController(live);
		this.#attachBtwController(live);
		live.unsubscribeActivity = live.activity.onChange(() => this.#scheduleActivity(live));
		this.#scheduleActivity(live);
	}
	async #disposeLive(live: LiveSession): Promise<void> {
		live.titleAbort?.abort();
		this.#retiredLive.add(live);
		const handoff = live.exclusiveViewHandoff;
		this.#cancelQuestions(live);
		const failures: unknown[] = [];
		const attempt = async (operation: () => unknown | Promise<unknown>) => {
			try {
				await operation();
			} catch (error) {
				failures.push(error);
			}
		};
		// Transfer the final view, not terminal delivery. The retiring request still
		// joins this exact promise before ACK; teardown may not dispose its manager first.
		const persistence = this.#persistRetiringView(live, handoff);
		if (handoff) handoff.transferred = persistence;
		await attempt(() => persistence);
		const persistenceFailures = failures.length;
		await attempt(() => live.unsubscribe());
		await attempt(() => live.unsubscribeActivity());
		await attempt(() => live.unsubscribeIdentity());
		await attempt(() => live.observation?.dispose());
		if (live.timer) clearTimeout(live.timer);
		if (live.activityTimer) clearTimeout(live.activityTimer);
		live.timer = undefined;
		live.activityTimer = undefined;
		await attempt(() => live.btw?.dispose());
		await attempt(() => live.operator?.dispose());
		await attempt(() => live.gatePresenter?.dispose());
		await attempt(() => live.preferences.dispose());
		await attempt(() => live.mcp.dispose());
		await attempt(() => live.activity.dispose());
		const controllersReleased = failures.length === persistenceFailures;
		await attempt(() => this.#disposeCandidate(live));
		if (controllersReleased) {
			void this.#cleanupRuns.get(live)?.then(
				() => this.#retiredLive.delete(live),
				() => {},
			);
		}
		if (failures.length) throw new AggregateError(failures, "Session failed to release all owned resources");
	}
	async #persistRetiringView(live: LiveSession, handoff?: ExclusiveViewHandoff): Promise<void> {
		const failures: unknown[] = [];
		const attempt = async (operation: () => unknown | Promise<unknown>) => {
			try {
				await operation();
			} catch (error) {
				failures.push(error);
			}
		};
		// The workspace caller bounds these joins with its original deadline. Actual
		// cleanup retains the manager until the SDK-settled handoff and flush finish.
		await attempt(async () => handoff?.ready);
		await attempt(async () => handoff?.persistence);
		await attempt(async () => live.viewPersistence);
		await attempt(async () => {
			// A ready exclusive handoff permits capture while its receipt still holds busy.
			// Failed publications never regain authority, including on cleanup retry. A copy
			// the store refused keeps the last view it saved; its newer tail reopens elsewhere.
			if ((live.busy && !handoff) || !this.#ownsView(live) || isEmbeddedAppendRefused(live.sdk)) return;
			const view = this.#captureView(live);
			if (!view) return;
			await live.sdk.sessionManager.flush();
			if (!this.#ownsView(live)) return;
			const tail = await this.#transcriptTail(live);
			if (!this.#ownsView(live)) return;
			this.#recordView(live, view, tail);
			await this.#save();
		});
		if (failures.length) throw new AggregateError(failures, "Session final view persistence failed");
	}
	#ownsView(live: LiveSession): boolean {
		return this.#viewOwners.get(live.metadata) === live.viewOwnerToken && !this.#rolledBackPublications.has(live);
	}
	async #persistLive(live: LiveSession): Promise<void> {
		do {
			live.viewPending = false;
			// A refused copy cannot write; the last view saved before the refusal stays.
			if (!this.#ownsView(live) || isEmbeddedAppendRefused(live.sdk)) return;
			await this.#flushSession(live, live);
			if (!this.#ownsView(live)) return;
			await this.#save();
		} while (live.viewPending && this.#ownsView(live));
	}
	#captureView(candidate: SessionCandidate): SdkSessionView | undefined {
		if (candidate.sdk.sessionLifecycle.disposed) return;
		try {
			const view = captureSessionView(candidate.sdk);
			// Do not pin a brand-new empty transcript to root: another surface may
			// append its first messages before the app reopens it. Once tracked, root is exact.
			if (!candidate.metadata.view && candidate.sdk.messages.length === 0) return;
			return view;
		} catch (error) {
			if (error instanceof SdkRevisionError && error.code === "busy") return;
			throw error;
		}
	}
	#recordView(
		candidate: SessionCandidate,
		flushed: SdkSessionView | undefined,
		tail: EmbeddedTranscriptTail | undefined,
	): void {
		if (!flushed) return;
		const current = this.#captureView(candidate);
		// Flush yields to other inputs. Never replace saved intent with a cursor
		// from an older operation, nor publish a cursor whose entries were not flushed.
		if (current?.sessionId !== flushed.sessionId || current.leafEntryId !== flushed.leafEntryId) return;
		candidate.metadata.view = current;
		// Saved together with the view. Without a readable tail there is no later-writer
		// evidence, so the row restores exactly like one saved before tails were recorded.
		if (tail) candidate.metadata.viewTail = tail.held;
		else delete candidate.metadata.viewTail;
	}
	/** The committed transcript's tails; undefined when unreadable, which never blocks persistence. */
	async #transcriptTail(candidate: SessionCandidate): Promise<EmbeddedTranscriptTail | undefined> {
		try {
			return await readEmbeddedTranscriptTail(candidate.sdk);
		} catch {
			return undefined;
		}
	}
	async #flushSession(live: SessionCandidate, owner?: LiveSession): Promise<void> {
		if (owner && !this.#ownsView(owner)) return;
		const manager = live.sdk.sessionManager;
		const sessionId = live.sdk.sessionId;
		const generation = live.sdk.sessionLifecycle.generation;
		const assertCurrent = (): void => {
			const lifecycle = live.sdk.sessionLifecycle;
			if (
				lifecycle.disposed ||
				lifecycle.transitioning ||
				lifecycle.generation !== generation ||
				live.sdk.sessionManager !== manager ||
				live.sdk.sessionId !== sessionId
			) {
				throw new Error("Session changed while persisting desktop catalog");
			}
		};
		assertCurrent();
		const view = this.#captureView(live);
		const file = manager.getSessionFile();
		if (!file) {
			if (live.metadata.file) throw new Error("Persisted session file unavailable");
			return;
		}
		const scope: SessionScope = live.metadata.scope ?? "desktop";
		const root = await fs.realpath(this.#storageRoot(scope)).catch(() => this.#storageRoot(scope));
		const parent = await fs.realpath(path.dirname(file)).catch(() => path.dirname(file));
		const relative = path.relative(root, path.join(parent, path.basename(file)));
		if (owner && !this.#ownsView(owner)) return;
		assertCurrent();
		this.#sessionPath(relative, scope);
		// Record the transcript before the remaining fallible steps so a later failure
		// can still discard the file this host just created.
		live.metadata.file = relative;
		live.metadata.scope = scope;
		live.metadata.sessionId = manager.getSessionId();
		this.#holdTranscript(manager);
		// A committed empty successor reserves its path before creating the file.
		// Materialize through the SDK, never publish a merely reserved catalog path.
		await manager.ensureOnDisk();
		if (owner && !this.#ownsView(owner)) return;
		assertCurrent();
		await manager.flush();
		if (owner && !this.#ownsView(owner)) return;
		assertCurrent();
		const stat = await fs.stat(file);
		if (owner && !this.#ownsView(owner)) return;
		assertCurrent();
		if (!stat.isFile()) throw new Error("Invalid persisted session file");
		const tail = await this.#transcriptTail(live);
		if (owner && !this.#ownsView(owner)) return;
		assertCurrent();
		this.#recordView(live, view, tail);
	}
	#cancelQuestions(owner?: LiveSession): void {
		const failures: unknown[] = [];
		for (const pending of [...this.#questions.values()]) {
			// Catalog IDs survive reopen; only this publication owns its pending dialogs.
			if (owner && pending.ownerToken !== owner.viewOwnerToken) continue;
			try {
				pending.settle(null);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length) throw new AggregateError(failures, "Could not publish question cancellations");
	}
	async #ask(
		live: LiveSession,
		question: Omit<DesktopQuestion, "id" | "sessionId">,
		generation: number,
		options?: ExtensionUIDialogOptions,
	): Promise<string | boolean | null> {
		if (
			this.#closed ||
			this.#live.get(live.metadata.id) !== live ||
			this.#retiredLive.has(live) ||
			live.sdk.sessionLifecycle.generation !== generation ||
			options?.signal?.aborted
		)
			return null;
		if ([...this.#questions.values()].some(item => item.question.sessionId === live.metadata.id))
			throw new Error("Session already has a pending question");
		const deferred = Promise.withResolvers<string | boolean | null>();
		const dto = {
			...question,
			title: this.#redact(question.title).slice(0, 1000),
			message: question.message ? this.#redact(question.message).slice(0, TEXT_LIMIT) : undefined,
			initialValue: question.initialValue ? this.#redact(question.initialValue).slice(0, TEXT_LIMIT) : undefined,
			id: crypto.randomUUID(),
			sessionId: live.metadata.id,
		};
		if (question.options?.some(option => this.#redact(option) !== option))
			throw new Error("Question contains secret option values");
		let timer: Timer | undefined;
		const cancel = () => settle(null);
		const settle = (value: string | boolean | null) => {
			if (!this.#questions.delete(dto.id)) return;
			if (timer) clearTimeout(timer);
			options?.signal?.removeEventListener("abort", cancel);
			deferred.resolve(value);
			this.#publish(live);
		};
		this.#questions.set(dto.id, { ownerToken: live.viewOwnerToken, question: dto, settle });
		options?.signal?.addEventListener("abort", cancel, { once: true });
		if (options?.timeout !== undefined)
			timer = setTimeout(
				() => {
					settle(null);
					options.onTimeout?.();
				},
				Math.max(0, options.timeout),
			);
		this.#publish(live);
		return deferred.promise;
	}
	#ui(live: LiveSession, generation: number): ExtensionUIContext {
		const unsupported = (): never => {
			throw new Error("Terminal-only UI is unavailable in desktop");
		};
		const textQuestion = async (
			kind: "input" | "editor",
			title: string,
			initialValue?: string,
			options?: ExtensionUIDialogOptions,
		) => {
			const value = await this.#ask(live, { kind, title, initialValue }, generation, options);
			return typeof value === "string" ? value : undefined;
		};
		return {
			select: async (title, options, dialogOptions) => {
				const value = await this.#ask(live, { kind: "select", title, options }, generation, dialogOptions);
				return typeof value === "string" ? value : undefined;
			},
			confirm: async (title, message, options) =>
				(await this.#ask(live, { kind: "confirm", title, message }, generation, options)) === true,
			input: (title, placeholder, options) => textQuestion("input", title, placeholder, options),
			editor: (title, prefill, options) => textQuestion("editor", title, prefill, options),
			notify: (message, type) => {
				if (
					this.#closed ||
					this.#live.get(live.metadata.id) !== live ||
					this.#retiredLive.has(live) ||
					live.sdk.sessionLifecycle.generation !== generation
				)
					return;
				live.notices.push({
					anchor: live.sdk.messages.length,
					message: {
						id: crypto.randomUUID(),
						role: "system",
						text: this.#redact(message).slice(0, TEXT_LIMIT),
						isError: type === "error",
					},
				});
				live.notices = live.notices.slice(-20);
				this.#schedule(live);
			},
			onTerminalInput: unsupported,
			setStatus: unsupported,
			setWorkingMessage: unsupported,
			setWidget: unsupported,
			setFooter: unsupported,
			setHeader: unsupported,
			setTitle: unsupported,
			custom: unsupported,
			setEditorText: unsupported,
			pasteToEditor: unsupported,
			getEditorText: unsupported,
			setEditorComponent: unsupported,
			get theme(): never {
				return unsupported();
			},
			getAllThemes: unsupported,
			getTheme: unsupported,
			setTheme: unsupported,
			getToolsExpanded: unsupported,
			setToolsExpanded: unsupported,
		};
	}
	async #delivery(
		id: string,
		changes: Partial<Pick<DesktopDeliveryReceipt, "disposition" | "sdkSubmissionId" | "error">>,
	): Promise<void> {
		try {
			await this.#deliveries.update(id, changes);
		} catch (error) {
			const receipt = this.#deliveries.list().find(item => item.id === id);
			if (receipt) this.#emit({ type: "delivery", receipt });
			throw error;
		}
		const receipt = this.#deliveries.list().find(item => item.id === id);
		if (receipt) this.#emit({ type: "delivery", receipt });
	}
	async #beginDelivery(id: string, sessionId: string): Promise<void> {
		await this.#deliveries.begin(id, sessionId);
		this.#emit({ type: "delivery", receipt: this.#deliveries.list().find(item => item.id === id)! });
	}
	#observeDelivery(operation: Promise<void>): void {
		const observed = operation.catch(error => {
			this.#deliveryFailures.push(error);
			try {
				this.#emit({ type: "fatal", error: `Delivery journal: ${this.#error(error)}` });
			} catch {
				/* The observer must not reject. */
			}
		});
		this.#deliveryObservers.add(observed);
		void observed.then(() => this.#deliveryObservers.delete(observed));
	}
	async #extensionInput(
		live: LiveSession,
		id: string,
		text: string,
		images: ImageContent[],
		allowGateMutation = false,
		beforeTerminal?: () => Promise<void>,
	): Promise<{ handled: boolean; text: string; images: ImageContent[] }> {
		const runner = live.sdk.extensionRunner;
		if (!runner?.hasHandlers("input")) return { handled: false, text, images };
		await this.#delivery(id, { disposition: "accepted" });
		const generation = live.sdk.sessionLifecycle.generation;
		let result: InputEventResult;
		try {
			result = await runner.emitInput(text, images.length ? images : undefined, "interactive");
		} catch (error) {
			if (beforeTerminal) await beforeTerminal();
			await this.#delivery(id, { disposition: "unknown", error: "Extension input outcome unknown" });
			throw error;
		}
		if (
			this.#closed ||
			this.#live.get(live.metadata.id) !== live ||
			live.sdk.sessionLifecycle.generation !== generation ||
			(live.gateMutation && !allowGateMutation)
		) {
			if (beforeTerminal) await beforeTerminal();
			await this.#delivery(id, { disposition: "unknown", error: "Session changed during extension input" });
			throw new Error("Session changed during extension input");
		}
		if (result.handled) {
			if (beforeTerminal) await beforeTerminal();
			await this.#delivery(id, { disposition: "completed" });
			return { handled: true, text, images };
		}
		return { handled: false, text: result.text ?? text, images: result.images ?? images };
	}
	#taskCompleted(sessionId: string, identity: ["local", string, number, string] | ["managed", number, string]): void {
		if (this.#closed) return;
		const id = JSON.stringify([this.#connectionGeneration, sessionId, ...identity]);
		if (this.#completedTasks.has(id)) return;
		this.#completedTasks.add(id);
		this.#emit({ type: "task-completed", id, sessionId });
	}
	#localTaskCompletion(
		live: LiveSession,
	): (scope: { lineage: string; generation: number; attemptId: string }) => void {
		const sdk = live.sdk;
		const metadata = live.metadata;
		const desktopSessionId = metadata.id;
		const sessionId = sdk.sessionId;
		const manager = sdk.sessionManager;
		const managerId = manager.getSessionId();
		const file = manager.getSessionFile();
		const identityGeneration = manager.getSessionIdentityGeneration();
		const generation = sdk.sessionLifecycle.generation;
		const cwd = manager.getCwd();
		const project = this.#catalog.projects.find(item => item.id === metadata.projectId);
		return scope => {
			const lifecycle = sdk.sessionLifecycle;
			if (
				this.#closed ||
				this.#live.get(metadata.id) !== live ||
				this.#retiredLive.has(live) ||
				!this.#catalog.sessions.includes(metadata) ||
				!project ||
				!this.#catalog.projects.includes(project) ||
				project.closed ||
				project.id !== metadata.projectId ||
				project.path !== cwd ||
				lifecycle.disposed ||
				lifecycle.transitioning ||
				lifecycle.generation !== generation ||
				live.sdk !== sdk ||
				sdk.sessionId !== sessionId ||
				metadata.id !== desktopSessionId ||
				sdk.sessionManager !== manager ||
				manager.getSessionId() !== managerId ||
				manager.getSessionFile() !== file ||
				manager.getSessionIdentityGeneration() !== identityGeneration ||
				manager.getCwd() !== cwd ||
				typeof scope.lineage !== "string" ||
				!scope.lineage.trim() ||
				typeof scope.attemptId !== "string" ||
				!scope.attemptId.trim() ||
				!Number.isSafeInteger(scope.generation) ||
				scope.generation < 0
			)
				return;
			this.#taskCompleted(desktopSessionId, ["local", scope.lineage, scope.generation, scope.attemptId]);
		};
	}
	async #promptDelivery(
		live: LiveSession,
		id: string,
		text: string,
		images: ImageContent[],
		settleView: () => void,
		arrival: number,
		alreadyBegun = false,
		allowGateMutation = false,
		editEntryId?: string,
	): Promise<void> {
		let completeTask = this.#localTaskCompletion(live);
		// Only a Stop that arrived after this prompt's request interrupts it.
		const stopped = () => this.#stoppedSince(live.metadata.id, arrival);
		if (!alreadyBegun) await this.#beginDelivery(id, live.metadata.id);
		let accepted = false;
		const settleTerminalView = async () => {
			// An extension or a rejected invocation can leave SDK work running. Do not
			// transfer the view until it settles, or replace the delivery's own error.
			if (live.sdk.isAwaitingIdle) {
				try {
					await live.sdk.waitForIdle();
				} catch {
					return;
				}
			}
			settleView();
		};
		const input = await this.#extensionInput(live, id, text, images, allowGateMutation, settleTerminalView);
		if (input.handled) return;
		if (stopped()) {
			// A Stop that overtook this prompt before it reached the SDK (its delivery record, startup
			// or an input hook) found nothing to abort. The prompt definitively did not run: hand the
			// text back.
			await settleTerminalView();
			await this.#delivery(id, { disposition: "refused", error: "Prompt stopped before it started" });
			return;
		}
		accepted = this.#deliveries.list().some(receipt => receipt.id === id && receipt.disposition === "accepted");
		text = input.text;
		images = input.images;
		const run: { started?: AttemptRunHandle } = {};
		const terminals = new Map<string, { reason: string | undefined; assistant: string | undefined }>();
		// This prompt's own user message is the first one its first accepted run appends.
		let promptScope: string | undefined;
		let promptMessage: AgentMessage | undefined;
		let userTurnObserved = false;
		const unsubscribe = live.sdk.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "user") {
				userTurnObserved = true;
				if (promptMessage === undefined && event.scope && scopeKey(event.scope) === promptScope) {
					promptMessage = event.message;
					// Bound by its run's scope, so no queued input with the same text may claim it.
					live.claimedUserTurns.add(event.message);
				}
			}
			if (event.type !== "agent_end" || !event.scope) return;
			const assistant = event.messages.filter(message => message.role === "assistant").at(-1);
			terminals.set(scopeKey(event.scope), { reason: event.stopReason, assistant: assistant?.stopReason });
		});
		let journalFailed = false;
		const options: {
			onPreflightAcceptCommit: () => Promise<void>;
			onRunAccepted: (handle: AttemptRunHandle) => void;
		} = {
			onRunAccepted: handle => {
				run.started = handle;
				promptScope ??= scopeKey(handle.scope);
				// Revision admission advances lifecycle generation before starting its turn.
				if (editEntryId !== undefined) completeTask = this.#localTaskCompletion(live);
				live.scopeOwners.set(scopeKey(handle.scope), { id, order: 0 });
			},
			onPreflightAcceptCommit: async () => {
				try {
					await this.#delivery(id, { disposition: "accepted" });
				} catch (error) {
					journalFailed = true;
					throw error;
				}
				accepted = true;
				this.#startAutoTitle(live, text);
			},
		};
		try {
			if (editEntryId !== undefined)
				await live.factory.revise(
					{ entryId: editEntryId, action: "edit", body: text, ...(images.length ? { images } : {}) },
					options,
				);
			else if (images.length) await createSessionImageInput(live.sdk).prompt(text, images, options);
			else await live.sdk.prompt(text, options);
			await live.sdk.waitForIdle();
		} catch (error) {
			await settleTerminalView();
			if (!journalFailed && stopped()) {
				// The user stopped this prompt. Once its text is in the transcript that is a
				// cancellation. If no run ever took it, it definitively did not run: `refused`
				// is what returns the text to the composer, which `cancelled` would not.
				if (persistedUserTurn(live.sdk, promptMessage)) {
					await this.#delivery(id, { disposition: "cancelled" });
					return;
				}
				if (!run.started && !userTurnObserved) {
					await this.#delivery(id, { disposition: "refused", error: "Prompt stopped before it started" });
					return;
				}
			}
			// The store refused this copy because another process wrote the transcript first. Before
			// any run took the prompt nothing reached the provider: return the text to the composer.
			if (!journalFailed && isEmbeddedAppendRefused(live.sdk) && !run.started && !userTurnObserved) {
				await this.#delivery(id, { disposition: "refused", error: STALE_TRANSCRIPT });
				throw new Error(STALE_TRANSCRIPT);
			}
			await this.#delivery(
				id,
				journalFailed
					? { disposition: "unknown", error: "Delivery journal unavailable" }
					: {
							disposition: run.started ? "failed" : accepted ? "unknown" : "refused",
							error: run.started ? "Prompt failed" : accepted ? "Prompt outcome unknown" : "Prompt refused",
						},
			);
			if (editEntryId !== undefined && error instanceof SdkRevisionError && error.code === "invalid_input")
				throw new Error("Invalid entry ID for editing");
			throw error;
		} finally {
			unsubscribe();
		}
		// SDK idle is distinct from durable terminal delivery. Retirement may now take
		// the final view while this request continues to own its pending journal write.
		settleView();
		const owned = run.started ? terminals.get(scopeKey(run.started.scope)) : undefined;
		if (owned?.assistant === "error" || owned?.assistant === "aborted" || owned?.reason === "cancelled") {
			// A user Stop whose prompt text is already in the transcript is a cancellation, not
			// an uncertain outcome. A Host abort (workspace close, session switch) stays unknown.
			if (owned.assistant !== "error" && stopped() && persistedUserTurn(live.sdk, promptMessage)) {
				await this.#delivery(id, { disposition: "cancelled" });
				return;
			}
			await this.#delivery(id, {
				disposition: owned.assistant === "error" ? "failed" : "unknown",
				error: owned.assistant === "error" ? "Prompt failed" : "Prompt outcome unknown",
			});
			if (owned.assistant === "error" && run.started) this.#recordScopeFailure(live, run.started.scope, id);
			throw new Error(owned.assistant === "error" ? "Prompt failed" : "Prompt outcome unknown");
		}
		await this.#delivery(id, {
			disposition: accepted && owned?.reason === "completed" && owned.assistant ? "completed" : "unknown",
		});
		if (accepted && run.started && owned?.reason === "completed" && owned.assistant === "stop")
			completeTask(run.started.scope);
	}
	/**
	 * Finds the transcript user turn that is this queued input's own. The SDK does not say which
	 * turn an input became, so the match is by exact text, made one-to-one: a turn already claimed
	 * (including a prompt's own, bound by scope) is skipped and the first free match is claimed.
	 *
	 * Claims happen as terminals settle. The SDK settles a run's inputs in the order it took them
	 * and runs end one after another; each Host terminal handler then waits only for its own
	 * queued-receipt write, which the journal completes in admission order. The only input taken
	 * but never appended is a steer handed back by the Stop that ends its run (a taken follow-up
	 * is always appended), and it is the last one taken. Every input taken before it was admitted
	 * before it too (steers are taken in admission order and ahead of any follow-up waiting at the
	 * same boundary), so all of them claim first, their own turns are the free matches, and the
	 * handed-back steer finds none. A follow-up claiming ahead of an earlier-taken steer can only
	 * swap two appended turns of the same text, which changes no outcome.
	 */
	#claimUserTurn(live: LiveSession, claimant: UserTurnClaimant): AgentMessage | undefined {
		const turn = claimant.turns.find(
			message => !live.claimedUserTurns.has(message) && copyableMessageText(message) === claimant.text,
		);
		if (turn) live.claimedUserTurns.add(turn);
		return turn;
	}
	#recordScopeFailure(
		live: LiveSession,
		scope: { lineage: string; generation: number; attemptId: string },
		fallback: string,
	): void {
		if (this.#live.get(live.metadata.id) !== live || scope.generation < (live.errorScopeGeneration ?? -1)) return;
		live.errorScopeGeneration = scope.generation;
		live.errorScopeKey = scopeKey(scope);
		live.error = "Prompt failed";
		live.errorOwner = live.scopeOwners.get(scopeKey(scope))?.id ?? fallback;
		this.#publish(live);
	}
	async #exclusive<T>(
		live: LiveSession,
		operation: (settleView: () => void) => Promise<T>,
		retireGates = false,
		persistSource = true,
		// Only a prompt whose turn failed describes the conversation. The `prompt`
		// request passes its id; `command.run` records the failure of the prompt it
		// forwards itself. Leaving this unset means this helper records nothing:
		// `retry()` returning false becomes a request error, and a failed compaction
		// is a refused maintenance step, so neither marks the session failed and each
		// reports through its own request.
		recordFailure?: string,
	): Promise<T> {
		if (live.busy || live.sdk.isStreaming || live.operator?.isBusy())
			throw new Error("Another operation is running. Try again when it finishes.");
		live.busy = true;
		const done = Promise.withResolvers<void>();
		live.exclusiveDone = done.promise;
		live.gateMutation = retireGates;
		live.error = undefined;
		live.errorOwner = undefined;
		live.errorScopeGeneration = undefined;
		live.errorScopeKey = undefined;
		live.scopeOwners.clear();
		live.errorEpoch = (live.errorEpoch ?? 0) + 1;
		this.#publish(live);
		// Delete disposes inside its own operation; fork owns a separate publication.
		// Only requests that owe source persistence participate in this handoff.
		const ready = persistSource ? Promise.withResolvers<void>() : undefined;
		const viewHandoff: ExclusiveViewHandoff | undefined = ready
			? { ready: ready.promise, settle: () => ready.resolve() }
			: undefined;
		live.exclusiveViewHandoff = viewHandoff;
		// Set when the store refused this operation's write. Its wording waits for the replacement below.
		let staleError: Error | undefined;
		try {
			if (retireGates) await live.gatePresenter?.withdrawAll();
			return await operation(() => viewHandoff?.settle());
		} catch (caught) {
			// Any write this operation made may meet the store's refusal; say it plainly, once.
			if (isEmbeddedAppendRefused(live.sdk)) staleError = new Error(STALE_TRANSCRIPT);
			const error = staleError ?? caught;
			if (
				recordFailure &&
				!live.errorOwner &&
				this.#deliveries.list().some(receipt => receipt.id === recordFailure && receipt.disposition === "failed")
			) {
				live.error = this.#error(error);
				live.errorOwner = recordFailure;
			}
			throw error;
		} finally {
			live.streamingMessage = undefined;
			viewHandoff?.settle();
			try {
				this.#cancelQuestions(live);
				if (viewHandoff?.transferred) await viewHandoff.transferred;
				else if (persistSource) {
					const persistence = this.#persistLive(live);
					if (viewHandoff) viewHandoff.persistence = persistence;
					await persistence;
				}
			} finally {
				live.gateMutation = false;
				live.busy = false;
				live.exclusiveViewHandoff = undefined;
				done.resolve();
				if (live.exclusiveDone === done.promise) live.exclusiveDone = undefined;
				if (this.#live.get(live.metadata.id) === live) this.#publish(live);
				// The refusal lasts for this copy's lifetime. Replace it now, so the user sees the
				// other surface's turns instead of a conversation that fails every write.
				if (isEmbeddedAppendRefused(live.sdk)) {
					const replacement = await this.#replaceStale(live);
					// The request's error tells only what actually happened to the conversation.
					if (staleError) {
						staleError.message = STALE_OUTCOME[replacement];
						if (live.errorOwner && live.error === STALE_TRANSCRIPT) live.error = staleError.message;
					}
				}
			}
		}
	}
	/**
	 * A user Stop; a confirmed Disconnect stops a conversation exactly this way. `arrival` is the
	 * arrival number of the request that asked for it.
	 */
	async #stop(live: LiveSession, arrival: number): Promise<void> {
		if (live.operator?.isBusy()) {
			if (!live.operatorCurrentId)
				throw new Error("Waiting for the previous command to settle. Stop cannot be proven for this conversation.");
			live.operator.abort({ operationId: live.operatorCurrentId });
			this.#publish(live);
			return;
		}
		// This Stop goes on to stop the run. Record its arrival before releasing anything it
		// interrupts, so every input that arrived earlier sees it from here on. A Stop that only
		// cancelled a shell command, or could not proceed, returned above without recording.
		this.#runStops.set(live.metadata.id, Math.max(this.#runStops.get(live.metadata.id) ?? 0, arrival));
		this.#cancelQuestions(live);
		// An input still queued never reached the conversation, so Stop hands it back: `removed`
		// returns its text to the composer, where `cancelled` would drop it. This write lands
		// before the SDK's own cancellation report, which the final receipt then ignores.
		for (const tracked of live.queued.values()) {
			if (tracked.submission.cancel()) await this.#delivery(tracked.deliveryId, { disposition: "removed" });
		}
		// Stop means stop: the default cause ends the run without starting another. A user steer it
		// did not take is dropped and reported removed; an agent follow-up stays queued for the next
		// turn. The TUI's `user_interrupt` would resume into both at once. Outcomes are classified
		// from the recorded Stop, not from the cause.
		await live.sdk.abort();
		this.#publish(live);
	}
	/** Work Disconnect would stop: a turn, queued input, a command or a question still waiting. */
	#disconnectWouldStop(live: LiveSession): { running: boolean; queued: number } | undefined {
		const running =
			live.sdk.isStreaming ||
			live.exclusiveDone !== undefined ||
			live.operator?.isBusy() === true ||
			[...this.#questions.values()].some(pending => pending.ownerToken === live.viewOwnerToken);
		return running || live.queued.size > 0 ? { running, queued: live.queued.size } : undefined;
	}
	/**
	 * Release the app's writer for one conversation without deleting it, so another surface (the
	 * terminal) can continue it. The final view is saved first, so Connect lands where the app
	 * left off unless someone appended. Work in progress needs explicit confirmation and is
	 * stopped through Stop, whose receipts classify each input as usual.
	 */
	async #disconnect(metadata: SavedSession, confirm: boolean, arrival: number): Promise<DesktopDisconnectResult> {
		if (metadata.managed) throw new Error("Disconnect this conversation in the terminal that owns it.");
		const opening = this.#opening.get(metadata.id);
		if (opening) await opening.catch(() => {});
		let live = this.#live.get(metadata.id);
		if (live && !metadata.disconnected) {
			const stopping = this.#disconnectWouldStop(live);
			if (stopping && !confirm) return { disconnected: false, confirm: stopping };
			if (stopping) await this.#stop(live, arrival);
			// Join the stopped request until its receipt and view are written; disposing earlier would
			// turn a cancelled prompt into an unknown one.
			for (let attempt = 0; attempt < 3 && live.exclusiveDone; attempt++) await live.exclusiveDone;
			await live.viewPersistence?.catch(() => {});
			if (live.sdk.isStreaming) await live.sdk.waitForIdle().catch(() => {});
			live = this.#live.get(metadata.id);
			if (live && (live.busy || live.sdk.isStreaming || live.operator?.isBusy()))
				throw new Error("The conversation is still stopping. Try Disconnect again.");
		}
		// From here every writing request refuses, and nothing reopens the writer behind this.
		metadata.disconnected = true;
		const failures: unknown[] = [];
		if (live) {
			this.#live.delete(metadata.id);
			this.#retiredLive.add(live);
			live.queued.clear();
			try {
				// Persists the final view and saves the catalog, now carrying the released state.
				await this.#disposeLive(live);
			} catch (error) {
				failures.push(error);
			}
		}
		try {
			await this.#save();
		} catch (error) {
			failures.push(error);
		}
		await this.#loadReadOnly(metadata);
		this.#publishSnapshot();
		if (failures.length === 1) throw failures[0];
		if (failures.length) throw new AggregateError(failures, "Disconnect could not release every resource");
		return { disconnected: true, session: this.#dto(metadata) };
	}
	/** Take the conversation back through the normal open path, which lands on any newer tail. */
	async #connect(metadata: SavedSession): Promise<DesktopSession> {
		if (metadata.managed) return this.#dto(metadata);
		const wasDisconnected = metadata.disconnected === true;
		if (wasDisconnected) {
			delete metadata.disconnected;
			try {
				await this.#save();
			} catch (error) {
				metadata.disconnected = true;
				throw error;
			}
		}
		try {
			const live = await this.#open(metadata);
			this.#readOnly.delete(metadata.id);
			this.#publish(live);
		} catch (error) {
			// A reopen that fails leaves the conversation released, with Connect still offered.
			if (wasDisconnected) {
				metadata.disconnected = true;
				await this.#save().catch(() => {});
			}
			this.#publishSnapshot();
			throw error;
		}
		this.#publishSnapshot();
		return this.#dto(metadata);
	}
	/** Show a conversation the app does not write, from its transcript, re-reading only a changed file. */
	async #loadReadOnly(metadata: SavedSession): Promise<ReadOnlyView> {
		const file = metadata.file ? this.#sessionPath(metadata.file, metadata.scope) : undefined;
		const stat = file ? await fs.stat(file).catch(() => undefined) : undefined;
		const stamp = stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : "";
		const cached = this.#readOnly.get(metadata.id);
		if (cached && cached.stamp === stamp) return cached;
		const view = metadata.view;
		const history =
			file && stat
				? await readEmbeddedTranscriptHistory(
						file,
						view && {
							entryId: view.leafEntryId,
							...(metadata.viewTail === undefined ? {} : { whenTail: metadata.viewTail }),
						},
					)
				: undefined;
		const loaded: ReadOnlyView = {
			stamp,
			// Another transcript at the recorded path is not this conversation's history.
			messages: history && (!metadata.sessionId || history.sessionId === metadata.sessionId) ? history.messages : [],
		};
		this.#readOnly.set(metadata.id, loaded);
		return loaded;
	}
	/**
	 * Requests on a conversation the app does not write. Reads answer from the transcript; delete
	 * removes it without opening a writer; everything else refuses before any work starts.
	 */
	async #dispatchReadOnly(request: DesktopRequest, metadata: SavedSession): Promise<unknown> {
		const { method, params } = request;
		switch (method) {
			case "session.select":
				await this.#loadReadOnly(metadata);
				this.#emit({ type: "session", session: this.#dto(metadata) });
				return this.#dto(metadata);
			case "history.get": {
				const offset = params.offset === undefined ? 0 : params.offset;
				const limit = params.limit === undefined ? HISTORY_PAGE_LIMIT : params.limit;
				if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
					throw new Error("Invalid history offset");
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_LIMIT)
					throw new Error("Invalid history limit");
				const view = await this.#loadReadOnly(metadata);
				const { total, page, truncated } = projectHistoryPage(view.messages, offset, limit, text =>
					this.#redact(text),
				);
				return { sessionId: metadata.id, total, offset, messages: page, truncated } satisfies DesktopHistory;
			}
			case "activity.get":
				return {
					sessionId: metadata.id,
					revision: 0,
					activity: {
						available: false,
						reason: READ_ONLY_ACTIVITY,
						sessionGeneration: "read-only",
						connectionGeneration: this.#connectionGeneration,
					},
				} satisfies DesktopActivityUpdate;
			case "session.delete":
				this.#readOnly.delete(metadata.id);
				return this.#forgetMissingSession(metadata);
			default:
				throw this.#notWritable(metadata);
		}
	}
	/** Replaces a live copy the store refused, once no work remains on it. */
	async #replaceStale(live: LiveSession): Promise<StaleReplacement> {
		const id = live.metadata.id;
		if (this.#closed || !this.#catalog.sessions.includes(live.metadata)) return "deferred";
		// A concurrent request already retired this copy; its reopen decides the outcome.
		if (this.#live.get(id) !== live) {
			const opening = this.#opening.get(id);
			if (!opening) return this.#live.has(id) ? "reloaded" : "failed";
			return opening.then(
				() => "reloaded" as const,
				() => "failed" as const,
			);
		}
		// Queued input can never be written by a refused copy. Hand back what no run has taken yet:
		// `refused` returns its text to the composer, and the copy no longer waits on it.
		for (const tracked of [...live.queued.values()]) {
			if (!tracked.submission.cancel()) continue;
			live.queued.delete(tracked.dto.id);
			await this.#delivery(tracked.deliveryId, { disposition: "refused", error: STALE_TRANSCRIPT });
		}
		// Input a run already took, a gate or extension startup still needs this copy. The next
		// select or prompt after that work settles reloads it (see #refreshIfMoved).
		if (!this.#reloadable(live)) return "deferred";
		try {
			this.#publish(await this.#reload(live));
			return "reloaded";
		} catch (error) {
			console.error(`Desktop could not reopen a conversation changed elsewhere: ${String(error)}`);
			// The row is no longer live; publish it so the app stops offering the retired copy.
			this.#publishSnapshot();
			return "failed";
		}
	}
	/** Nothing a reload could interrupt or lose: no run, queued input, question, gate or startup. */
	#reloadable(live: LiveSession): boolean {
		const gates = live.activityUpdate?.activity.sessionState?.gates;
		return (
			this.#live.get(live.metadata.id) === live &&
			!this.#opening.has(live.metadata.id) &&
			!live.busy &&
			!live.sdk.isStreaming &&
			live.queued.size === 0 &&
			!live.operator?.isBusy() &&
			!live.startupPending &&
			!live.gateMutation &&
			!(gates?.available && gates.pending.length > 0) &&
			![...this.#questions.values()].some(pending => pending.ownerToken === live.viewOwnerToken)
		);
	}
	/**
	 * Before showing or prompting an idle conversation, reopen it if another process appended
	 * to its transcript since this copy read it. The reopen lands on the new tail.
	 */
	async #refreshIfMoved(live: LiveSession): Promise<LiveSession> {
		if (!this.#reloadable(live)) return this.#current(live);
		const tail = await this.#transcriptTail(live);
		const moved = isEmbeddedAppendRefused(live.sdk) || (tail !== undefined && tail.committed !== tail.held);
		// Re-check after the read: another request may have started work on this copy, or already
		// replaced it, meanwhile.
		if (!moved || !this.#reloadable(live)) return this.#current(live);
		return this.#reload(live);
	}
	/** The row's current copy; a concurrent request may already be reopening or have replaced it. */
	#current(live: LiveSession): Promise<LiveSession> {
		return this.#live.get(live.metadata.id) === live && !this.#opening.has(live.metadata.id)
			? Promise.resolve(live)
			: this.#open(live.metadata);
	}
	/** Retires a live copy the way a workspace close does, then opens the row again. */
	#reload(live: LiveSession): Promise<LiveSession> {
		const metadata = live.metadata;
		// Synchronous up to its first await, so no request can find the row neither live nor opening.
		const reopened = (async () => {
			this.#live.delete(metadata.id);
			this.#retiredLive.add(live);
			try {
				this.#cancelQuestions(live);
				await this.#disposeLive(live);
			} catch (error) {
				console.error(`Desktop could not fully release a stale conversation copy: ${String(error)}`);
			}
			return this.#load(metadata);
		})();
		this.#opening.set(metadata.id, reopened);
		const release = () => {
			if (this.#opening.get(metadata.id) === reopened) this.#opening.delete(metadata.id);
		};
		void reopened.then(release, release);
		return reopened;
	}
	handle(request: DesktopRequest): Promise<void> {
		// Register before initialization or admission can yield. Shutdown must never join itself.
		const task = Promise.resolve().then(() => this.#handle(request));
		if (request.method !== "shutdown") {
			this.#tasks.add(task);
			const release = () => this.#tasks.delete(task);
			void task.then(release, release);
		}
		return task;
	}
	/** Whether a Stop that arrived after `arrival` has stopped this conversation's run. */
	#stoppedSince(sessionId: string, arrival: number): boolean {
		return (this.#runStops.get(sessionId) ?? 0) > arrival;
	}
	async #handle(request: DesktopRequest): Promise<void> {
		// Stops and inputs are compared in the order they reach the Host. Each request is numbered on
		// arrival, before any await; a Stop records its number only once it goes on to stop the run.
		// An input that arrived before it therefore sees it however long the input's delivery record,
		// startup or input hook takes, an input that arrived after it never does, and a Stop that
		// only cancels a shell command, or cannot proceed, applies to no input.
		const arrival = ++this.#arrivals;
		let promptBegun = false;
		let promptAdmissionAttempted = false;
		try {
			if (this.#closed && request.method !== "shutdown") throw new Error("Host is closed");
			await this.initialize();
			if (this.#closed && request.method !== "shutdown") throw new Error("Host is closed");
			if (request.method === "prompt") {
				prepareDesktopAttachmentInput(request);
				const metadata = this.#metadata(request.params);
				promptAdmissionAttempted = true;
				await this.#beginDelivery(request.id, metadata.id);
				promptBegun = true;
			}
			if (this.#closed && request.method !== "shutdown") throw new Error("Host is closed");
			const result = await this.#dispatch(request, arrival);
			this.#emit(
				{ type: "response", id: request.id, ok: true, result: result ?? null },
				PROJECTED_CONTROL_METHODS.has(request.method),
				request.method === "preferences.apply" ? (result as DesktopPreferenceResult).outcome : undefined,
			);
		} catch (error) {
			let receipt = this.#deliveries?.list().find(item => item.id === request.id);
			if (request.method === "prompt" && promptBegun && receipt?.disposition === "pending") {
				try {
					await this.#delivery(request.id, { disposition: "refused", error: "Prompt refused" });
				} catch {
					/* The journal exposes unknown when persistence fails. */
				}
				receipt = this.#deliveries.list().find(item => item.id === request.id);
			}
			const deliveryDisposition =
				request.method !== "prompt"
					? undefined
					: receipt?.disposition === "refused"
						? "refused"
						: receipt?.disposition === "failed"
							? "failed"
							: receipt || promptAdmissionAttempted || this.#deliveries?.hasAcknowledged(request.id)
								? "unknown"
								: "refused";
			const preferenceOutcome =
				request.method === "preferences.apply" && error instanceof DesktopPreferenceError && error.outcome
					? projectPreferenceOutcome(error.outcome)
					: undefined;
			this.#emit(
				{
					type: "response",
					id: request.id,
					ok: false,
					error: this.#error(error),
					...(deliveryDisposition ? { deliveryDisposition } : {}),
					...(preferenceOutcome ? { preferenceOutcome } : {}),
				},
				false,
				preferenceOutcome,
			);
		}
	}
	async #dispatch(request: DesktopRequest, arrival: number): Promise<unknown> {
		const { method, params } = request;
		const attachmentInput = method === "prompt" ? prepareDesktopAttachmentInput(request) : undefined;
		if (method === "bootstrap") {
			// Pick up conversations another surface (the terminal) created since the workspace was
			// opened. Each workspace refreshes under its own open/close fence; one that cannot be
			// listed keeps its current rows and never blocks the snapshot.
			await Promise.all(
				this.#catalog.projects
					.filter(project => !project.closed)
					.map(project =>
						this.#withProject(project.path, () => this.#refreshProject(project)).catch(error => {
							console.error(`Desktop could not refresh a workspace's conversations: ${String(error)}`);
						}),
					),
			);
			const snapshot = this.snapshot();
			this.#emit({ type: "snapshot", snapshot });
			// The snapshot splits one history budget across every row, and the app replaces its
			// rows with it. Follow with the full projection of any open conversation it cut short,
			// so a refresh on window focus never shrinks the transcript being read.
			const shown = [
				...[...this.#live.values()].map(live => live.metadata),
				...this.#catalog.sessions.filter(session => this.#readOnly.has(session.id)),
			];
			for (const metadata of shown) {
				const row = snapshot.sessions.find(session => session.id === metadata.id);
				if (!row) continue;
				const full = this.#dto(metadata);
				if (JSON.stringify(full.messages) !== JSON.stringify(row.messages))
					this.#emit({ type: "session", session: full });
			}
			return snapshot;
		}
		if (method === "delivery.ack") {
			await this.#deliveries.ack(requiredString(params, "deliveryId", 128));
			return null;
		}
		if (method === "shutdown") {
			await this.close();
			return null;
		}
		if (method === "composer.complete") return this.#complete(params);
		if (method === "message.copyText") return this.#copyText(request);
		if (typeof params.sessionId === "string") {
			const metadata = this.#catalog.sessions.find(session => session.id === params.sessionId);
			if (metadata?.managed) {
				// The terminal may already have deleted a discovered conversation's transcript. That
				// row can never open again, so deleting it only forgets the reference. A transcript
				// the SDK still lists stays under its own control surface.
				if (method === "session.delete" && (await this.#discoveredTranscriptGone(metadata)))
					return this.#forgetDiscovered(metadata);
				return this.#dispatchManaged(request, this.#metadata(params));
			}
		}
		if (method === "auth.providers") {
			const names = new Map(getOAuthProviders().map(provider => [provider.id, provider.name]));
			return (await this.#authorizationProviders())
				.filter(status => status.canEnroll || status.canStoreApiKey)
				.map(
					(status): DesktopAuthProvider => ({
						id: status.provider,
						name: names.get(status.provider) ?? status.provider,
						configured: status.configured,
						stored: status.stored,
						credentialKinds: [...status.credentialKinds],
						canSignIn: status.canEnroll,
						canStoreKey: status.canStoreApiKey,
					}),
				);
		}
		if (method === "auth.keyProviders") {
			// Enrollment metadata is not a model selection catalog. Unauthenticated
			// providers belong here, never in snapshot.models or models.list.
			return (await this.#authorizationProviders())
				.filter(provider => provider.canStoreApiKey)
				.map(provider => provider.provider);
		}
		if (method === "auth.state")
			return this.#authState ? this.#authorizationFlow("auth.read", { flowId: this.#authState.id }) : null;
		if (method === "auth.login") {
			if (this.#authState?.status === "authorizing" || this.#authState?.status === "waiting")
				throw new Error("An authorization flow is already active");
			return this.#authorizationFlow("auth.start", { provider: requiredString(params, "provider", 100) });
		}
		if (method === "auth.cancel")
			return this.#authorizationFlow("auth.cancel", { flowId: identifier(params, "flowId") });
		if (method === "auth.answer") {
			if (typeof params.value !== "string") throw new Error("Invalid authorization answer");
			return this.#authorizationFlow("auth.answer", {
				flowId: identifier(params, "flowId"),
				promptId: identifier(params, "promptId"),
				value: params.value,
			});
		}
		if (method === "project.open") {
			const resolved = await fs.realpath(requiredString(params, "path"));
			if (!(await fs.stat(resolved)).isDirectory()) throw new Error("Project must be a directory");
			return this.#withProject(resolved, () => this.#openProject(resolved));
		}
		if (method === "project.close") {
			const projectId = identifier(params, "projectId");
			const project = this.#catalog.projects.find(item => item.id === projectId);
			if (!project) throw new Error("Project not found");
			return this.#withProject(project.path, () => this.#closeProject(project));
		}
		if (method === "project.reorder") {
			const ids = params.ids;
			if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("Invalid project order");
			const previous = this.#catalog.projects;
			// The renderer can only order what the snapshot shows, so the request is validated
			// against the open workspaces and spliced back into the slots closed ones occupy.
			const visible = previous.filter(project => !project.closed);
			if (ids.length !== visible.length || new Set(ids).size !== ids.length)
				throw new Error("Invalid project order");
			const reordered = ids.map(id => visible.find(project => project.id === id));
			if (reordered.some(project => !project)) throw new Error("Invalid project order");
			let cursor = 0;
			const next = previous.map(project => (project.closed ? project : reordered[cursor++]!));
			this.#catalog.projects = next;
			try {
				await this.#save();
			} catch (error) {
				this.#catalog.projects = previous;
				throw error;
			}
			this.#publishSnapshot();
			return null;
		}
		if (method === "session.reorder") {
			const projectId = identifier(params, "projectId");
			const ids = params.ids;
			if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("Invalid session order");
			const current = this.#catalog.sessions.filter(session => session.projectId === projectId);
			if (ids.length !== current.length || new Set(ids).size !== ids.length)
				throw new Error("Invalid session order");
			const reordered = ids.map(id => current.find(session => session.id === id));
			if (reordered.some(session => !session)) throw new Error("Invalid session order");
			const previous = this.#catalog.sessions;
			const next: SavedSession[] = [];
			let cursor = 0;
			for (const session of previous) {
				if (session.projectId !== projectId) next.push(session);
				else next.push(reordered[cursor++]!);
			}
			this.#catalog.sessions = next;
			try {
				await this.#save();
			} catch (error) {
				this.#catalog.sessions = previous;
				throw error;
			}
			this.#publishSnapshot();
			return null;
		}
		if (method === "session.create") {
			const projectId = identifier(params, "projectId");
			const owning = this.#catalog.projects.find(item => item.id === projectId);
			if (!owning) throw new Error("Project not found");
			if (owning.closed) throw new Error("Workspace is closed. Open the folder again to use this conversation.");
			const metadata: SavedSession = {
				id: crypto.randomUUID(),
				projectId,
				title: "New session",
				starred: false,
				// New conversations live in the terminal's store so both surfaces resume
				// the same transcript. The catalog and UI state stay private.
				scope: "managed",
				createdAt: Date.now(),
			};
			this.#catalog.sessions.push(metadata);
			try {
				await this.#open(metadata);
			} catch (error) {
				this.#catalog.sessions = this.#catalog.sessions.filter(item => item !== metadata);
				await this.#save();
				throw error;
			}
			this.#publishSnapshot();
			return this.#dto(metadata);
		}
		if (method === "gate.presented" || method === "gate.retired") {
			// UI acknowledgements must never wait for session opening or its active turn.
			const metadata = this.#metadata(params);
			const presenter = this.#live.get(metadata.id)?.gatePresenter;
			if (!presenter) throw new Error("No owned gate presenter for this session");
			const id = requiredString(params, "presentationId", 128);
			if (method === "gate.presented") presenter.acknowledgePresented(id);
			else presenter.acknowledgeRetired(id, requiredString(params, "nonce", 128));
			return null;
		}
		if (method === "question.answer") {
			const pending = this.#questions.get(identifier(params, "questionId"));
			if (!pending) throw new Error("Question not found or already answered");
			pending.settle(validateQuestionAnswer(pending.question, params));
			return null;
		}
		if (method === "auth.setKey") {
			if (this.#authState?.status === "authorizing" || this.#authState?.status === "waiting")
				throw new Error("Wait for account authorization to finish before saving an API key");
			const provider = requiredString(params, "provider", 100);
			const key = requiredString(params, "key", 16_384);
			this.#secrets.add(key);
			if (
				!(await this.#authorizationProviders()).some(
					status => status.provider === provider && status.canStoreApiKey,
				)
			)
				throw new Error("Unknown provider");
			const stored = await this.#authorization!.execute("auth.apiKey.store", { provider, key });
			if (Array.isArray(stored) || !("saved" in stored)) throw new Error("Invalid authorization storage response");
			this.#rememberCredentials();
			const catalogRefreshed = await this.#refreshModelCatalogs([
				this.#control!,
				...[...this.#live.values()].map(live => live.factory),
			]);
			this.#publishSnapshot();
			return { provider, saved: true, catalogRefreshed: stored.catalogRefreshed && catalogRefreshed };
		}
		if (method === "settings.get") {
			const target = params.sessionId ? this.#metadata(params) : undefined;
			// A released conversation has no session settings of its own open; show the app's.
			const settings = target && this.#writable(target) ? (await this.#open(target)).settings : this.#settings!;
			return desktopSettings(settings);
		}
		if (method === "settings.set") {
			const settingPath = validateDesktopSetting(params.path, params.value);
			if (params.sessionId) {
				const target = this.#metadata(params);
				if (this.#writable(target)) await this.#open(target);
			}
			// Settings are application-wide; refuse to change them under an active run.
			const targets = [...this.#live.values()];
			if (targets.some(live => live.busy || live.sdk.isStreaming)) throw new Error("Session busy");
			const patch = (settings: Settings): Record<string, unknown> => ({
				[settingPath]: params.value,
				// Enabling compaction restores the native active strategy, through the same atomic SDK write.
				...(settingPath === "compaction.enabled" &&
				params.value === true &&
				settings.get("compaction.strategy") === "off"
					? { "compaction.strategy": "context-full" }
					: {}),
			});
			const controls = createSdkPreferenceControls(this.#control!.session);
			try {
				requireAppliedPreference(await controls.patchConfig({ scope: "global", patch: patch(this.#settings!) }));
			} finally {
				controls.dispose();
			}
			for (const live of targets)
				requireAppliedPreference(
					await live.preferences.writeConfig({ scope: "global", patch: patch(live.settings) }),
				);
			this.#publishSnapshot();
			return null;
		}
		if (method === "command.list")
			return [
				...ACP_BUILTIN_SLASH_COMMANDS.filter(command => !DESKTOP_OWNED_COMMANDS.has(command.name)).map(
					command =>
						({
							name: command.name,
							description: command.description,
							...(command.input?.hint ? { hint: command.input.hint } : {}),
						}) satisfies DesktopCommand,
				),
				{
					name: "btw",
					description: "Text-only side chat separate from the existing conversation",
					hint: "<question>",
				},
			];
		if (method === "command.run")
			return this.#command(this.#metadata(params), requiredString(params, "text"), request.id, arrival);
		if (method === "history.get") {
			const target = this.#metadata(params);
			if (!target.managed && !this.#writable(target)) return this.#dispatchReadOnly(request, target);
			const live = await this.#open(target);
			const offset = params.offset === undefined ? 0 : params.offset;
			const limit = params.limit === undefined ? HISTORY_PAGE_LIMIT : params.limit;
			if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
				throw new Error("Invalid history offset");
			if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_LIMIT)
				throw new Error("Invalid history limit");
			const { total, page, truncated } = projectHistoryPage(
				live.sdk.messages,
				offset,
				limit,
				text => this.#redact(text),
				{ sessionGeneration: live.sdk.sessionLifecycle.generation, streamingMessage: live.streamingMessage },
			);
			return {
				sessionId: live.metadata.id,
				total,
				offset,
				messages: page,
				truncated,
			} satisfies DesktopHistory;
		}
		const sessionMethods = [
			"session.disconnect",
			"session.connect",
			"session.select",
			"session.rename",
			"session.delete",
			"session.star",
			"session.fork",
			"session.revision",
			"session.compact",
			"session.retry",
			"session.export",
			"prompt",
			"abort",
			"activity.get",
			"activity.detail",
			"activity.operate",
			"activity.acknowledge",
			"preferences.get",
			"preferences.apply",
			"gate.present",
			"gate.answer",
			"gate.withdraw",
			"models.list",
			"operator.execute",
			"operator.get",
			"operator.abort",
			"operator.fold",
			"btw.open",
			"btw.get",
			"btw.submit",
			"btw.cancel",
			"btw.close",
			"mcp.get",
			"mcp.operate",
			"session.info",
			"session.pullRequest",
			"model.set",
			"thinking.set",
			"diff.get",
			"tools.list",
			"tools.set",
			"tool.detail",
			"goal.operate",
			"queue.cancel",
		];
		if (!sessionMethods.includes(method)) throw new Error("Unknown method");
		const metadata = this.#metadata(params);
		if (method === "session.disconnect") {
			if (params.confirm !== undefined && typeof params.confirm !== "boolean") throw new Error("Invalid confirm");
			return this.#disconnect(metadata, params.confirm === true, arrival);
		}
		if (method === "session.connect") return this.#connect(metadata);
		if (!this.#writable(metadata)) return this.#dispatchReadOnly(request, metadata);
		// A transcript another surface removed must not wedge its row. A session this host
		// still owns keeps the normal delete path, which disposes it and tolerates the
		// missing file; only an unowned row is forgotten outright.
		if (
			method === "session.delete" &&
			!this.#live.has(metadata.id) &&
			!this.#opening.has(metadata.id) &&
			(await this.#transcriptMissing(metadata))
		)
			return await this.#forgetMissingSession(metadata);
		const live =
			method === "session.select" || method === "prompt"
				? await this.#refreshIfMoved(await this.#open(metadata))
				: await this.#open(metadata);
		if (method === "session.delete" && live.startupPending) {
			if (live.gateMutation) throw new Error("Session change already in progress");
			live.gateMutation = true;
			live.titleAbort?.abort();
			try {
				this.#cancelQuestions(live);
				await live.sdk.abort();
				return await this.#deleteSession(live, metadata);
			} finally {
				live.gateMutation = false;
			}
		}
		if (method === "session.select") {
			this.#publish(live);
			return this.#dto(metadata);
		}
		if (method === "abort") {
			await this.#stop(live, arrival);
			return null;
		}
		if (method.startsWith("btw.")) {
			this.#refreshSessionServices(live);
			const controller = live.btw;
			if (!controller) throw new Error("No side-chat controller is connected to this conversation.");
			const { sessionId: _sessionId, sessionGeneration, ...input } = params;
			if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration !== live.sdk.sessionLifecycle.generation)
				throw new Error("The session changed. Open the side chat again.");
			if ((method === "btw.open" || method === "btw.submit") && live.gateMutation)
				throw new Error("Open the side chat again after the session change finishes.");
			switch (method) {
				case "btw.get":
					if (Object.keys(input).length) throw new Error("Invalid side-chat read parameters");
					return controller.get();
				case "btw.open":
					return controller.open(input);
				case "btw.submit":
					return controller.submit(input);
				case "btw.cancel":
					return controller.cancel(input);
				case "btw.close":
					controller.close(input);
					return null;
			}
		}
		if (method.startsWith("operator.")) {
			const operator = live.operator;
			if (!operator) throw new Error("No command execution controller is connected to this conversation.");
			const allowed =
				method === "operator.execute"
					? ["sessionId", "text"]
					: method === "operator.fold"
						? ["sessionId"]
						: ["sessionId", "operationId"];
			if (Object.keys(params).some(key => !allowed.includes(key))) throw new Error("Invalid operator parameters");
			if (method === "operator.get")
				return operator.getOperation({ operationId: requiredString(params, "operationId", 128) });
			if (method === "operator.abort")
				return operator.abort({ operationId: requiredString(params, "operationId", 128) });
			if (method === "operator.fold") return operator.fold({});
			if (method === "operator.execute")
				return this.#exclusive(live, async () => {
					const text = requiredString(params, "text", 65_536);
					await live.sdk.sessionManager.ensureOnDisk();
					return operator.execute({ text });
				});
		}
		if (method === "activity.get") return this.#activityUpdate(live);
		if (method === "activity.detail") return live.activity.getDetail(readActivityRef(params.ref));
		if (method === "activity.operate") {
			live.activity.operate(readActivityRef(params.ref), readActivityOperation(params.operation));
			return this.#activityUpdate(live, true);
		}
		if (method === "activity.acknowledge") {
			live.activity.acknowledgeFailures(readActivityAcknowledgement(params.scope));
			return this.#activityUpdate(live, true);
		}
		if (method === "session.info" || method === "session.pullRequest" || method === "mcp.get") {
			if (Object.keys(params).some(key => key !== "sessionId")) throw new Error("Invalid session read parameters");
			if (method === "session.pullRequest") return readDesktopPullRequest(live.sdk.sessionManager.getCwd());
			return method === "session.info"
				? readDesktopSessionInfo(
						{ info: input => this.#observation(live).info(input) },
						{
							catalogSessionId: metadata.id,
							redact: text => {
								for (const identity of [
									live.sdk.sessionId,
									live.sdk.sessionManager.getSessionId(),
									live.sdk.credentialSessionId,
									live.sdk.getAgentId(),
								])
									if (identity) text = text.replaceAll(identity, "[session]");
								return this.#redact(text);
							},
						},
					)
				: live.mcp.getSnapshot();
		}
		if (method === "mcp.operate") {
			if (Object.keys(params).some(key => !["sessionId", "ref", "action"].includes(key)))
				throw new Error("Invalid MCP parameters");
			return this.#exclusive(live, () => live.mcp.operate(params.ref, params.action));
		}
		if (method === "preferences.get") return live.preferences.read();
		if (method === "preferences.apply") {
			let outcome: SdkPreferenceOutcome | undefined;
			let preferenceError: DesktopPreferenceError | undefined;
			try {
				const applied = await this.#exclusive(live, async () => {
					try {
						const result = await live.preferences.apply(params.action);
						// Capture before #exclusive's ancillary persistence/publication can fail.
						outcome = result.outcome;
						return result;
					} catch (error) {
						if (error instanceof DesktopPreferenceError && error.outcome) {
							outcome = error.outcome;
							preferenceError = error;
						}
						throw error;
					}
				});
				// A profile selection replaces the live model, which the snapshot carries.
				this.#publishSnapshot();
				return applied;
			} catch (error) {
				if (!outcome || error === preferenceError) throw error;
				throw new DesktopPreferenceError(
					preferenceError?.code ?? "preference_failed",
					outcome.applied
						? "The preference was applied, but current preferences could not be read or published. Refresh before retrying."
						: (preferenceError?.message ??
								"The preference operation was not confirmed as applied. Refresh before retrying."),
					outcome,
					{
						cause: preferenceError
							? new AggregateError([preferenceError, error], "Preference readback and publication failed")
							: error,
					},
				);
			}
		}
		if (method === "gate.present" || method === "gate.answer" || method === "gate.withdraw") {
			const presenter = live.gatePresenter;
			if (!presenter) throw new Error(live.gateUnavailable ?? "No owned gate presenter for this session");
			if (method === "gate.present") {
				if (live.gateMutation)
					throw new Error(
						"Existing approval screens are closing before the session change. Open this one again after the change finishes.",
					);
				return presenter.present(readActivityRef(params.ref));
			}
			const id = requiredString(params, "presentationId", 128);
			if (method === "gate.withdraw") {
				await presenter.withdraw(id);
				return null;
			}
			const result = await presenter.answer(id, readGateAnswer(params.answer));
			this.#activityUpdate(live, true);
			this.#publish(live);
			return result;
		}
		if (method === "models.list") {
			if (params.refresh !== undefined && typeof params.refresh !== "boolean")
				throw new Error("Invalid model catalog refresh");
			const generation = live.sdk.sessionLifecycle.generation;
			const sessionId = live.sdk.sessionId;
			const manager = live.sdk.sessionManager;
			if (params.refresh) await this.#refreshModelCatalogs([live.factory]);
			const lifecycle = live.sdk.sessionLifecycle;
			if (
				this.#closed ||
				this.#live.get(metadata.id) !== live ||
				lifecycle.disposed ||
				lifecycle.transitioning ||
				lifecycle.generation !== generation ||
				live.sdk.sessionId !== sessionId ||
				live.sdk.sessionManager !== manager
			)
				throw new Error("Session changed while refreshing model catalog");
			this.#assertModelCatalogReady(live.sdk.modelRegistry);
			return this.#sessionModels(live.sdk).map(projectDesktopModel);
		}
		if (method === "tools.list") return projectToolCatalog(live.sdk, text => this.#redact(text));
		if (method === "tool.detail")
			return projectToolDetail(
				live.sdk,
				live.streamingMessage,
				requiredString(params, "callId", 512),
				text => this.#redact(text),
				this.#secrets,
			);
		if (method === "diff.get") return this.#diff(live);
		if (method === "prompt") {
			if (live.gateMutation) throw new Error("Send the message after the session change finishes.");
			await this.#awaitStartup(live);
			if (!attachmentInput) throw new Error("Prompt attachment envelope was not validated");
			let { text, images } = attachmentInput;
			const { editEntryId } = attachmentInput;
			if (live.gateMutation) throw new Error("Send the message after the session change finishes.");
			if (live.operator?.isBusy()) throw new Error("Send the message after the command finishes.");
			const commandName = /^\s*\/([^\s/]+)(?:\s|$)/.exec(text)?.[1]?.toLowerCase();
			if (
				commandName &&
				(ADVERTISED_COMMANDS.has(commandName) || DESKTOP_OWNED_COMMANDS.has(commandName) || commandName === "btw")
			) {
				if (editEntryId !== undefined) throw new Error("A slash command cannot replace a prompt.");
				if (Array.isArray(params.attachments) && params.attachments.length)
					throw new Error("Slash commands cannot be submitted with attachments.");
				if (live.busy || live.sdk.isStreaming)
					throw new Error("Run the command after the current operation finishes.");
				const result = await this.#command(metadata, text, request.id, arrival, true);
				if (result.refused) await this.#delivery(request.id, { disposition: "refused", error: result.output });
				else if (result.consumed && result.prompt === undefined && commandName !== "btw")
					await this.#delivery(request.id, { disposition: "completed" });
				else if (commandName === "btw") await this.#delivery(request.id, { disposition: "accepted" });
				return result;
			}
			if (text.trimStart().startsWith("/")) await this.#observation(live).catalog({});
			if (editEntryId !== undefined && (live.busy || live.sdk.isStreaming))
				throw new Error("Edit the prompt after the current operation finishes.");
			if (live.busy || live.sdk.isStreaming) {
				const completeTask = this.#localTaskCompletion(live);
				const stopped = () => this.#stoppedSince(live.metadata.id, arrival);
				const input = await this.#extensionInput(live, request.id, text, images);
				if (input.handled) return null;
				if (stopped()) {
					// A Stop overtook this input before it was queued (its delivery record, startup or
					// input hook): the Stop's queue sweep could not see it, and queueing it now would
					// start a turn after the Stop.
					await this.#delivery(request.id, { disposition: "refused", error: "Prompt stopped before it started" });
					return null;
				}
				text = input.text;
				images = input.images;
				// TUI parity: an active run accepts steering or a follow-up instead of rejecting input.
				const deliverAs = params.deliverAs === "followUp" ? "followUp" : "steer";
				live.queuedAdmissionOrder = (live.queuedAdmissionOrder ?? 0) + 1;
				const admissionOrder = live.queuedAdmissionOrder;
				const errorEpoch = live.errorEpoch;
				let accepted = this.#deliveries
					.list()
					.some(receipt => receipt.id === request.id && receipt.disposition === "accepted");
				let journalFailed = false;
				const options: { deliverAs: "steer" | "followUp"; onPreflightAcceptCommit: () => Promise<void> } = {
					deliverAs,
					onPreflightAcceptCommit: async () => {
						try {
							await this.#delivery(request.id, { disposition: "accepted" });
						} catch (error) {
							journalFailed = true;
							throw error;
						}
						accepted = true;
						this.#startAutoTitle(live, text);
					},
				};
				const terminalEvents = new Map<string, { reason: string | undefined; assistant: string | undefined }>();
				// The terminal's attempt scope can name a different attempt of the same logical run, so
				// this input's own user turn is found by its text among those appended after admission.
				const claimant: UserTurnClaimant = { text, turns: [] };
				const unsubscribeTerminal = live.sdk.subscribe(event => {
					if (event.type === "message_end" && event.message.role === "user") claimant.turns.push(event.message);
					if (event.type !== "agent_end" || !event.scope) return;
					const assistant = event.messages.filter(message => message.role === "assistant").at(-1);
					terminalEvents.set(scopeKey(event.scope), {
						reason: event.stopReason,
						assistant: assistant?.stopReason,
					});
				});
				let submission: QueuedInputSubmission;
				try {
					submission = images.length
						? await createSessionImageInput(live.sdk).submitUserMessage(text, images, options)
						: await live.sdk.submitUserMessage(text, { ...options, trackSubmission: true });
				} catch (error) {
					unsubscribeTerminal();
					// A Stop cancelled this steer's pending admission. As for a prompt Stop caught before
					// its run, nothing of it reached the conversation, so its text goes back.
					const stoppedBeforeQueue = !journalFailed && stopped() && !claimant.turns.length;
					await this.#delivery(
						request.id,
						journalFailed
							? { disposition: "unknown", error: "Delivery journal unavailable" }
							: stoppedBeforeQueue
								? { disposition: "refused", error: "Prompt stopped before it started" }
								: {
										disposition: accepted ? "unknown" : "refused",
										error: accepted ? "Submission outcome unknown" : "Submission refused",
									},
					);
					if (stoppedBeforeQueue) return null;
					throw error;
				}
				const queuedPersisted = this.#delivery(request.id, {
					disposition: "queued",
					sdkSubmissionId: submission.submissionId,
				}).catch(error => {
					unsubscribeTerminal();
					throw error;
				});
				const dto: DesktopQueuedInput = {
					id: submission.submissionId,
					text: this.#redact(text).slice(0, TEXT_LIMIT),
					deliverAs,
					cancelable: true,
				};
				live.queued.set(dto.id, { dto, submission, deliveryId: request.id });
				const settle = (execution?: DesktopQueuedInput["execution"]) => {
					const tracked = live.queued.get(dto.id);
					if (!tracked) return;
					if (execution) tracked.dto.execution = execution;
					// A resolved execution means the SDK already owns the input.
					tracked.dto.cancelable = false;
					this.#publish(live);
				};
				this.#observeDelivery(
					submission.execution.then(
						async outcome => {
							if (outcome.disposition !== "removed" && live.errorEpoch === errorEpoch) {
								const key = scopeKey(outcome.attemptScope);
								const owner = live.scopeOwners.get(key);
								if (!owner || admissionOrder < owner.order) {
									live.scopeOwners.set(key, { id: request.id, order: admissionOrder });
									if (live.errorScopeKey === key)
										this.#recordScopeFailure(live, outcome.attemptScope, request.id);
								}
							}
							await queuedPersisted;
							settle(outcome.disposition);
							if (outcome.disposition === "removed")
								await this.#delivery(request.id, {
									disposition:
										outcome.reason === "cancelled"
											? "cancelled"
											: outcome.reason === "refused"
												? "refused"
												: "removed",
								});
							else await this.#delivery(request.id, { disposition: "accepted" });
						},
						async () => {
							await queuedPersisted;
							settle();
							await this.#delivery(request.id, {
								disposition: "unknown",
								error: "Submission lifecycle unavailable",
							});
						},
					),
				);
				this.#observeDelivery(
					submission.terminal.then(
						async outcome => {
							await queuedPersisted;
							unsubscribeTerminal();
							live.queued.delete(dto.id);
							this.#publish(live);
							const terminal =
								outcome.disposition === "completed"
									? terminalEvents.get(scopeKey(outcome.attemptScope))
									: undefined;
							// Consumption settles before the input's own message is appended, so after a Stop
							// this input counts as sent only once its own turn is in the transcript.
							const ownTurn =
								outcome.disposition === "completed" ? this.#claimUserTurn(live, claimant) : undefined;
							const stoppedRun = stopped();
							const inTranscript = ownTurn !== undefined && persistedUserTurn(live.sdk, ownTurn);
							const disposition =
								outcome.disposition === "removed"
									? outcome.reason === "cancelled"
										? "cancelled"
										: outcome.reason === "refused"
											? "refused"
											: "removed"
									: terminal?.assistant === "error"
										? "failed"
										: terminal?.reason === "completed" &&
												terminal.assistant &&
												terminal.assistant !== "aborted"
											? // A run Stop ended after its final answer still completes, but an input
												// it took and handed back unsent is not part of that answer.
												stoppedRun && !inTranscript
												? "unknown"
												: "completed"
											: (terminal?.assistant === "aborted" || terminal?.reason === "cancelled") &&
													stoppedRun &&
													inTranscript
												? "cancelled"
												: "unknown";
							await this.#delivery(request.id, {
								disposition,
								...(disposition === "failed" ? { error: "Prompt failed" } : {}),
							});
							if (
								accepted &&
								disposition === "completed" &&
								terminal?.assistant === "stop" &&
								outcome.disposition === "completed"
							)
								completeTask(outcome.attemptScope);
							if (
								disposition === "failed" &&
								outcome.disposition === "completed" &&
								live.errorEpoch === errorEpoch
							)
								this.#recordScopeFailure(live, outcome.attemptScope, request.id);
						},
						async () => {
							await queuedPersisted;
							unsubscribeTerminal();
							live.queued.delete(dto.id);
							this.#publish(live);
							await this.#delivery(request.id, {
								disposition: "unknown",
								error: "Submission lifecycle unavailable",
							});
						},
					),
				);
				await queuedPersisted;
				this.#publish(live);
				return { queued: true, submissionId: submission.submissionId };
			}
			return this.#exclusive(
				live,
				async settleView => {
					await this.#promptDelivery(
						live,
						request.id,
						text,
						images,
						settleView,
						arrival,
						true,
						false,
						editEntryId,
					);
					return null;
				},
				false,
				true,
				request.id,
			);
		}
		if (method === "queue.cancel") {
			const id = requiredString(params, "queueId", 200);
			const tracked = live.queued.get(id);
			if (!tracked) throw new Error("Queued input not found");
			const removed = tracked.submission.cancel();
			if (removed) await this.#delivery(tracked.deliveryId, { disposition: "cancelled" });
			// Either way this queue id is settled: keeping it would leave a cancelable
			// chip whose delivery already happened.
			live.queued.delete(id);
			this.#publish(live);
			return { removed };
		}
		if (method === "session.delete" && !live.busy && !live.sdk.isStreaming && !live.operator?.isBusy())
			live.titleAbort?.abort();
		return this.#exclusive(
			live,
			async () => {
				switch (method) {
					case "session.rename": {
						const title = requiredString(params, "title", 200).trim();
						await live.sdk.setSessionName(title, "user");
						metadata.title = title;
						this.#publishSnapshot();
						return null;
					}
					case "session.star":
						if (typeof params.starred !== "boolean") throw new Error("Invalid starred");
						metadata.starred = params.starred;
						this.#publishSnapshot();
						return null;
					case "session.delete":
						return this.#deleteSession(live, metadata);
					case "session.fork":
						return this.#fork(live, params);
					case "session.revision":
						return this.#showRevision(live, params);
					case "session.compact":
						await live.sdk.compact();
						return null;
					case "session.retry":
						if (!(await live.sdk.retry())) throw new Error("Session cannot be retried");
						return null;
					case "session.export": {
						const directory = path.join(this.dataDir, "exports");
						await fs.mkdir(directory, { recursive: true, mode: 0o700 });
						return {
							path: await live.sdk.exportToHtml(
								path.join(directory, `${metadata.id}-${crypto.randomUUID()}.html`),
							),
						};
					}
					case "model.set": {
						this.#assertModelCatalogReady(live.sdk.modelRegistry);
						const modelId = requiredString(params, "modelId", 500);
						const model = this.#sessionModels(live.sdk).find(
							model => `${model.provider}/${model.id}` === modelId,
						);
						if (!model)
							throw new Error(
								"This model is not available from a registered provider. Check provider registration and authentication.",
							);
						const level =
							params.thinkingLevel === undefined
								? undefined
								: validateModelThinking(model, params.thinkingLevel);
						const controls = createSdkPreferenceControls(live.sdk);
						try {
							requireAppliedPreference(
								await controls.selectModel({ provider: model.provider, modelId: model.id, scope: "global" }),
							);
						} finally {
							controls.dispose();
						}
						if (level !== undefined) await live.sdk.setThinkingLevelForControl(level, true);
						return null;
					}
					case "thinking.set": {
						this.#assertModelCatalogReady(live.sdk.modelRegistry);
						const level = validateSessionThinking(live.sdk, params.level);
						await live.sdk.setThinkingLevelForControl(level, false);
						return null;
					}
					case "tools.set": {
						const names = params.names;
						if (
							!Array.isArray(names) ||
							names.some(name => typeof name !== "string" || !live.sdk.getAllToolNames().includes(name))
						)
							throw new Error("Invalid tool names");
						await live.sdk.setActiveToolsByName(names as string[], { explicit: true });
						return null;
					}
					case "goal.operate": {
						const op = requiredString(params, "op", 20);
						if (
							op !== "create" &&
							op !== "get" &&
							op !== "resume" &&
							op !== "pause" &&
							op !== "complete" &&
							op !== "drop"
						)
							throw new Error("Invalid goal operation");
						return live.sdk.operateGoal(op, op === "create" ? requiredString(params, "objective") : undefined);
					}
					default:
						throw new Error("Unknown method");
				}
			},
			method === "session.delete" || method === "session.fork",
			method !== "session.fork" && method !== "session.delete",
		);
	}
	#observation(live: LiveSession): SdkComposerObservation {
		this.#refreshSessionServices(live);
		live.observation ??= createSdkComposerObservation(live.sdk, live.factory);
		return live.observation;
	}
	#composer(live: LiveSession): DesktopComposerCompletion {
		if (live.completion?.isCurrent()) return live.completion;
		const sdk = live.sdk;
		const generation = sdk.sessionLifecycle.generation;
		const sessionId = sdk.sessionId;
		const manager = sdk.sessionManager;
		const cwd = manager.getCwd();
		const project = this.#catalog.projects.find(item => item.id === live.metadata.projectId);
		let completion: DesktopComposerCompletion;
		const isCurrent = () => {
			const lifecycle = sdk.sessionLifecycle;
			return (
				!this.#closed &&
				this.#live.get(live.metadata.id) === live &&
				!this.#retiredLive.has(live) &&
				live.completion === completion &&
				!live.gateMutation &&
				!!project &&
				!project.closed &&
				project.path === cwd &&
				!lifecycle.disposed &&
				!lifecycle.transitioning &&
				lifecycle.generation === generation &&
				sdk.sessionId === sessionId &&
				sdk.sessionManager === manager &&
				manager.getCwd() === cwd
			);
		};
		completion = new DesktopComposerCompletion(this.#observation(live), isCurrent);
		live.completion = completion;
		return completion;
	}

	async #copyText(request: DesktopRequest): Promise<{ text: string }> {
		const { params } = request;
		if (Object.keys(params).some(key => !["sessionId", "sessionGeneration", "entryId"].includes(key)))
			throw new Error("Invalid copy parameters");
		const metadata = this.#metadata(params);
		const entryId = requiredString(params, "entryId", 256);
		const generation = params.sessionGeneration;
		if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)
			throw new Error("Invalid sessionGeneration");
		const project = this.#catalog.projects.find(item => item.id === metadata.projectId);
		const cwd = project?.path;
		const catalogCurrent = () =>
			!this.#closed &&
			this.#catalog.sessions.includes(metadata) &&
			!!project &&
			this.#catalog.projects.includes(project) &&
			project.id === metadata.projectId &&
			!project.closed &&
			project.path === cwd;
		let rawText: string;
		if (metadata.managed) {
			const session = this.#managed.get(metadata.id);
			const epoch = this.#managedProjectEpochs.get(metadata.projectId) ?? 0;
			const current = () =>
				catalogCurrent() &&
				!!session &&
				this.#managed.get(metadata.id) === session &&
				session.isAttached &&
				session.controlGeneration === generation &&
				(this.#managedProjectEpochs.get(metadata.projectId) ?? 0) === epoch;
			if (!session || !current()) throw new Error("SDK owner changed. Select the conversation again.");
			rawText = await session.copyText(entryId, generation);
			if (!current()) throw new Error("SDK owner changed. Select the conversation again.");
		} else {
			// Copy never opens an owner or takes the mutation lock, even during a run.
			const live = this.#live.get(metadata.id);
			if (!live) throw new Error("Session changed. Select the conversation again.");
			const sdk = live.sdk;
			const manager = sdk.sessionManager;
			const file = manager.getSessionFile();
			const managerId = manager.getSessionId();
			const identityGeneration = manager.getSessionIdentityGeneration();
			const sessionId = sdk.sessionId;
			const current = () =>
				catalogCurrent() &&
				this.#live.get(metadata.id) === live &&
				!this.#retiredLive.has(live) &&
				!live.gateMutation &&
				live.sdk === sdk &&
				!sdk.sessionLifecycle.disposed &&
				!sdk.sessionLifecycle.transitioning &&
				sdk.sessionLifecycle.generation === generation &&
				sdk.sessionId === sessionId &&
				sdk.sessionManager === manager &&
				manager.getSessionId() === managerId &&
				manager.getSessionIdentityGeneration() === identityGeneration &&
				manager.getCwd() === cwd &&
				manager.getSessionFile() === file &&
				sdk.sessionFile === file;
			if (!current()) throw new Error("Session changed. Select the conversation again.");
			await this.#awaitStartup(live);
			if (!current()) throw new Error("Session changed. Select the conversation again.");
			if (!manager.getBranch().some(entry => entry.id === entryId))
				throw new Error("The message is not on the active conversation branch.");
			const entry = manager.getEntry(entryId);
			const text = entry?.type === "message" ? copyableMessageText(entry.message) : undefined;
			if (text === undefined) throw new Error("The message is no longer available for copying.");
			rawText = text;
		}
		// Redact the complete message once, before measuring the exact success frame.
		const result = { text: this.#redact(rawText) };
		const frame: DesktopFrame = { type: "response", id: request.id, ok: true, result };
		if (Buffer.byteLength(JSON.stringify(frame), "utf8") + 1 > MAX_FRAME_BYTES)
			throw new Error("The complete message exceeds the desktop copy frame limit (8 MiB).");
		return result;
	}

	async #complete(params: Record<string, unknown>): Promise<DesktopCompletionResult> {
		const input = readDesktopCompletionInput(params);
		const metadata = this.#metadata(params);
		if (metadata.managed) {
			// A read of suggestions never opens/reconnects an owner on behalf of an old draft.
			const session = this.#managed.get(metadata.id);
			const project = this.#catalog.projects.find(item => item.id === metadata.projectId);
			const epoch = this.#managedProjectEpochs.get(metadata.projectId) ?? 0;
			const cwd = project?.path;
			const current = () =>
				!this.#closed &&
				!!project &&
				!project.closed &&
				project.path === cwd &&
				this.#managed.get(metadata.id) === session &&
				session?.isAttached === true &&
				session.controlGeneration === input.sessionGeneration &&
				(this.#managedProjectEpochs.get(metadata.projectId) ?? 0) === epoch;
			if (!current()) throw new Error("SDK owner changed. Select the conversation again.");
			const result = await session!.query("composer.complete", { text: input.text, cursor: input.cursor });
			if (!current()) throw new Error("SDK owner changed. Select the conversation again.");
			return this.#filterCompletions(projectDesktopCompletion(result as SdkComposerCompletionResult));
		}
		const live = this.#live.get(metadata.id);
		if (!live || live.sdk.sessionLifecycle.generation !== input.sessionGeneration)
			throw new Error("Session changed. Select the conversation again.");
		await this.#awaitStartup(live);
		if (live.sdk.sessionLifecycle.generation !== input.sessionGeneration)
			throw new Error("Session changed. Select the conversation again.");
		return this.#filterCompletions(await this.#composer(live).complete(input.text, input.cursor));
	}
	#filterCompletions(result: DesktopCompletionResult): DesktopCompletionResult {
		return {
			...result,
			items: result.items.filter(item => !DESKTOP_OWNED_COMMANDS.has(/^\s*\/([^\s/]+)/.exec(item.text)?.[1] ?? "")),
		};
	}

	async #openManaged(metadata: SavedSession): Promise<ManagedSession> {
		const existing = this.#managed.get(metadata.id);
		if (existing?.isAttached) return existing;
		const pending = this.#managedOpening.get(metadata.id);
		if (pending) return pending;
		if (existing) this.#managed.delete(metadata.id);
		const project = this.#catalog.projects.find(item => item.id === metadata.projectId)!;
		const projectEpoch = this.#managedProjectEpochs.get(project.id) ?? 0;
		const cwd = project.path;
		const session = new ManagedSession({
			agentDir: this.agentDir,
			cwd: project.path,
			id: metadata.id,
			projectId: metadata.projectId,
			title: metadata.title,
			starred: metadata.starred,
			nextControlGeneration: () => {
				if (this.#managedControlEpoch >= Number.MAX_SAFE_INTEGER)
					throw new Error("Desktop control generation exhausted");
				return ++this.#managedControlEpoch;
			},
			redact: text => this.#redact(text),
			delivery: (id, changes) => this.#delivery(id, changes),
			turnEnded: this.#endedTurns.has(metadata.id),
			onTurnEnded: () => this.#endedTurns.add(metadata.id),
			onTaskCompleted: (turnId, desktopEpoch) => {
				if (
					!this.#closed &&
					this.#managed.get(metadata.id) === session &&
					this.#catalog.sessions.includes(metadata) &&
					this.#catalog.projects.includes(project) &&
					project.id === metadata.projectId &&
					!project.closed &&
					project.path === cwd &&
					(this.#managedProjectEpochs.get(project.id) ?? 0) === projectEpoch &&
					session.controlGeneration === desktopEpoch &&
					typeof turnId === "string" &&
					turnId.trim()
				)
					this.#taskCompleted(metadata.id, ["managed", desktopEpoch, turnId]);
			},
			onChange: () => {
				if (this.#managed.get(metadata.id) === session && !this.#closed && !project.closed)
					this.#emit({ type: "session", session: session.dto() });
			},
		});
		const opening = (async () => {
			try {
				await existing?.close();
				await session.open();
				if (this.#closed || project.closed || (this.#managedProjectEpochs.get(project.id) ?? 0) !== projectEpoch)
					throw new Error("Workspace closed while connecting to SDK owner");
				this.#managed.set(metadata.id, session);
				return session;
			} catch (error) {
				await session.close();
				throw error;
			}
		})();
		this.#managedOpening.set(metadata.id, opening);
		try {
			return await opening;
		} finally {
			if (this.#managedOpening.get(metadata.id) === opening) this.#managedOpening.delete(metadata.id);
		}
	}

	async #dispatchManaged(request: DesktopRequest, metadata: SavedSession): Promise<unknown> {
		const { method, params } = request;
		const supported = [
			"session.select",
			"history.get",
			"prompt",
			"abort",
			"models.list",
			"model.set",
			"thinking.set",
			"session.info",
		];
		if (!supported.includes(method))
			throw new Error(`The SDK owner does not support desktop ${method}. Use its original control surface.`);
		const query =
			method === "session.select" ||
			method === "history.get" ||
			method === "models.list" ||
			method === "session.info";
		// A write must not resume/reconnect an owner on behalf of an old rendered
		// intent. Only reads may establish or synchronize the current attachment.
		const session = query ? await this.#openManaged(metadata) : this.#managed.get(metadata.id);
		if (
			!session ||
			(!query &&
				(!Number.isSafeInteger(params.sessionGeneration) || params.sessionGeneration !== session.controlGeneration))
		)
			throw new Error("SDK owner changed before control dispatch. Select the conversation again.");
		switch (method) {
			case "session.info": {
				if (Object.keys(params).some(key => key !== "sessionId"))
					throw new Error("Invalid session read parameters");
				const generation = session.controlGeneration;
				const info = await session.query("session.info");
				if (
					this.#closed ||
					this.#managed.get(metadata.id) !== session ||
					!session.isAttached ||
					session.controlGeneration !== generation
				)
					throw new Error("SDK owner changed. Select the conversation again.");
				return projectDesktopSessionInfo(info as SdkSessionInfo, {
					catalogSessionId: metadata.id,
					redact: text => this.#redact(text),
				});
			}
			case "session.select":
				await session.refresh();
				this.#publishSnapshot();
				return session.dto();
			case "history.get": {
				const offset = params.offset ?? 0;
				const limit = params.limit ?? HISTORY_PAGE_LIMIT;
				if (
					typeof offset !== "number" ||
					!Number.isInteger(offset) ||
					offset < 0 ||
					typeof limit !== "number" ||
					!Number.isInteger(limit) ||
					limit < 1 ||
					limit > HISTORY_PAGE_LIMIT
				)
					throw new Error("Invalid history page");
				await session.refresh();
				return session.history(offset, limit);
			}
			case "prompt": {
				if (params.editEntryId !== undefined)
					throw new Error("Prompt editing is unavailable for this SDK connection.");
				const input = prepareDesktopAttachmentInput(request);
				if (input.images.length) throw new Error("Image submission is unavailable for this SDK connection");
				await session.prompt(request.id, input.text, params.deliverAs);
				return null;
			}
			case "abort":
				return session.control("turn.abort");
			case "models.list":
				await session.refresh();
				return session.models();
			case "model.set":
				return session.setModel(requiredString(params, "modelId", 500), params.thinkingLevel);
			case "thinking.set":
				return session.setThinking(params.level);
		}
	}

	/**
	 * Hides a workspace's live conversations after its durable close. Teardown failures are
	 * reported rather than rethrown: the close itself already succeeded and must not be undone
	 * by an uncooperative abort, but the operator still needs to see that a run was cut short.
	 */
	async #teardownProject(projectId: string): Promise<void> {
		// The close already owns the workspace's queue entry, so teardown must finish on a budget:
		// an uncooperative abort would otherwise keep every later reopen of this folder waiting.
		const deadline = AbortSignal.timeout(CLOSE_TEARDOWN_TIMEOUT_MS);
		this.#managedProjectEpochs.set(projectId, (this.#managedProjectEpochs.get(projectId) ?? 0) + 1);
		const managedOpening = [...this.#managedOpening.entries()].filter(
			([id]) => this.#catalog.sessions.find(session => session.id === id)?.projectId === projectId,
		);
		for (const [id] of managedOpening) this.#managedOpening.delete(id);
		await Promise.allSettled(managedOpening.map(([, opening]) => bounded(opening, deadline)));
		for (const [id, session] of [...this.#managed]) {
			if (this.#catalog.sessions.find(item => item.id === id)?.projectId !== projectId) continue;
			this.#managed.delete(id);
			try {
				await bounded(session.close(), deadline);
			} catch (error) {
				console.error(`Desktop workspace could not detach SDK session ${id}: ${String(error)}`);
			}
		}
		// A session that is still opening when the workspace closes must not stay live either:
		// settling each in-flight open lets its publish path see the closed project and refuse.
		const opening = [...this.#opening.entries()]
			.filter(([id]) => this.#catalog.sessions.find(session => session.id === id)?.projectId === projectId)
			.map(([, promise]) => promise);
		await Promise.allSettled(opening.map(promise => bounded(promise, deadline)));
		// Retire each live session independently so one failed teardown cannot leave the rest running.
		const questionFailures: unknown[] = [];
		for (const [id, live] of [...this.#live]) {
			if (live.metadata.projectId !== projectId) continue;
			try {
				this.#cancelQuestions(live);
			} catch (error) {
				// The answer is already settled; retain its publication error without skipping owners.
				questionFailures.push(error);
			}
			// A failed cancellation receipt remains unknown in the journal, but must not prevent
			// this session or the remaining owners from being retired and stopped.
			for (const tracked of live.queued.values()) {
				try {
					if (tracked.submission.cancel()) await this.#delivery(tracked.deliveryId, { disposition: "cancelled" });
				} catch (error) {
					console.error(
						`Desktop workspace close could not cancel delivery ${tracked.deliveryId}: ${String(error)}`,
					);
				}
			}
			this.#live.delete(id);
			this.#retiredLive.add(live);
			try {
				await live.sdk.abort({ cause: "session_switch", timeoutMs: CLOSE_ABORT_TIMEOUT_MS });
			} catch (error) {
				console.error(`Desktop workspace close could not abort session ${id}: ${String(error)}`);
			}
			try {
				await bounded(this.#disposeLive(live), deadline);
			} catch (error) {
				console.error(`Desktop workspace close could not dispose session ${id}: ${String(error)}`);
			}
		}
		if (questionFailures.length)
			throw new AggregateError(questionFailures, "Workspace close could not publish question cancellations");
	}
	/** Serializes open/close for one workspace path; a rejected step does not poison the queue. */
	#withProject<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#projectLocks.get(key) ?? Promise.resolve();
		const next = previous.then(operation, operation);
		const tail = next.then(
			() => undefined,
			() => undefined,
		);
		this.#projectLocks.set(key, tail);
		void tail.then(() => {
			if (this.#projectLocks.get(key) === tail) this.#projectLocks.delete(key);
		});
		return next;
	}

	/** Read-only SDK inventory: no recovery, transcript copies, or eager live sessions. */
	async #discoverProjectSessions(
		project: DesktopProject,
	): Promise<{ discovered: SavedSession[]; creationTimes: Map<string, number> }> {
		const { managed, local: desktop } = await listEmbeddedProjectSessions({
			cwd: project.path,
			agentDir: this.agentDir,
			directory: path.join(this.dataDir, "sessions", project.id),
		});
		const sessions = [...managed, ...desktop];
		const discovered: SavedSession[] = [];
		const creationTimes = new Map<string, number>();
		const ids = new Set(this.#catalog.sessions.map(session => session.id));
		const catalogRow = (session: (typeof sessions)[number]) =>
			this.#catalog.sessions.find(
				item =>
					item.id === session.id ||
					(item.projectId === project.id && item.sessionId === session.id) ||
					(item.projectId === project.id &&
						item.file !== undefined &&
						path.resolve(session.path) === this.#sessionPath(item.file, item.scope)),
			);
		// A branch fork keeps the full copy it was cut from as private parent lineage, and only
		// the branch enters the catalog. A listed conversation's parent is lineage, not a new row.
		const lineage = new Set<string>();
		for (const session of sessions)
			if (session.parentSessionPath && catalogRow(session)) lineage.add(session.parentSessionPath);
		for (const session of sessions.sort((left, right) => left.created.getTime() - right.created.getTime())) {
			const createdAt = session.created.getTime();
			if (!ID.test(session.id) || !session.cwd || !Number.isFinite(createdAt) || createdAt < 0) continue;
			// Managed inventories can include legacy and project-local candidates. Header
			// scope must still name this exact directory, never a parent or sibling project.
			const cwd = await fs.realpath(session.cwd).catch(() => undefined);
			if (cwd !== project.path) continue;
			const existing = catalogRow(session);
			if (existing?.projectId === project.id) creationTimes.set(existing.id, createdAt);
			if (
				existing ||
				desktop.includes(session) ||
				ids.has(session.id) ||
				// Includes a conversation still being created, whose catalog row has no SDK id yet.
				this.#heldTranscripts.has(session.id) ||
				this.#catalog.released?.includes(session.id) ||
				this.#heldTranscripts.has(path.resolve(session.path)) ||
				lineage.has(session.id) ||
				lineage.has(path.resolve(session.path))
			)
				continue;
			ids.add(session.id);
			discovered.push({
				id: session.id,
				projectId: project.id,
				title: (session.title || session.firstMessage.trim() || "Untitled session").slice(0, 200),
				starred: session.starred,
				managed: true,
				createdAt,
			});
		}
		return { discovered, creationTimes };
	}

	/** Restores or refreshes a workspace under the same fence used by close. */
	async #openProject(resolved: string): Promise<DesktopProject> {
		const existing = this.#catalog.projects.find(item => item.path === resolved);
		const project: DesktopProject = existing ?? {
			id: crypto.randomUUID(),
			name: (path.basename(resolved) || resolved).slice(0, 200),
			path: resolved,
		};
		const discovery = await this.#discoverProjectSessions(project);
		const closed = project.closed;
		delete project.closed;
		if (!existing) this.#catalog.projects.push(project);
		const undo = this.#mergeDiscovered(project, discovery);
		try {
			await this.#save();
		} catch (error) {
			undo?.();
			if (!existing) this.#catalog.projects = this.#catalog.projects.filter(item => item !== project);
			if (closed !== undefined) project.closed = closed;
			throw error;
		}
		this.#publishSnapshot();
		return project;
	}

	/** Records a removed row's transcript identity in the next catalog save; returns its undo. */
	#release(metadata: SavedSession): () => void {
		return this.#releaseId(metadata.sessionId ?? (metadata.managed ? metadata.id : undefined));
	}
	#releaseId(id: string | undefined): () => void {
		const previous = this.#catalog.released;
		if (id === undefined || previous?.includes(id)) return () => {};
		this.#catalog.released = [...(previous ?? []), id].slice(-RELEASED_LIMIT);
		return () => {
			if (previous) this.#catalog.released = previous;
			else delete this.#catalog.released;
		};
	}
	#holdTranscript(manager: SessionManager): void {
		this.#heldTranscripts.add(manager.getSessionId());
		const file = manager.getSessionFile();
		if (file) this.#heldTranscripts.add(path.resolve(file));
	}

	/**
	 * Adds conversations another surface created in an open workspace. The caller holds the
	 * workspace fence and publishes; nothing is saved when the discovery changed nothing.
	 */
	async #refreshProject(project: DesktopProject): Promise<void> {
		// Queued behind a close or reopen of the same path: refresh only what is still open.
		if (project.closed || !this.#catalog.projects.includes(project)) return;
		const discovery = await this.#discoverProjectSessions(project);
		const undo = this.#mergeDiscovered(project, discovery);
		// Creation-time corrections alone are saved with the next catalog write; a new row needs
		// its own, and only then can bootstrap wait on the catalog queue.
		if (!undo || !discovery.discovered.length) return;
		try {
			await this.#save();
		} catch (error) {
			undo();
			throw error;
		}
	}

	/** Applies one discovery to the catalog and returns its undo, or undefined when nothing changed. */
	#mergeDiscovered(
		project: DesktopProject,
		{ discovered, creationTimes }: { discovered: SavedSession[]; creationTimes: Map<string, number> },
	): (() => void) | undefined {
		const previousCreationTimes = new Map<SavedSession, number | undefined>();
		for (const session of this.#catalog.sessions) {
			const createdAt = creationTimes.get(session.id);
			if (createdAt === undefined || createdAt === session.createdAt) continue;
			previousCreationTimes.set(session, session.createdAt);
			session.createdAt = createdAt;
		}
		// Place newly discovered history chronologically without disturbing any existing user order.
		for (const session of discovered) {
			const index = this.#catalog.sessions.findIndex(
				item =>
					item.projectId === project.id &&
					item.createdAt !== undefined &&
					session.createdAt !== undefined &&
					item.createdAt > session.createdAt,
			);
			if (index === -1) this.#catalog.sessions.push(session);
			else this.#catalog.sessions.splice(index, 0, session);
		}
		if (!discovered.length && !previousCreationTimes.size) return undefined;
		return () => {
			for (const [session, createdAt] of previousCreationTimes) {
				if (createdAt === undefined) delete session.createdAt;
				else session.createdAt = createdAt;
			}
			const added = new Set(discovered);
			this.#catalog.sessions = this.#catalog.sessions.filter(session => !added.has(session));
		};
	}

	/**
	 * Hides a workspace and retires its live conversations. Closing never deletes the directory,
	 * the sessions or their files, and reopening the path restores the same identity.
	 */
	async #closeProject(project: DesktopProject): Promise<null> {
		const previous = project.closed;
		project.closed = true;
		try {
			await this.#save();
		} catch (error) {
			if (previous === undefined) delete project.closed;
			else project.closed = previous;
			throw error;
		}
		// Publication cannot undo the durable close or bypass its owned teardown.
		const failures: unknown[] = [];
		try {
			this.#publishSnapshot();
		} catch (error) {
			failures.push(error);
		} finally {
			try {
				await this.#teardownProject(project.id);
			} catch (error) {
				failures.push(error);
			}
		}
		try {
			this.#publishSnapshot();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length) throw new AggregateError(failures, "Workspace close publication and teardown failed");
		return null;
	}

	async #deleteSession(live: LiveSession, metadata: SavedSession): Promise<null> {
		this.#cancelQuestions(live);
		live.queued.clear();
		await this.#disposeLive(live);
		this.#live.delete(metadata.id);
		const index = this.#catalog.sessions.indexOf(metadata);
		this.#catalog.sessions = this.#catalog.sessions.filter(item => item !== metadata);
		const restoreReleased = this.#release(metadata);
		try {
			await this.#save();
		} catch (error) {
			this.#catalog.sessions.splice(index, 0, metadata);
			restoreReleased();
			throw error;
		}
		await this.#forgetDeliveries(metadata);
		if (metadata.file) await this.#deleteTranscript(metadata.file, metadata.scope);
		this.#publishSnapshot();
		return null;
	}
	#startAutoTitle(live: LiveSession, text: string): void {
		if (!text.trim() || live.sdk.isLocallyHandledSlashCommand(text.trimStart()) || live.titleAbort) return;
		const controller = new AbortController();
		live.titleAbort = controller;
		const manager = live.sdk.sessionManager;
		const sessionId = live.sdk.sessionId;
		const managerId = manager.getSessionId();
		const sessionFile = manager.getSessionFile();
		const identityGeneration = manager.getSessionIdentityGeneration();
		const generation = live.sdk.sessionLifecycle.generation;
		const current = () => {
			const lifecycle = live.sdk.sessionLifecycle;
			return (
				!controller.signal.aborted &&
				!this.#closed &&
				!this.#retiredLive.has(live) &&
				this.#live.get(live.metadata.id) === live &&
				this.#catalog.sessions.includes(live.metadata) &&
				!lifecycle.disposed &&
				!lifecycle.transitioning &&
				lifecycle.generation === generation &&
				live.sdk.sessionManager === manager &&
				live.sdk.sessionId === sessionId &&
				manager.getSessionId() === managerId &&
				manager.getSessionFile() === sessionFile &&
				manager.getSessionIdentityGeneration() === identityGeneration
			);
		};
		void (async () => {
			try {
				const result = await live.sdk.generateAutoSessionTitle(text, { signal: controller.signal });
				if (result.kind === "failed") {
					console.error("Desktop automatic session title generation failed");
					return;
				}
				if (result.kind !== "applied" || !current()) return;
				const title = manager.getSessionName()?.slice(0, 200);
				if (!title || title === live.metadata.title) return;
				// The SDK header already durably owns this title. Update the display
				// cache without enqueuing optional I/O ahead of delivery writes. Normal
				// catalog mutations persist it; reopening reconciles it from the SDK.
				live.metadata.title = title;
				this.#publish(live);
				this.#publishSnapshot();
			} catch {
				console.error("Desktop automatic session title generation failed");
			}
		})();
	}
	/** Mirror the session's own title into the desktop catalog after a command changed it. */
	#syncTitle(live: LiveSession): void {
		const title = live.sdk.sessionManager.getSessionName?.();
		if (!title || title === live.metadata.title) {
			this.#publishSnapshot();
			return;
		}
		live.metadata.title = title.slice(0, 200);
		this.#publishSnapshot();
		this.#publish(live);
	}
	/**
	 * Run one builtin slash command through the public SDK dispatcher so the app
	 * executes exactly the same handlers as text/ACP mode. Commands that only
	 * exist as TUI modals are not advertised and cannot reach this path.
	 */
	async #command(
		metadata: SavedSession,
		text: string,
		requestId: string,
		arrival: number,
		alreadyBegun = false,
	): Promise<DesktopCommandResult> {
		const live = await this.#open(metadata);
		await this.#awaitStartup(live);
		const name = text.trimStart().replace(/^\/+/, "").split(/\s+/, 1)[0]?.toLowerCase() ?? "";
		if (/^\s*\/btw(?:\s|$)/i.test(text)) {
			const question = text
				.trimStart()
				.replace(/^\/btw(?:\s+|$)/i, "")
				.trim();
			if (!question)
				return { consumed: false, refused: true, output: "Open the side-chat menu or type /btw <question>." };
			this.#refreshSessionServices(live);
			if (live.gateMutation || !live.btw)
				throw new Error("Open the side chat again after the session change finishes.");
			live.btw.open({ question });
			return {
				consumed: true,
				output: "Side-chat request accepted. It is not added to the existing conversation history.",
			};
		}
		if (DESKTOP_OWNED_COMMANDS.has(name))
			return { consumed: false, refused: true, output: DESKTOP_OWNED_REFUSALS[name] ?? DESKTOP_UNAVAILABLE };
		if (text.trimStart().startsWith("/") && !ADVERTISED_COMMANDS.has(name))
			// TUI-only or unknown names never reach the dispatcher: its own notice
			// would report success and an unknown name would spend a provider turn.
			return { consumed: false, refused: true, output: DESKTOP_UNAVAILABLE };
		// Commands mutate the same session as prompts, so they take the same lock.
		return this.#exclusive(
			live,
			settleView => this.#runCommand(live, text, requestId, settleView, arrival, alreadyBegun),
			true,
		);
	}
	async #runCommand(
		live: LiveSession,
		text: string,
		requestId: string,
		settleView: () => void,
		arrival: number,
		alreadyBegun = false,
	): Promise<DesktopCommandResult> {
		const chunks: string[] = [];
		let written = 0;
		let dropped = false;
		const append = (value: string) => {
			if (written >= COMMAND_OUTPUT_LIMIT) return;
			const redacted = this.#redact(value);
			const bounded = redacted.slice(0, COMMAND_OUTPUT_LIMIT - written);
			chunks.push(bounded);
			written += bounded.length;
			if (bounded.length < redacted.length) dropped = true;
		};
		const runtime: SlashCommandRuntime = {
			session: live.sdk,
			sessionManager: live.sdk.sessionManager,
			settings: live.settings,
			cwd: live.sdk.sessionManager.getCwd(),
			output: value => append(String(value)),
			refreshCommands: async () => {
				await live.factory.refreshCommands();
				live.completion = undefined;
				this.#publishSnapshot();
			},
			reloadPlugins: async () => {
				await live.sdk.reloadSkills();
				await live.factory.refreshCommands();
				live.completion = undefined;
				this.#publishSnapshot();
			},
			notifyTitleChanged: () => this.#syncTitle(live),
			notifyConfigChanged: () => this.#publishSnapshot(),
		};
		try {
			const result = await executeAcpBuiltinSlashCommand(text, runtime);
			let forwarded: string | undefined;
			let consumed = false;
			if (result === false) {
				if (text.trimStart().startsWith("/")) {
					// A slash-prefixed name no builtin can drive is a TUI-only or unknown
					// command; refuse instead of silently sending it to the model.
					return {
						consumed: false,
						refused: true,
						output:
							"This command is not available in the desktop app. Send ordinary messages without a leading slash.",
					};
				} else {
					// Plain text: forward as a prompt, matching ACP mode.
					forwarded = text;
				}
			} else if ("prompt" in result) {
				forwarded = result.prompt;
				consumed = true;
			} else {
				consumed = true;
			}
			this.#syncTitle(live);
			if (forwarded !== undefined) {
				// A builtin that returns a prompt starts a real turn, so its failure is the
				// conversation's failure even though command.run itself is administrative.
				try {
					// Judged against the command's own arrival: a Stop while the command ran stops this.
					await this.#promptDelivery(live, requestId, forwarded, [], settleView, arrival, alreadyBegun, true);
				} catch (error) {
					if (
						!live.errorOwner &&
						this.#deliveries.list().some(receipt => receipt.id === requestId && receipt.disposition === "failed")
					) {
						live.error = this.#error(error);
						live.errorOwner = requestId;
					}
					throw error;
				}
			}
			return {
				consumed,
				output: chunks.join("\n").trim(),
				...(forwarded !== undefined ? { prompt: forwarded } : {}),
				...(dropped ? { outputTruncated: true } : {}),
			};
		} finally {
			// A command may have stored credentials; keep redaction current even when
			// the command itself failed.
			this.#rememberCredentials();
		}
	}
	async #diff(live: LiveSession): Promise<DesktopDiff[]> {
		const observation = createSdkDiffObservation(live.sdk);
		try {
			const snapshot = await observation.summary({ scope: "working-tree" });
			return snapshot.files.map(row => {
				const file = observation.file({ ref: row.ref });
				return {
					path: this.#redact(file.path),
					status: file.status,
					patch:
						this.#redact(file.body).slice(0, 32_000) +
						(file.truncated || file.body.length > 32_000 ? "\n[Diff truncated at 32,000 characters]" : ""),
				};
			});
		} finally {
			observation.dispose();
		}
	}
	close(): Promise<void> {
		this.#closing ??= this.#close();
		return this.#closing;
	}
	async #close(): Promise<void> {
		this.#closed = true;
		const failures: unknown[] = [];
		const attempt = async (operation: () => unknown | Promise<unknown>) => {
			try {
				await operation();
			} catch (error) {
				failures.push(error);
			}
		};
		for (const live of this.#live.values()) live.titleAbort?.abort();
		if (this.#init) await this.#init.catch(() => {});
		if (this.#authPoll) clearTimeout(this.#authPoll);
		this.#authPoll = undefined;
		const authorizationClose = this.#authorization?.close();
		// Attach a handler immediately while unrelated session cleanup drains.
		void authorizationClose?.catch(() => {});
		await attempt(() => this.#cancelQuestions());
		await Promise.allSettled([...this.#opening.values(), ...this.#managedOpening.values()]);
		await Promise.allSettled([...this.#managed.values()].map(session => session.close()));
		this.#managed.clear();
		await attempt(() => this.#cancelQuestions());
		await Promise.all([...this.#live.values()].map(live => attempt(() => live.sdk.abort())));
		await Promise.allSettled([...this.#tasks]);
		await Promise.all(
			[...new Set([...this.#live.values(), ...this.#retiredLive])].map(async live => {
				await attempt(() => this.#disposeLive(live));
			}),
		);
		this.#live.clear();
		await Promise.all([...this.#candidates].map(candidate => attempt(() => this.#disposeCandidate(candidate))));
		// Shutdown joins real retained teardown, including timed-out and rolled-back publications.
		await Promise.all([...this.#cleanupOwners.values()].map(completion => attempt(() => completion)));
		// Terminal queue observers can require disposal to settle. Join them only after SDK teardown.
		while (this.#deliveryObservers.size) await Promise.all([...this.#deliveryObservers]);
		failures.push(...this.#deliveryFailures);
		await attempt(() => this.#saving);
		failures.push(...this.#saveFailures);
		let authorizationJoined = false;
		await attempt(async () => {
			await authorizationClose;
			authorizationJoined = true;
		});
		const sessionsReleased =
			this.#cleanupOwners.size === 0 && this.#candidates.size === 0 && this.#retiredLive.size === 0;
		// The hidden control owner lends auth to local sessions; retire it only after all borrowers and authorization settle.
		if (authorizationJoined && sessionsReleased && this.#control) {
			await attempt(() => this.#control!.session.dispose());
			await attempt(() => this.#control!.releaseResources());
		}
		if (failures.length) throw new AggregateError(failures, "Desktop shutdown failed to clean up all SDK resources");
	}
}
