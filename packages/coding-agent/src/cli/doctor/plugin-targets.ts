import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { getPluginsDir, getPluginsLockfile, getProjectPluginOverridesPath } from "@gajae-code/utils";
import { resolveOrDefaultProjectRegistryPath } from "../../discovery/helpers";
import { GJC_BUNDLE_KIND, type LocalRestorePlanV1 } from "../../extensibility/gjc-plugins/types";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace/index.js";
import type { MarketplaceRestorePlanV1 } from "../../extensibility/plugins/marketplace/manager";
import { sourcePin } from "../../extensibility/plugins/marketplace/source-resolver";
import { doctorCheck } from "./checks";
import type { DoctorConfigSource, DoctorContext } from "./context";
import { type DoctorFileObservation, doctorMapping, readDoctorFile } from "./files";
import { pluginTargetId } from "./ids";
import { type PluginQuarantinePlan, previewPluginQuarantine } from "./plugin-quarantine";
import { runPluginRestoreAction } from "./plugin-restore";
import type { DoctorCheck } from "./types";

/**
 * Construct the marketplace manager exactly as the ordinary plugin CLI does, so
 * doctor reads and repairs the same canonical registries and cache roots the
 * product itself owns. Never a doctor-private layout.
 */
export async function createDoctorMarketplaceManager(cwd: string): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(cwd),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
	});
}

/**
 * The immutable commit the private-marketplace catalog records for this plugin.
 * Uses the product's own pin resolver so doctor and the restore lane agree on
 * what counts as immutable; a mutable source yields no pin and stays
 * unauthorizable.
 */
function marketplacePin(plan: MarketplaceRestorePlanV1 | undefined): string | undefined {
	if (!plan) return undefined;
	const pin = sourcePin(plan.source);
	return pin.immutable ? pin.sha : undefined;
}

type Family = "gjc" | "npm" | "marketplace";
interface PluginEntry {
	readonly name: string;
	readonly enabled: unknown;
	readonly restoreRef?: string;
	readonly restoreArtifactDigest?: string;
}

/**
 * Stable artifact-tree digest of the recorded bundle: sorted relative path plus
 * per-file content hash, exactly the shape the restore lifecycle recomputes from
 * the resolved source. Derived only from already-read registry metadata, so it
 * remains identical across runs and can be authorized before any effect.
 */
function storedArtifactDigest(entry: Record<string, unknown>): string | undefined {
	const files = entry.copiedFiles;
	if (!Array.isArray(files) || files.length === 0 || files.length > 10_000) return undefined;
	const rows: Array<readonly [string, string]> = [];
	for (const raw of files) {
		const file = doctorMapping(raw);
		if (
			!file ||
			typeof file.relativePath !== "string" ||
			typeof file.sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(file.sha256)
		)
			return undefined;
		rows.push([file.relativePath, file.sha256]);
	}
	const hash = createHash("sha256");
	for (const [relativePath, sha256] of rows.sort((a, b) => a[0].localeCompare(b[0]))) {
		hash.update(relativePath);
		hash.update("\0");
		hash.update(sha256);
		hash.update("\0");
	}
	return hash.digest("hex");
}

/**
 * Immutable `--ref` a restore must be pinned to, derived only from the already-read
 * registry record. Never resolves, fetches, or inspects the source itself; a source
 * that carries no immutable identity yields no pin, so restore stays unauthorizable.
 */
function storedRestoreRef(entry: Record<string, unknown>): string | undefined {
	const source = doctorMapping(entry.source);
	if (!source) return undefined;
	if (source.kind === "git")
		return typeof source.sha === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(source.sha)
			? source.sha
			: undefined;
	if (source.kind === "path")
		return typeof entry.manifestHash === "string" && /^[0-9a-f]{64}$/.test(entry.manifestHash)
			? `local:${entry.manifestHash}`
			: undefined;
	if (source.kind === "tarball")
		return typeof entry.version === "string" && entry.version.length > 0 && entry.version.length <= 128
			? `version:${entry.version}`
			: undefined;
	return undefined;
}

function registryFailure(
	source: DoctorConfigSource,
	family: Family,
	observation: DoctorFileObservation,
	malformed = false,
): DoctorCheck {
	return doctorCheck(
		`plugin.${family}.${source.scope}.registry`,
		`t1:plugin-registry:${source.root.rootId}:${family}:${source.scope}`,
		{
			scope: source.scope,
			execution: malformed || observation.status === "missing" ? "completed" : "blocked",
			health: malformed ? "error" : observation.status === "missing" ? "not_applicable" : "unknown",
			evidenceLevel: "observed",
			reasonCode: malformed ? "plugin_registry_invalid" : `plugin_registry_${observation.status}`,
			evidence: {
				present: observation.status === "read",
				runtimeProbed: false,
				...("errno" in observation ? { errno: observation.errno } : {}),
			},
		},
	);
}

