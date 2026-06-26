import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GjcPluginLoadErrorCode, GjcPluginRegistryEntry } from "./types";

/**
 * Session-start validation: the registry is the collision authority. Capability
 * provider output is supplied as EVIDENCE only; plugin surfaces are never
 * resolved by capability first-wins. Offending surfaces are quarantined
 * fail-closed with a stable error code rather than silently shadowed.
 */

export interface SessionCapabilityEvidence {
	/** Built-in + provider tool names already present before plugin insertion. */
	toolNames?: Iterable<string>;
	/** Non-plugin MCP server names from providers/built-ins. */
	mcpNames?: Iterable<string>;
	/** Non-plugin hook keys (event:phase:target:name) from providers/built-ins. */
	hookKeys?: Iterable<string>;
	/** Existing appendix extension ids already present. */
	appendixIds?: Iterable<string>;
}

export interface SessionQuarantine {
	plugin: string;
	surfaceId: string;
	code: GjcPluginLoadErrorCode;
	message: string;
}

export interface SessionValidationResult {
	/** Registry entries (enabled, non-quarantined) whose surfaces may activate. */
	active: GjcPluginRegistryEntry[];
	/** Per-surface quarantine records (fail-closed). */
	quarantine: SessionQuarantine[];
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

/**
 * Re-verify that the installed files still match the registry's recorded hashes.
 * Drift (manual edits, partial writes) quarantines the whole plugin with
 * runtime_mismatch.
 */
export async function verifyEntryHashes(entry: GjcPluginRegistryEntry): Promise<SessionQuarantine | null> {
	for (const file of entry.copiedFiles) {
		const abs = path.join(entry.pluginRoot, file.relativePath);
		let buf: Buffer;
		try {
			buf = await fs.readFile(abs);
		} catch {
			return {
				plugin: entry.name,
				surfaceId: `plugin:${entry.name}`,
				code: "runtime_mismatch",
				message: `Installed file missing: ${file.relativePath}`,
			};
		}
		if (sha256(buf) !== file.sha256) {
			return {
				plugin: entry.name,
				surfaceId: `plugin:${entry.name}`,
				code: "runtime_mismatch",
				message: `Installed file hash drift: ${file.relativePath}`,
			};
		}
	}
	return null;
}

function activeSurfaceIds(entry: GjcPluginRegistryEntry): {
	tools: { id: string; name: string }[];
	mcps: { id: string; name: string }[];
	hooks: { id: string }[];
	appendices: { id: string }[];
} {
	const disabled = new Set(entry.disabledSurfaceIds);
	return {
		tools: entry.surfaces.tools
			.filter(t => !disabled.has(t.extensionId))
			.map(t => ({ id: t.extensionId, name: t.name })),
		mcps: entry.surfaces.mcps
			.filter(m => !disabled.has(m.extensionId))
			.map(m => ({ id: m.extensionId, name: m.name })),
		hooks: entry.surfaces.hooks.filter(h => !disabled.has(h.extensionId)).map(h => ({ id: h.extensionId })),
		appendices: [...entry.surfaces.systemAppendices, ...entry.surfaces.agentAppendices]
			.filter(a => !disabled.has(a.extensionId))
			.map(a => ({ id: a.extensionId })),
	};
}

/**
 * Validate the effective installed registry against the current capability
 * universe (evidence) and across plugins. Returns the entries that may activate
 * plus per-surface quarantine records. Disabled entries/surfaces are skipped
 * (not an error).
 */
export function validateSessionBundles(
	entries: readonly GjcPluginRegistryEntry[],
	evidence: SessionCapabilityEvidence = {},
	preQuarantined: readonly SessionQuarantine[] = [],
): SessionValidationResult {
	const quarantine: SessionQuarantine[] = [...preQuarantined];
	const quarantinedPlugins = new Set(preQuarantined.map(q => q.plugin));

	const seenTools = new Set<string>(evidence.toolNames ?? []);
	const seenMcps = new Set<string>(evidence.mcpNames ?? []);
	const seenHooks = new Set<string>(evidence.hookKeys ?? []);
	const seenAppendices = new Set<string>(evidence.appendixIds ?? []);

	const active: GjcPluginRegistryEntry[] = [];
	for (const entry of entries) {
		if (!entry.enabled) continue; // user-disabled, not an error
		if (quarantinedPlugins.has(entry.name)) continue;
		const surfaces = activeSurfaceIds(entry);
		let collided = false;
		const recordCollision = (surfaceId: string, what: string): void => {
			collided = true;
			quarantine.push({
				plugin: entry.name,
				surfaceId,
				code: "session_collision",
				message: `${what} collides with an existing capability/plugin; fail-closed (no shadowing)`,
			});
		};
		for (const t of surfaces.tools) if (seenTools.has(t.name)) recordCollision(t.id, `tool "${t.name}"`);
		for (const m of surfaces.mcps) if (seenMcps.has(m.name)) recordCollision(m.id, `mcp "${m.name}"`);
		for (const h of surfaces.hooks) if (seenHooks.has(h.id)) recordCollision(h.id, `hook "${h.id}"`);
		for (const a of surfaces.appendices) if (seenAppendices.has(a.id)) recordCollision(a.id, `appendix "${a.id}"`);

		if (collided) {
			// Fail-closed for the whole plugin entry so partial activation cannot
			// leave a half-applied bundle.
			continue;
		}
		// Reserve this plugin's surfaces so a later plugin colliding with it is
		// also caught (deterministic order => earlier plugin wins reservation).
		for (const t of surfaces.tools) seenTools.add(t.name);
		for (const m of surfaces.mcps) seenMcps.add(m.name);
		for (const h of surfaces.hooks) seenHooks.add(h.id);
		for (const a of surfaces.appendices) seenAppendices.add(a.id);
		active.push(entry);
	}
	return { active, quarantine };
}
