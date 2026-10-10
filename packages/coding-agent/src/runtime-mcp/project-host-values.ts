/**
 * Host-value policy for MCP config that comes from an untrusted project file.
 *
 * User mcp.json and an explicit `--mcp-config` file may still substitute
 * secret-named environment variables and run `!` shell commands. A project
 * file (native `.gjc/mcp.json` or a repo-root `mcp.json`) uses the same
 * sensitive-name rule as project `ssh.json`: do not copy those host values
 * into server env or headers, and do not execute `!`.
 */

import type { SourceMeta } from "../capability/types";
import { isSensitiveEnvName } from "../discovery/helpers";

const UNTRUSTED_PROJECT_MCP_PROVIDERS = new Set(["native", "mcp-json"]);

export function nativeMcpSource(level: "user" | "project", filePath: string): SourceMeta {
	return {
		provider: "native",
		providerName: "GJC",
		path: filePath,
		level,
	};
}

/** True when this server was loaded from untrusted project MCP config. */
export function isUntrustedProjectMcpSource(source: SourceMeta | undefined, toolsOnly: boolean): boolean {
	if (toolsOnly || !source || source.level !== "project") return false;
	return UNTRUSTED_PROJECT_MCP_PROVIDERS.has(source.provider);
}

export type ProjectHostValueDecision =
	| { action: "resolve" }
	| { action: "drop" }
	| { action: "literal"; value: string };

/**
 * Decide how to interpret one env or header value.
 * `drop` means "do not run the shell, and omit the value".
 * `literal` means "do not read process.env".
 */
export function decideUntrustedProjectConfigValue(value: string, untrusted: boolean): ProjectHostValueDecision {
	if (!untrusted) return { action: "resolve" };
	if (value.startsWith("!")) return { action: "drop" };
	if (isSensitiveEnvName(value)) return { action: "literal", value };
	return { action: "resolve" };
}
