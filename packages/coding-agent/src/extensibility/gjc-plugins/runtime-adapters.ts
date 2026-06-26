import * as path from "node:path";
import { loadCustomTools } from "../custom-tools/loader";
import type { CustomTool } from "../custom-tools/types";
import { loadEffectiveGjcPluginRegistry } from "./registry";
import { type SessionQuarantine, validateSessionBundles, verifyEntryHashes } from "./session-validation";

export interface AlwaysOnPluginTools {
	tools: CustomTool[];
	quarantine: SessionQuarantine[];
}

/**
 * Load the always-on plugin tool surfaces for the effective registry at `cwd`.
 *
 * Safety properties:
 * - Hash drift quarantines the plugin (runtime_mismatch) before any import.
 * - Session-start collisions vs reserved/built-in names quarantine fail-closed.
 * - Manifest-declared tool names are authoritative: a factory that returns a
 *   different/extra/missing name is rejected with runtime_mismatch and skipped.
 * - Reserved tool names are never overwritten.
 *
 * Returns an empty result when no plugins are installed, so callers that always
 * call this in `createAgentSession` incur no behavior change without plugins.
 */
export async function loadAlwaysOnPluginTools(input: {
	cwd: string;
	reservedToolNames: string[];
}): Promise<AlwaysOnPluginTools> {
	const effective = await loadEffectiveGjcPluginRegistry(input.cwd);
	if (effective.length === 0) return { tools: [], quarantine: [] };

	// Hash-drift quarantine before importing any plugin code.
	const preQuarantine: SessionQuarantine[] = [];
	for (const entry of effective) {
		if (!entry.enabled) continue;
		const drift = await verifyEntryHashes(entry);
		if (drift) preQuarantine.push(drift);
	}

	const reserved = new Set(input.reservedToolNames);
	const { active, quarantine } = validateSessionBundles(
		effective,
		{ toolNames: input.reservedToolNames },
		preQuarantine,
	);

	// Map declared (path -> name) for every active always-on tool surface.
	const declared = new Map<string, { name: string; plugin: string }>();
	for (const entry of active) {
		const disabled = new Set(entry.disabledSurfaceIds);
		for (const t of entry.surfaces.tools) {
			if (disabled.has(t.extensionId)) continue;
			declared.set(path.join(entry.pluginRoot, t.relativePath), { name: t.name, plugin: entry.name });
		}
	}
	if (declared.size === 0) return { tools: [], quarantine };

	const loaded = await loadCustomTools(
		[...declared.keys()].map(p => ({ path: p })),
		input.cwd,
		input.reservedToolNames,
	);

	// Group loaded tools by their source path for exact-name verification.
	const byPath = new Map<string, string[]>();
	for (const lt of loaded.tools) {
		const key = path.resolve(lt.path);
		const list = byPath.get(key) ?? [];
		list.push(lt.tool.name);
		byPath.set(key, list);
	}

	const tools: CustomTool[] = [];
	const seenNames = new Set<string>(reserved);
	for (const [declaredPath, info] of declared) {
		const returned = byPath.get(path.resolve(declaredPath)) ?? [];
		// Manifest is authoritative: exactly the one declared name must come back.
		if (returned.length !== 1 || returned[0] !== info.name) {
			quarantine.push({
				plugin: info.plugin,
				surfaceId: `tool:${info.name}`,
				code: "runtime_mismatch",
				message: `Tool factory returned ${JSON.stringify(returned)}, expected exactly ["${info.name}"]`,
			});
			continue;
		}
		if (seenNames.has(info.name)) {
			// Defense in depth: never overwrite a reserved/earlier name.
			quarantine.push({
				plugin: info.plugin,
				surfaceId: `tool:${info.name}`,
				code: "session_collision",
				message: `Tool name "${info.name}" already present; refusing to overwrite`,
			});
			continue;
		}
		const match = loaded.tools.find(lt => path.resolve(lt.path) === path.resolve(declaredPath));
		if (match) {
			tools.push(match.tool);
			seenNames.add(info.name);
		}
	}
	return { tools, quarantine };
}

/**
 * Render the always-on system-appendix blocks for the effective registry at
 * `cwd`, applying hash-drift + collision quarantine first. Returns "" when no
 * plugins are installed/enabled. Safe to call unconditionally at session start.
 */
export async function renderAlwaysOnSystemAppendices(input: { cwd: string }): Promise<string> {
	const effective = await loadEffectiveGjcPluginRegistry(input.cwd);
	if (effective.length === 0) return "";
	const preQuarantine: SessionQuarantine[] = [];
	for (const entry of effective) {
		if (!entry.enabled) continue;
		const drift = await verifyEntryHashes(entry);
		if (drift) preQuarantine.push(drift);
	}
	const { active } = validateSessionBundles(effective, {}, preQuarantine);
	const { renderPluginAppendices } = await import("./prompt-appendix");
	return (await renderPluginAppendices(active)).system;
}

