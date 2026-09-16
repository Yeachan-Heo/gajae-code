/**
 * MarketplaceManager — orchestrates registry, fetcher, resolver, and cache.
 *
 * Constructor takes explicit paths for testability (same pattern as registry.ts).
 * The `clearPluginRootsCache` dependency is injected so callers can provide
 * the real `clearAnthropic modelPluginRootsCache` while tests supply a counter stub.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	exactRemoveDirectoryTree,
	type NativeDirectoryTreeSnapshot,
	type NativeExactUnlinkResult,
	renameDirectoryNoReplacePathAsync,
	snapshotDirectoryTree,
} from "@gajae-code/natives";
import { isEnoent, logger, pathIsWithin } from "@gajae-code/utils";
import { withFileLock } from "../../../config/file-lock";
import { cachePlugin, getCachedPluginPath, inspectCachedPlugin, stageCachedPlugin } from "./cache";
import { classifySource, fetchMarketplace, parseMarketplaceCatalog, promoteCloneToCache } from "./fetcher";
import {
	addInstalledPlugin,
	addMarketplaceEntry,
	getInstalledPlugin,
	getMarketplaceEntry,
	readInstalledPluginsRegistry,
	readMarketplacesRegistry,
	removeInstalledPlugin,
	removeMarketplaceEntry,
	writeInstalledPluginsRegistry,
	writeMarketplacesRegistry,
} from "./registry";
import { assertPinnedSource, resolvePluginSource, sourcePin, verifyResolvedProvenance } from "./source-resolver";
import type {
	InstalledPluginEntry,
	InstalledPluginSummary,
	InstalledPluginsRegistry,
	MarketplaceCatalog,
	MarketplacePluginEntry,
	MarketplaceRegistryEntry,
} from "./types";
import { buildPluginId, parsePluginId } from "./types";

// ── Options ──────────────────────────────────────────────────────────────────

export interface MarketplaceManagerOptions {
	marketplacesRegistryPath: string;
	installedRegistryPath: string;
	/**
	 * Path to the project-scoped installed_plugins.json.
	 * Required when installPlugin / uninstallPlugin is called with scope: "project".
	 * Resolved by resolveActiveProjectRegistryPath(cwd) in callers.
	 */
	projectInstalledRegistryPath?: string;
	marketplacesCacheDir: string;
	pluginsCacheDir: string;
	/** Injected for testing; production callers pass clearAnthropic modelPluginRootsCache.
	 *  Receives any additional file paths that should also be invalidated from the fs cache.
	 */
	clearPluginRootsCache?: (extraPaths?: readonly string[]) => void;
	/**
	 * Test seam ONLY: injected immediately after {@link MarketplaceManager.applyPluginRestore}
	 * renames the staged candidate onto `finalPath` and captures its own
	 * published identity, before any further verification. Production callers
	 * never set this — default behavior is a no-op. Exists so a test can
	 * deterministically simulate a concurrent second writer republishing
	 * `finalPath` with a different inode inside the real race window, to
	 * exercise the `foreign_owner_conflict` rollback branch without a second
	 * process. Never used to bypass or weaken the identity re-check itself.
	 */
	afterRestorePublish?: (finalPath: string) => Promise<void>;
}

export type MarketplaceRestoreRiskClass = "plugin-change" | "install-replace" | "network" | "external-execution";

/**
 * Pure, read-only restoration descriptor. Every field is an observation of
 * already-stored registry/catalog/local-artifact state; nothing here resolves
 * a source, touches the network, or stages anything. `installPath` names the
 * artifact this plan is ABOUT (the thing that would be repaired), never a
 * staged candidate — the plan carries no writable authority.
 */
export interface MarketplaceRestorePlanV1 {
	schemaVersion: 1;
	kind: "marketplace-plugin.restore-artifact";
	pluginId: string;
	scope: "user" | "project";
	version: string;
	installPath: string;
	enabled: boolean;
	/** Pinned SHA already recorded for this install, when known. */
	gitCommitSha?: string;
	/** Covers every entry recorded for this pluginId (all scopes) plus the local artifact observation. */
	baselineFingerprint: string;
	catalogFingerprint: string;
	source: MarketplacePluginEntry["source"];
	artifact: { status: "present" | "absent" | "unreadable"; digest?: string };
	riskClasses: readonly MarketplaceRestoreRiskClass[];
	writes: false;
	fetch: false;
	execute: false;
}

/**
 * Materialized after explicit risk authorization: a verified, staged,
 * pinned-SHA candidate bound to the exact baseline/catalog it was reviewed
 * against. `originalInstallPath` (what apply repairs) and `stagedArtifactPath`
 * (the verified candidate bytes) are always distinct paths — apply never
 * confuses the target it is replacing with the replacement.
 */
export interface MarketplaceReviewedRestoreTokenV1 {
	schemaVersion: 1;
	kind: "marketplace-plugin.restore-artifact";
	purpose: "restore-artifact";
	pluginId: string;
	scope: "user" | "project";
	version: string;
	originalInstallPath: string;
	stagedArtifactPath: string;
	enabled: boolean;
	pinnedSha: string;
	baselineFingerprint: string;
	catalogFingerprint: string;
	candidateFingerprint: string;
	candidateArtifact: { status: "present"; digest: string };
	riskClasses: readonly MarketplaceRestoreRiskClass[];
	reviewedAt: string;
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Snapshot a directory tree for {@link exactRemoveDirectoryTree}, or return
 * `undefined` if nothing exists there (native snapshot failure for a missing
 * path is expected, not an error).
 */
/**
 * `exactRemoveDirectoryTree` reports a verified detach as `cleanup_pending` with
 * `payloadDurable: true` and the detached path: the tree was atomically moved out
 * of the canonical name and its bytes are durable, only the final unlink of that
 * detached copy is outstanding. Treating that as failure would refuse a mutation
 * that already happened, so detachment is judged by the detached path plus
 * durability, never by `ok` alone.
 */
function detachedTree(result: NativeExactUnlinkResult): string | undefined {
	if (result.ok && result.detachedPath) return result.detachedPath;
	return result.code === "cleanup_pending" &&
		result.payloadDurable === true &&
		result.detachedPath &&
		!result.retainedUnknownPath
		? result.detachedPath
		: undefined;
}

/** True when the canonical name is vacated, whether or not a detached copy still awaits cleanup. */
function treeRemoved(result: NativeExactUnlinkResult): boolean {
	return result.ok || detachedTree(result) !== undefined;
}

async function snapshotIfPresent(targetPath: string): Promise<NativeDirectoryTreeSnapshot | undefined> {
	const stat = await fs.lstat(targetPath).catch(() => undefined);
	if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
	const snapshot = snapshotDirectoryTree(targetPath);
	return snapshot.ok ? snapshot.snapshot : undefined;
}

/**
 * Full identity comparison between two directory tree snapshots. A same-
 * filesystem `renameat`-class namespace operation changes neither the root's
 * nor any entry's dev/ino/nlink — the inode identity travels with the rename,
 * only its containing-directory pathname changes — so the snapshot captured
 * BEFORE the publish rename remains exact identity evidence for what the
 * rename just published. Used here to CONFIRM that expectation holds (an
 * unexpected mismatch means a third party touched finalPath in the interim),
 * never as a substitute for the native exactRemoveDirectoryTree identity check
 * itself, which independently re-validates the same snapshot at mutation time.
 */
function sameDirectoryTreeIdentity(
	expected: NativeDirectoryTreeSnapshot,
	actual: NativeDirectoryTreeSnapshot,
): boolean {
	if (expected.rootDev !== actual.rootDev || expected.rootIno !== actual.rootIno) return false;
	if (expected.entries.length !== actual.entries.length) return false;
	const byPath = new Map(actual.entries.map(entry => [entry.relativePath, entry]));
	return expected.entries.every(entry => {
		const match = byPath.get(entry.relativePath);
		return (
			match !== undefined &&
			match.kind === entry.kind &&
			match.dev === entry.dev &&
			match.ino === entry.ino &&
			match.nlink === entry.nlink &&
			match.size === entry.size &&
			match.sha256 === entry.sha256
		);
	});
}

/**
 * `refused` — nothing was mutated; safe to retry after fixing the cause.
 * `conflict` — a filesystem mutation was attempted and then fully, verifiably
 * rolled back to OUR exact prior artifact; the installed state is unchanged
 * from before this apply ran.
 * `foreign_owner_conflict` — a filesystem mutation was attempted, but the
 * publish target now belongs to a different, concurrently-completed owner.
 * Neither the foreign publication nor our own retained backup is touched;
 * `retainedBackupPath` on the error names exactly where our pre-swap artifact
 * is preserved for inspection/manual reconciliation.
 * `uncertain` — a filesystem mutation was attempted and rollback to OUR prior
 * artifact could not be verified; the installed state may not match either
 * the old or new artifact and requires manual inspection.
 * A caller (doctor journal) MUST record all four distinctly and MUST NOT
 * treat any of the non-`refused` outcomes as a clean no-op.
 */
export type MarketplaceRestoreOutcome = "refused" | "conflict" | "foreign_owner_conflict" | "uncertain";

/**
 * Typed refusal/failure for the restore lane. Every throw site in
 * previewPluginRestore/authorizePluginRestore/applyPluginRestore uses this
 * class (never a bare `Error`) so a caller (the doctor journal) can
 * distinguish a clean pre-mutation refusal from a filesystem mutation that
 * was attempted and either rolled back, lost to a foreign owner, or left
 * uncertain.
 */
export class MarketplaceRestoreError extends Error {
	readonly reasonCode: MarketplaceRestoreReasonCode;
	readonly sideEffectStarted: boolean;
	readonly outcome: MarketplaceRestoreOutcome;
	/** Set whenever a pre-swap backup survives this call untouched: `foreign_owner_conflict` and every `uncertain` outcome that retains it. */
	readonly retainedBackupPath?: string;
	/**
	 * Private, non-reported free-text context (e.g. a wrapped underlying error
	 * message). NEVER surfaced as `reasonCode` — `reasonCode` reaches redacted
	 * external reports and must stay a fixed enum member.
	 */
	readonly detail?: string;
	constructor(
		reasonCode: MarketplaceRestoreReasonCode,
		options: {
			sideEffectStarted?: boolean;
			outcome?: MarketplaceRestoreOutcome;
			retainedBackupPath?: string;
			detail?: string;
		} = {},
	) {
		super(reasonCode);
		this.name = "MarketplaceRestoreError";
		this.reasonCode = reasonCode;
		this.sideEffectStarted = options.sideEffectStarted ?? false;
		this.outcome = options.outcome ?? (this.sideEffectStarted ? "conflict" : "refused");
		if (options.detail !== undefined) this.detail = options.detail;
		if (options.retainedBackupPath !== undefined) this.retainedBackupPath = options.retainedBackupPath;
	}
}

/**
 * Fixed enum of every `MarketplaceRestoreError.reasonCode` produced by
 * previewPluginRestore/authorizePluginRestore/applyPluginRestore. `reasonCode`
 * reaches redacted external reports, so it MUST stay a member of this exact
 * set — never an interpolated raw Error message (that goes into `detail`,
 * a private, non-reported field on the error).
 */
export const MARKETPLACE_RESTORE_REASON_CODES = [
	"invalid_plugin_id",
	"not_installed",
	"marketplace_missing",
	"catalog_entry_missing",
	"catalog_changed",
	"baseline_changed",
	"original_path_not_canonical_private_layout",
	"candidate_changed",
	"unpinned_source",
	"unsupported_shared_layout",
	"install_path_not_canonical_private_layout",
	"resolved_provenance_mismatch",
	"unsafe_candidate_artifact",
	"authorization_missing",
	"staged_artifact_inside_cache_root",
	"final_path_outside_private_cache_root",
	"invalid_restore_token",
	"staged_snapshot_unavailable",
	"private_cache_root_missing",
	"private_cache_root_changed",
	"final_path_snapshot_unavailable",
	"final_path_is_symlink",
	"backup_detach_failed",
	"final_path_changed_before_backup",
	"backup_detach_unverified",
	"backup_publish_failed",
	"final_path_claimed_by_new_owner",
	"post_publish_identity_unconfirmed",
	"post_publish_digest_mismatch",
	"registry_write_failed",
	"post_publish_registry_verification_failed",
	"unexpected_occupant_before_our_publish",
	"rollback_rename_failed",
	"rollback_digest_mismatch",
	"restore_publish_failed",
] as const;
export type MarketplaceRestoreReasonCode = (typeof MARKETPLACE_RESTORE_REASON_CODES)[number];

export type MarketplaceRestoreApplyStatus = "verified" | "not_needed";

/**
 * Discriminated success result for {@link MarketplaceManager.applyPluginRestore}.
 * A TypeScript discriminated union (not one interface with optional fields):
 * `not_needed` structurally has ONLY `staleStagedArtifactPath` and can never
 * carry a `retainedBackupPath` field — there is no backup rollback state in
 * a branch that made zero mutations. `verified` carries neither field, since
 * a fully committed apply has nothing stale or retained to report.
 *
 * `sideEffectStarted` is explicit and MUST be `false` for `not_needed` (zero
 * filesystem or registry mutation of any kind is attempted — the token is not
 * consumed and can be safely retried or discarded) and `true` for `verified`
 * (the cache directory was swapped and the registry written). `entry` for
 * `verified` is re-read from disk after the write, not the in-memory value
 * that was written, so it is independent observation rather than an echo of
 * the input.
 *
 * `not_needed.staleStagedArtifactPath` names the token's now-redundant staged
 * scratch directory for the CALLER to dispose of; this function does not
 * delete it (doing so would itself be a write inside a branch that must
 * remain a true zero-effect no-op), and it is populated ONLY with the exact
 * path this same call's precheck confirmed still exists and still matches
 * the token — never a path this call did not itself verify.
 */
export type MarketplaceRestoreApplyResult =
	| { status: "verified"; sideEffectStarted: true; entry: InstalledPluginEntry }
	| {
			status: "not_needed";
			sideEffectStarted: false;
			entry: InstalledPluginEntry;
			/** Present only when this call itself verified the staged directory still exists. */
			staleStagedArtifactPath?: string;
	  };

// ── Manager ──────────────────────────────────────────────────────────────────

export class MarketplaceManager {
	#opts: MarketplaceManagerOptions;

