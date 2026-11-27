/**
 * Session-local MCP controls are a root interactive CLI capability.
 *
 * The grant is an unforgeable token: only this module can mint one, and
 * `./runtime-mcp/*` is not a package export, so an SDK caller of
 * `createAgentSession` cannot request the capability by setting an option.
 */
const issuedGrants = new WeakSet<object>();

export interface SessionMcpControlGrant {
	readonly grantSource: "root-interactive-cli";
}

/** Mint a grant. Only the root interactive CLI entry point calls this. */
export function issueSessionMcpControlGrant(): SessionMcpControlGrant {
	const grant: SessionMcpControlGrant = Object.freeze({ grantSource: "root-interactive-cli" });
	issuedGrants.add(grant);
	return grant;
}

/** True only for a token minted by {@link issueSessionMcpControlGrant}. */
export function isIssuedSessionMcpControlGrant(value: unknown): value is SessionMcpControlGrant {
	return typeof value === "object" && value !== null && issuedGrants.has(value);
}
