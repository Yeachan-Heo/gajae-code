/** Browser-safe operator transport. This leaf deliberately has no SDK imports. */
export type DesktopOperatorKind = "bash" | "python";
export type DesktopOperatorStatus = "running" | "cancel_requested" | "completed" | "cancelled" | "failed";
export type DesktopOperatorErrorCode =
	| "invalid_input"
	| "busy"
	| "disposed"
	| "stale_session"
	| "session_transitioning"
	| "not_found"
	| "already_terminal"
	| "unsupported"
	| "backend_failure"
	| "redaction_failed";

export interface DesktopOperatorExecuteInput {
	/** Explicit TUI prefix: ! / !! for shell, $ / $$ for Python. */
	text: string;
}

export interface DesktopOperatorReference {
	operationId: string;
}

export interface DesktopOperatorOperation {
	operationId: string;
	connectionGeneration: string;
	sessionGeneration: number;
	kind: DesktopOperatorKind;
	excludeFromContext: boolean;
	status: DesktopOperatorStatus;
	/** Bounded, redacted plain text. Submitted command/code is not separately echoed. */
	output: string;
	outputTruncated: boolean;
	/** Without a host streaming redactor, content is withheld until SDK settlement. */
	liveOutput: "redacted" | "withheld";
	exitCode?: number;
	signal?: string;
	error?: { code: DesktopOperatorErrorCode; message: string };
}

export interface DesktopOperatorEvent {
	type: "operator.updated";
	operation: DesktopOperatorOperation;
}

export interface DesktopOperatorFoldResult {
	/** Not an operator operation: raw ! / !! executions are not managed tool folds. */
	target: "current_foreground_tool";
	status: "folded" | "already_backgrounded" | "unsupported";
}