	constructor(options: MarketplaceManagerOptions) {
		this.#opts = options;
	}

	// Invalidate fs caches for all registry paths the manager writes, then clear plugin roots.
	#clearCache(): void {
		const extra = this.#opts.projectInstalledRegistryPath
			? ([this.#opts.projectInstalledRegistryPath] as readonly string[])
			: undefined;
		this.#opts.clearPluginRootsCache?.(extra);
	}

	// ── Marketplace lifecycle ─────────────────────────────────────────────────

	async addMarketplace(source: string): Promise<MarketplaceRegistryEntry> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const existingNames = new Set(reg.marketplaces.map(m => m.name));

		const { catalog, clonePath } = await fetchMarketplace(source, this.#opts.marketplacesCacheDir);

		if (existingNames.has(catalog.name)) {
			if (clonePath) {
				await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
			}
			throw new Error(`Marketplace "${catalog.name}" already exists`);
		}

		// Promote the temp clone to its final cache location now that we know it's not a duplicate.
		if (clonePath) {
			await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);
		}

		const sourceType = classifySource(source);
		const normalizedSource =
			sourceType === "local"
				? path.resolve(source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source)
				: source;

		const catalogPath = path.join(this.#opts.marketplacesCacheDir, catalog.name, "marketplace.json");

		// Persist the fetched catalog so subsequent reads don't require re-fetching.
		await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const now = new Date().toISOString();
		const entry: MarketplaceRegistryEntry = {
			name: catalog.name,
			sourceType,
			sourceUri: normalizedSource,
			catalogPath,
			addedAt: now,
			updatedAt: now,
		};

		const updated = addMarketplaceEntry(reg, entry);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);

		logger.debug("Marketplace added", { name: catalog.name, sourceType });
		return entry;
	}

	async removeMarketplace(name: string): Promise<void> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		// removeMarketplaceEntry throws if not found — propagate to caller.
		const updated = removeMarketplaceEntry(reg, name);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);

		await fs.rm(path.join(this.#opts.marketplacesCacheDir, name), {
			recursive: true,
			force: true,
		});