function parse(observation: DoctorFileObservation): Record<string, unknown> | undefined {
	if (observation.status !== "read") return undefined;
	try {
		return doctorMapping(JSON.parse(observation.text));
	} catch {
		return undefined;
	}
}

async function addEntries(
	context: DoctorContext,
	source: DoctorConfigSource,
	family: Family,
	entries: readonly PluginEntry[],
	checks: DoctorCheck[],
	registryPath?: string,
): Promise<void> {
	if (entries.length > 1000)
		checks.push(
			doctorCheck(
				`plugin.${family}.${source.scope}.coverage`,
				`t1:plugin-registry:${source.root.rootId}:${family}:${source.scope}`,
				{
					scope: source.scope,
					execution: "blocked",
					health: "unknown",
					evidenceLevel: "observed",
					reasonCode: "limit_exceeded",
					evidence: { count: 1000 },
				},
			),
		);
	for (const entry of entries.slice(0, 1000)) {
		if (!entry.name || entry.name.length > 256) continue;
		const targetId = pluginTargetId(source.root.rootId, family, source.scope, entry.name);
		let quarantinePlan: PluginQuarantinePlan | undefined;
		if (context.options.repair === "plugin.quarantine-selected" && context.options.targetId === targetId) {
			quarantinePlan = await previewPluginQuarantine({
				family,
				scope: source.scope,
				name: entry.name,
				cwd: context.cwd,
				home: os.homedir(),
				rootId: source.root.rootId,
				registryPath,
			});
		}
		// Read-only observation only: preview never resolves a source, fetches, stages, or writes.
		let restorePlan: LocalRestorePlanV1 | undefined;
		if (
			family === "gjc" &&
			entry.restoreRef &&
			entry.restoreArtifactDigest &&
			context.options.repair === "plugin.restore-known-artifact" &&
			context.options.targetId === targetId
		) {
			const preview = await runPluginRestoreAction({
				kind: "preview",
				target: { identity: { kind: GJC_BUNDLE_KIND, scope: source.scope, name: entry.name }, cwd: context.cwd },
			});
			if ("ok" in preview && preview.ok && "value" in preview) {
				const value = preview.value;
				if (
					typeof value === "object" &&
					value !== null &&
					"kind" in value &&
					value.kind === "gjc-plugin.restore-artifact" &&
					"artifact" in value
				)
					restorePlan = value;
			}
		}
		// Private-marketplace lane: the same read-only preview contract. It reads the
		// installed registry, the marketplace catalog and the cached artifact; it never
		// resolves a source, fetches, stages, or writes.
		let marketplaceRestorePlan: MarketplaceRestorePlanV1 | undefined;
		if (
			family === "marketplace" &&
			context.options.repair === "plugin.restore-known-artifact" &&
			context.options.targetId === targetId
		) {
			try {
				const preview = await runPluginRestoreAction({
					kind: "marketplace-preview",
					manager: await createDoctorMarketplaceManager(context.cwd),
					pluginId: entry.name,
					scope: source.scope,
				});
				if (
					typeof preview === "object" &&
					preview !== null &&
					"kind" in preview &&
					preview.kind === "marketplace-plugin.restore-artifact" &&
					"artifact" in preview
				)
					marketplaceRestorePlan = preview;
			} catch {
				// A refused preview leaves the target unrepairable rather than guessing a plan.
			}
		}
		context.targets.set(targetId, {
			kind: "plugin",
			targetId,
			family,
			scope: source.scope,
			name: entry.name,
			root: source.root,
			quarantinePlan,
			restorePlan,
			marketplaceRestorePlan,
			// The marketplace pin is the catalog's recorded immutable commit, observed
			// read-only during preview. A version alone is a moving selector and must
			// never authorize a restore.
			restoreRef: entry.restoreRef ?? marketplacePin(marketplaceRestorePlan),
			// For the marketplace family the pin is the CATALOG fingerprint, never the
			// installed artifact's digest: the artifact is the thing being repaired, so
			// pinning it would make an absent or unreadable tree — D6's whole purpose —
			// permanently unrepairable, and would authorize the damaged bytes rather
			// than the intended ones. The candidate bytes are still bound: the apply
			// path independently recomputes the resolved source digest.
			restoreArtifactDigest: entry.restoreArtifactDigest ?? marketplaceRestorePlan?.catalogFingerprint,
			registryPath,
		});
		const valid = entry.enabled === undefined || typeof entry.enabled === "boolean";
		checks.push(
			doctorCheck(`plugin.${family}.${source.scope}.${targetId.split(":").at(-1)}`, targetId, {
				scope: source.scope,
				execution: "completed",
				health: valid ? "ok" : "error",
				evidenceLevel: "observed",
				reasonCode: valid ? "plugin_registry_entry_observed" : "plugin_enabled_invalid",
				evidence: {
					enabled: quarantinePlan?.enabled ?? entry.enabled !== false,
					sourceClass: family,
					runtimeProbed: false,
					...(restorePlan ? { artifactStatus: restorePlan.artifact.status } : {}),
					...(marketplaceRestorePlan ? { artifactStatus: marketplaceRestorePlan.artifact.status } : {}),
				},
				remediationIds: ["plugin.quarantine-selected", "plugin.restore-known-artifact"],
			}),
		);
	}
}

