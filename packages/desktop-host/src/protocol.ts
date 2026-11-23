import type { DesktopActivitySnapshot } from "./activity-protocol";
import type { DesktopBtwEvent } from "./btw-protocol";
import type { DesktopGatePresentationEvent } from "./gate-presentation-protocol";
import type { DesktopOperatorEvent } from "./operator-protocol";
import type { DesktopPreferenceOutcome } from "./preferences-protocol";
import type { DesktopToolCall } from "./tool-protocol";

export const PROTOCOL_VERSION = 1;

export const DESKTOP_METHODS = [
	"bootstrap",
	"project.open",
	"project.close",
	"project.reorder",
	"session.reorder",
	"session.create",
	"session.select",
	"session.rename",
	"session.delete",
	"session.star",
	"session.fork",
	"session.revision",
	"session.compact",
	"session.retry",
	"session.export",
	"session.disconnect",
	"session.connect",
	"prompt",
	"abort",
	"models.list",
	"model.set",
	"thinking.set",
	"settings.get",
	"settings.set",
	"auth.setKey",
	"auth.providers",
	"auth.keyProviders",
	"auth.login",
	"auth.state",
	"auth.answer",
	"auth.cancel",
	"question.answer",
	"command.list",
	"command.run",
	"composer.complete",
	"history.get",
	"message.copyText",
	"activity.get",
	"activity.detail",
	"activity.operate",
	"activity.acknowledge",
	"preferences.get",
	"preferences.apply",
	"gate.present",
	"gate.presented",
	"gate.answer",
	"gate.withdraw",
	"gate.retired",
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
	"queue.cancel",
	"delivery.ack",
	"diff.get",
	"tools.list",
	"tools.set",
	"tool.detail",
	"goal.operate",
	"shutdown",
] as const;
export type DesktopMethod = (typeof DESKTOP_METHODS)[number];

export interface DesktopRequest {
	id: string;
	method: DesktopMethod;
	params: Record<string, unknown>;
}

export type DesktopMessageBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "image"; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }
	| { type: "image-unavailable"; reason: string };

export interface DesktopMessage {
	id: string;
	/** Canonical persisted user-entry identity; display IDs never authorize branching. */
	entryId?: string;
	/** Exact persisted prompt or finished answer; never authorizes copying a bounded preview. */
	copy?: { entryId: string; sessionGeneration: number };
	/** Sibling user prompts sharing this prompt's parent; present only when another revision exists. */
	revision?: DesktopMessageRevision;
	blocks?: DesktopMessageBlock[];
	role: "user" | "assistant" | "tool" | "system";
	text: string;
	toolName?: string;
	/** User execution remains visible but is omitted from model context. */
	excludeFromContext?: boolean;
	cancelled?: boolean;
	isError?: boolean;
	truncated?: boolean;
	/** Call metadata on a `role: "tool"` row; a row without it renders from `toolName` and `text`. */
	tool?: DesktopToolCall;
}

export interface DesktopMessageRevision {
	/** Zero-based position among the answered sibling prompts, oldest first. */
	index: number;
	count: number;
	/** Persisted user-entry IDs accepted by `session.revision`. */
	previous?: string;
	next?: string;
}

export interface DesktopQuestion {
	id: string;
	sessionId: string;
	kind: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	initialValue?: string;
}

export interface DesktopDeliveryReceipt {
	id: string;
	sessionId: string;
	disposition:
		| "pending"
		| "accepted"
		| "queued"
		| "completed"
		| "failed"
		| "removed"
		| "cancelled"
		| "refused"
		| "unknown";
	sdkSubmissionId?: string;
	error?: string;
}

export interface DesktopQueuedInput {
	id: string;
	text: string;
	deliverAs: "steer" | "followUp";
	/** False once the SDK has already admitted the input into the run. */
	cancelable: boolean;
	execution?: "joined-current-run" | "promoted-to-run" | "completed" | "removed";
}
/** Detached JSON wire values; the host mapper checks them against public SDK capabilities. */
export type DesktopThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/**
 * Wire vocabulary for thinking control: the SDK's canonical transports plus the
 * native toggle/always-on modes. Declared here rather than imported from the SDK
 * so the renderer program never pulls the provider graph in; the parity guard in
 * `model-controls.ts` keeps it aligned with `THINKING_CONTROL_MODES`.
 */
export type DesktopThinkingMode =
	| "effort"
	| "budget"
	| "google-level"
	| "anthropic-adaptive"
	| "anthropic-budget-effort"
	| "toggle"
	| "always-on";
