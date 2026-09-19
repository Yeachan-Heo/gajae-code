import type { AgentSession } from "../session/agent-session";

const REDACTED = "<redacted>";
const SENSITIVE_KEY_PATTERN = /(?:token|secret|key|credential|password|authorization|auth|bearer|cookie|session)/i;

export function redactMCPEndpoint(value: string | undefined): string | undefined {
	if (!value) return value;
	try {
		const url = new URL(value);
		if (url.username) url.username = REDACTED;
		if (url.password) url.password = REDACTED;
		if (url.pathname !== "/") url.pathname = `/${REDACTED}`;
		for (const key of Array.from(url.searchParams.keys())) {
			url.searchParams.set(key, REDACTED);
		}
		url.hash = "";
		return url.toString();
	} catch {
		return REDACTED;
	}
}

export function redactMCPDiagnosticValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactMCPDiagnosticValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactMCPDiagnosticValue(entry),
		]),
	);
}

/**
 * Capability granted to a session that the root interactive entry point created
 * with an explicit `--mcp-config` path. Holding it is the only way to read exact
 * MCP status; it carries no manager, transport, or configuration reference.
 */
export interface ExactMcpControls {
	readonly grantSource: "root-interactive-exact-config";
	/**
	 * The exact config this session was started with. Status needs it because a
	 * tools-only manager deletes a server from its own bookkeeping when the
	 * connection fails, so the manager alone can never report a server that did
	 * not come up — the very case an operator runs `/mcp` to see.
	 */
	readonly configPath: string;
}

/**
 * Exact MCP capability lives in a revocable export-blocked leaf WeakMap.
 *
 * The registry lives in this module because the file is a dependency-free leaf
 * whose package subpath is blocked (`./runtime-mcp/*` is null in package.json
 * exports) and which no barrel re-exports, so nothing outside this package can
 * reach the map or mint a capability. Keep it that way: runtime imports here
 * must stay at zero and the session type is referenced with `import type` only.
 */
const exactMcpControlsBySession = new WeakMap<AgentSession, ExactMcpControls>();

export function attachExactMcpControls(session: AgentSession, controls: ExactMcpControls): void {
	exactMcpControlsBySession.set(session, controls);
}

export function getExactMcpControls(session: AgentSession): ExactMcpControls | undefined {
	return exactMcpControlsBySession.get(session);
}

/** Revoke controls when the AgentSession object adopts a new logical identity. */
export function revokeExactMcpControls(session: AgentSession): void {
	exactMcpControlsBySession.delete(session);
}
