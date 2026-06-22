/**
 * Host plugin setup for `gjc setup claude` and `gjc setup codex`.
 *
 * Renders install guidance and a fail-closed coordinator MCP config preview for
 * the canonical generated plugin bundle under `plugins/`. This is intentionally
 * render-only and fail-closed: the workdir allowlist is scoped to the project
 * root and no mutation class is enabled until the user opts in.
 */

import * as fs from "node:fs";
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
	check?: { ok: boolean; checked: string[]; missing: string[] };
}

const NAMESPACE_LABEL = "gajae-code-plugin";

function resolveProjectRoot(flags: HostPluginSetupFlags): string {
	const explicit = flags.root?.find(root => root.trim().length > 0);
	return explicit ? path.resolve(explicit) : getProjectDir();
}

function verifyBundleFiles(files: string[]): { ok: boolean; checked: string[]; missing: string[] } {
	const missing = files.filter(file => !fs.existsSync(file));
	return { ok: missing.length === 0, checked: files, missing };
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
			...(flags.check
				? {
						check: verifyBundleFiles([
							manifestPath,
							marketplacePath,
							path.join(pluginPath, ".claude-plugin", ".mcp.json"),
							path.join(pluginPath, ".claude-plugin", "commands", "delegate_execute.md"),
							path.join(pluginPath, ".claude-plugin", "skills", "gjc-delegation", "SKILL.md"),
						]),
					}
				: {}),
		};
	}

	// Codex remains preview-only until the operator proves the target Codex build
	// can install and activate personal marketplace plugins at runtime.
	const manifestPath = path.join(pluginPath, ".codex-plugin", "plugin.json");
	const marketplacePath = path.join(pluginPath, ".agents", "plugins", "marketplace.json");
	return {
		ok: true,
		host,
		mode: "render",
		gated: true,
		pluginPath,
		manifestPath,
		marketplacePath,
		installGuidance: [
			`Preview the documented personal marketplace file: ${marketplacePath}`,
			"Do not run `codex plugin install gajae-code`; this setup is fail-closed until a versioned Codex smoke proves install and runtime activation for the target build.",
			"Smoke by registering the personal marketplace, then confirm a fresh Codex runtime exposes gjc_delegate_plan / gjc_delegate_execute / gjc_delegate_team before claiming support.",
		],
		coordinatorConfigPreview: { command: "gjc", args: ["mcp-serve", "coordinator"], env },
		mutationPolicy:
			"Fail-closed: delegation is read-only until you set GJC_COORDINATOR_MCP_MUTATIONS=sessions and pass allow_mutation:true per call.",
		notes: [
			"Codex setup is preview-only: generated files follow the documented ~/.agents/plugins/marketplace.json personal marketplace shape and plugin.json uses mcp_servers, but runtime install/activation is not claimed without a versioned local smoke.",
			"The legacy top-level plugins/codex-marketplace.json is generated only as a compatibility copy of the documented .agents/plugins marketplace file.",
		],
		...(flags.check
			? {
					check: verifyBundleFiles([
						manifestPath,
						marketplacePath,
						path.join(pluginPath, "codex-marketplace.json"),
						path.join(pluginPath, ".codex.mcp.json"),
						path.join(pluginPath, "skills", "gjc-delegation", "SKILL.md"),
					]),
				}
			: {}),
	};
}

export function formatHostPluginSetup(result: HostPluginSetupResult): string {
	const lines: string[] = [];
	lines.push(`host: ${result.host}${result.gated ? " (gated on versioned smoke)" : ""}`);
	lines.push(`plugin: ${result.pluginPath}`);
	lines.push("install:");
	for (const step of result.installGuidance) lines.push(`  - ${step}`);
	lines.push(`mcp: ${result.coordinatorConfigPreview.command} ${result.coordinatorConfigPreview.args.join(" ")}`);
	lines.push(
		`  GJC_COORDINATOR_MCP_WORKDIR_ROOTS=${result.coordinatorConfigPreview.env.GJC_COORDINATOR_MCP_WORKDIR_ROOTS}`,
	);
	lines.push(result.mutationPolicy);
	for (const note of result.notes) lines.push(`note: ${note}`);
	return lines.join("\n");
}
