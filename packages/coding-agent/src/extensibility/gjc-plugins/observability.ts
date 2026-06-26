import { loadEffectiveGjcPluginRegistry } from "./registry";
import { type SessionQuarantine, validateSessionBundles, verifyEntryHashes } from "./session-validation";
import type { GjcPluginRegistryEntry, GjcPluginScope } from "./types";

/**
 * Observability for GJC plugin bundle surfaces, consumable by the extension
 * dashboard / state manager. Each surface row carries its stable extension id,
 * owning plugin, scope, source kind, enabled/disabled/quarantined status, and a
 * content hash. MCP auth/header values are NEVER included.
 */

export type PluginSurfaceStatus = "enabled" | "disabled" | "quarantined";

export interface PluginSurfaceRow {
	extensionId: string;
	kind: "tool" | "hook" | "mcp" | "system-appendix" | "agent-appendix" | "subskill";
	plugin: string;
	scope: GjcPluginScope;
	sourceKind: GjcPluginRegistryEntry["source"]["kind"];
	status: PluginSurfaceStatus;
	hash: string;
	quarantineCode?: string;
}

export interface PluginObservabilitySummary {
	plugins: number;
	surfaces: PluginSurfaceRow[];
}

function statusFor(
	entry: GjcPluginRegistryEntry,
	extensionId: string,
	quarantinedIds: Map<string, string>,
): { status: PluginSurfaceStatus; quarantineCode?: string } {
	const q =
		quarantinedIds.get(`${entry.name}\u0000${extensionId}`) ??
		quarantinedIds.get(`${entry.name}\u0000plugin:${entry.name}`);
	if (q) return { status: "quarantined", quarantineCode: q };
	if (!entry.enabled || entry.disabledSurfaceIds.includes(extensionId)) return { status: "disabled" };
	return { status: "enabled" };
}

function rowsForEntry(entry: GjcPluginRegistryEntry, quarantinedIds: Map<string, string>): PluginSurfaceRow[] {
	const base = (extensionId: string, hash: string): Omit<PluginSurfaceRow, "kind"> => ({
		extensionId,
		plugin: entry.name,
		scope: entry.scope,
		sourceKind: entry.source.kind,
		hash,
		...statusFor(entry, extensionId, quarantinedIds),
	});
	const rows: PluginSurfaceRow[] = [];
	for (const t of entry.surfaces.tools) rows.push({ kind: "tool", ...base(t.extensionId, t.sha256) });
	for (const h of entry.surfaces.hooks) rows.push({ kind: "hook", ...base(h.extensionId, h.sha256) });
	// MCP: only name/config hash, never command/url/headers/auth.
	for (const m of entry.surfaces.mcps) rows.push({ kind: "mcp", ...base(m.extensionId, m.configHash) });
	for (const a of entry.surfaces.systemAppendices)
		rows.push({ kind: "system-appendix", ...base(a.extensionId, a.contentHash) });
	for (const a of entry.surfaces.agentAppendices)
		rows.push({ kind: "agent-appendix", ...base(a.extensionId, a.contentHash) });
	for (const s of entry.surfaces.subskills) rows.push({ kind: "subskill", ...base(s.extensionId, s.sha256) });
	return rows;
}

/**
 * Build the observability summary for the effective registry at `cwd`, including
 * hash-drift and session-collision quarantine status.
 */
export async function summarizeGjcPluginObservability(cwd: string): Promise<PluginObservabilitySummary> {
	const effective = await loadEffectiveGjcPluginRegistry(cwd);
	const preQuarantine: SessionQuarantine[] = [];
	for (const entry of effective) {
		if (!entry.enabled) continue;
		const drift = await verifyEntryHashes(entry);
		if (drift) preQuarantine.push(drift);
	}
	const { quarantine } = validateSessionBundles(effective, {}, preQuarantine);
	const quarantinedIds = new Map<string, string>();
	for (const q of quarantine) quarantinedIds.set(`${q.plugin}\u0000${q.surfaceId}`, q.code);

	const surfaces: PluginSurfaceRow[] = [];
	for (const entry of effective) surfaces.push(...rowsForEntry(entry, quarantinedIds));
	return { plugins: effective.length, surfaces };
}
