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
	const marketplaceRoot = path.join(projectRoot, "plugins");
	const pluginDir = path.join(marketplaceRoot, "gajae-code");
	const repo = flags.repo && flags.repo.trim().length > 0 ? flags.repo.trim() : NAMESPACE_LABEL;

	// Concrete, fail-closed env: workdir allowlist is the project root, no mutations.
	const env: Record<string, string> = {
		GJC_COORDINATOR_MCP_WORKDIR_ROOTS: projectRoot,
		GJC_COORDINATOR_MCP_REPO: repo,
		GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
	};

	if (host === "claude") {
		const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
		const marketplacePath = path.join(marketplaceRoot, ".claude-plugin", "marketplace.json");
		return {
			ok: true,
			host,
			mode: "render",
			gated: false,
			pluginPath: marketplaceRoot,
			manifestPath,
			marketplacePath,
			installGuidance: [
				`Add the local marketplace: /plugin marketplace add ${marketplaceRoot}`,
				"Install the plugin: /plugin install gajae-code",
				"Then call gjc_delegate_plan / gjc_delegate_execute / gjc_delegate_team from Claude Code.",
			],
			coordinatorConfigPreview: { command: "gjc", args: ["mcp-serve", "coordinator"], env },
			mutationPolicy:
				"Fail-closed: delegation is read-only until you set GJC_COORDINATOR_MCP_MUTATIONS=sessions and pass allow_mutation:true per call.",
			notes: [],
			...(flags.check
				? { check: verifyBundleFiles([manifestPath, marketplacePath, path.join(pluginDir, ".mcp.json")]) }
				: {}),
		};
	}

	// Codex: verified installable on Codex CLI 0.139.0 via the local marketplace smoke.
	const manifestPath = path.join(pluginDir, ".codex-plugin", "plugin.json");
	const marketplacePath = path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
	return {
		ok: true,
		host,
		mode: "render",
		gated: false,
		pluginPath: marketplaceRoot,
		manifestPath,
		marketplacePath,
		installGuidance: [
			`Add the local marketplace: codex plugin marketplace add ${marketplaceRoot}`,
			"Install the plugin: codex plugin add gajae-code@gajae-code-local",
			"Then call gjc_delegate_plan / gjc_delegate_execute / gjc_delegate_team from Codex.",
		],
		coordinatorConfigPreview: { command: "gjc", args: ["mcp-serve", "coordinator"], env },
		mutationPolicy:
			"Fail-closed: delegation is read-only until you set GJC_COORDINATOR_MCP_MUTATIONS=sessions and pass allow_mutation:true per call.",
		notes: [
			"Verified on Codex CLI 0.139.0: marketplace add + plugin add install the plugin (enabled) and `codex mcp list` registers gjc-coordinator with the fail-closed env.",
			"The bundled .codex.mcp.json workdir root is host-neutral; `gjc setup codex` renders a concrete root, and operators should re-run the local marketplace smoke on their target Codex version.",
		],
		...(flags.check
			? {
					check: verifyBundleFiles([
						manifestPath,
						marketplacePath,
						path.join(pluginDir, ".codex.mcp.json"),
						path.join(pluginDir, "skills", "gjc-delegation", "SKILL.md"),
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