export interface DesktopThinkingOption {
	value: DesktopThinkingLevel;
	label: string;
	description?: string;
}
export interface DesktopThinking {
	/** Live effective SDK level, not a guessed default or provider reasoning text. */
	level: DesktopThinkingLevel | null;
	options: DesktopThinkingOption[];
	scope: "session" | "global config" | null;
	available: boolean;
	mode?: DesktopThinkingMode;
	reason?: string;
}
export interface DesktopTodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
	/** The task's notes, oldest first: at most 5, each redacted and cut to 300 characters. */
	notes?: string[];
}
export interface DesktopTodoPhase {
	name: string;
	tasks: DesktopTodoItem[];
}
export interface DesktopGoal {
	objective: string;
	status: "active" | "paused" | "complete" | "dropped";
	/** Present only when the SDK reported a value; never zero-filled by the host. */
	tokensUsed?: number;
	timeUsedSeconds?: number;
}
export interface DesktopSession {
	id: string;
	projectId: string;
	title: string;
	/**
	 * `done` means a turn of this conversation ended while the app was running and the session is
	 * otherwise settled (not busy, waiting on an answer/gate, or failed). Everything else is `idle`,
	 * including a conversation with history from an earlier run: loading, opening, selecting or
	 * renaming a conversation never changes its status, and notices never count as a turn.
	 */
	status: "idle" | "done" | "running" | "waiting" | "error";
	queued?: DesktopQueuedInput[];
	starred: boolean;
	model?: string;
	/** Null until the actual session is opened; display metadata grants no image authority. */
	imageInput: { supported: boolean; blocked: boolean } | null;
	/** True while a canonical SDK operator execution promise remains unsettled. */
	operatorRunning: boolean;
	/** Display sequencing only; never authorizes an SDK control. */
	controlGeneration: number | null;
	/** The host can rewind this conversation's tree to edit a prompt or show another revision. */
	promptEditing?: true;
	/** Present on host projections, including unavailable unopened/no-model sessions. */
	thinking?: DesktopThinking;
	/** Live `todo_write` state for the session; omitted when the list is empty. */
	todos?: DesktopTodoPhase[];
	/** Active or retained goal state from the `goal` tool; omitted when there is none. */
	goal?: DesktopGoal;
	messages: DesktopMessage[];
	historyTruncated?: boolean;
	question?: DesktopQuestion;
	/** Last failed prompt turn for this conversation; administrative refusals answer their request instead. */
	error?: string;
	errorOwner?: string;
	/**
	 * Whether the app writes this conversation itself. Absent only on a row an earlier build saved
	 * without a transcript path, until the shared store's listing places it.
	 */
	connection?: DesktopSessionConnection;
}

/**
 * Who writes a conversation, whichever surface created it. `connected`: the app opens its own writer when the
 * conversation is used. `disconnected`: the user released it (`session.disconnect`) so another
 * surface, such as the terminal, can continue it; it survives restarts, its history is read from
 * the transcript and nothing can be sent until `session.connect`. `elsewhere`: another gjc
 * process has it open, so the app shows it read-only; `session.connect` checks again.
 */
/**
 * A request refused because the app does not write the conversation right now: it is released
 * (`disconnected`), being released (`disconnecting`), or another gjc process has it (`elsewhere`).
 * The session's `connection` state already says the first and last of these.
 */
export type DesktopConnectionRefusal = "elsewhere" | "disconnected" | "disconnecting";

export interface DesktopSessionConnection {
	state: "connected" | "disconnected" | "elsewhere";
}

/**
 * `session.disconnect` answer. Without `confirm`, a conversation with a running turn, queued
 * input or background work is left untouched and the answer says what Disconnect would stop.
 * With `confirm: true` the turn and queue are stopped exactly as Stop does, and the background
 * work ends with the session, before the writer is released. `background` (present only when
 * above zero) counts running jobs and live tasks.
 */
export type DesktopDisconnectResult =
	| { disconnected: true; session: DesktopSession }
	| { disconnected: false; confirm: { running: boolean; queued: number; background?: number } };

export type DesktopForkResult =
	| { cancelled: true }
	| { cancelled: false; session: DesktopSession; selectedText: string };

