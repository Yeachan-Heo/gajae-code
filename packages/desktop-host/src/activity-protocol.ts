/** Browser-safe wire DTOs. No backend SDK types or capability objects belong here. */
export interface DesktopActivityScope {
	sessionGeneration: string;
	connectionGeneration: string;
}

/** A reference into one controller's bounded view, never an SDK owner or control grant. */
export interface DesktopActivityRef extends DesktopActivityScope {
	key: string;
}

export type DesktopActivityOperation = "cancel" | "delete" | "stop" | "pause" | "resume";
export type DesktopActivityStatus = "running" | "paused" | "queued" | "completed" | "failed" | "cancelled";

interface DesktopActivityEntry {
	ref: DesktopActivityRef;
	id: string;
	controls: DesktopActivityOperation[];
	reason?: string;
}

export interface DesktopActivityJob extends DesktopActivityEntry {
	type: "job";
	kind: string;
	label: string;
	status: DesktopActivityStatus;
	backgrounded: boolean;
	deliveryState: "pending" | "delivered" | "failed-visible";
	outputAvailable: boolean;
	error?: string;
}

export interface DesktopActivityTask extends DesktopActivityEntry {
	type: "task";
	status: DesktopActivityStatus;
	requestedModel?: string;
	effectiveModel?: string;
}

export interface DesktopActivityCron extends DesktopActivityEntry {
	type: "cron";
	schedule: string;
	recurring: boolean;
	firing: boolean;
	nextFireAt?: number;
}

export interface DesktopActivityGateSummary {
	ref: DesktopActivityRef;
	kind: "question" | "approval" | "execution";
	stage: string;
	createdAt: string;
	/** The emitter advertises remote answers; getGate must present complete content first. */
	answerable: boolean;
	reason?: string;
}

export interface DesktopActivityGate extends DesktopActivityGateSummary {
	content: { title?: string; prompt?: string; summary?: string; plan?: string; source?: string; language?: string };
	/** Inert producer evidence references; never auto-fetched or treated as authority. */
	artifacts: Array<{ kind: string; path?: string; sha256?: string }>;
	/** Redacted display instructions only, never the backend validation schema. */
	schemaJson: string;
	/** Only original advertised values that validate as complete answers. */
	choices: Array<{ key: string; label: string; description?: string }>;
	/** Producer option labels can explain structured JSON answers without becoming action buttons. */
	optionLabels: Array<{ label: string; description?: string }>;
	truncated: boolean;
	maxAnswerBytes: number;
}

export type DesktopActivityGateAnswer =
	| { kind: "choice"; choiceKey: string }
	| { kind: "json"; json: string };

/** Accepted means the response was accepted, not that the user approved execution. */
export interface DesktopActivityGateAnswerResult {
	status: "accepted" | "rejected";
	reason?: string;
}

/** Scalar session summaries; answering is a separate explicit gate operation. */
export interface DesktopActivitySessionState {
	goal: { enabled: boolean; status: "active" | "paused" | "complete" | "dropped"; tokensUsed: number; timeUsedSeconds: number } | null;
	workflow: { skill: string } | null;
	gates:
		| { available: false; reason: string }
		| { available: true; pending: DesktopActivityGateSummary[]; truncated: boolean };
}

export type DesktopActivitySnapshot = DesktopActivityScope & {
	sessionState?: DesktopActivitySessionState;
} & (
	| { available: false; reason: string }
	| {
			available: true;
			jobs: DesktopActivityJob[];
			tasks: DesktopActivityTask[];
			crons: DesktopActivityCron[];
			truncated: { jobs: boolean; tasks: boolean; crons: boolean };
			activeMonitorCount: number;
			activeCronCount: number;
			worstState: "none" | "running" | "failed";
			failedUnacknowledged: boolean;
		}
);

export interface DesktopActivityDetail {
	entry: DesktopActivityJob | DesktopActivityTask | DesktopActivityCron;
	/** Only actual, readable monitor output; absent for all other activities. */
	output?: { text: string; truncated: boolean };
}

export type DesktopActivityErrorCode =
	| "unavailable"
	| "disposed"
	| "stale_session"
	| "stale_connection"
	| "invalid_reference"
	| "not_found"
	| "stale_generation"
	| "unsupported"
	| "control_busy"
	| "already_terminal"
	| "backend_failure"
	| "redaction_failed"
	| "invalid_answer"
	| "gate_not_presented"
	| "gate_busy"
	| "gate_content_too_large"
	| "gate_resolution_failed";
