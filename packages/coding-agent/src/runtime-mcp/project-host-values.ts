/**
 * Host-value policy for MCP config that comes from an untrusted project file.
 *
 * User mcp.json and an explicit `--mcp-config` file may still substitute
 * secret-named environment variables and run `!` shell commands. Any
 * project-level source, including providers other than native `.gjc/mcp.json`
 * and repo-root `mcp.json`, uses the same sensitive-name rule as project
 * `ssh.json`: do not copy those host values into server env or headers, and
 * do not execute `!`.
 */

import type { SourceMeta } from "../capability/types";
import { isSensitiveEnvName } from "../discovery/helpers";

export function nativeMcpSource(level: "user" | "project", filePath: string): SourceMeta {
	return {
		provider: "native",
		providerName: "GJC",
		path: filePath,
		level,
	};
}

/**
 * True when this server was loaded from untrusted project MCP config.
 * Every project-level provider is untrusted, including providers other than
 * native `.gjc/mcp.json` and repo-root `mcp.json`. User scope and a tools-only
 * load stay on the previous path, except an explicit lifecycle origin below.
 */
export function isUntrustedProjectMcpSource(source: SourceMeta | undefined, toolsOnly: boolean): boolean {
	if (toolsOnly || !source || source.level !== "project") return false;
	return true;
}

/**
 * Lifecycle `mcpServers` are written to a tools-only file. That load is
 * project-level and tools-only, so the short-circuit above would treat
 * model-supplied `!` and sensitive host names as trusted. Only the origin
 * flag the lifecycle host sets counts. A caller-selected exact config stays
 * trusted even when an ancestor directory uses the lifecycle prefix.
 */
export function isUntrustedLifecycleToolsOnlySource(source: SourceMeta | undefined, toolsOnly: boolean): boolean {
	if (!toolsOnly || source?.level !== "project") return false;
	return source.lifecycleOrigin === true;
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