		logger.debug("Marketplace removed", { name });
	}

	async updateMarketplace(name: string): Promise<MarketplaceRegistryEntry> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const existing = getMarketplaceEntry(reg, name);
		if (!existing) {
			throw new Error(`Marketplace "${name}" not found`);
		}

		const { catalog, clonePath } = await fetchMarketplace(existing.sourceUri, this.#opts.marketplacesCacheDir);

		// Guard against upstream catalog silently renaming itself — the registry
		// entry is keyed by name, so a drift would corrupt the entry on next read.
		if (catalog.name !== name) {
			if (clonePath) {
				await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
			}
			throw new Error(
				`Marketplace catalog name changed from "${name}" to "${catalog.name}". ` +
					`Remove and re-add the marketplace to update.`,
			);
		}

		// Promote the temp clone to its final cache location now that drift check passed.
		if (clonePath) {
			await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);
		}

		// Overwrite cached catalog
		await Bun.write(existing.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const updatedEntry: MarketplaceRegistryEntry = {
			...existing,
			updatedAt: new Date().toISOString(),
		};

		const updatedReg = {
			...reg,
			marketplaces: reg.marketplaces.map(m => (m.name === name ? updatedEntry : m)),
		};
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updatedReg);

		logger.debug("Marketplace updated", { name });
		return updatedEntry;
	}

	async updateAllMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const marketplaces = await this.listMarketplaces();
		const results: MarketplaceRegistryEntry[] = [];
		for (const m of marketplaces) {
			const updated = await this.updateMarketplace(m.name);
			results.push(updated);
		}
		return results;
	}

	async listMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		return reg.marketplaces;
	}

	// ── Plugin discovery ──────────────────────────────────────────────────────

	async listAvailablePlugins(marketplace?: string): Promise<MarketplacePluginEntry[]> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);

		if (marketplace !== undefined) {
			const entry = reg.marketplaces.find(m => m.name === marketplace);
			if (!entry) {
				throw new Error(`Marketplace "${marketplace}" not found`);
			}
			const catalog = await this.#readCatalog(entry);
			return catalog.plugins;
		}

		const all: MarketplacePluginEntry[] = [];
		for (const entry of reg.marketplaces) {
			const catalog = await this.#readCatalog(entry);
			all.push(...catalog.plugins);
		}
		return all;
	}

	async getPluginInfo(name: string, marketplace: string): Promise<MarketplacePluginEntry | null> {
		const plugins = await this.listAvailablePlugins(marketplace);
		return plugins.find(p => p.name === name) ?? null;
	}

	/**
	 * Pure, read-only restoration observation. Reads the installed registry
	 * entry, the marketplace catalog entry, and the local cache artifact only.
	 * Never resolves the plugin source, never touches the network, never stages
	 * or writes anything.
	 */
	async previewPluginRestore(pluginId: string, scope: "user" | "project"): Promise<MarketplaceRestorePlanV1> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) throw new MarketplaceRestoreError("invalid_plugin_id");
		const registryPath = this.#registryPath(scope);
		const registry = await readInstalledPluginsRegistry(registryPath);
		const siblings = getInstalledPlugin(registry, pluginId) ?? [];
		const installed = siblings.find(entry => entry.scope === scope);
		if (!installed) throw new MarketplaceRestoreError("not_installed");
		const marketplace = getMarketplaceEntry(
			await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath),
			parsed.marketplace,
		);
		if (!marketplace) throw new MarketplaceRestoreError("marketplace_missing");
		const catalog = await this.#readCatalog(marketplace);
		const plugin = catalog.plugins.find(item => item.name === parsed.name);
		if (!plugin) throw new MarketplaceRestoreError("catalog_entry_missing");
		const artifact = await inspectCachedPlugin(installed.installPath);
		return {
			schemaVersion: 1,
			kind: "marketplace-plugin.restore-artifact",
			pluginId,
			scope,
			version: installed.version,
			installPath: installed.installPath,
			enabled: installed.enabled !== false,
			...(installed.gitCommitSha ? { gitCommitSha: installed.gitCommitSha } : {}),
			// Fingerprints EVERY sibling entry recorded under this pluginId in this
			// scope's registry file, not just the matched entry, so a later apply
			// that would silently drop a sibling is caught as a baseline mismatch.
			baselineFingerprint: fingerprint({ pluginId, scope, siblings, marketplace: marketplace.updatedAt, artifact }),
			catalogFingerprint: fingerprint({ marketplace, plugin }),
			source: plugin.source,
			artifact,
			riskClasses: this.#restoreRiskClasses(plugin),
			writes: false,
			fetch: false,
			execute: false,
		};
	}

	/** Recompute the exact risk classes a restore of this catalog entry needs. Never trust a caller-supplied set. */
	#restoreRiskClasses(plugin: MarketplacePluginEntry): MarketplaceRestoreRiskClass[] {
		const classes: MarketplaceRestoreRiskClass[] = ["plugin-change", "install-replace"];
		if (typeof plugin.source !== "string") classes.push("network");
		return classes;
	}

	/**
	 * Materialize a verified, pinned-SHA candidate after explicit risk
	 * authorization. Re-derives every fact from live state instead of trusting
	 * the caller-supplied plan: risk classes are recomputed (never taken from
	 * `plan.riskClasses`), the source is re-read from the current catalog entry
	 * (never from `plan.source`), and the resolved checkout's HEAD is
	 * independently re-verified against the pinned SHA before anything is
	 * staged. The plan itself confers no authority — only an explicit,
	 * risk-complete `authorizations` set does.
	 */
	async authorizePluginRestore(
		plan: MarketplaceRestorePlanV1,
		authorizations: readonly string[],
	): Promise<MarketplaceReviewedRestoreTokenV1> {
		const parsed = parsePluginId(plan.pluginId);
		if (!parsed) throw new MarketplaceRestoreError("invalid_plugin_id");
		const currentRegistry = await readInstalledPluginsRegistry(this.#registryPath(plan.scope));
		const currentSiblings = getInstalledPlugin(currentRegistry, plan.pluginId) ?? [];
		const current = currentSiblings.find(entry => entry.scope === plan.scope);
		if (!current) throw new MarketplaceRestoreError("not_installed");
		const marketplace = getMarketplaceEntry(
			await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath),
			parsed.marketplace,
		);
		if (!marketplace) throw new MarketplaceRestoreError("marketplace_missing");
		const currentArtifact = await inspectCachedPlugin(current.installPath);
		const currentBaseline = fingerprint({
			pluginId: plan.pluginId,
			scope: plan.scope,
			siblings: currentSiblings,
			marketplace: marketplace.updatedAt,
			artifact: currentArtifact,
		});
		if (currentBaseline !== plan.baselineFingerprint) throw new MarketplaceRestoreError("baseline_changed");
		const catalog = await this.#readCatalog(marketplace);
		const plugin = catalog.plugins.find(item => item.name === parsed.name);
		if (!plugin || fingerprint({ marketplace, plugin }) !== plan.catalogFingerprint)
			throw new MarketplaceRestoreError("catalog_changed");
		// Recomputed from the CURRENT catalog entry, never from plan.riskClasses
		// or plan.source — a caller cannot under-report risk to bypass authorization.
		const riskClasses = this.#restoreRiskClasses(plugin);
		// reasonCode stays the fixed enum member "authorization_missing"; the
		// specific missing risk class is carried in the private, non-reported
		// `detail` field, never interpolated into the reported reasonCode.
		for (const risk of riskClasses)
			if (!authorizations.includes(risk))
				throw new MarketplaceRestoreError("authorization_missing", { detail: `missing risk class: ${risk}` });
		// Every source shape that is NOT a pinnable single-plugin git object maps to
		// unsupported_shared_layout, not a generic pin-failure code, so a report
		// never implies D6 support for a shared/non-private layout:
		//  - npm sources are the D7-scoped shared node_modules layout.
		//  - string (relative "./plugins/foo") sources resolve INSIDE the shared
		//    marketplace clone tree, not a private per-(marketplace,name,version)
		//    cache entry — there is no independently pinnable object to restore.
		if (typeof plugin.source === "string" || (typeof plugin.source === "object" && plugin.source.source === "npm"))
			throw new MarketplaceRestoreError("unsupported_shared_layout");
		assertPinnedSource(plugin.source);
		const pin = sourcePin(plugin.source);
		if (!pin.sha) throw new MarketplaceRestoreError("unpinned_source");
		// current.installPath must be exactly the canonical cache path for its OWN
		// recorded version — mirrors installPlugin/uninstallPlugin's
		// #validateCacheDeletionTargets identity check, so restore never touches a
		// path outside the private per-(marketplace,name,version) cache layout.
		const recordedPath = getCachedPluginPath(
			this.#opts.pluginsCacheDir,
			parsed.marketplace,
			parsed.name,
			current.version,
		);
		if (path.resolve(current.installPath) !== recordedPath)
			throw new MarketplaceRestoreError("install_path_not_canonical_private_layout");
		const resolved = await resolvePluginSource(plugin, {
			marketplaceClonePath: this.#resolveMarketplaceRoot(marketplace),
			catalogMetadata: catalog.metadata,
			tmpDir: os.tmpdir(),
		});
		// Staged under a fresh random scratch path, NOT a predictable path derived
		// from the target's own name — apply never guesses a staging location.
		const stagingPath = path.join(os.tmpdir(), `gjc-marketplace-restore-${randomBytes(12).toString("hex")}`);
		try {
			// Independently re-derive provenance from the checkout itself (a fresh
			// `rev-parse HEAD`) rather than trusting whatever the resolver claims to
			// have cloned. Verify against the actual git repository root
			// (tempCloneRoot) rather than resolved.dir: for git-subdir sources,
			// resolved.dir is a SUBDIRECTORY of the clone and has no HEAD of its own.
			// npm/string sources are already refused above (unsupported_shared_layout)
			// before reaching this point, so `plugin.source` is always a pinnable
			// git-style object here.
			{
				const provenanceRoot = resolved.tempCloneRoot ?? resolved.dir;
				const provenanceOk = await verifyResolvedProvenance(provenanceRoot, pin.sha);
				if (!provenanceOk) throw new MarketplaceRestoreError("resolved_provenance_mismatch");
			}
			await stageCachedPlugin(resolved.dir, stagingPath);
			const digest = await inspectCachedPlugin(stagingPath);
			// This is a scratch-directory failure only — nothing installed has been
			// touched, so it is a clean refusal, not a partial mutation.
			if (digest.status !== "present" || !digest.digest)
				throw new MarketplaceRestoreError("unsafe_candidate_artifact");
			return {
				schemaVersion: 1,
				kind: "marketplace-plugin.restore-artifact",
				purpose: "restore-artifact",
				pluginId: plan.pluginId,
				scope: plan.scope,
				version: current.version,
				originalInstallPath: current.installPath,
				stagedArtifactPath: stagingPath,
				enabled: current.enabled !== false,
				pinnedSha: pin.sha,
				baselineFingerprint: plan.baselineFingerprint,
				catalogFingerprint: plan.catalogFingerprint,
				candidateFingerprint: fingerprint({
					plugin,
					digest: digest.digest,
					version: current.version,
					pinnedSha: pin.sha,
				}),
				candidateArtifact: { status: "present", digest: digest.digest },
				riskClasses,
				reviewedAt: new Date().toISOString(),
			};
		} catch (error) {
			await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
			throw error;
		} finally {
			if (resolved.tempCloneRoot)
				await fs.rm(resolved.tempCloneRoot, { recursive: true, force: true }).catch(() => {});
		}
	}

	/**
	 * Publish a verified restore candidate. Re-verifies catalog/baseline/
	 * candidate CAS against live state (the token confers no authority by
	 * itself), swaps the private per-version cache directory atomically with a
	 * randomized backup name, and mutates ONLY the matched (pluginId, scope)
	 * registry entry — every sibling entry, every other pluginId, and the
	 * opposite scope's registry file are left untouched. On any failure after
	 * the filesystem swap the exact old artifact/registry pair is restored.
	 */
	async applyPluginRestore(token: MarketplaceReviewedRestoreTokenV1): Promise<MarketplaceRestoreApplyResult> {
		const parsed = parsePluginId(token.pluginId);
		if (!parsed || token.purpose !== "restore-artifact" || token.schemaVersion !== 1)
			throw new MarketplaceRestoreError("invalid_restore_token");
		const pluginsCacheDir = path.resolve(this.#opts.pluginsCacheDir);
		// Path containment: the staged candidate must live under a scratch root we
		// control (never inside the private cache tree itself), and the original
		// install path must be the exact canonical private-layout path for the
		// token's own (marketplace, name, version) — never an arbitrary foreign path.
		// Everything up to here is a pure precheck: no mutation has been attempted,
		// so every throw is a clean `refused`.
		const stagedResolved = path.resolve(token.stagedArtifactPath);
		if (pathIsWithin(pluginsCacheDir, stagedResolved) || stagedResolved === pluginsCacheDir)
			throw new MarketplaceRestoreError("staged_artifact_inside_cache_root");
		const finalPath = getCachedPluginPath(this.#opts.pluginsCacheDir, parsed.marketplace, parsed.name, token.version);
		if (!pathIsWithin(pluginsCacheDir, finalPath))
			throw new MarketplaceRestoreError("final_path_outside_private_cache_root");
		if (path.resolve(token.originalInstallPath) !== finalPath)
			throw new MarketplaceRestoreError("original_path_not_canonical_private_layout");

		const registryPath = this.#registryPath(token.scope);
		// Shared exclusion primitive: the same withFileLock every OTHER writer in
		// this class uses against this exact path, so restore's CAS is real
		// exclusion against every writer of this registry file.
		return await withFileLock(registryPath, async () => {
			const registry = await readInstalledPluginsRegistry(registryPath);
			const siblings = getInstalledPlugin(registry, token.pluginId) ?? [];
			const matchIndex = siblings.findIndex(entry => entry.scope === token.scope);
			if (matchIndex < 0) throw new MarketplaceRestoreError("not_installed");
			const current = siblings[matchIndex] as InstalledPluginEntry;
			const marketplace = getMarketplaceEntry(
				await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath),
				parsed.marketplace,
			);
			if (!marketplace) throw new MarketplaceRestoreError("marketplace_missing");
			const catalog = await this.#readCatalog(marketplace);
			const plugin = catalog.plugins.find(item => item.name === parsed.name);
			if (!plugin || fingerprint({ marketplace, plugin }) !== token.catalogFingerprint)
				throw new MarketplaceRestoreError("catalog_changed");
			// If the catalog was rewritten to a shared/non-private source shape between
			// authorize and apply (e.g. an operator edited the catalog to point at an
			// npm package or a relative in-clone path), that is the SAME
			// unsupported_shared_layout condition authorize would have refused up
			// front — report it identically here rather than falling through to a
			// generic catalog_changed/pin-mismatch code.
			if (typeof plugin.source === "string" || (typeof plugin.source === "object" && plugin.source.source === "npm"))
				throw new MarketplaceRestoreError("unsupported_shared_layout");
			// Explicit pin recheck, independent of the hash comparison above: the
			// CURRENT catalog entry's own pinned SHA must still equal the exact SHA
			// this token was authorized against. The catalogFingerprint hash already
			// covers the full plugin object (including source.sha), so a catalog
			// rewrite that changes the pin is already caught above; this makes the
			// pin-specific failure mode explicit rather than relying solely on
			// implied hash coverage, and fails closed if source.sha is ever removed
			// or the catalog entry becomes unpinned between authorize and apply.
			const currentPin = sourcePin(plugin.source);
			if (!currentPin.sha || currentPin.sha.toLowerCase() !== token.pinnedSha.toLowerCase())
				throw new MarketplaceRestoreError("catalog_changed");
			const currentArtifact = await inspectCachedPlugin(current.installPath);
			if (path.resolve(current.installPath) !== finalPath)
				throw new MarketplaceRestoreError("original_path_not_canonical_private_layout");

			// The baseline fingerprint authorizes a MUTATION, and it covers the observed
			// artifact — so a successful apply necessarily changes it. Checking it before
			// the zero-effect no-op below would make a retry of the very token that just
			// succeeded fail as `baseline_changed`. The no-op writes nothing, renames
			// nothing, and returns freshly read disk state, so it needs no mutation
			// authority; every non-baseline CAS check (catalog fingerprint, explicit pin,
			// canonical layout) has already run above and still gates it.
			const baselineMatches =
				fingerprint({
					pluginId: token.pluginId,
					scope: token.scope,
					siblings,
					marketplace: marketplace.updatedAt,
					artifact: currentArtifact,
				}) === token.baselineFingerprint;

			// Idempotent retry: if the currently installed artifact already matches
			// the verified candidate (e.g. a prior apply of this exact token already
			// published it), this is a no-op.
			if (currentArtifact.status === "present" && currentArtifact.digest === token.candidateArtifact.digest) {
				// TRUE zero-effect no-op: no rm, no rename, no registry write. The
				// now-redundant staged scratch directory is left exactly where it is;
				// disposing of it is the caller's responsibility (or a separate,
				// explicitly-effectful cleanup step), never folded into this branch.
				// `current` here is itself the fresh disk-read entry from the top of
				// this function, not an echo of the token.
				//
				// staleStagedArtifactPath is populated ONLY when THIS call's own
				// read-only precheck confirms a directory still exists at exactly that
				// path — a prior apply of the same token (e.g. a second not_needed in a
				// row) may have already had it disposed of by the caller, and this
				// function must never report a path it did not itself just verify.
				const stagedStillPresent = await inspectCachedPlugin(token.stagedArtifactPath);
				return stagedStillPresent.status === "present"
					? {
							status: "not_needed",
							sideEffectStarted: false,
							entry: current,
							staleStagedArtifactPath: token.stagedArtifactPath,
						}
					: { status: "not_needed", sideEffectStarted: false, entry: current };
			}

			// A real mutation follows, so the recorded baseline must still authorize it.
			if (!baselineMatches) throw new MarketplaceRestoreError("baseline_changed");

			// Independently re-verify the staged candidate's bytes right now — never
			// trust the digest recorded on the token without recomputing it. Still no
			// mutation of installed state, so still a clean refusal on failure.
			const stagedDigest = await inspectCachedPlugin(token.stagedArtifactPath);
			if (stagedDigest.status !== "present" || stagedDigest.digest !== token.candidateArtifact.digest)
				throw new MarketplaceRestoreError("candidate_changed");
			if (
				fingerprint({ plugin, digest: stagedDigest.digest, version: token.version, pinnedSha: token.pinnedSha }) !==
				token.candidateFingerprint
			)
				throw new MarketplaceRestoreError("candidate_changed");

			// Snapshot the staged candidate's identity BEFORE it is ever renamed. A
			// `renameat`-class syscall does not change a directory's dev/ino on the
			// same filesystem (rename is a namespace operation, not a copy), so this
			// exact snapshot remains valid evidence of what now sits at finalPath
			// once the rename below lands — no post-publish re-snapshot is needed to
			// establish that identity, closing the window a post-publish snapshot
			// would otherwise reopen. A cross-device rename (different filesystem)
			// changes this invariant, which is exactly why the no-replace publish
			// below is required to fail closed on cross_device rather than silently
			// falling back to copy semantics — see the cross-device handling note
			// further down.
			const stagedSnapshot = await snapshotIfPresent(token.stagedArtifactPath);
			if (!stagedSnapshot) throw new MarketplaceRestoreError("staged_snapshot_unavailable");

			// Parent-directory identity check immediately before the destructive
			// swap sequence, closing the TOCTOU window between the reads above and
			// the filesystem mutation below.
			const parentBefore = await fs.lstat(pluginsCacheDir, { bigint: true }).catch(() => undefined);
			if (!parentBefore?.isDirectory()) throw new MarketplaceRestoreError("private_cache_root_missing");

			const finalSnapshotBefore = await snapshotIfPresent(finalPath);
			const finalStat = await fs.lstat(finalPath).catch(error => {
				if (isEnoent(error)) return undefined;
				throw error;
			});
			if (finalStat?.isSymbolicLink()) throw new MarketplaceRestoreError("final_path_is_symlink");
			const hadFinal = finalStat !== undefined;
			// Single-component name; never renamed elsewhere on collision since the
			// native no-replace primitive is what actually refuses an occupied slot.
			const backup = `${finalPath}.restore-backup-${process.pid}-${randomBytes(6).toString("hex")}`;

			const parentRecheck = await fs.lstat(pluginsCacheDir, { bigint: true }).catch(() => undefined);
			if (!parentRecheck || parentRecheck.dev !== parentBefore.dev || parentRecheck.ino !== parentBefore.ino)
				throw new MarketplaceRestoreError("private_cache_root_changed");

			// Step 1: move any existing occupant out of finalPath into the backup
			// slot using the native identity-bound exact-remove-then-no-replace-
			// publish sequence, so check+mutate is one atomic native operation
			// rather than TypeScript-level lstat-then-rename.
			// exactRemoveDirectoryTree only succeeds when the on-disk tree still
			// matches the snapshot taken microseconds earlier;
			// renameDirectoryNoReplacePathAsync only succeeds when `backup` does not
			// already exist. Neither call ever overwrites a foreign occupant.
			//
			// From here on a filesystem mutation is about to be attempted. Every
			// subsequent failure MUST surface as `conflict` (verified rollback),
			// `foreign_owner_conflict` (a new owner claimed the slot; nothing of
			// ours is destroyed), or `uncertain` (rollback could not be verified) —
			// never a plain refusal once this point is reached.
			let backupSnapshot: NativeDirectoryTreeSnapshot | undefined;
			if (hadFinal) {
				// Not yet an effect: nothing has been renamed or detached at this point,
				// merely a decision about whether it is safe to proceed. sideEffectStarted
				// stays false — effects are physical, not procedural.
				if (!finalSnapshotBefore) throw new MarketplaceRestoreError("final_path_snapshot_unavailable");
				const detached = exactRemoveDirectoryTree(finalPath, finalSnapshotBefore, {
					dev: parentBefore.dev,
					ino: parentBefore.ino,
				});
				const detachedPath = detachedTree(detached);
				if (!detachedPath) {
					// identity_mismatch means finalPath already changed before we ever
					// touched it — exactRemoveDirectoryTree refused the mutation entirely,
					// so this is a pure precheck refusal: nothing moved, sideEffectStarted
					// stays false.
					if (detached.code === "identity_mismatch")
						throw new MarketplaceRestoreError("final_path_changed_before_backup");
					// Any other native refusal from exactRemoveDirectoryTree also means the
					// call did not mutate anything (the native primitive only mutates on a
					// verified match); this is the same class of pure refusal.
					throw new MarketplaceRestoreError("backup_detach_failed");
				}
				const detachedSnapshot = await snapshotIfPresent(detachedPath);
				if (!detachedSnapshot)
					throw new MarketplaceRestoreError("backup_detach_unverified", {
						sideEffectStarted: true,
						outcome: "uncertain",
					});
				// The native detach parks the tree at a FIXED `<name>.removing` slot. Once it
				// has been republished under the backup name that slot must be vacated, or a
				// later detach of the same canonical path inside this same transaction (the
				// rollback path) collides with our own leftover and is misread as a foreign
				// claim. The rename below is what vacates it; failure is reported, never assumed.
				const backupPublish = await renameDirectoryNoReplacePathAsync(detachedPath, backup);
				if (!backupPublish.ok) {
					// mutationState "not_committed" proves the rename never moved the
					// object; it is still at the detached path, so that path is real
					// observed evidence to report. mutationState "unknown" means we
					// cannot trust EITHER location from the result alone — independently
					// observe which of the two paths actually holds the object right now
					// (via a real fs check) before naming it, rather than assuming.
					const observedAtDetached =
						backupPublish.mutationState === "not_committed"
							? true
							: await fs.lstat(detachedPath).then(
									() => true,
									() => false,
								);
					const observedAtBackup = observedAtDetached
						? false
						: await fs.lstat(backup).then(
								() => true,
								() => false,
							);
					throw new MarketplaceRestoreError("backup_publish_failed", {
						sideEffectStarted: true,
						outcome: "uncertain",
						// Only ever names a path THIS call independently confirmed holds the
						// object right now — never a computed/assumed name. If neither
						// location can be confirmed, omit the field entirely and let the
						// uncertain outcome stand alone rather than pointing at empty air.
						...(observedAtDetached
							? { retainedBackupPath: detachedPath }
							: observedAtBackup
								? { retainedBackupPath: backup }
								: {}),
					});
				}
				backupSnapshot = detachedSnapshot;
			}
			// `stagedSnapshot` (captured above, before any rename) is the AUTHORITATIVE
			// identity a rollback removal binds to — a same-filesystem `renameat` does
			// not change dev/ino, so this pre-publish snapshot remains valid evidence
			// of what sits at finalPath once our rename lands, with no post-publish
			// re-snapshot needed to establish it (that would reopen exactly the TOCTOU
			// window this closes).
			let published = false;
			try {
				// INVARIANT COUPLING (do not weaken without re-checking `stagedSnapshot`
				// authority above and in the rollback catch block below): this call MUST
				// remain a pure namespace rename with no copy-semantics fallback on ANY
				// failure reason, including `cross_device`. `renameDirectoryNoReplacePathAsync`
				// returns `{ ok: false, reason: "cross_device" }` rather than transparently
				// copying across filesystems; we only branch on `.ok`, so a cross-device
				// staging root fails closed as a plain publish refusal. If this primitive
				// (or a future replacement) is ever changed to copy-then-delete across
				// devices on cross_device, the dev/ino-stability assumption behind
				// `stagedSnapshot` breaks silently and every identity-bound check in this
				// method becomes unsound.
				const publish = await renameDirectoryNoReplacePathAsync(token.stagedArtifactPath, finalPath);
				// Test seam only (no-op in production): lets a test deterministically
				// simulate a concurrent second writer republishing finalPath here,
				// exercising the foreign-owner branch below without weakening it.
				if (this.#opts.afterRestorePublish) await this.#opts.afterRestorePublish(finalPath);
				if (!publish.ok) {
					// A failed no-replace publish reports `mutationState`: "not_committed"
					// (proven nothing landed — e.g. destination_exists) is the ONLY case
					// safe to treat as a clean "someone else occupies finalPath, nothing of
					// ours was ever published" refusal. "unknown" (durability unprovable)
					// means the rename MAY have partially committed despite `.ok === false`
					// — that is NOT a clean refusal; it must be treated as uncertain and,
					// if we detached a backup, retained rather than silently dropped.
					// Cheap to confirm rather than assume: an lstat on `backup` right now,
					// not a derived-from-control-flow claim. If hadFinal but backup is not
					// actually there (a concurrent actor in the same 0700 tree unlinked or
					// replaced it between our detach and this check), omit the field rather
					// than report a stale path.
					const backupObservedNow = hadFinal
						? await fs.lstat(backup).then(
								() => true,
								() => false,
							)
						: false;
					if (publish.mutationState === "unknown") {
						throw new MarketplaceRestoreError("post_publish_identity_unconfirmed", {
							sideEffectStarted: true,
							outcome: "uncertain",
							...(backupObservedNow ? { retainedBackupPath: backup } : {}),
						});
					}
					// mutationState === "not_committed": proven nothing of ours landed at
					// finalPath. Our backup (if any) is intact and untouched; report
					// without entering the destructive rollback path below at all.
					throw new MarketplaceRestoreError("final_path_claimed_by_new_owner", {
						sideEffectStarted: hadFinal,
						outcome: "foreign_owner_conflict",
						...(backupObservedNow ? { retainedBackupPath: backup } : {}),
					});
				}
				published = true;
				// Confirmation, NOT authority: an independent post-publish snapshot must
				// agree with the pre-publish `stagedSnapshot` on entry count/content
				// (dev/ino legitimately differ across the parent-directory boundary the
				// rename crossed, but the tree's own content identity does not). A
				// mismatch here is never trusted as "ours" — it means a third party
				// touched finalPath in the sub-millisecond gap and is reported as
				// foreign_owner_conflict without deleting anything.
				const postPublishConfirm = await snapshotIfPresent(finalPath);
				// A mismatch here means the object at the canonical name is no longer the one
				// we just published: a concurrent owner claimed it. That is the same fact the
				// pre-publish refusal reports, so it carries the same reason code; an absent
				// or unreadable observation is only unconfirmed, not proof of a new owner.
				if (!postPublishConfirm || !sameDirectoryTreeIdentity(stagedSnapshot, postPublishConfirm)) {
					const claimed = postPublishConfirm !== undefined;
					// Real lstat confirmation, not derived-from-control-flow: `backup` was
					// last touched during Step 1 and nothing between then and here should
					// have moved it, but a concurrent actor in the same tree could have.
					const backupObservedNow = hadFinal
						? await fs.lstat(backup).then(
								() => true,
								() => false,
							)
						: false;
					throw new MarketplaceRestoreError(
						claimed ? "final_path_claimed_by_new_owner" : "post_publish_identity_unconfirmed",
						{
							sideEffectStarted: true,
							outcome: "foreign_owner_conflict",
							...(backupObservedNow ? { retainedBackupPath: backup } : {}),
						},
					);
				}
				const postDigest = await inspectCachedPlugin(finalPath);
				if (postDigest.status !== "present" || postDigest.digest !== token.candidateArtifact.digest)
					throw new MarketplaceRestoreError("post_publish_digest_mismatch", { sideEffectStarted: true });
				const nextEntry: InstalledPluginEntry = {
					...current,
					installPath: finalPath,
					gitCommitSha: token.pinnedSha,
					enabled: current.enabled,
					lastUpdated: new Date().toISOString(),
				};
				// Replace ONLY the matched sibling; every other entry under this
				// pluginId (other scopes' duplicates recorded in this same file, if
				// any) is preserved verbatim, in order.
				const nextSiblings = [...siblings];
				nextSiblings[matchIndex] = nextEntry;
				try {
					await writeInstalledPluginsRegistry(registryPath, {
						...registry,
						plugins: { ...registry.plugins, [token.pluginId]: nextSiblings },
					});
				} catch {
					// Registry write failed after the fs swap succeeded: roll the fs pair
					// back so artifact and registry never drift out of the pair they were
					// published as.
					throw new MarketplaceRestoreError("registry_write_failed", {
						sideEffectStarted: true,
						outcome: "conflict",
					});
				}
				// Independent post-write observation, BEFORE the backup is discarded:
				// re-read installed_plugins.json FROM DISK (not the in-memory
				// registry/nextEntry we just wrote), so success evidence is a fresh
				// observation of the actually-persisted state rather than an echo of the
				// write input. The artifact itself was ALREADY independently confirmed
				// (postDigest, above) before this registry write was even attempted, so
				// there is no separate artifact-durability question left to re-ask here.
				// Exact-CAS-bound registry revert used by both verification failure
				// branches below: reverts to the EXACT pre-write `registry` object this
				// call itself read at the top (preserving every sibling scope and any
				// concurrent unrelated edit that object already captured), then
				// independently re-reads the file to CONFIRM the revert actually landed
				// — never silently swallowed. If the revert write throws, or the
				// post-revert re-read does not exactly match the pre-write registry for
				// this pluginId's entries, that is NOT a clean rollback: it is reported
				// as `uncertain`, never folded into a bare `failed`/silently-assumed
				// `conflict`.
				const revertRegistryAndVerify = async (reasonCode: MarketplaceRestoreReasonCode): Promise<never> => {
					let revertWriteOk = true;
					try {
						await writeInstalledPluginsRegistry(registryPath, registry);
					} catch {
						revertWriteOk = false;
					}
					const revertConfirmed = revertWriteOk
						? await readInstalledPluginsRegistry(registryPath).then(
								reverted =>
									JSON.stringify(getInstalledPlugin(reverted, token.pluginId) ?? []) ===
									JSON.stringify(siblings),
								() => false,
							)
						: false;
					throw new MarketplaceRestoreError(reasonCode, {
						sideEffectStarted: true,
						// Registry revert verified byte-for-byte against the exact pre-write
						// siblings this call read → conflict (installed state provably back
						// to before this apply). Unverified/failed revert → uncertain, since
						// the registry may now claim an entry the artifact pair does not
						// actually match.
						outcome: revertConfirmed ? "conflict" : "uncertain",
					});
				};
				const confirmedRegistry = await readInstalledPluginsRegistry(registryPath);
				const confirmedEntry = getInstalledPlugin(confirmedRegistry, token.pluginId)?.find(
					entry => entry.scope === token.scope,
				);
				if (!confirmedEntry || confirmedEntry.installPath !== finalPath) {
					// The registry write is not provably durable. Revert to the exact
					// pre-write CAS baseline and independently verify that revert before
					// classifying the outcome — never a silently-swallowed best-effort.
					throw await revertRegistryAndVerify("post_publish_registry_verification_failed");
				}
				// One final independent artifact re-verification, bound to this SAME
				// canonical registry+disk read (not the earlier postDigest snapshot):
				// the "verified" success result reported to the caller must be backed
				// by evidence gathered AFTER the registry write, not only before it —
				// otherwise a caller could report `verified` for a state that changed
				// again between the artifact check and the registry write.
				//
				// A durable write plus a successful digest check on a STALE read is not
				// proof: inspectCachedPlugin(path) alone reads by PATH ONLY and could
				// observe a DIFFERENT object if something replaced finalPath in the
				// interim yet coincidentally produced the same digest, or more subtly,
				// could simply race a concurrent mutation without any way to detect it.
				// Bind this final read to the exact identity captured at publish time
				// (`stagedSnapshot`, dev/ino-stable across the same-filesystem rename) via
				// the same sameDirectoryTreeIdentity check used to confirm the publish
				// itself — not merely re-reading the same path and hoping it is still
				// the same object.
				const finalSnapshot = await snapshotIfPresent(confirmedEntry.installPath);
				if (!finalSnapshot || !sameDirectoryTreeIdentity(stagedSnapshot, finalSnapshot)) {
					throw await revertRegistryAndVerify("post_publish_registry_verification_failed");
				}
				const finalDigest = await inspectCachedPlugin(confirmedEntry.installPath);
				if (finalDigest.status !== "present" || finalDigest.digest !== token.candidateArtifact.digest) {
					throw await revertRegistryAndVerify("post_publish_registry_verification_failed");
				}
				// Confirmed: only now is the backup discarded (identity-bound exact
				// removal, never a blind rm) and the mutation treated as durably
				// committed.
				if (hadFinal && backupSnapshot) {
					const backupParent = await fs.lstat(pluginsCacheDir, { bigint: true }).catch(() => undefined);
					if (backupParent)
						exactRemoveDirectoryTree(backup, backupSnapshot, { dev: backupParent.dev, ino: backupParent.ino });
				}
				this.#clearCache();
				return { status: "verified", sideEffectStarted: true, entry: confirmedEntry };
			} catch (error) {
				// If we never detached an original (nothing of ours to protect: either
				// !hadFinal, or a precheck refused before Step 1 ran), there is nothing
				// to roll back — rethrow as-is rather than touching finalPath at all,
				// which matters especially for !hadFinal: a foreign occupant that just
				// appeared there must never be snapshotted/removed by us.
				if (!hadFinal || !backupSnapshot) throw error;
				// A specific foreign-owner-conflict thrown above already fully
				// evaluated and reported the retained-backup state; do not re-run
				// rollback logic over it.
				if (error instanceof MarketplaceRestoreError && error.outcome === "foreign_owner_conflict") throw error;
				// From here we KNOW an original was detached into `backup`
				// (backupSnapshot is set), so finalPath is either empty (our publish
				// never landed) or holds our own just-published candidate (a later
				// step failed, e.g. registry write). Roll it back to the backup using
				// the SAME identity-bound exact-remove-then-no-replace-publish pattern:
				// never blind-rm/overwrite, and the object currently at finalPath must
				// match the snapshot we captured AT PUBLISH TIME (not a fresh re-snapshot
				// — a fresh snapshot would trivially "match" any foreign object currently
				// sitting there and defeat identity binding entirely).
				// Every retainedBackupPath below is a real lstat confirmation taken at
				// the point of the throw, not a name derived purely from control flow —
				// a concurrent actor in the same 0700 tree could in principle unlink or
				// replace `backup` between an earlier step and this error construction.
				const confirmBackupObserved = () =>
					fs.lstat(backup).then(
						() => true,
						() => false,
					);
				const finalPathExists = await fs
					.lstat(finalPath)
					.then(() => true)
					.catch(() => false);
				if (finalPathExists) {
					if (!published) {
						// Our own publish never actually landed (failure happened before Step 2
						// succeeded), yet something now occupies finalPath: that is necessarily
						// a foreign write, not ours — refuse to touch it rather than guess.
						const backupObservedNow = await confirmBackupObserved();
						throw new MarketplaceRestoreError("unexpected_occupant_before_our_publish", {
							sideEffectStarted: true,
							outcome: "uncertain",
							...(backupObservedNow ? { retainedBackupPath: backup } : {}),
						});
					}
					// stagedSnapshot (captured before our rename, dev/ino-stable across a
					// same-filesystem renameat) is the authoritative identity a rollback
					// removal binds to here — the same evidence used to confirm the publish
					// above, not a freshly re-derived snapshot that would trivially match
					// whatever a third party just wrote.
					const publishedParent = await fs.lstat(pluginsCacheDir, { bigint: true }).catch(() => undefined);
					if (!publishedParent) {
						const backupObservedNow = await confirmBackupObserved();
						throw new MarketplaceRestoreError("private_cache_root_missing", {
							sideEffectStarted: true,
							outcome: "uncertain",
							...(backupObservedNow ? { retainedBackupPath: backup } : {}),
						});
					}
					const removedPublished = exactRemoveDirectoryTree(finalPath, stagedSnapshot, {
						dev: publishedParent.dev,
						ino: publishedParent.ino,
					});
					if (!treeRemoved(removedPublished)) {
						const backupObservedNow = await confirmBackupObserved();
						// `identity_mismatch` is the only native outcome that proves the object at
						// finalPath is not the one we published — i.e. a new owner claimed it.
						// Any other refusal (an occupied detach slot, an I/O failure) means the
						// removal could not be carried out at all, which is unresolved, not proof
						// of a foreign claim. Reporting the wrong one of those two would either
						// slander a healthy state or hide an unfinished rollback.
						const claimed = removedPublished.code === "identity_mismatch";
						throw new MarketplaceRestoreError(
							claimed ? "final_path_claimed_by_new_owner" : "rollback_rename_failed",
							{
								sideEffectStarted: true,
								outcome: claimed ? "foreign_owner_conflict" : "uncertain",
								...(backupObservedNow ? { retainedBackupPath: backup } : {}),
							},
						);
					}
				}
				const restorePublish = await renameDirectoryNoReplacePathAsync(backup, finalPath);
				if (!restorePublish.ok) {
					// Restore failed: confirm what actually remains at `backup` right now
					// (the no-replace rename may have left it there proven-untouched, or
					// its outcome may be unprovable — either way, verify rather than assume).
					const backupObservedNow = await confirmBackupObserved();
					throw new MarketplaceRestoreError("rollback_rename_failed", {
						sideEffectStarted: true,
						outcome: "uncertain",
						...(backupObservedNow ? { retainedBackupPath: backup } : {}),
					});
				}
				const restoredDigest = await inspectCachedPlugin(finalPath);
				if (restoredDigest.status !== "present" || restoredDigest.digest !== currentArtifact.digest) {
					throw new MarketplaceRestoreError("rollback_digest_mismatch", {
						sideEffectStarted: true,
						outcome: "uncertain",
						retainedBackupPath: finalPath,
					});
				}
				if (error instanceof MarketplaceRestoreError) {
					// The FILESYSTEM half of rollback (artifact restored to `backup`,
					// digest-verified above) succeeded. But the triggering error may ALSO
					// carry its own already-computed outcome from an earlier, independent
					// verification — most notably `revertRegistryAndVerify`, whose
					// `uncertain` means the REGISTRY-level CAS revert could not be
					// confirmed even though the fs artifact rollback here succeeded.
					// Never force-upgrade that to `conflict`: the overall outcome must be
					// the worse of the two independent verifications, so a caller is never
					// told "clean rollback" when either half is unconfirmed.
					// The fs rollback already moved the artifact OUT of `backup` and back
					// onto finalPath (digest-verified above), so `backup` is no longer a
					// separate standalone artifact — no retainedBackupPath is carried
					// forward here regardless of which outcome wins.
					// `foreign_owner_conflict` on the triggering error described the state
					// BEFORE this rollback ran. The rollback has now removed our publication
					// and digest-verified the prior artifact back at the canonical name, so
					// nothing foreign remains there and reporting it as a foreign claim would
					// misdescribe the settled state; only genuine uncertainty survives.
					throw new MarketplaceRestoreError(error.reasonCode, {
						sideEffectStarted: true,
						outcome: error.outcome === "uncertain" ? "uncertain" : "conflict",
						...(error.detail !== undefined ? { detail: error.detail } : {}),
					});
				}
				// A non-MarketplaceRestoreError (e.g. a raw filesystem error) reaching
				// here: reasonCode stays a fixed enum member ("restore_publish_failed"),
				// never the interpolated Error.message, which is only carried in the
				// private `detail` field.
				throw new MarketplaceRestoreError("restore_publish_failed", {
					sideEffectStarted: true,
					outcome: "conflict",
					...(error instanceof Error ? { detail: error.message } : {}),
				});
			}
		});
	}

	// ── Install / uninstall ────────────────────────────────────────────────────────────

	async installPlugin(
		name: string,
		marketplace: string,
		options?: { force?: boolean; scope?: "user" | "project" },
	): Promise<InstalledPluginEntry> {
		const force = options?.force ?? false;
		const scope = options?.scope ?? "user";
		const registryPath = this.#registryPath(scope);

		// 1. Find marketplace entry
		const mktReg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const mktEntry = getMarketplaceEntry(mktReg, marketplace);
		if (!mktEntry) {
			throw new Error(`Marketplace "${marketplace}" not found`);
		}

		// 2. Find plugin in catalog
		const catalog = await this.#readCatalog(mktEntry);
		const pluginEntry = catalog.plugins.find(p => p.name === name);
		if (!pluginEntry) {
			throw new Error(`Plugin "${name}" not found in marketplace "${marketplace}"`);
		}

		const pluginId = buildPluginId(name, marketplace);

		// Steps 3-6 (registry read-check, source resolve/cache, and the final
		// registry read-modify-write) run under the SAME registry lock every other
		// writer of this file (applyPluginRestore, uninstallPlugin,
		// setPluginEnabled) now takes, so the already-installed check and the
		// terminal write are CAS-consistent against concurrent writers rather than
		// racing them.
		return await withFileLock(registryPath, async () => {
			// 3. Check if already installed
			const instReg = await readInstalledPluginsRegistry(registryPath);
			const existing = getInstalledPlugin(instReg, pluginId);
			if (existing && existing.length > 0 && !force) {
				throw new Error(`Plugin "${pluginId}" is already installed. Use force option to reinstall.`);
			}
			const existingCachePaths = existing ? await this.#validateCacheDeletionTargets(pluginId, existing) : [];

			// 4. Resolve source path.
			// marketplaceClonePath is the marketplace root — the directory containing .Anthropic model-plugin/
			// catalogPath is <marketplacesCacheDir>/<name>/marketplace.json, so the root is two levels up.
			// For local sources the content was fetched from a local path; the stored catalog is a copy
			// under marketplacesCacheDir. We need the original source root for resolving relative paths.
			// Use: path.dirname(catalogPath) is <cacheDir>/<name>/, and that IS the stored copy root,
			// so `path.resolve(mktEntry.catalogPath, "../..")` = parent of <name>/ inside cacheDir
			// which is wrong for local sources. Instead, derive from the stored catalog directory:
			// stored at: <marketplacesCacheDir>/<catalogName>/marketplace.json
			// The marketplace root for local sources should be the actual local path, but we only have
			// sourceUri. For local sources, use path.resolve of sourceUri; for others use the cache dir.
			const marketplaceClonePath = this.#resolveMarketplaceRoot(mktEntry);

			// URL-sourced marketplaces only cache marketplace.json, not the full plugin tree.
			// Relative string sources ("./plugins/foo") cannot be resolved against the cache dir.
			if (mktEntry.sourceType === "url" && typeof pluginEntry.source === "string") {
				throw new Error(
					`Plugin "${name}" uses a relative source path but marketplace "${marketplace}" was added via URL. ` +
						`Relative sources require a git or local marketplace. Re-add the marketplace using its git URL.`,
				);
			}

			const { dir: sourcePath, tempCloneRoot } = await resolvePluginSource(pluginEntry, {
				marketplaceClonePath,
				catalogMetadata: catalog.metadata,
				tmpDir: os.tmpdir(),
			});

			// 5. Determine version: catalog entry > plugin manifest > git SHA > fallback
			let version!: string;
			let cachePath!: string;
			try {
				version = await this.#resolvePluginVersion(pluginEntry, sourcePath);
				if ([marketplace, name, version].some(component => /[. ]$/.test(component))) {
					throw new Error(`Invalid cache identity for plugin "${pluginId}"`);
				}
				cachePath = await cachePlugin(sourcePath, this.#opts.pluginsCacheDir, marketplace, name, version);
				await this.#writeEmbeddedLspConfig(pluginEntry, cachePath);
			} finally {
				// Clean up temp clone dirs created by resolvePluginSource; leave user-supplied local dirs alone
				if (tempCloneRoot) {
					await fs.rm(tempCloneRoot, { recursive: true, force: true }).catch(() => {});
				}
			}

			// Only now clean up old entries — new cache succeeded, so it is safe to remove old ones.
			if (existing && existing.length > 0) {
				// Remove from scope-appropriate registry first, then cross-check refs before disk deletion.
				const prunedReg = removeInstalledPlugin(await readInstalledPluginsRegistry(registryPath), pluginId);
				await writeInstalledPluginsRegistry(registryPath, prunedReg);

				// Read both registries AFTER removal — only delete paths no longer referenced by either.
				const [userReg, projectReg] = await Promise.all([
					readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
					this.#opts.projectInstalledRegistryPath
						? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
						: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
				]);
				const referenced = this.#collectReferencedCacheIdentities(userReg, projectReg);
				const cachePathIdentity = this.#cacheDeletionIdentity(cachePath);

				for (const existingCachePath of existingCachePaths) {
					const existingIdentity = this.#cacheDeletionIdentity(existingCachePath);
					if (existingIdentity !== cachePathIdentity && !referenced.has(existingIdentity)) {
						await fs.rm(existingCachePath, { recursive: true, force: true });
					}
				}
			}

			// 6. Build and register the entry, preserving enabled state from previous install
			const now = new Date().toISOString();
			// Carry over enabled flag from existing entry — a disabled plugin must stay disabled after upgrade
			const wasDisabled = existing?.some(e => e.enabled === false);
			const installedEntry: InstalledPluginEntry = {
				scope,
				installPath: cachePath,
				version,
				installedAt: now,
				lastUpdated: now,
				...(wasDisabled ? { enabled: false } : {}),
			};

			const freshInstReg = await readInstalledPluginsRegistry(registryPath);
			const newInstReg = addInstalledPlugin(freshInstReg, pluginId, installedEntry);
			await writeInstalledPluginsRegistry(registryPath, newInstReg);

			this.#clearCache();

			logger.debug("Plugin installed", { pluginId, version, cachePath });
			return installedEntry;
		});
	}

	async #writeEmbeddedLspConfig(entry: MarketplacePluginEntry, cachePath: string): Promise<void> {
		const lspServers = entry.lspServers;
		if (!lspServers) return;

		const targetPath = path.join(cachePath, ".lsp.json");
		if (typeof lspServers === "string") {
			const sourcePath = path.resolve(cachePath, lspServers);
			if (!pathIsWithin(cachePath, sourcePath)) {
				throw new Error(`Plugin "${entry.name}" lspServers path escapes the plugin directory`);
			}
			const content = await Bun.file(sourcePath).text();
			await Bun.write(targetPath, content);
			return;
		}

		await Bun.write(targetPath, `${JSON.stringify({ servers: lspServers }, null, 2)}\n`);
	}

	/**
	 * Resolve plugin version from multiple sources:
	 * 1. Catalog entry version (if set)
	 * 2. Plugin manifest (.Anthropic model-plugin/plugin.json or package.json)
	 * 3. Git SHA from source (truncated to 7 chars)
	 * 4. Fallback "0.0.0"
	 */
	async #resolvePluginVersion(entry: MarketplacePluginEntry, sourcePath: string): Promise<string> {
		// 1. Catalog entry version
		if (entry.version) return entry.version;

		// 2. Plugin manifest
		for (const manifestPath of [
			path.join(sourcePath, ".claude-plugin", "plugin.json"),
			path.join(sourcePath, "package.json"),
		]) {
			try {
				const content = await Bun.file(manifestPath).json();
				if (typeof content?.version === "string" && content.version) {
					return content.version;
				}
			} catch {
				// Missing or invalid — try next
			}
		}

		// 3. Git SHA from source definition
		if (typeof entry.source === "object" && "sha" in entry.source && entry.source.sha) {
			return entry.source.sha.slice(0, 7);
		}

		return "0.0.0";
	}

	async #validateCacheDeletionTargets(pluginId: string, entries: readonly InstalledPluginEntry[]): Promise<string[]> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID format: "${pluginId}". Expected "name@marketplace".`);
		}

		const targets: string[] = [];
		for (const entry of entries) {
			if ([parsed.marketplace, parsed.name, entry.version].some(component => /[. ]$/.test(component))) {
				throw new Error(`Refusing to remove plugin "${pluginId}": invalid recorded cache identity`);
			}

			let targetPath: string;
			try {
				targetPath = getCachedPluginPath(
					this.#opts.pluginsCacheDir,
					parsed.marketplace,
					parsed.name,
					entry.version,
				);
			} catch (error) {
				throw new Error(`Refusing to remove plugin "${pluginId}": invalid recorded cache identity`, {
					cause: error,
				});
			}

			if (entry.installPath !== targetPath) {
				throw new Error(`Refusing to remove plugin "${pluginId}": recorded install path is not its cache path`);
			}

			try {
				const stat = await fs.lstat(targetPath);
				if (stat.isSymbolicLink()) {
					throw new Error(`Refusing to remove plugin "${pluginId}": cache path is a symbolic link or junction`);
				}
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}

			targets.push(targetPath);
		}
		return targets;
	}

	#cacheDeletionIdentity(cachePath: string): string {
		// Model Windows path identity on every host so reference protection is
		// deterministic: case is ignored and trailing dots/spaces are discarded.
		return path
			.resolve(cachePath)
			.split(path.sep)
			.map(component => component.replace(/[. ]+$/, "").toLowerCase())
			.join(path.sep);
	}

	#collectReferencedCacheIdentities(...registries: InstalledPluginsRegistry[]): Set<string> {
		const identities = new Set<string>();
		for (const registry of registries) {
			for (const [pluginId, entries] of Object.entries(registry.plugins)) {
				const parsed = parsePluginId(pluginId);
				if (!parsed) continue;
				for (const entry of entries) {
					try {
						const cachePath = getCachedPluginPath(
							this.#opts.pluginsCacheDir,
							parsed.marketplace,
							parsed.name,
							entry.version,
						);
						identities.add(this.#cacheDeletionIdentity(cachePath));
					} catch {
						// Invalid registry entries cannot identify a permitted cache target.
					}
				}
			}
		}
		return identities;
	}

	/**
	 * Resolve which installed copy an uninstall would remove.
	 *
	 * Strictly read-only, and the shared preflight for {@link uninstallPlugin}:
	 * target lookup, scope disambiguation, and cache-path validation all happen
	 * here, so a preview refuses exactly what the real uninstall refuses.
	 */
	async resolveUninstallTarget(
		pluginId: string,
		scope?: "user" | "project",
	): Promise<{
		scope: "user" | "project";
		entries: InstalledPluginEntry[];
		cachePaths: string[];
		registry: InstalledPluginsRegistry;
	}> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID format: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		// Disambiguation: if installed in both scopes and no explicit scope, require one.
		let targetScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to remove.`,
				);
			}
			targetScope = scope;
		} else if (inProject) {
			if (scope === "user") {
				throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			}
			targetScope = "project";
		} else {
			if (scope === "project") {
				throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			}
			targetScope = "user";
		}

		const entries = targetScope === "project" ? projectEntries! : userEntries!;
		return {
			scope: targetScope,
			entries,
			cachePaths: await this.#validateCacheDeletionTargets(pluginId, entries),
			registry: targetScope === "project" ? projectReg : userReg,
		};
	}

	async uninstallPlugin(pluginId: string, scope?: "user" | "project"): Promise<void> {
		// Resolve the target and hold the same shared registry lock across both the
		// resolve and the write, so a concurrent writer cannot change which entry
		// this removes between the read and the write (the un-locked
		// resolveUninstallTarget remains available separately for read-only CLI
		// dry-run preview, which never mutates and therefore needs no CAS).
		const registryPathFor = (targetScope: "user" | "project") => this.#registryPath(targetScope);
		const userLockPath = this.#opts.installedRegistryPath;
		const projectLockPath = this.#opts.projectInstalledRegistryPath;
		// Lock BOTH scope registries in a fixed order (user, then project) so a
		// disambiguation decision that must inspect both scopes is made under
		// exclusion against every other writer of either file, avoiding deadlock
		// with any other caller that also locks in this same order.
		await withFileLock(userLockPath, async () => {
			const runUnderProjectLock = async (): Promise<void> => {
				const {
					scope: targetScope,
					cachePaths: targetCachePaths,
					registry: targetReg,
				} = await this.resolveUninstallTarget(pluginId, scope);
				const registryPath = registryPathFor(targetScope);

				const updatedReg = removeInstalledPlugin(targetReg, pluginId);
				await writeInstalledPluginsRegistry(registryPath, updatedReg);

				// Read both registries AFTER removal — only delete paths no longer referenced by either.
				const [freshUserReg, freshProjectReg] = await Promise.all([
					readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
					this.#opts.projectInstalledRegistryPath
						? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
						: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
				]);
				const referenced = this.#collectReferencedCacheIdentities(freshUserReg, freshProjectReg);

				for (const targetCachePath of targetCachePaths) {
					if (!referenced.has(this.#cacheDeletionIdentity(targetCachePath))) {
						await fs.rm(targetCachePath, { recursive: true, force: true });
					}
				}

				this.#clearCache();

				logger.debug("Plugin uninstalled", { pluginId, scope: targetScope });
			};
			if (projectLockPath) await withFileLock(projectLockPath, runUnderProjectLock);
			else await runUnderProjectLock();
		});
	}

	// ── Plugin state ──────────────────────────────────────────────────────────

	async listInstalledPlugins(): Promise<InstalledPluginSummary[]> {
		const userReg = await readInstalledPluginsRegistry(this.#opts.installedRegistryPath);
		const projectReg = this.#opts.projectInstalledRegistryPath
			? await readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
			: null;

		// Only enabled project installs shadow user installs — a disabled project copy leaves
		// the user entry as the active one and must not be reported as shadowed.
		const activeProjectIds = new Set(
			projectReg
				? Object.entries(projectReg.plugins)
						.filter(([, entries]) => entries.length > 0 && entries[0].enabled !== false)
						.map(([id]) => id)
				: [],
		);
		const results: InstalledPluginSummary[] = [];

		// Project entries first
		if (projectReg) {
			for (const [id, entries] of Object.entries(projectReg.plugins)) {
				results.push({ id, scope: "project", entries });
			}
		}
		// User entries (shadow-marked if overridden by project)
		for (const [id, entries] of Object.entries(userReg.plugins)) {
			results.push({
				id,
				scope: "user",
				entries,
				...(activeProjectIds.has(id) ? { shadowedBy: "project" as const } : {}),
			});
		}
		return results;
	}

	async setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<void> {
		// Same fixed user->project lock order as uninstallPlugin: the entire
		// disambiguation read plus the write runs under exclusion against every
		// other registry writer.
		const projectLockPath = this.#opts.projectInstalledRegistryPath;
		const runUnderProjectLock = async (): Promise<void> => {
			const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);

			const inUser = userEntries && userEntries.length > 0;
			const inProject = projectEntries && projectEntries.length > 0;

			if (!inUser && !inProject) {
				throw new Error(`Plugin "${pluginId}" is not installed`);
			}

			// Disambiguation: if installed in both scopes and no explicit scope, require one.
			let targetScope: "user" | "project";
			if (inUser && inProject) {
				if (!scope) {
					throw new Error(
						`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to modify.`,
					);
				}
				targetScope = scope;
			} else if (inProject) {
				if (scope === "user") {
					throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
				}
				targetScope = "project";
			} else {
				if (scope === "project") {
					throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
				}
				targetScope = "user";
			}

			const reg = targetScope === "project" ? projectReg : userReg;
			const entries = targetScope === "project" ? projectEntries! : userEntries!;
			const registryPath = this.#registryPath(targetScope);

			const updated = {
				...reg,
				plugins: {
					...reg.plugins,
					[pluginId]: entries.map(e => ({ ...e, enabled })),
				},
			};
			await writeInstalledPluginsRegistry(registryPath, updated);

			this.#clearCache();

			logger.debug("Plugin enabled state changed", { pluginId, enabled, scope: targetScope });
		};
		await withFileLock(this.#opts.installedRegistryPath, async () => {
			if (projectLockPath) await withFileLock(projectLockPath, runUnderProjectLock);
			else await runUnderProjectLock();
		});
	}

	// ── Update / upgrade ─────────────────────────────────────────────────────

	// Refresh marketplace catalogs that haven't been updated in more than 24 h.
	// Per-marketplace failures are silently swallowed — offline is fine.
	async refreshStaleMarketplaces(): Promise<void> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const staleMs = 24 * 60 * 60 * 1000;
		for (const entry of reg.marketplaces) {
			if (Date.now() - Date.parse(entry.updatedAt) >= staleMs) {
				try {
					await this.updateMarketplace(entry.name);
				} catch {
					// Network or parse failure — leave stale, try next time.
				}
			}
		}
	}

	// Compare installed plugin versions against their catalog entries.
	// Returns one entry per (pluginId, scope) pair where the catalog declares a newer version.
	// Catalog entries without a version field are skipped.
	async checkForUpdates(): Promise<Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>> {
		const mktReg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const updates: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];

		// Keyed by (path, scope) so each scope is checked independently.
		// A plugin current in user scope but stale in project scope must still appear.
		const registryEntries: Array<[string, "user" | "project"]> = [[this.#opts.installedRegistryPath, "user"]];
		if (this.#opts.projectInstalledRegistryPath) {
			registryEntries.push([this.#opts.projectInstalledRegistryPath, "project"]);
		}

		for (const [regPath, scope] of registryEntries) {
			const instReg = await readInstalledPluginsRegistry(regPath);
			for (const [pluginId, entries] of Object.entries(instReg.plugins)) {
				const parsed = parsePluginId(pluginId);
				if (!parsed) continue;
				const installed = entries[0];
				if (!installed) continue;

				const mktEntry = mktReg.marketplaces.find(m => m.name === parsed.marketplace);
				if (!mktEntry) continue;

				let catalogVersion: string | undefined;
				try {
					const catalog = await this.#readCatalog(mktEntry);
					catalogVersion = catalog.plugins.find(p => p.name === parsed.name)?.version;
				} catch {
					continue;
				}

				if (!catalogVersion || catalogVersion === installed.version) continue;

				// Treat newer semver as an update; fall back to inequality for non-semver tags.
				let isNewer: boolean;
				try {
					isNewer = Bun.semver.order(catalogVersion, installed.version) > 0;
				} catch {
					isNewer = catalogVersion !== installed.version;
				}

				if (isNewer) {
					updates.push({ pluginId, scope, from: installed.version, to: catalogVersion });
				}
			}
		}

		return updates;
	}

	// Re-install a specific plugin at the latest catalog version (force-overwrites).
	async upgradePlugin(pluginId: string, scope?: "user" | "project"): Promise<InstalledPluginEntry> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		let resolvedScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to upgrade.`,
				);
			}
			resolvedScope = scope;
		} else if (inProject) {
			if (scope === "user") throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			resolvedScope = "project";
		} else {
			if (scope === "project") throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			resolvedScope = "user";
		}

		return this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: resolvedScope });
	}

	// Upgrade a plugin across all scopes where it is installed.
	// Returns one entry per scope upgraded (0–2 entries).
	async upgradePluginAcrossScopes(pluginId: string): Promise<InstalledPluginEntry[]> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		const results: InstalledPluginEntry[] = [];

		if (inProject) {
			const entry = await this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: "project" });
			results.push(entry);
		}
		if (inUser) {
			const entry = await this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: "user" });
			results.push(entry);
		}

		return results;
	}

	// Upgrade every (pluginId, scope) pair that checkForUpdates reports as outdated.
	// Only stale scopes are touched; a current user install is not re-installed when only
	// the project scope is stale. Per-entry failures are skipped — partial success is returned.
	async upgradeAllPlugins(): Promise<
		Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>
	> {
		const updates = await this.checkForUpdates();
		const results: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];
		for (const update of updates) {
			try {
				const entry = await this.upgradePlugin(update.pluginId, update.scope);
				results.push({ pluginId: update.pluginId, scope: update.scope, from: update.from, to: entry.version });
			} catch {
				// Skip this entry; partial upgrades are better than none.
			}
		}
		return results;
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	#registryPath(scope: "user" | "project"): string {
		if (scope === "project") {
			if (!this.#opts.projectInstalledRegistryPath) {
				throw new Error("project-scoped install requires running inside a project directory");
			}
			return this.#opts.projectInstalledRegistryPath;
		}
		return this.#opts.installedRegistryPath;
	}

	async #findInBothRegistries(pluginId: string): Promise<{
		userEntries: InstalledPluginEntry[] | undefined;
		projectEntries: InstalledPluginEntry[] | undefined;
		userReg: InstalledPluginsRegistry;
		projectReg: InstalledPluginsRegistry;
	}> {
		const [userReg, projectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		return {
			userEntries: getInstalledPlugin(userReg, pluginId),
			projectEntries: getInstalledPlugin(projectReg, pluginId),
			userReg,
			projectReg,
		};
	}

	async #readCatalog(entry: MarketplaceRegistryEntry): Promise<MarketplaceCatalog> {
		try {
			const content = await Bun.file(entry.catalogPath).text();
			return parseMarketplaceCatalog(content, entry.catalogPath);
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(
					`Marketplace catalog not found at ${entry.catalogPath}. Try: /marketplace update ${entry.name}`,
				);
			}
			throw err;
		}
	}

	/**
	 * Compute the marketplace root directory for source resolution.
	 *
	 * For local sources: sourceUri IS the local path, so resolve it directly.
	 * This gives the directory containing `.Anthropic model-plugin/marketplace.json`,
	 * which is what resolvePluginSource expects as `marketplaceClonePath`.
	 *
	 * For remote sources (git/github/url): the catalog was cloned into
	 * `<marketplacesCacheDir>/<name>/`, so the root is the parent of catalogPath.
	 */
	#resolveMarketplaceRoot(entry: MarketplaceRegistryEntry): string {
		if (entry.sourceType === "local") {
			// expandHome already happened in fetcher; resolve to ensure absolute.
			const expanded = entry.sourceUri.startsWith("~/")
				? path.join(os.homedir(), entry.sourceUri.slice(2))
				: entry.sourceUri;
			return path.resolve(expanded);
		}
		// For git/github/url sources, the catalog lives at <cloneDir>/marketplace.json
		// under marketplacesCacheDir/<name>/; parent = <marketplacesCacheDir>/<name>/
		return path.dirname(entry.catalogPath);
	}
}
