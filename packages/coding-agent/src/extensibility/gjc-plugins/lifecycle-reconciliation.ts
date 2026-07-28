import { createHash } from "node:crypto";
import {
	GJC_BUNDLE_KIND,
	type GjcBundleIdentity,
	type GjcPluginQuarantineEntry,
	type GjcPluginRegistryEntry,
	type GjcPluginScope,
	type NormalizedGjcPluginBundle,
	type NormalizedGjcPluginSurfaces,
} from "./types";

/**
 * Pure fingerprint and reconciliation helpers for the GJC bundle lifecycle.
 * Nothing here reads or writes the filesystem: every function is a
 * deterministic projection of its inputs so preview/apply can compare-and-swap
 * on stable hashes.
 */

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function bundleIdentity(scope: GjcPluginScope, name: string): GjcBundleIdentity {
	return { kind: GJC_BUNDLE_KIND, scope, name };
}

export function identityKey(identity: GjcBundleIdentity): string {
	return `${identity.kind}\u0000${identity.scope}\u0000${identity.name}`;
}

export function identityEquals(a: GjcBundleIdentity, b: GjcBundleIdentity): boolean {
	return a.kind === b.kind && a.scope === b.scope && a.name === b.name;
}

/** All stable surface IDs of a surface set, sorted and de-duplicated. */
export function surfaceIdsOf(surfaces: NormalizedGjcPluginSurfaces): string[] {
	const ids = [
		...surfaces.subskills.map(s => s.extensionId),
		...surfaces.tools.map(t => t.extensionId),
		...surfaces.hooks.map(h => h.extensionId),
		...surfaces.mcps.map(m => m.extensionId),
		...surfaces.systemAppendices.map(a => a.extensionId),
		...surfaces.agentAppendices.map(a => a.extensionId),
	];
	return [...new Set(ids)].sort();
}

/**
 * Fingerprint of the exact installed target: identity plus the persisted bytes
 * that any update must not silently replace.
 */
export function targetFingerprint(entry: GjcPluginRegistryEntry): string {
	const files = [...entry.copiedFiles]
		.map(f => `${f.relativePath}:${f.sha256}:${f.bytes}`)
		.sort()
		.join("\n");
	return sha256(
		[
			identityKey(bundleIdentity(entry.scope, entry.name)),
			entry.version,
			entry.manifestHash,
			surfaceIdsOf(entry.surfaces).join(","),
			files,
		].join("\u0000"),
	);
}

/**
 * Fingerprint of the exact installed baseline an update compares against: the
 * installed content, the persisted enablement intent it must carry forward,
 * and the stored source descriptor the update re-resolves from.
 *
 * Toggling the bundle or any surface changes this, so a preview taken before
 * the toggle can no longer be applied. Binding the source matters just as much:
 * apply re-resolves `entry.source.uri` before taking the locks, so a descriptor
 * that changed in between must invalidate the reviewed baseline rather than let
 * an update be committed from a locator the reviewer never saw.
 */
export function baselineFingerprint(entry: GjcPluginRegistryEntry): string {
	const source = [
		entry.source.kind,
		entry.source.uri,
		entry.source.ref ?? "",
		entry.source.sha ?? "",
		entry.source.resolvedAt,
	].join("\u0001");
	return sha256(
		[
			targetFingerprint(entry),
			entry.enabled ? "1" : "0",
			[...new Set(entry.disabledSurfaceIds)].sort().join(","),
			[...new Set((entry.quarantine ?? []).map(q => `${q.surfaceId}:${q.code}`))].sort().join(","),
			source,
		].join("\u0000"),
	);
}

/** Fingerprint of an update candidate before it is written anywhere. */
export function candidateFingerprint(scope: GjcPluginScope, bundle: NormalizedGjcPluginBundle): string {
	const files = [...bundle.files]
		.map(f => `${f.relativePath}:${f.sha256}:${f.bytes}`)
		.sort()
		.join("\n");
	return sha256(
		[
			identityKey(bundleIdentity(scope, bundle.name)),
			bundle.version,
			bundle.manifestHash,
			surfaceIdsOf(bundle.surfaces).join(","),
			files,
		].join("\u0000"),
	);
}

/**
 * Fingerprint of everything besides the target and candidate bytes that the
 * update decision depended on: opposite-scope same-name entries and the
 * effective collision universe.
 */
export function decisionContextFingerprint(
	target: GjcBundleIdentity,
	effectiveEntries: readonly GjcPluginRegistryEntry[],
): string {
	// The target's own state is covered by the baseline fingerprint; this hash
	// only tracks the surrounding universe (notably same-name opposite-scope
	// entries) so drift is attributed to the correct gate.
	const parts = effectiveEntries
		.filter(e => !identityEquals(bundleIdentity(e.scope, e.name), target))
		.map(e => `${e.scope}\u0000${e.name}\u0000${e.version}\u0000${e.manifestHash}\u0000${e.enabled ? "1" : "0"}`)
		.sort();
	return sha256([identityKey(target), ...parts].join("\n"));
}

/**
 * Fingerprint of the inputs that decide live activation. Changes here (and only
 * here) advance the activation generation.
 */
export function activationFingerprint(entries: readonly GjcPluginRegistryEntry[]): string {
	const parts = entries
		.filter(e => e.enabled)
		.map(e => {
			const disabled = [...new Set(e.disabledSurfaceIds)].sort().join(",");
			const quarantined = [...new Set((e.quarantine ?? []).map(q => q.surfaceId))].sort().join(",");
			return [identityKey(bundleIdentity(e.scope, e.name)), e.manifestHash, disabled, quarantined].join("\u0000");
		})
		.sort();
	return sha256(parts.join("\n"));
}

export interface ReconciledEnablement {
	disabledSurfaceIds: string[];
	quarantine: GjcPluginQuarantineEntry[];
}

/**
 * Carry persisted enablement intent across an update:
 * - surviving disabled IDs stay disabled,
 * - IDs whose surface disappeared are dropped,
 * - new surface IDs are enabled by omission,
 * - quarantine is recomputed from candidateQuarantine against the candidate's
 *   surface set; omitted input means no candidate quarantine is justified.
 */
export function reconcileEnablement(
	previousDisabledSurfaceIds: readonly string[],
	candidateSurfaceIds: readonly string[],
	candidateQuarantine: readonly GjcPluginQuarantineEntry[] = [],
): ReconciledEnablement {
	const surviving = new Set(candidateSurfaceIds);
	const disabledSurfaceIds = [...new Set(previousDisabledSurfaceIds)].filter(id => surviving.has(id)).sort();
	const seen = new Set<string>();
	const quarantine = candidateQuarantine
		.filter(q => {
			if (!surviving.has(q.surfaceId)) return false;
			if (seen.has(q.surfaceId)) return false;
			seen.add(q.surfaceId);
			return true;
		})
		.sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
	return { disabledSurfaceIds, quarantine };
}

export interface SurfaceDelta {
	addedSurfaceIds: string[];
	removedSurfaceIds: string[];
	retainedSurfaceIds: string[];
}

export function diffSurfaceIds(
	currentSurfaceIds: readonly string[],
	candidateSurfaceIds: readonly string[],
): SurfaceDelta {
	const current = new Set(currentSurfaceIds);
	const candidate = new Set(candidateSurfaceIds);
	return {
		addedSurfaceIds: [...candidate].filter(id => !current.has(id)).sort(),
		removedSurfaceIds: [...current].filter(id => !candidate.has(id)).sort(),
		retainedSurfaceIds: [...candidate].filter(id => current.has(id)).sort(),
	};
}