/** Inventory only: registry data is read, never source-resolved or executed. */
export async function collectPluginTargets(context: DoctorContext): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	const npm = await readDoctorFile(getPluginsLockfile());
	const npmRegistry = parse(npm);
	const npmPlugins = doctorMapping(npmRegistry?.plugins);
	const marketplacePath = path.join(getPluginsDir(), "installed_plugins.json");
	const marketplace = await readDoctorFile(marketplacePath);
	const marketplaceRegistry = parse(marketplace);
	const marketplacePlugins = doctorMapping(marketplaceRegistry?.plugins);
	for (const source of context.sources) {
		// Same canonical layout as registryPathForScope; keep this collector free
		// of installer/compiler imports so broken native code cannot block it.
		const gjc = await readDoctorFile(path.join(source.root.locator, "gjc-plugins", "registry.json"));
		const registry = parse(gjc);
		if (gjc.status !== "read") checks.push(registryFailure(source, "gjc", gjc));
		else if (registry?.version !== 1 || registry.scope !== source.scope || !Array.isArray(registry.plugins))
			checks.push(registryFailure(source, "gjc", gjc, true));
		else {
			const entries: PluginEntry[] = [];
			let malformed = false;
			for (const raw of registry.plugins) {
				const entry = doctorMapping(raw);
				if (!entry || typeof entry.name !== "string" || entry.scope !== source.scope) {
					malformed = true;
					continue;
				}
				entries.push({
					name: entry.name,
					enabled: entry.enabled,
					restoreRef: storedRestoreRef(entry),
					restoreArtifactDigest: storedArtifactDigest(entry),
				});
			}
			if (malformed) checks.push(registryFailure(source, "gjc", gjc, true));
			await addEntries(context, source, "gjc", entries, checks);
		}
		if (npm.status !== "read") checks.push(registryFailure(source, "npm", npm));
		else if (!npmPlugins) checks.push(registryFailure(source, "npm", npm, true));
		else {
			let disabled: readonly unknown[] = [];
			let validOverrides = true;
			if (source.scope === "project") {
				const overrides = await readDoctorFile(getProjectPluginOverridesPath(context.cwd));
				const parsed = parse(overrides);
				if (
					overrides.status !== "missing" &&
					(overrides.status !== "read" ||
						!parsed ||
						(parsed.disabled !== undefined && !Array.isArray(parsed.disabled)))
				) {
					checks.push(registryFailure(source, "npm", overrides, overrides.status === "read"));
					validOverrides = false;
				} else if (Array.isArray(parsed?.disabled)) disabled = parsed.disabled;
			}
			if (validOverrides)
				await addEntries(
					context,
					source,
					"npm",
					Object.entries(npmPlugins).map(([name, value]) => ({
						name,
						enabled: disabled.includes(name) ? false : doctorMapping(value)?.enabled,
					})),
					checks,
				);
		}
		if (marketplace.status !== "read") checks.push(registryFailure(source, "marketplace", marketplace));
		else if (!marketplacePlugins || marketplaceRegistry?.version !== 2)
			checks.push(registryFailure(source, "marketplace", marketplace, true));
		else {
			const entries: PluginEntry[] = [];
			let malformed = false;
			for (const [name, values] of Object.entries(marketplacePlugins)) {
				if (!Array.isArray(values)) {
					malformed = true;
					continue;
				}
				for (const raw of values) {
					const value = doctorMapping(raw);
					if (!value) {
						malformed = true;
						continue;
					}
					if (value.scope === source.scope) entries.push({ name, enabled: value.enabled });
				}
			}
			if (malformed) checks.push(registryFailure(source, "marketplace", marketplace, true));
			await addEntries(context, source, "marketplace", entries, checks, marketplacePath);
		}
	}
	return checks;
}
