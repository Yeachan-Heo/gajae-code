/** Browser-only DTOs. No SDK types, configuration, credentials, or manager targets. */
export type DesktopMcpAction = "suspend" | "resume" | "reconnect";

export type DesktopMcpErrorCode =
	| "invalid_input" | "unavailable" | "disposed" | "stale_session" | "session_transitioning"
	| "stale_connection" | "not_found" | "stale_target" | "busy" | "unsupported"
	| "unknown_effect" | "backend_failure" | "redaction_failed";

export interface DesktopMcpScope {
	connectionGeneration: string;
	sessionGeneration: number;
}

/** Connection-local view identity, never an SDK capability. */
export interface DesktopMcpRef extends DesktopMcpScope {
	key: string;
}

export interface DesktopMcpServer {
	ref: DesktopMcpRef;
	label: string;
	state: "connected" | "connecting" | "disconnected" | "suspended" | "unknown";
	transport: "stdio" | "http" | "sse" | "unknown";
	sharing: "shared" | "per-session" | "unknown";
	toolCount: number;
	controls: DesktopMcpAction[];
}

export interface DesktopMcpSnapshot extends DesktopMcpScope {
	available: boolean;
	/** Controls affect the captured factory manager, which can be shared by sessions. */
	scope: "factory_manager_may_be_shared";
	servers: DesktopMcpServer[];
	truncated: boolean;
	error?: { code: DesktopMcpErrorCode; message: string };
}

export interface DesktopMcpOperationResult {
	/** Manager connection/catalog effect only; not remote or session-registry settlement. */
	status: "suspended" | "resumed" | "reconnected";
	cleanup: "not_certified";
	snapshot: DesktopMcpSnapshot;
}
