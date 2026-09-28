/** Provider-agnostic Code Mode policy and direct-tool partitioning. */

import { logger } from "@gajae-code/utils";

export type CodeModeSetting = "off" | "auto" | "on";

/**
 * Tools whose results participate in session/UI/control-plane state and should
 * remain directly visible instead of being wrapped inside an eval result.
 */
export const CODE_MODE_KEEP_TOOLS: ReadonlySet<string> = new Set([
	"eval",
	"ask",
	"task",
	"todo_write",
	"yield",
	"checkpoint",
	"rewind",
	"resolve",
	"skill",
	"skill_discovery",
	"goal",
	"move_session",
	"search_tool_bm25",
]);

export interface CodeModeResolution {
	active: boolean;
	directToolNames: Set<string>;
}

export function resolveCodeMode(args: {
	toolMode?: string;
	setting: CodeModeSetting;
	extraDirectTools?: readonly string[];
	enabledToolNames: readonly string[];
	evalTransportAvailable: boolean;
}): CodeModeResolution {
	const active =
		args.enabledToolNames.includes("eval") &&
		args.evalTransportAvailable &&
		(args.setting === "on" || (args.setting === "auto" && args.toolMode === "code_mode_only"));
	if (!active) return { active: false, directToolNames: new Set(args.enabledToolNames) };

	const directToolNames = new Set<string>();
	for (const name of args.enabledToolNames) {
		if (CODE_MODE_KEEP_TOOLS.has(name)) directToolNames.add(name);
	}
	for (const name of args.extraDirectTools ?? []) {
		if (args.enabledToolNames.includes(name)) directToolNames.add(name);
	}
	return { active: true, directToolNames };
}

/** codex-rs TurnToolFunctionInfo shape (snake_case on the wire). */
export interface ToolNamespaceFunctionInfo {
	name: string;
	direct: boolean;
	code_mode_name: string | null;
	deferred: boolean;
	source: { kind: "harness" } | { kind: "mcp"; server_name: string };
}

/** codex-rs TurnToolNamespacesInfo shape. */
export interface ToolNamespacesInfo {
	[namespace: string]: {
		name: string;
		functions: Record<string, ToolNamespaceFunctionInfo>;
	};
}

export function buildToolNamespacesInfo(args: {
	tools: ReadonlyArray<{ name: string; customWireName?: string; loadMode?: string; mcpServerName?: string }>;
	directToolNames: ReadonlySet<string>;
}): ToolNamespacesInfo {
	const functions: Record<string, ToolNamespaceFunctionInfo> = Object.create(null);
	for (const tool of args.tools) {
		const direct = args.directToolNames.has(tool.name);
		const wireName = direct ? (tool.customWireName ?? tool.name) : tool.name;
		const existing = functions[wireName];
		if (existing) {
			const existingExact = existing.code_mode_name === wireName;
			const candidateExact = tool.name === wireName;
			const replace = direct && (!existing.direct || (candidateExact && !existingExact));
			logger.warn("Code Mode wire name collision", {
				wireName,
				kept: replace ? tool.name : existing.code_mode_name,
				dropped: replace ? existing.code_mode_name : tool.name,
			});
			if (!replace) continue;
		}
		functions[wireName] = {
			name: wireName,
			direct,
			code_mode_name: tool.name,
			deferred: tool.loadMode === "discoverable",
			source: tool.mcpServerName ? { kind: "mcp", server_name: tool.mcpServerName } : { kind: "harness" },
		};
	}
	return { functions: { name: "functions", functions } };
}
