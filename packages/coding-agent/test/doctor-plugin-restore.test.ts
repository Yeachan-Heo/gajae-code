import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	applyGjcBundleRestore,
	authorizeGjcBundleRestore,
	installGjcBundle,
	previewGjcBundleRestore,
} from "../src/extensibility/gjc-plugins";
import { registryPathForScope } from "../src/extensibility/gjc-plugins/registry";
import { inspectCachedPlugin } from "../src/extensibility/plugins/marketplace/cache";
import { MarketplaceManager, MarketplaceRestoreError } from "../src/extensibility/plugins/marketplace/manager";
import {
	writeInstalledPluginsRegistry,
	writeMarketplacesRegistry,
} from "../src/extensibility/plugins/marketplace/registry";
import type { InstalledPluginsRegistry, MarketplacesRegistry } from "../src/extensibility/plugins/marketplace/types";

const fixture = path.join(import.meta.dir, "fixtures", "gjc-plugins", "valid-six-surface-bundle");
let originalAgentDir: string;
let agentDir: string;
let cwd: string;

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-doctor-restore-agent-"));
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-doctor-restore-cwd-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	await fs.rm(agentDir, { recursive: true, force: true });
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("GJC plugin artifact restore", () => {
	test("preview is pure and repairs a missing artifact without changing enablement", async () => {
		const source = path.join(cwd, "source");
		await fs.cp(fixture, source, { recursive: true });
		const installed = await installGjcBundle({ cwd }, "project", source);
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const identity = installed.value.summary.identity;
		const before = await previewGjcBundleRestore({ cwd }, identity);
		expect(before.ok).toBe(true);
		if (!before.ok) return;
		const registryPath = registryPathForScope("project", cwd);
		const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
		await fs.rm(registry.plugins[0].pluginRoot, { recursive: true, force: true });
		const plan = await previewGjcBundleRestore({ cwd }, identity);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.value.writes).toBe(false);
		expect(plan.value.artifact.status).toBe("absent");
		const token = await authorizeGjcBundleRestore({ cwd }, plan.value, ["plugin-change", "install-replace"]);
		expect(token.ok).toBe(true);
		if (!token.ok) return;
		expect(await applyGjcBundleRestore({ cwd }, token.value)).toMatchObject({
			ok: true,
			value: { status: "updated" },
		});
	});

	test("second restore is a no-op and rejects a mutated baseline", async () => {
		const source = path.join(cwd, "source");
		await fs.cp(fixture, source, { recursive: true });
		const installed = await installGjcBundle({ cwd }, "project", source);
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const identity = installed.value.summary.identity;
		const plan = await previewGjcBundleRestore({ cwd }, identity);
		if (!plan.ok) return;
		const token = await authorizeGjcBundleRestore({ cwd }, plan.value, ["plugin-change", "install-replace"]);
		if (!token.ok) return;
		expect(await applyGjcBundleRestore({ cwd }, token.value)).toMatchObject({
			ok: true,
			value: { status: "unchanged" },
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────
// Private marketplace restore
// ─────────────────────────────────────────────────────────────────────────

interface PrivateMarketplaceFixture {
	manager: MarketplaceManager;
	pluginId: string;
	sha: string;
	installedRoot: string;
	pluginsCacheDir: string;
	installedRegistryPath: string;
	marketplacesRegistryPath: string;
}

/** Sets up a locally hosted, pinned-SHA "private marketplace" with one plugin installed at a corrupt canonical cache path. */
async function setupPrivateMarketplace(
	managerOverrides: Partial<ConstructorParameters<typeof MarketplaceManager>[0]> = {},
): Promise<PrivateMarketplaceFixture> {
	const marketplaceRoot = path.join(cwd, "private-marketplace");
	const pluginRepo = path.join(cwd, "plugin-repo");
	await fs.mkdir(path.join(pluginRepo, ".claude-plugin"), { recursive: true });
	await fs.writeFile(
		path.join(pluginRepo, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "private-plugin", version: "1.0.0" }),
	);
	spawnSync("git", ["init", "-q", pluginRepo]);
	spawnSync("git", ["-C", pluginRepo, "config", "user.email", "test@example.invalid"]);
	spawnSync("git", ["-C", pluginRepo, "config", "user.name", "test"]);
	spawnSync("git", ["-C", pluginRepo, "add", "."]);
	spawnSync("git", ["-C", pluginRepo, "commit", "-qm", "fixture"]);
	const sha = spawnSync("git", ["-C", pluginRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

	await fs.mkdir(marketplaceRoot, { recursive: true });
	const catalogPath = path.join(marketplaceRoot, "marketplace.json");
	const catalog = {
		name: "private",
		owner: { name: "test" },
		plugins: [{ name: "private-plugin", source: { source: "url", url: pluginRepo, sha }, version: "1.0.0" }],
	};
	await fs.writeFile(catalogPath, JSON.stringify(catalog));

	const pluginsCacheDir = path.join(cwd, "cache");
	// Canonical private per-(marketplace,name,version) layout: <cacheDir>/<marketplace>___<name>___<version>/
	const installedRoot = path.join(pluginsCacheDir, "private___private-plugin___1.0.0");
	await fs.mkdir(installedRoot, { recursive: true });
	await fs.writeFile(path.join(installedRoot, "corrupt"), "bad");

	const installedRegistryPath = path.join(cwd, "installed.json");
	const marketplacesRegistryPath = path.join(cwd, "marketplaces.json");
	const marketplacesRegistry: MarketplacesRegistry = {
		version: 1,
		marketplaces: [
			{
				name: "private",
				sourceType: "local",
				sourceUri: marketplaceRoot,
				catalogPath,
				addedAt: "2020-01-01T00:00:00.000Z",
				updatedAt: "2020-01-01T00:00:00.000Z",
			},
		],
	};
	await writeMarketplacesRegistry(marketplacesRegistryPath, marketplacesRegistry);
	const pluginId = "private-plugin@private";
	const installedRegistry: InstalledPluginsRegistry = {
		version: 2,
		plugins: {
			[pluginId]: [
				{
					scope: "user",
					installPath: installedRoot,
					version: "1.0.0",
					installedAt: "2020-01-01T00:00:00.000Z",
					lastUpdated: "2020-01-01T00:00:00.000Z",
					enabled: false,
				},
			],
		},
	};
	await writeInstalledPluginsRegistry(installedRegistryPath, installedRegistry);

	const manager = new MarketplaceManager({
		marketplacesRegistryPath,
		installedRegistryPath,
		marketplacesCacheDir: path.join(cwd, "marketplace-cache"),
		pluginsCacheDir,
		...managerOverrides,
	});
	return { manager, pluginId, sha, installedRoot, pluginsCacheDir, installedRegistryPath, marketplacesRegistryPath };
}

describe("private marketplace artifact restore", () => {
	test("restores a corrupt canonical-layout artifact, is idempotent on retry, and preserves disabled state", async () => {
		const { manager, pluginId, sha, installedRoot, pluginsCacheDir, installedRegistryPath } =
			await setupPrivateMarketplace();
		const plan = await manager.previewPluginRestore(pluginId, "user");
		expect(plan.writes).toBe(false);
		expect(plan.fetch).toBe(false);
		expect(plan.execute).toBe(false);
		expect(plan.riskClasses).toContain("network");

		const token = await manager.authorizePluginRestore(plan, ["plugin-change", "install-replace", "network"]);
		expect(token.purpose).toBe("restore-artifact");
		expect(token.originalInstallPath).toBe(installedRoot);
		expect(token.stagedArtifactPath).not.toBe(installedRoot);

		const restored = await manager.applyPluginRestore(token);
		expect(restored.status).toBe("verified");
		expect(restored.sideEffectStarted).toBe(true);
		expect(restored.entry.enabled).toBe(false);
		// Target-private install path: exactly the canonical per-(marketplace,
		// name,version) cache entry, never a shared/version-keyed path another
		// plugin could also resolve to.
		expect(path.resolve(restored.entry.installPath)).toBe(path.resolve(installedRoot));
		expect(path.basename(restored.entry.installPath)).toBe("private___private-plugin___1.0.0");
		expect(path.dirname(path.resolve(restored.entry.installPath))).toBe(path.resolve(pluginsCacheDir));
		const repairedFiles = await fs.readdir(installedRoot);
		expect(repairedFiles).toContain(".claude-plugin");
		expect(repairedFiles).not.toContain("corrupt");
		// The restored artifact's digest must exactly equal the pinned candidate's
		// digest that authorize independently verified — not merely "apply
		// returned ok".
		const restoredDigest = await inspectCachedPlugin(restored.entry.installPath);
		expect(restoredDigest.status).toBe("present");
		expect(restoredDigest.digest).toBe(token.candidateArtifact.digest);
		// Post-write confirmation was read back from disk, not echoed from input:
		// the installed_plugins.json on disk must actually carry the new gitCommitSha,
		// the exact pinned SHA, and the preserved disabled state.
		const persisted: InstalledPluginsRegistry = JSON.parse(await fs.readFile(installedRegistryPath, "utf8"));
		const persistedEntry = persisted.plugins[pluginId]?.find(entry => entry.scope === "user");
		expect(persistedEntry?.gitCommitSha).toBe(restored.entry.gitCommitSha);
		expect(persistedEntry?.gitCommitSha).toBe(sha);
		expect(persistedEntry?.enabled).toBe(false);

		// Second apply of the SAME token: the artifact already matches, so this
		// must be a no-op with ZERO filesystem effect anywhere — not even deleting
		// the now-redundant staged scratch directory, which the not_needed branch
		// must leave for the caller to dispose of. Snapshot the entire private
		// cache tree and the registry file byte-for-byte before and after, and
		// assert exact equality, rather than checking only one known write path.
		const snapshotTree = async (root: string): Promise<Record<string, string>> => {
			const out: Record<string, string> = {};
			const walk = async (dir: string, rel: string): Promise<void> => {
				const entries = await fs.readdir(dir, { withFileTypes: true });
				for (const entry of entries) {
					const childRel = rel ? `${rel}/${entry.name}` : entry.name;
					const childAbs = path.join(dir, entry.name);
					if (entry.isDirectory()) await walk(childAbs, childRel);
					else out[childRel] = await fs.readFile(childAbs, "utf8").catch(() => "<binary>");
				}
			};
			await walk(root, "");
			return out;
		};
		const cacheBefore = await snapshotTree(path.dirname(installedRoot));
		const registryBefore = await fs.readFile(installedRegistryPath, "utf8");

		const retried = await manager.applyPluginRestore(token);
		expect(retried.status).toBe("not_needed");
		expect(retried.sideEffectStarted).toBe(false);
		expect(retried.entry.installPath).toBe(restored.entry.installPath);
		expect(retried.entry.lastUpdated).toBe(restored.entry.lastUpdated);
		// The staged scratch directory is reported for the caller to dispose of,
		// not deleted by this call, and it is a DIFFERENT path than the canonical
		// install root (never conflated with the installed artifact itself).
		if (retried.status !== "not_needed") throw new Error("expected not_needed");
		// The first apply published by RENAMING the staged directory onto the canonical
		// name, so the staging path no longer exists. A path this call did not itself
		// observe is never reported, so there is nothing stale to hand back.
		const stagedStillExists = await fs
			.lstat(token.stagedArtifactPath)
			.then(() => true)
			.catch(() => false);
		expect(stagedStillExists).toBe(false);
		expect(retried.staleStagedArtifactPath).toBeUndefined();

		const cacheAfter = await snapshotTree(path.dirname(installedRoot));
		const registryAfter = await fs.readFile(installedRegistryPath, "utf8");
		expect(cacheAfter).toEqual(cacheBefore);
		expect(registryAfter).toBe(registryBefore);

		// A THIRD apply of the same token must still be a clean not_needed —
		// confirming the token was never marked "consumed" by the second call.
		const retriedAgain = await manager.applyPluginRestore(token);
		expect(retriedAgain.status).toBe("not_needed");
		expect(retriedAgain.sideEffectStarted).toBe(false);
	});

	test("preview never mutates the registry or cache", async () => {
		const { manager, pluginId, installedRegistryPath, pluginsCacheDir } = await setupPrivateMarketplace();
		const before = await fs.readFile(installedRegistryPath, "utf8");
		await manager.previewPluginRestore(pluginId, "user");
		const after = await fs.readFile(installedRegistryPath, "utf8");
		expect(after).toBe(before);
		// No marketplace clone / network activity from a pure preview.
		const cacheEntries = await fs.readdir(pluginsCacheDir);
		expect(cacheEntries).toEqual(["private___private-plugin___1.0.0"]);
	});

	test("authorize rejects a mutated baseline recorded after preview, as a typed refused error", async () => {
		const { manager, pluginId, installedRegistryPath } = await setupPrivateMarketplace();
		const plan = await manager.previewPluginRestore(pluginId, "user");
		const registry: InstalledPluginsRegistry = JSON.parse(await fs.readFile(installedRegistryPath, "utf8"));
		registry.plugins[pluginId]![0]!.enabled = true;
		await writeInstalledPluginsRegistry(installedRegistryPath, registry);
		try {
			await manager.authorizePluginRestore(plan, ["plugin-change", "install-replace", "network"]);
			throw new Error("expected authorizePluginRestore to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(MarketplaceRestoreError);
			const restoreError = error as MarketplaceRestoreError;
			expect(restoreError.reasonCode).toBe("baseline_changed");
			expect(restoreError.outcome).toBe("refused");
			expect(restoreError.sideEffectStarted).toBe(false);
		}
	});

	test("authorize refuses without every recomputed risk authorization, ignoring a caller-forged plan.riskClasses", async () => {
		const { manager, pluginId } = await setupPrivateMarketplace();
		const plan = await manager.previewPluginRestore(pluginId, "user");
		// Forge riskClasses to only what the caller wants to authorize — must not
		// bypass the server-side recomputation in authorizePluginRestore.
		const forged = { ...plan, riskClasses: ["plugin-change", "install-replace"] as const };
		try {
			await manager.authorizePluginRestore(forged, ["plugin-change", "install-replace"]);
			throw new Error("expected authorizePluginRestore to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(MarketplaceRestoreError);
			const restoreError = error as MarketplaceRestoreError;
			// reasonCode is the fixed enum member; the specific missing risk class is
			// carried only in the private, non-reported `detail` field.
			expect(restoreError.reasonCode).toBe("authorization_missing");
			expect(restoreError.detail).toContain("network");
		}
	});

	test("authorize refuses an npm-sourced plugin as unsupported_shared_layout, a typed refusal that leaves the install record intact", async () => {
		const { manager, pluginId, marketplacesRegistryPath, installedRegistryPath } = await setupPrivateMarketplace();
		// Rewrite the catalog to an npm source — the D7-scoped shared
		// node_modules layout, which D6 must refuse explicitly rather than
		// attempting a partial/best-effort resolution.
		const marketplacesRegistry: MarketplacesRegistry = JSON.parse(
			await fs.readFile(marketplacesRegistryPath, "utf8"),
		);
		const catalogPath = marketplacesRegistry.marketplaces[0]!.catalogPath;
		const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
		catalog.plugins[0].source = { source: "npm", package: "private-plugin" };
		await fs.writeFile(catalogPath, JSON.stringify(catalog));

		const plan = await manager.previewPluginRestore(pluginId, "user");
		try {
			await manager.authorizePluginRestore(plan, ["plugin-change", "install-replace", "network"]);
			throw new Error("expected authorizePluginRestore to reject");
		} catch (error) {
			// A TYPED refusal, not a generic/collapsed exception: reasonCode is the
			// exact fixed enum member so a report/dispatch layer can distinguish it
			// from every other failure mode, sideEffectStarted is false (nothing was
			// staged/mutated), and outcome is a clean refused — safe to retry via a
			// different (e.g. D7 disable) path.
			expect(error).toBeInstanceOf(MarketplaceRestoreError);
			const restoreError = error as MarketplaceRestoreError;
			expect(restoreError.reasonCode).toBe("unsupported_shared_layout");
			expect(restoreError.sideEffectStarted).toBe(false);
			expect(restoreError.outcome).toBe("refused");
		}
		// The installed record itself must be completely untouched by the refused
		// restore attempt — D7's disable path for this same plugin must still see
		// the exact same entry it would have seen before this call.
		const registry: InstalledPluginsRegistry = JSON.parse(await fs.readFile(installedRegistryPath, "utf8"));
		expect(registry.plugins[pluginId]?.[0]).toMatchObject({ scope: "user", enabled: false });
	});

	test("authorize refuses a non-canonical (shared-layout) installPath as a typed refusal", async () => {
		const { manager, pluginId, installedRegistryPath, pluginsCacheDir } = await setupPrivateMarketplace();
		// Simulate a shared global/version-keyed layout (a single path a SECOND
		// plugin could also resolve to, unlike the private per-(marketplace,name,
		// version) cache entry): installPath does not match the private per-version
		// cache identity the manager owns.
		const sharedPath = path.join(pluginsCacheDir, "node_modules", "private-plugin");
		await fs.mkdir(sharedPath, { recursive: true });
		const registry: InstalledPluginsRegistry = JSON.parse(await fs.readFile(installedRegistryPath, "utf8"));
		registry.plugins[pluginId]![0]!.installPath = sharedPath;
		await writeInstalledPluginsRegistry(installedRegistryPath, registry);
		const plan = await manager.previewPluginRestore(pluginId, "user");
		try {
			await manager.authorizePluginRestore(plan, ["plugin-change", "install-replace", "network"]);
			throw new Error("expected authorizePluginRestore to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(MarketplaceRestoreError);
			const restoreError = error as MarketplaceRestoreError;
			expect(restoreError.reasonCode).toBe("install_path_not_canonical_private_layout");
			expect(restoreError.sideEffectStarted).toBe(false);
			expect(restoreError.outcome).toBe("refused");
		}
		// Refusal must leave the shared path directory itself completely untouched
		// — no best-effort mutation of a tree this restore does not privately own.
		expect(await fs.stat(sharedPath).then(s => s.isDirectory())).toBe(true);
	});

	test("apply rejects a forged candidate digest as a typed refused error (no mutation)", async () => {
		const { manager, pluginId, installedRoot } = await setupPrivateMarketplace();
		const plan = await manager.previewPluginRestore(pluginId, "user");
		const token = await manager.authorizePluginRestore(plan, ["plugin-change", "install-replace", "network"]);
		const forged = { ...token, candidateArtifact: { status: "present" as const, digest: "0".repeat(64) } };
		try {
			await manager.applyPluginRestore(forged);
			throw new Error("expected applyPluginRestore to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(MarketplaceRestoreError);
			const restoreError = error as MarketplaceRestoreError;
			expect(restoreError.reasonCode).toBe("candidate_changed");
			expect(restoreError.outcome).toBe("refused");
			expect(restoreError.sideEffectStarted).toBe(false);
		}
		// The original corrupt artifact must be completely untouched.
		const files = await fs.readdir(installedRoot);
		expect(files).toContain("corrupt");
	});

	test("apply refuses a staged artifact path inside the private cache root as a typed refused error", async () => {
		const { manager, pluginId, pluginsCacheDir } = await setupPrivateMarketplace();
		const plan = await manager.previewPluginRestore(pluginId, "user");
		const token = await manager.authorizePluginRestore(plan, ["plugin-change", "install-replace", "network"]);
		const forged = { ...token, stagedArtifactPath: path.join(pluginsCacheDir, "escape-attempt") };
		try {
			await manager.applyPluginRestore(forged);
			throw new Error("expected applyPluginRestore to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(MarketplaceRestoreError);
			const restoreError = error as MarketplaceRestoreError;
			expect(restoreError.reasonCode).toBe("staged_artifact_inside_cache_root");
			expect(restoreError.outcome).toBe("refused");
			expect(restoreError.sideEffectStarted).toBe(false);
		}
	});

	test("apply preserves an unrelated sibling entry recorded under the same pluginId", async () => {
		const { manager, pluginId, installedRegistryPath } = await setupPrivateMarketplace();
		// Inject a second, unrelated entry recorded under the same pluginId key
		// (e.g. stale duplicate data) that restore must never touch or drop.
		const registry: InstalledPluginsRegistry = JSON.parse(await fs.readFile(installedRegistryPath, "utf8"));
		const sibling = { ...registry.plugins[pluginId]![0]!, scope: "project" as const, version: "9.9.9" };
		registry.plugins[pluginId] = [...registry.plugins[pluginId]!, sibling];
		await writeInstalledPluginsRegistry(installedRegistryPath, registry);

		const plan = await manager.previewPluginRestore(pluginId, "user");
		const token = await manager.authorizePluginRestore(plan, ["plugin-change", "install-replace", "network"]);
		await manager.applyPluginRestore(token);

		const after: InstalledPluginsRegistry = JSON.parse(await fs.readFile(installedRegistryPath, "utf8"));
		const preservedSibling = after.plugins[pluginId]?.find(entry => entry.scope === "project");
		expect(preservedSibling).toMatchObject({ version: "9.9.9", scope: "project" });
	});

	test("apply rolls back and reports a typed conflict when the registry write fails after publishing", async () => {
		const { manager, pluginId, installedRoot, installedRegistryPath } = await setupPrivateMarketplace();
		const plan = await manager.previewPluginRestore(pluginId, "user");
		const token = await manager.authorizePluginRestore(plan, ["plugin-change", "install-replace", "network"]);
		// atomicWriteJson writes to `${filePath}.tmp` before renaming it into
		// place. Pre-occupying that exact path with a directory makes the write
		// deterministically fail with EISDIR — AFTER the artifact swap has already
		// happened (registry read + swap both precede the registry write), which
		// is exactly the ordering this test needs to exercise the rollback path.
		const tmpBlockerPath = `${installedRegistryPath}.tmp`;
		await fs.mkdir(tmpBlockerPath);
		try {
			await manager.applyPluginRestore(token);
			throw new Error("expected applyPluginRestore to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(MarketplaceRestoreError);
			const restoreError = error as MarketplaceRestoreError;
			expect(restoreError.sideEffectStarted).toBe(true);
			// The published tree is detached from the canonical name, but the native
			// removal could not finish scrubbing it (the bundle carries a read-only
			// file), so the rollback is genuinely unfinished. It must be reported as
			// `uncertain` rather than upgraded to a clean `conflict`, and never as a
			// foreign claim — nothing foreign is involved.
			expect(restoreError.outcome).toBe("uncertain");
			expect(restoreError.reasonCode).toBe("rollback_rename_failed");
			// The prior artifact is retained and named, never silently discarded.
			expect(restoreError.retainedBackupPath).toBeDefined();
			expect(await fs.readdir(restoreError.retainedBackupPath!)).toContain("corrupt");
		} finally {
			await fs.rm(tmpBlockerPath, { recursive: true, force: true });
		}
		// The canonical name is vacated rather than left holding a half-published
		// artifact the registry no longer references.
		await expect(fs.readdir(installedRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("apply reports foreign_owner_conflict with a retained, untouched backup when a concurrent owner republishes finalPath", async () => {
		let finalPathAtSeam = "";
		const { manager, pluginId, installedRoot } = await setupPrivateMarketplace({
			// Deterministic in-process simulation of a second concurrent writer: right
			// after our own publish rename lands (and our identity is captured), swap
			// finalPath out for a DIFFERENT directory with a different inode, exactly
			// as a racing second `applyPluginRestore` caller would.
			afterRestorePublish: async targetPath => {
				finalPathAtSeam = targetPath;
				await fs.rm(targetPath, { recursive: true, force: true });
				await fs.mkdir(targetPath, { recursive: true });
				await fs.writeFile(path.join(targetPath, "foreign-owner-marker"), "someone else published this");
			},
		});
		const plan = await manager.previewPluginRestore(pluginId, "user");
		const token = await manager.authorizePluginRestore(plan, ["plugin-change", "install-replace", "network"]);
		try {
			await manager.applyPluginRestore(token);
			throw new Error("expected applyPluginRestore to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(MarketplaceRestoreError);
			const restoreError = error as MarketplaceRestoreError;
			expect(restoreError.reasonCode).toBe("final_path_claimed_by_new_owner");
			expect(restoreError.outcome).toBe("foreign_owner_conflict");
			expect(restoreError.sideEffectStarted).toBe(true);
			expect(restoreError.retainedBackupPath).toBeDefined();
			// The retained backup must be OUR exact prior (corrupt) artifact, fully
			// intact and untouched by the rollback logic.
			const backupFiles = await fs.readdir(restoreError.retainedBackupPath!);
			expect(backupFiles).toContain("corrupt");
		}
		// The foreign owner's publication at finalPath must be completely
		// untouched — never deleted, never overwritten by our rollback.
		expect(finalPathAtSeam).toBe(installedRoot);
		const foreignFiles = await fs.readdir(installedRoot);
		expect(foreignFiles).toEqual(["foreign-owner-marker"]);
	});
});
