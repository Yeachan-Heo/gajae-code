export const GJC_RESTRICTED_ROLE_AGENT_BASH_ENV = "GJC_RESTRICTED_ROLE_AGENT_BASH";

export function isRestrictedRoleAgentBash(): boolean {
	return process.env[GJC_RESTRICTED_ROLE_AGENT_BASH_ENV] === "1";
}
