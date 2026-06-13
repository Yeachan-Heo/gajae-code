import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type GcCollectResult,
	type GcContext,
	type GcError,
	type GcPruneOutcome,
	type GcRecord,
	type GcStoreAdapter,
	gcPidStatusLabel,
	gcProbeToLeasePidStatus,
} from "../gjc-runtime/gc-runtime";
import { classifyLeaseStatus, readLease, reapDeadOwnerArtifacts } from "./session-lease";
import {
	type HarnessRootRegistryForGc,
	type HarnessRootRegistryListingForGc,
	listHarnessRootRegistriesForGc,
	removeHarnessRootRegistryFileForGc,
	rewriteHarnessRootRegistryForGc,
	sessionPaths,
} from "./storage";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function registryErrors(registries: HarnessRootRegistryListingForGc[]): GcError[] {
	return registries
		.filter(registry => registry.error)
		.map(registry => ({
			store: "registry_entries",
			scope: registry.file,
			message: registry.error ?? "registry_error",
		}));
}

async function collectRegistries(ctx: GcContext): Promise<HarnessRootRegistryListingForGc[]> {
	return listHarnessRootRegistriesForGc(ctx.env);
}

export const harnessLeasesGcAdapter: GcStoreAdapter = {
	store: "harness_leases",
	async collect(ctx: GcContext): Promise<GcCollectResult> {
		const records: GcRecord[] = [];
		const errors: GcError[] = [];
		const registries = await collectRegistries(ctx);
		errors.push(...registryErrors(registries).map(error => ({ ...error, store: "harness_leases" as const })));

		const roots = new Set<string>();
		for (const registry of registries) {
			if (registry.error) continue;
			for (const entry of registry.roots) roots.add(path.resolve(entry.root));
		}

		for (const root of roots) {
			const sessionsDir = path.join(root, "sessions");
			let sessionEntries: string[];
			try {
				sessionEntries = await fs.readdir(sessionsDir);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") continue;
				errors.push({ store: "harness_leases", scope: sessionsDir, message: errorMessage(error) });
				continue;
			}

			for (const sessionId of sessionEntries) {
				const sessionDir = sessionPaths(root, sessionId).dir;
				try {
					const stat = await fs.stat(sessionDir);
					if (!stat.isDirectory()) continue;
					const lease = await readLease(root, sessionId);
					if (!lease) continue;
					const status = classifyLeaseStatus(lease, { probe: gcProbeToLeasePidStatus(ctx.probe) });
					const pidProbe = ctx.probe(lease.pid);
					const pidStatus = gcPidStatusLabel(pidProbe);
					const removable = status === "dead" && pidProbe.status === "dead";
					records.push({
						store: "harness_leases",
						id: sessionId,
						root,
						path: sessionPaths(root, sessionId).lease,
						pid: lease.pid,
						pid_status: pidStatus,
						status,
						stale: status === "dead",
						removable,
						action: "none",
						reason: removable
							? `lease owner pid ${lease.pid} is dead`
							: `lease owner pid ${lease.pid} is ${pidStatus}; keeping`,
					});
				} catch (error) {
					errors.push({ store: "harness_leases", scope: sessionDir, message: errorMessage(error) });
				}
			}
		}

		return { records, errors };
	},
	async prune(record: GcRecord, ctx: GcContext): Promise<GcPruneOutcome> {
		if (!record.root) return { removed: false, skipped: "missing_root" };
		const lease = await readLease(record.root, record.id);
		if (!lease) return { removed: false, skipped: "lease_not_dead_or_missing" };
		const status = classifyLeaseStatus(lease, { probe: gcProbeToLeasePidStatus(ctx.probe) });
		if (status !== "dead") return { removed: false, skipped: "lease_not_dead_or_missing" };
		const removed = await reapDeadOwnerArtifacts(record.root, record.id, lease.ownerId, lease.leaseEpoch, {
			probe: gcProbeToLeasePidStatus(ctx.probe),
		});
		return removed ? { removed: true } : { removed: false, skipped: "reaper_guard_rejected" };
	},
};

async function splitRegistryRoots(registry: HarnessRootRegistryForGc): Promise<{
	liveRoots: HarnessRootRegistryForGc["roots"];
	danglingRoots: HarnessRootRegistryForGc["roots"];
}> {
	const liveRoots: HarnessRootRegistryForGc["roots"] = [];
	const danglingRoots: HarnessRootRegistryForGc["roots"] = [];
	for (const entry of registry.roots) {
		const sessionDir = sessionPaths(entry.root, registry.sessionId).dir;
		if (await exists(sessionDir)) liveRoots.push(entry);
		else danglingRoots.push(entry);
	}
	return { liveRoots, danglingRoots };
}

export const registryEntriesGcAdapter: GcStoreAdapter = {
	store: "registry_entries",
	async collect(ctx: GcContext): Promise<GcCollectResult> {
		const records: GcRecord[] = [];
		const errors: GcError[] = [];
		const registries = await collectRegistries(ctx);
		errors.push(...registryErrors(registries));

		for (const registry of registries) {
			if (registry.error) continue;
			try {
				const { liveRoots, danglingRoots } = await splitRegistryRoots(registry);
				if (danglingRoots.length === 0) continue;
				records.push({
					store: "registry_entries",
					id: registry.sessionId,
					path: registry.file,
					pid_status: "none",
					status: "dangling",
					stale: true,
					removable: true,
					action: "none",
					reason: `dangling roots: ${danglingRoots.map(entry => entry.root).join(", ")}`,
					detail: `${danglingRoots.length} dangling, ${liveRoots.length} live`,
				});
			} catch (error) {
				errors.push({ store: "registry_entries", scope: registry.file, message: errorMessage(error) });
			}
		}

		return { records, errors };
	},
	async prune(record: GcRecord, ctx: GcContext): Promise<GcPruneOutcome> {
		if (!record.path) return { removed: false, skipped: "missing_registry_path" };
		const registries = await collectRegistries(ctx);
		const registry = registries.find(entry => entry.file === record.path);
		if (!registry || registry.error) return { removed: false, skipped: "registry_not_readable" };
		const { liveRoots, danglingRoots } = await splitRegistryRoots(registry);
		if (danglingRoots.length === 0) return { removed: false, skipped: "no_dangling_roots" };
		if (liveRoots.length === 0) {
			await removeHarnessRootRegistryFileForGc(record.path);
		} else {
			await rewriteHarnessRootRegistryForGc(record.path, { sessionId: registry.sessionId, roots: liveRoots });
		}
		return { removed: true };
	},
};