export interface DesktopProject {
	id: string;
	name: string;
	path: string;
	/**
	 * A closed workspace is hidden with its conversations but keeps its identity, so reopening
	 * the same directory restores the same project and its sessions. Closing never deletes.
	 */
	closed?: boolean;
}
export interface DesktopModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	reasoning: boolean;
	/** Concrete levels only: the resolved level already reflects any profile default. */
	thinking: { options: DesktopThinkingOption[]; mode?: DesktopThinkingMode };
}
export interface DesktopCapability {
	id: string;
	label: string;
	available: boolean;
	reason?: string;
}
export interface DesktopSnapshot {
	protocolVersion: number;
	projects: DesktopProject[];
	sessions: DesktopSession[];
	models: DesktopModel[];
	capabilities: DesktopCapability[];
	deliveries: DesktopDeliveryReceipt[];
}
export interface DesktopSetting {
	path: string;
	value: unknown;
	type: string;
	description?: string;
	choices?: string[];
	writable: boolean;
}
export interface DesktopDiff {
	path: string;
	status: string;
	patch: string;
}
export interface DesktopCompletionItem {
	value: string;
	label: string;
	description?: string;
	/** Exact whole-draft replacement from the public SDK composer observation. */
	text: string;
	/** UTF-16 offset in text. */
	cursor: number;
}
export interface DesktopCompletionResult {
	items: DesktopCompletionItem[];
	reason?: string;
}
export interface DesktopCommand {
	name: string;
	description: string;
	hint?: string;
}
export interface DesktopCommandResult {
	/**
	 * True when a builtin handled the text. False means nothing was executed: see
	 * `prompt` for text forwarded to the model and `refused` for declined text.
	 */
	consumed: boolean;
	/** The host declined to run this text; `output` explains why and nothing happened. */
	refused?: boolean;
	/** Text the command emitted for the operator. */
	output: string;
	/** Residual prompt that the command asked to forward to the model. */
	prompt?: string;
	outputTruncated?: boolean;
}
export interface DesktopHistory {
	sessionId: string;
	/** Total visible messages, independent of the snapshot projection cap. */
	total: number;
	offset: number;
	messages: DesktopMessage[];
	truncated: boolean;
}
/** One provider the app can enroll: `auth.login` and/or `auth.setKey` is admitted for it. */
export interface DesktopAuthProvider {
	id: string;
	/** OAuth catalog name when one exists, otherwise the provider id verbatim. */
	name: string;
	/** Effective authentication now: a stored credential, models.yml or a runtime key. */
	configured: boolean;
	/**
	 * Current presence of a credential in the shared SDK store (shared with the terminal app).
	 * Presence, not history: it never says which flow or key save put the credential there.
	 */
	stored: boolean;
	credentialKinds: ("api_key" | "oauth")[];
	/** `auth.login` is admitted for this provider. */
	canSignIn: boolean;
	/** `auth.setKey` is admitted for this provider. */
	canStoreKey: boolean;
}
export interface DesktopCredentialSaveResult {
	provider: string;
	saved: true;
	/** False means credentials are stored but at least one catalog needs a retry. */
	catalogRefreshed: boolean;
}
export interface DesktopAuthState {
	id: string;
	provider: string;
	status: "authorizing" | "waiting" | "complete" | "cancelled" | "error";
	url?: string;
	instructions?: string;
	/** One-time device code to enter on the provider's page; `instructions` carries the same code as prose. */
	verificationCode?: string;
	/**
	 * A provider risk notice the user must accept before the flow continues. Present only while
	 * the flow is `waiting` on that acknowledgement, never alongside `prompt`. Confirm with
	 * `auth.answer {promptId: warning.id, value: "confirm"}`; decline with `auth.cancel`.
	 */
	warning?: { id: string; message: string };
	prompt?: { id: string; message: string; placeholder?: string; allowEmpty?: boolean };
	error?: string;
	/**
	 * Present only as `false`, on an `error` state whose credentials were saved but whose model
	 * catalog refresh failed (mirrors `DesktopCredentialSaveResult.catalogRefreshed`). Every other
	 * error, including a re-sign-in that fails while older credentials remain stored, omits it.
	 */
	catalogRefreshed?: false;
}
export interface DesktopActivityUpdate {
	sessionId: string;
	/** Monotonic within the host's live catalog binding, not an SDK atomicity receipt. */
	revision: number;
	activity: DesktopActivitySnapshot;
}
/** Ephemeral proof of one successful actual run; never part of a snapshot or receipt. */
export interface DesktopTaskCompletion {
	id: string;
	sessionId: string;
}

export type DesktopFrame =
	| { type: "response"; id: string; ok: true; result: unknown }
	| {
			type: "response";
			id: string;
			ok: false;
			error: string;
			deliveryDisposition?: "refused" | "failed" | "unknown";
			preferenceOutcome?: DesktopPreferenceOutcome;
			/** Set when the request was refused only because of who writes the conversation. */
			connectionRefusal?: DesktopConnectionRefusal;
	  }
	| { type: "snapshot"; snapshot: DesktopSnapshot }
	| { type: "session"; session: DesktopSession }
	| { type: "delivery"; receipt: DesktopDeliveryReceipt }
	| ({ type: "task-completed" } & DesktopTaskCompletion)
	| { type: "auth"; auth: DesktopAuthState }
	| { type: "activity"; update: DesktopActivityUpdate }
	| { type: "gate"; sessionId: string; event: DesktopGatePresentationEvent }
	| { type: "operator"; sessionId: string; event: DesktopOperatorEvent }
	| { type: "btw"; sessionId: string; sessionGeneration: number; event: DesktopBtwEvent }
	| { type: "fatal"; error: string };

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function parseRequest(line: string): DesktopRequest {
	if (new TextEncoder().encode(line).byteLength > MAX_FRAME_BYTES) throw new Error("Request exceeds frame limit");
	const value: unknown = JSON.parse(line);
	if (!value || typeof value !== "object") throw new Error("Invalid request");
	const request = value as Record<string, unknown>;
	if (
		typeof request.id !== "string" ||
		!request.id.length ||
		request.id.length > 128 ||
		typeof request.method !== "string" ||
		!DESKTOP_METHODS.includes(request.method as DesktopMethod) ||
		!request.params ||
		typeof request.params !== "object" ||
		Array.isArray(request.params)
	)
		throw new Error("Invalid request envelope");
	return request as unknown as DesktopRequest;
}
