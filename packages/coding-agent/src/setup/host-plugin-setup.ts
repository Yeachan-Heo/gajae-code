/**
 * Host plugin setup for `gjc setup claude` and `gjc setup codex`.
 *
 * Renders install guidance and a fail-closed coordinator MCP config preview for
 * the canonical generated plugin bundle under `plugins/`. This is intentionally
 * render-only and fail-closed: the workdir allowlist is scoped to the project
 * root and no mutation class is enabled until the user opts in.
 */

import * as path from "node:path";
import { getProjectDir } from "@gajae-code/utils";

export type HostPluginKind = "claude" | "codex";

export interface HostPluginSetupFlags {
	json?: boolean;
	check?: boolean;
	root?: string[];
	repo?: string;
}

export interface HostPluginSetupResult {
	ok: true;
	host: HostPluginKind;
	mode: "render";
	gated: boolean;
	pluginPath: string;
	manifestPath: string;
	marketplacePath: string;
	installGuidance: string[];
	coordinatorConfigPreview: {
		command: string;
		args: string[];
		env: Record<string, string>;
	};
	mutationPolicy: string;
	notes: string[];
}

const NAMESPACE_LABEL = "gajae-code-plugin";

function resolveProjectRoot(flags: HostPluginSetupFlags): string {
	const explicit = flags.root?.find(root => root.trim().length > 0);
	return explicit ? path.resolve(explicit) : getProjectDir();
}

export function buildHostPluginSetup(host: HostPluginKind, flags: HostPluginSetupFlags = {}): HostPluginSetupResult {
	const projectRoot = resolveProjectRoot(flags);
	const pluginPath = path.join(projectRoot, "plugins");
	const repo = flags.repo && flags.repo.trim().length > 0 ? flags.repo.trim() : NAMESPACE_LABEL;

	// Concrete, fail-closed env: workdir allowlist is the project root, no mutations.
	const env: Record<string, string> = {
		GJC_COORDINATOR_MCP_WORKDIR_ROOTS: projectRoot,
		GJC_COORDINATOR_MCP_REPO: repo,
		GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
	};

	if (host === "claude") {
		const manifestPath = path.join(pluginPath, ".claude-plugin", "plugin.json");
		const marketplacePath = path.join(pluginPath, ".claude-plugin", "marketplace.json");
		return {
			ok: true,
			host,
			mode: "render",
			gated: false,
			pluginPath,
			manifestPath,
			marketplacePath,
			installGuidance: [
				`Add the local marketplace: /plugin marketplace add ${marketplacePath}`,
				"Install the plugin: /plugin install gajae-code",
				"Then call gjc_delegate_plan / gjc_delegate_execute / gjc_delegate_team from Claude Code.",
			],
			coordinatorConfigPreview: { command: "gjc", args: ["mcp-serve", "coordinator"], env },
			mutationPolicy:
				"Fail-closed: delegation is read-only until you set GJC_COORDINATOR_MCP_MUTATIONS=sessions and pass allow_mutation:true per call.",
			notes: [],
		};
	}

	// Codex is gated on a versioned local marketplace smoke.
	const manifestPath = path.join(pluginPath, ".codex-plugin", "plugin.json");
	const marketplacePath = path.join(pluginPath, "codex-marketplace.json");
	return {
		ok: true,
		host,
		mode: "render",
		gated: true,
		pluginPath,
		manifestPath,
		marketplacePath,
		installGuidance: [
			`Add the local marketplace: codex plugin marketplace add ${pluginPath}`,
			"Install the plugin: codex plugin install gajae-code",
			"Then call gjc_delegate_plan / gjc_delegate_execute / gjc_delegate_team from Codex.",
		],
		coordinatorConfigPreview: { command: "gjc", args: ["mcp-serve", "coordinator"], env },
		mutationPolicy:
			"Fail-closed: delegation is read-only until you set GJC_COORDINATOR_MCP_MUTATIONS=sessions and pass allow_mutation:true per call.",
		notes: [
			"Codex acceptance is gated on a versioned local marketplace smoke: record the Codex version and confirm `tools/list` exposes the three delegate tools before claiming Codex support.",
			"If the target Codex version rejects the shared mcpServers .mcp.json wrapper, emit a Codex-specific root MCP file only after the smoke verifies the accepted shape.",
		],
	};
}

export function formatHostPluginSetup(result: HostPluginSetupResult): string {
	const lines: string[] = [];
	lines.push(`host: ${result.host}${result.gated ? " (gated on versioned smoke)" : ""}`);
	lines.push(`plugin: ${result.pluginPath}`);
	lines.push("install:");
	for (const step of result.installGuidance) lines.push(`  - ${step}`);
	lines.push(`mcp: ${result.coordinatorConfigPreview.command} ${result.coordinatorConfigPreview.args.join(" ")}`);
	lines.push(`  GJC_COORDINATOR_MCP_WORKDIR_ROOTS=${result.coordinatorConfigPreview.env.GJC_COORDINATOR_MCP_WORKDIR_ROOTS}`);
	lines.push(result.mutationPolicy);
	for (const note of result.notes) lines.push(`note: ${note}`);
	return lines.join("\n");
}