/**
 * Render the agent-appendix block and Tier-1 sub-skill advertisement for a role
 * agent at session/spawn time. Hash-drift + collision quarantine applied first.
 * Returns empty strings when nothing applies.
 */
export async function renderAgentPromptAdditions(input: {
	cwd: string;
	agentName: string;
}): Promise<{ appendix: string; advertisement: string }> {
	const effective = await loadEffectiveGjcPluginRegistry(input.cwd);
	if (effective.length === 0) return { appendix: "", advertisement: "" };
	const preQuarantine: SessionQuarantine[] = [];
	for (const entry of effective) {
		if (!entry.enabled) continue;
		const drift = await verifyEntryHashes(entry);
		if (drift) preQuarantine.push(drift);
	}
	const { active } = validateSessionBundles(effective, {}, preQuarantine);
	const { renderPluginAppendices } = await import("./prompt-appendix");
	const { buildAgentSubskillAdvertisement } = await import("./injection");
	const rendered = await renderPluginAppendices(active);
	return {
		appendix: rendered.byAgent.get(input.agentName as never) ?? "",
		advertisement: buildAgentSubskillAdvertisement(active, input.agentName),
	};
}

/**
 * Render the Tier-1 sub-skill advertisement for a workflow parent skill.
 * Returns "" when nothing applies. Quarantine applied first.
 */
export async function renderSkillAdvertisement(input: {
	cwd: string;
	skillName: string;
	phase?: string;
}): Promise<string> {
	const effective = await loadEffectiveGjcPluginRegistry(input.cwd);
	if (effective.length === 0) return "";
	const preQuarantine: SessionQuarantine[] = [];
	for (const entry of effective) {
		if (!entry.enabled) continue;
		const drift = await verifyEntryHashes(entry);
		if (drift) preQuarantine.push(drift);
	}
	const { active } = validateSessionBundles(effective, {}, preQuarantine);
	const { buildSubskillAdvertisement } = await import("./injection");
	return buildSubskillAdvertisement(active, input.skillName, input.phase);
}

/**
 * Convert active plugin-bundle MCP surfaces into runtime MCPServerConfig entries,
 * applying install + runtime MCP policy (URL scheme/private-range deny, DNS
 * re-resolution for http/sse, stdio root-confinement) before connection. Servers
 * failing policy are quarantined and excluded. Returns {} when none.
 */
export async function buildPluginMcpConfigs(input: { cwd: string }): Promise<{
	configs: Record<string, any>;
	quarantine: SessionQuarantine[];
}> {
	const effective = await loadEffectiveGjcPluginRegistry(input.cwd);
	if (effective.length === 0) return { configs: {}, quarantine: [] };
	const preQuarantine: SessionQuarantine[] = [];
	for (const entry of effective) {
		if (!entry.enabled) continue;
		const drift = await verifyEntryHashes(entry);
		if (drift) preQuarantine.push(drift);
	}
	const { active, quarantine } = validateSessionBundles(effective, {}, preQuarantine);
	const { assertMcpInstallPolicy, assertDnsResolvesPublic, assertUrlAllowed } = await import("./mcp-policy");
	const nodePath = await import("node:path");

	const configs: Record<string, any> = {};
	for (const entry of active) {
		const disabled = new Set(entry.disabledSurfaceIds);
		for (const m of entry.surfaces.mcps) {
			if (disabled.has(m.extensionId)) continue;
			const cfg = m.config;
			try {
				assertMcpInstallPolicy(cfg, { pluginRoot: entry.pluginRoot });
				if (cfg.transport === "stdio") {
					configs[m.name] = {
						type: "stdio",
						command: cfg.command,
						args: cfg.args,
						cwd: cfg.cwd ? nodePath.resolve(entry.pluginRoot, cfg.cwd) : entry.pluginRoot,
						// Third-party plugin MCP processes must not inherit host secrets;
						// only a minimal OS allowlist (PATH/HOME/temp/locale) is provided.
						noInheritEnv: true,
					};
				} else {
					const url = assertUrlAllowed(cfg.url ?? "", `MCP "${m.name}" url`);
					await assertDnsResolvesPublic(url.hostname, `MCP "${m.name}" host`);
					// Headers are intentionally NOT forwarded: the generic MCP config
					// resolution path expands ${env:...}/shell templates, which would let
					// a third-party bundle exfiltrate host secrets. Plugin-bundle MCP
					// servers connect without bundle-declared headers.
					configs[m.name] = { type: cfg.transport, url: cfg.url };
				}
			} catch (error) {
				quarantine.push({
					plugin: entry.name,
					surfaceId: m.extensionId,
					code: "security_policy",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return { configs, quarantine };
}
