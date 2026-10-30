import type { ThinkingControlMode } from "@gajae-code/ai/thinking-types";
import type { ThinkingLevelMetadata } from "@gajae-code/coding-agent/thinking-metadata";
import type { DesktopActivitySnapshot } from "./activity-protocol";
import type { DesktopBtwEvent } from "./btw-protocol";
import type { DesktopGatePresentationEvent } from "./gate-presentation-protocol";
import type { DesktopOperatorEvent } from "./operator-protocol";

export const PROTOCOL_VERSION = 1;

export const DESKTOP_METHODS = [
	"bootstrap",
	"project.open",
	"session.create",
	"session.select",
	"session.rename",
	"session.delete",
	"session.star",
	"session.fork",
	"session.compact",
	"session.retry",
	"session.export",
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
	"history.get",
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
	"queue.cancel",
	"delivery.ack",
	"diff.get",
	"tools.list",
	"tools.set",
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
	blocks?: DesktopMessageBlock[];
	role: "user" | "assistant" | "tool" | "system";
	text: string;
	toolName?: string;
	/** User execution remains visible but is omitted from model context. */
	excludeFromContext?: boolean;
	cancelled?: boolean;
	isError?: boolean;
	truncated?: boolean;
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
export type DesktopThinkingLevel = ThinkingLevelMetadata["value"];
export type DesktopThinkingMode = ThinkingControlMode | "toggle" | "always-on";
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
export interface DesktopSession {
	id: string;
	projectId: string;
	title: string;
	/**
	 * `done` means at least one visible message exists and the session is otherwise settled
	 * (not busy, waiting on an answer/gate, or failed); a never-used session stays `idle`.
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
	/** Present on host projections, including unavailable unopened/no-model sessions. */
	thinking?: DesktopThinking;
	messages: DesktopMessage[];
	historyTruncated?: boolean;
	question?: DesktopQuestion;
	/** Last failed prompt turn for this conversation; administrative refusals answer their request instead. */
	error?: string;
	errorOwner?: string;
}

export type DesktopForkResult =
	| { cancelled: true }
	| { cancelled: false; session: DesktopSession; selectedText: string };

export interface DesktopProject {
	id: string;
	name: string;
	path: string;
}
export interface DesktopModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	reasoning: boolean;
	/** Concrete model choices exclude inherit; only session thinking controls inherit. */
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
export interface DesktopAuthProvider {
	id: string;
	name: string;
	configured?: boolean;
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
	prompt?: { id: string; message: string; placeholder?: string; allowEmpty?: boolean };
	error?: string;
}
export interface DesktopActivityUpdate {
	sessionId: string;
	/** Monotonic within the host's live catalog binding, not an SDK atomicity receipt. */
	revision: number;
	activity: DesktopActivitySnapshot;
}
export type DesktopFrame =
	| { type: "response"; id: string; ok: true; result: unknown }
	| { type: "response"; id: string; ok: false; error: string; deliveryDisposition?: "refused" | "failed" | "unknown" }
	| { type: "snapshot"; snapshot: DesktopSnapshot }
	| { type: "session"; session: DesktopSession }
	| { type: "delivery"; receipt: DesktopDeliveryReceipt }
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
