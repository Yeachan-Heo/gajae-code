import { describe, expect, spyOn, test } from "bun:test";
import type { Dirent, PathLike, Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDefault } from "../src/config/settings-schema";
import {
	collectGcDiskReport,
	GC_DISK_POLICY_DEFAULTS,
	type GcDiskPolicy,
	type GcDiskReport,
	type GcPruneOutcome,
	type GcRecord,
	type GcReport,
	type GcStore,
	type GcStoreAdapter,
	resolveGcDiskPolicy,
	runGjcGcCommand,
} from "../src/gjc-runtime/gc-runtime";
import { SessionIndex } from "../src/sdk/broker/session-index";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every test runs against a private state root. `GJC_CODING_AGENT_DIR` pins the
 * agent dir, `GJC_HARNESS_ROOT_REGISTRY_DIR` pins the harness registry and
 * `TMPDIR` pins the `local://` root parent, so nothing here can reach ~/.gjc.
 */
interface TestRoot {
	root: string;
	agentDir: string;
	sessionsRoot: string;
	blobsDir: string;
	nativesDir: string;
	backupsDir: string;
	env: NodeJS.ProcessEnv;
}

async function makeTestRoot(): Promise<TestRoot> {
	// realpath: the verified-delete authority rejects reparse points anywhere in
	// the sessions root, and macOS temp dirs live behind /var -> /private/var.
	const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-gc-disk-")));
	const agentDir = path.join(root, "agent");
	await fsp.mkdir(agentDir, { recursive: true });
	return {
		root,
		agentDir,
		sessionsRoot: path.join(agentDir, "sessions"),
		blobsDir: path.join(agentDir, "blobs"),
		nativesDir: path.join(root, "natives"),
		backupsDir: path.join(root, "backups"),
		env: {
			GJC_CODING_AGENT_DIR: agentDir,
			GJC_HARNESS_ROOT_REGISTRY_DIR: path.join(root, "harness-roots"),
			TMPDIR: path.join(root, "tmp"),
		},
	};
}

async function backdate(target: string, ageDays: number): Promise<void> {
	const when = new Date(Date.now() - ageDays * DAY_MS);
	await fsp.utimes(target, when, when);
}

/** Restore write permission on every directory so a fixture can always be removed. */
async function unlockTree(root: string): Promise<void> {
	await fsp.chmod(root, 0o700).catch(() => {});
	let entries: string[];
	try {
		entries = await fsp.readdir(root);
	} catch {
		return;
	}
	for (const name of entries) {
		const child = path.join(root, name);
		if ((await fsp.lstat(child)).isDirectory()) await unlockTree(child);
	}
}

async function writeSession(
	fixture: TestRoot,
	project: string,
	id: string,
	options: { ageDays: number; blobRefs?: string[]; brokenHeader?: boolean },
): Promise<string> {
	const directory = path.join(fixture.sessionsRoot, project);
	await fsp.mkdir(directory, { recursive: true });
	const file = path.join(directory, `${id}.jsonl`);
	const lines = options.brokenHeader
		? [JSON.stringify({ type: "message", role: "user", content: "no session header here" })]
		: [JSON.stringify({ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00Z", cwd: fixture.root })];
	for (const ref of options.blobRefs ?? []) {
		lines.push(JSON.stringify({ type: "message", role: "user", content: `blob:sha256:${ref}` }));
	}
	await Bun.write(file, `${lines.join("\n")}\n`);
	await backdate(file, options.ageDays);
	return file;
}

async function writeBlob(fixture: TestRoot, content: string, ageDays: number): Promise<string> {
	await fsp.mkdir(fixture.blobsDir, { recursive: true, mode: 0o700 });
	const hash = new Bun.SHA256().update(content).digest("hex");
	const file = path.join(fixture.blobsDir, hash);
	await Bun.write(file, content);
	await backdate(file, ageDays);
	return hash;
}

async function writeNativesVersion(fixture: TestRoot, version: string): Promise<void> {
	const directory = path.join(fixture.nativesDir, version);
	await fsp.mkdir(directory, { recursive: true });
	await Bun.write(path.join(directory, "pi-natives.node"), `native-${version}`);
}

async function writeHarnessRegistry(fixture: TestRoot, sessionId: string): Promise<void> {
	const dir = fixture.env.GJC_HARNESS_ROOT_REGISTRY_DIR!;
	await fsp.mkdir(dir, { recursive: true });
	await Bun.write(
		path.join(dir, `${sessionId}.json`),
		JSON.stringify({ sessionId, roots: [{ root: path.join(fixture.root, "harness"), updatedAt: "2026-01-01" }] }),
	);
}

/** Sorted `relative-path:size` listing, used to prove a dry run mutated nothing. */
async function snapshotTree(root: string): Promise<string[]> {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
			const child = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				out.push(`${path.relative(root, child)}/`);
				stack.push(child);
				continue;
			}
			out.push(`${path.relative(root, child)}:${(await fsp.lstat(child)).size}`);
		}
	}
	return out.sort();
}

function policy(overrides: Partial<GcDiskPolicy> = {}): GcDiskPolicy {
	return resolveGcDiskPolicy({
		sessions_max_age_days: 30,
		sessions_max_total_bytes: 0,
		natives_keep_versions: 2,
		backups_max_age_days: 14,
		...overrides,
	});
}

async function runDisk(fixture: TestRoot, argv: string[], overrides: Partial<GcDiskPolicy> = {}): Promise<GcReport> {
	const result = await runGjcGcCommand(argv, fixture.root, fixture.env, [], policy(overrides));
	expect(result.stderr).toBe("");
	return JSON.parse(result.stdout) as GcReport;
}

function requireDisk(report: GcReport): GcDiskReport {
	if (!report.disk) throw new Error("Expected a disk report");
	return report.disk;
}

function reasonById(disk: GcDiskReport, surface: "sessions" | "blobs" | "natives" | "backups"): Map<string, string> {
	return new Map(disk.surfaces[surface].records.map(record => [record.id, `${record.action}:${record.reason}`]));
}

function fakeAdapter(store: GcStore, records: GcRecord[], prune?: () => Promise<GcPruneOutcome>): GcStoreAdapter {
	return {
		store,
		collect: async () => ({ records: records.map(record => ({ ...record })), errors: [] }),
		prune: prune ?? (async () => ({ removed: true })),
	};
}

describe("gjc gc --disk (report only)", () => {
	test("mutates nothing and reports reclaimable bytes per surface", async () => {
		const fixture = await makeTestRoot();
		try {
			await writeSession(fixture, "repo-a", "stale-session", { ageDays: 90 });
			await writeSession(fixture, "repo-a", "recent-session", { ageDays: 1 });
			await writeBlob(fixture, "unreferenced blob payload", 5);
			// Both predate any shipped release, so the running version is always newer.
			await writeNativesVersion(fixture, "0.0.1");
			await writeNativesVersion(fixture, "0.0.2");
			await fsp.mkdir(fixture.backupsDir, { recursive: true });
			await Bun.write(path.join(fixture.backupsDir, "gjc-update-old"), "old backup payload");
			await backdate(path.join(fixture.backupsDir, "gjc-update-old"), 40);

			const before = await snapshotTree(fixture.root);
			const report = await runDisk(fixture, ["--disk", "--json"], { natives_keep_versions: 1 });
			const disk = requireDisk(report);

			expect(disk.dry_run).toBe(true);
			expect(await snapshotTree(fixture.root)).toEqual(before);

			expect(disk.surfaces.sessions.reclaimable).toBe(1);
			expect(disk.surfaces.sessions.reclaimable_bytes).toBeGreaterThan(0);
			expect(disk.surfaces.blobs.reclaimable).toBe(1);
			expect(disk.surfaces.blobs.reclaimable_bytes).toBe("unreferenced blob payload".length);
			expect(disk.surfaces.natives.reclaimable).toBe(1);
			expect(disk.surfaces.backups.reclaimable).toBe(1);
			expect(disk.totals.reclaimable_bytes).toBe(
				disk.surfaces.sessions.reclaimable_bytes +
					disk.surfaces.blobs.reclaimable_bytes +
					disk.surfaces.natives.reclaimable_bytes +
					disk.surfaces.backups.reclaimable_bytes,
			);
			expect(reasonById(disk, "sessions").get("recent-session")).toBe("keep:most_recent_resumable_session");
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("text output names each surface and its reclaimable total", async () => {
		const fixture = await makeTestRoot();
		try {
			await writeSession(fixture, "repo-a", "stale-session", { ageDays: 90 });
			const result = await runGjcGcCommand(["--disk"], fixture.root, fixture.env, [], policy());
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("gjc gc --disk — report only");
			expect(result.stdout).toContain("Session transcripts");
			expect(result.stdout).toContain("Content-addressed blobs");
			expect(result.stdout).toContain("Cached native versions");
			expect(result.stdout).toContain("Update/restore backups");
			expect(result.stdout).toContain("Disk summary:");
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("gjc gc --disk --prune (sessions)", () => {
	test("reclaims only transcripts passing both the age policy and the reference check", async () => {
		const fixture = await makeTestRoot();
		try {
			const stale = await writeSession(fixture, "repo-a", "stale-session", { ageDays: 90 });
			const leased = await writeSession(fixture, "repo-a", "leased-session", { ageDays: 91 });
			const recent = await writeSession(fixture, "repo-a", "recent-session", { ageDays: 1 });
			await writeHarnessRegistry(fixture, "leased-session");

			const report = await runDisk(fixture, ["--disk", "--prune", "--json"]);
			const disk = requireDisk(report);
			const reasons = reasonById(disk, "sessions");

			expect(reasons.get("stale-session")).toBe("reclaimed:older_than_max_age(30d)");
			expect(reasons.get("leased-session")).toBe("keep:referenced_by_live_surface");
			expect(reasons.get("recent-session")).toBe("keep:most_recent_resumable_session");
			expect(await Bun.file(stale).exists()).toBe(false);
			expect(await Bun.file(leased).exists()).toBe(true);
			expect(await Bun.file(recent).exists()).toBe(true);
			expect(disk.dry_run).toBe(false);
			expect(disk.surfaces.sessions.reclaimed).toBe(1);
			expect(report.disk?.totals.failed).toBe(0);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("keeps an aged transcript whose session is registered as an SDK host", async () => {
		const fixture = await makeTestRoot();
		try {
			const hosted = await writeSession(fixture, "repo-a", "hosted-session", { ageDays: 120 });
			await writeSession(fixture, "repo-a", "recent-session", { ageDays: 1 });
			const index = await new SessionIndex(fixture.agentDir).open();
			await index.append({
				type: "host_registered",
				sessionId: "hosted-session",
				locator: { repo: fixture.root, stateRoot: fixture.root },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: Date.now(),
			});

			const disk = requireDisk(await runDisk(fixture, ["--disk", "--prune", "--json"]));
			expect(reasonById(disk, "sessions").get("hosted-session")).toBe("keep:referenced_by_live_surface");
			expect(await Bun.file(hosted).exists()).toBe(true);
			expect(disk.surfaces.sessions.reclaimed).toBe(0);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("the size axis only retires transcripts that the age axis already cleared for liveness", async () => {
		const fixture = await makeTestRoot();
		try {
			await writeSession(fixture, "repo-a", "older-recent", { ageDays: 5 });
			await writeSession(fixture, "repo-a", "newer-recent", { ageDays: 1 });
			await writeHarnessRegistry(fixture, "older-recent");

			// Budget of 1 byte forces the size axis on, but the only age-eligible
			// candidate is referenced, so nothing may be retired.
			const referenced = requireDisk(await runDisk(fixture, ["--disk", "--json"], { sessions_max_total_bytes: 1 }));
			expect(referenced.surfaces.sessions.reclaimable).toBe(0);

			await fsp.rm(path.join(fixture.env.GJC_HARNESS_ROOT_REGISTRY_DIR!, "older-recent.json"));
			const unreferenced = requireDisk(
				await runDisk(fixture, ["--disk", "--json"], { sessions_max_total_bytes: 1 }),
			);
			expect(reasonById(unreferenced, "sessions").get("older-recent")).toBe("would_reclaim:over_max_total_bytes(1)");
			expect(reasonById(unreferenced, "sessions").get("newer-recent")).toBe("keep:most_recent_resumable_session");
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("gjc gc --disk --prune (blob mark and sweep)", () => {
	test("removes only blobs unreferenced by every surviving session", async () => {
		const fixture = await makeTestRoot();
		try {
			const shared = await writeBlob(fixture, "shared attachment", 5);
			const staleOnly = await writeBlob(fixture, "stale attachment", 5);
			const fresh = await writeBlob(fixture, "just written", 0);
			await writeSession(fixture, "repo-a", "stale-session", { ageDays: 90, blobRefs: [shared, staleOnly] });
			await writeSession(fixture, "repo-a", "keeper-session", { ageDays: 1, blobRefs: [shared] });

			const disk = requireDisk(await runDisk(fixture, ["--disk", "--prune", "--json"]));
			const reasons = reasonById(disk, "blobs");

			expect(reasons.get(shared)).toBe("keep:referenced_by_surviving_session");
			expect(reasons.get(staleOnly)).toBe("reclaimed:unreferenced_by_any_surviving_session");
			expect(reasons.get(fresh)).toBe("keep:within_write_grace_window");
			expect(await Bun.file(path.join(fixture.blobsDir, shared)).exists()).toBe(true);
			expect(await Bun.file(path.join(fixture.blobsDir, staleOnly)).exists()).toBe(false);
			expect(await Bun.file(path.join(fixture.blobsDir, fresh)).exists()).toBe(true);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("keeps every blob when a surviving transcript could not be read for marking", async () => {
		const fixture = await makeTestRoot();
		try {
			const orphan = await writeBlob(fixture, "orphan attachment", 5);
			const transcript = await writeSession(fixture, "repo-a", "keeper-session", { ageDays: 1 });
			await fsp.chmod(transcript, 0o000);

			const disk = requireDisk(await runDisk(fixture, ["--disk", "--json"]));
			await fsp.chmod(transcript, 0o600);

			expect(reasonById(disk, "blobs").get(orphan)).toBe(
				"keep:withheld_evidence_incomplete: transcript_unreadable_during_mark",
			);
			expect(disk.surfaces.blobs.declined).toEqual({
				reason: "evidence_incomplete: transcript_unreadable_during_mark",
				withheld: 1,
				withheld_bytes: "orphan attachment".length,
			});
			expect(disk.surfaces.blobs.reclaimable).toBe(0);
			expect(disk.errors.some(error => error.surface === "blobs")).toBe(true);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("a session created while the store is being measured keeps its blob", async () => {
		const fixture = await makeTestRoot();
		try {
			// Older than the write grace window, so the only thing that can save it is
			// a reference — and that reference is written after the session walk has
			// already enumerated the store.
			const blob = await writeBlob(fixture, "payload referenced by a session that starts mid-sweep", 10);
			const survivor = await writeSession(fixture, "repo-a", "survivor", { ageDays: 0 });
			// A wide artifact tree keeps the session walk busy long enough for the
			// late session to land after enumeration and before the blob sweep.
			const artifacts = survivor.slice(0, -".jsonl".length);
			await fsp.mkdir(artifacts, { recursive: true });
			for (let index = 0; index < 6000; index++) await Bun.write(path.join(artifacts, `entry-${index}`), "x");

			const run = runGjcGcCommand(["--disk", "--prune", "--json"], fixture.root, fixture.env, [], policy());
			await Bun.sleep(10);
			await writeSession(fixture, "repo-b", "late-session", { ageDays: 0, blobRefs: [blob] });

			const disk = requireDisk(JSON.parse((await run).stdout) as GcReport);
			expect(reasonById(disk, "blobs").get(blob)).toBe("keep:referenced_by_surviving_session");
			expect(await Bun.file(path.join(fixture.blobsDir, blob)).exists()).toBe(true);
			expect(disk.errors).toEqual([]);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	}, 30000);

	test("withholds the sweep when a transcript keeps changing under the mark", async () => {
		const fixture = await makeTestRoot();
		try {
			const orphan = await writeBlob(fixture, "orphan payload under a moving mark", 10);
			const transcript = await writeSession(fixture, "repo-a", "busy-session", { ageDays: 0 });

			let appending = true;
			const appender = (async () => {
				for (let index = 0; appending && index < 20000; index++) {
					await fsp.appendFile(
						transcript,
						`${JSON.stringify({ type: "message", role: "user", content: index })}\n`,
					);
					await Bun.sleep(0);
				}
			})();
			const report = await runGjcGcCommand(["--disk", "--prune", "--json"], fixture.root, fixture.env, [], policy());
			appending = false;
			await appender;

			const disk = requireDisk(JSON.parse(report.stdout) as GcReport);
			expect(reasonById(disk, "blobs").get(orphan)).toBe(
				"keep:withheld_evidence_incomplete: sessions_changed_during_mark",
			);
			expect(disk.surfaces.blobs.declined?.reason).toBe("evidence_incomplete: sessions_changed_during_mark");
			expect(disk.surfaces.blobs.reclaimable).toBe(0);
			expect(await Bun.file(path.join(fixture.blobsDir, orphan)).exists()).toBe(true);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	}, 30000);
});

describe("gjc gc --disk --prune (blob sweep on incomplete evidence)", () => {
	test("keeps a blob whose only reference lives in an unreadable project directory", async () => {
		const fixture = await makeTestRoot();
		const projectDir = path.join(fixture.sessionsRoot, "repo-a");
		try {
			// Older than the write grace window, so only the reference held by the
			// live transcript stands between this blob and the sweep.
			const hash = await writeBlob(fixture, "precious user payload", 3);
			const transcript = await writeSession(fixture, "repo-a", "live-session", { ageDays: 0, blobRefs: [hash] });
			await fsp.chmod(projectDir, 0o000);

			const report = await runDisk(fixture, ["--disk", "--prune", "--json"]);
			await fsp.chmod(projectDir, 0o700);
			const disk = requireDisk(report);

			expect(await Bun.file(path.join(fixture.blobsDir, hash)).exists()).toBe(true);
			expect(await Bun.file(transcript).exists()).toBe(true);
			expect(disk.surfaces.blobs.reclaimed).toBe(0);
			expect(reasonById(disk, "blobs").get(hash)).toBe(
				"keep:withheld_evidence_incomplete: session_project_dir_unreadable",
			);
			expect(disk.surfaces.blobs.records.find(record => record.id === hash)?.withheld).toBe(true);
			expect(disk.surfaces.blobs.declined).toEqual({
				reason: "evidence_incomplete: session_project_dir_unreadable",
				withheld: 1,
				withheld_bytes: "precious user payload".length,
			});
		} finally {
			await fsp.chmod(projectDir, 0o700).catch(() => {});
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("reclaims nothing and names the reason when the sessions root cannot be read", async () => {
		const fixture = await makeTestRoot();
		try {
			const hash = await writeBlob(fixture, "payload past the age bound", 3);
			await writeSession(fixture, "repo-a", "live-session", { ageDays: 0, blobRefs: [hash] });
			await fsp.chmod(fixture.sessionsRoot, 0o000);

			const report = await runDisk(fixture, ["--disk", "--prune", "--json"]);
			await fsp.chmod(fixture.sessionsRoot, 0o700);
			const disk = requireDisk(report);

			expect(await Bun.file(path.join(fixture.blobsDir, hash)).exists()).toBe(true);
			expect(disk.surfaces.blobs.reclaimed).toBe(0);
			expect(disk.surfaces.blobs.declined?.reason).toBe("evidence_incomplete: sessions_root_unreadable");
			expect(disk.surfaces.blobs.declined?.withheld).toBe(1);
			expect(disk.errors.some(error => error.surface === "sessions")).toBe(true);
		} finally {
			await fsp.chmod(fixture.sessionsRoot, 0o700).catch(() => {});
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("the text report states that the blob surface declined and what it withheld", async () => {
		const fixture = await makeTestRoot();
		const projectDir = path.join(fixture.sessionsRoot, "repo-a");
		try {
			const hash = await writeBlob(fixture, "withheld payload", 3);
			await writeSession(fixture, "repo-a", "live-session", { ageDays: 0, blobRefs: [hash] });
			await fsp.chmod(projectDir, 0o000);

			const result = await runGjcGcCommand(["--disk", "--prune"], fixture.root, fixture.env, [], policy());
			await fsp.chmod(projectDir, 0o700);

			expect(result.stdout).toContain(
				"declined: reclaimed nothing — evidence_incomplete: session_project_dir_unreadable (withheld=1",
			);
			expect(await Bun.file(path.join(fixture.blobsDir, hash)).exists()).toBe(true);
		} finally {
			await fsp.chmod(projectDir, 0o700).catch(() => {});
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("gjc gc --disk dry-run parity", () => {
	for (const evidence of ["complete", "incomplete"] as const) {
		test(`--disk reports exactly what --disk --prune removes (${evidence} evidence)`, async () => {
			// Two identical state roots: one is only reported on, the other pruned.
			const dry = await makeTestRoot();
			const wet = await makeTestRoot();
			const orphans: string[] = [];
			try {
				for (const fixture of [dry, wet]) {
					const referenced = await writeBlob(fixture, "referenced payload", 10);
					orphans.push(await writeBlob(fixture, "orphan payload", 10));
					await writeSession(fixture, "repo-a", "live-session", { ageDays: 0, blobRefs: [referenced] });
					if (evidence === "incomplete") await fsp.chmod(path.join(fixture.sessionsRoot, "repo-a"), 0o000);
				}

				const dryReport = await runDisk(dry, ["--disk", "--json"]);
				const wetReport = await runDisk(wet, ["--disk", "--prune", "--json"]);
				for (const fixture of [dry, wet]) {
					await fsp.chmod(path.join(fixture.sessionsRoot, "repo-a"), 0o700).catch(() => {});
				}
				const dryDisk = requireDisk(dryReport);
				const wetDisk = requireDisk(wetReport);

				for (const surface of ["sessions", "blobs", "natives", "backups"] as const) {
					expect(wetDisk.surfaces[surface].reclaimed).toBe(dryDisk.surfaces[surface].reclaimable);
					expect(wetDisk.surfaces[surface].reclaimed_bytes).toBe(dryDisk.surfaces[surface].reclaimable_bytes);
					expect(wetDisk.surfaces[surface].declined).toEqual(dryDisk.surfaces[surface].declined);
				}

				// Complete evidence still sweeps; incomplete evidence sweeps nothing.
				expect(dryDisk.surfaces.blobs.reclaimable).toBe(evidence === "complete" ? 1 : 0);
				expect(await Bun.file(path.join(wet.blobsDir, orphans[1]!)).exists()).toBe(evidence !== "complete");
				expect(await Bun.file(path.join(dry.blobsDir, orphans[0]!)).exists()).toBe(true);
			} finally {
				for (const fixture of [dry, wet]) {
					await fsp.chmod(path.join(fixture.sessionsRoot, "repo-a"), 0o700).catch(() => {});
					await fsp.rm(fixture.root, { recursive: true, force: true });
				}
			}
		});
	}

	test("a transcript the delete authority will refuse is never reported as reclaimable", async () => {
		const fixture = await makeTestRoot();
		try {
			const corrupt = await writeSession(fixture, "repo-a", "corrupt-old", { ageDays: 120, brokenHeader: true });
			await writeSession(fixture, "repo-a", "newest", { ageDays: 0 });

			const dryDisk = requireDisk(await runDisk(fixture, ["--disk", "--json"]));
			expect(reasonById(dryDisk, "sessions").get("corrupt-old")).toBe(
				"keep:retention_declined: transcript_header_unusable",
			);
			expect(dryDisk.surfaces.sessions.reclaimable).toBe(0);

			const wetDisk = requireDisk(await runDisk(fixture, ["--disk", "--prune", "--json"]));
			expect(wetDisk.surfaces.sessions.reclaimed).toBe(dryDisk.surfaces.sessions.reclaimable);
			expect(await Bun.file(corrupt).exists()).toBe(true);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("a hard-linked transcript is neither promised by the dry run nor retired by prune", async () => {
		const fixture = await makeTestRoot();
		try {
			// The verified delete authority refuses anything but a single-link
			// transcript, so the age policy alone must not report it as reclaimable.
			const linked = await writeSession(fixture, "repo-a", "linked-old", { ageDays: 120 });
			const artifacts = linked.slice(0, -".jsonl".length);
			await fsp.mkdir(artifacts, { recursive: true });
			await Bun.write(path.join(artifacts, "attachment"), "artifact bytes");
			await fsp.link(linked, path.join(fixture.sessionsRoot, "repo-a", "linked-old.alias"));
			await writeSession(fixture, "repo-a", "newest", { ageDays: 0 });

			const dryDisk = requireDisk(await runDisk(fixture, ["--disk", "--json"]));
			expect(reasonById(dryDisk, "sessions").get("linked-old")).toBe(
				"keep:retention_declined: transcript_not_single_link",
			);
			expect(dryDisk.surfaces.sessions.reclaimable).toBe(0);

			const wetDisk = requireDisk(await runDisk(fixture, ["--disk", "--prune", "--json"]));
			expect(wetDisk.surfaces.sessions.reclaimed).toBe(dryDisk.surfaces.sessions.reclaimable);
			expect(wetDisk.surfaces.sessions.reclaimed_bytes).toBe(dryDisk.surfaces.sessions.reclaimable_bytes);
			expect(await Bun.file(linked).exists()).toBe(true);
			// The refusal lands before the artifact phase, so nothing of the session
			// is destroyed on the way to a keep.
			expect(await Bun.file(path.join(artifacts, "attachment")).exists()).toBe(true);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("a blob whose only reference is a retiring transcript stays reclaimable in the dry run", async () => {
		// The dry run leaves the retiring transcript on disk, so the blob sweep must
		// not treat it as live evidence and quietly under-report what prune removes.
		const dry = await makeTestRoot();
		const wet = await makeTestRoot();
		const blobs: string[] = [];
		try {
			for (const fixture of [dry, wet]) {
				const blob = await writeBlob(fixture, "payload referenced only by an aged session", 10);
				blobs.push(blob);
				await writeSession(fixture, "repo-a", "aged-session", { ageDays: 120, blobRefs: [blob] });
				await writeSession(fixture, "repo-a", "newest", { ageDays: 0 });
			}

			const dryDisk = requireDisk(await runDisk(dry, ["--disk", "--json"]));
			const wetDisk = requireDisk(await runDisk(wet, ["--disk", "--prune", "--json"]));

			expect(dryDisk.surfaces.sessions.reclaimable).toBe(1);
			expect(dryDisk.surfaces.blobs.reclaimable).toBe(1);
			expect(wetDisk.surfaces.sessions.reclaimed).toBe(dryDisk.surfaces.sessions.reclaimable);
			expect(wetDisk.surfaces.blobs.reclaimed).toBe(dryDisk.surfaces.blobs.reclaimable);
			expect(await Bun.file(path.join(wet.blobsDir, blobs[1]!)).exists()).toBe(false);
			expect(await Bun.file(path.join(dry.blobsDir, blobs[0]!)).exists()).toBe(true);
		} finally {
			await fsp.rm(dry.root, { recursive: true, force: true });
			await fsp.rm(wet.root, { recursive: true, force: true });
		}
	});
});

describe("gjc gc --disk --prune (half-completed retirement)", () => {
	test("a session whose artifacts were destroyed is reported as failed, not kept", async () => {
		const fixture = await makeTestRoot();
		const transcript = await writeSession(fixture, "repo-a", "old-session", { ageDays: 120 });
		const artifactsDir = transcript.slice(0, -".jsonl".length);
		const locked = path.join(artifactsDir, "locked");
		try {
			await fsp.mkdir(locked, { recursive: true });
			await Bun.write(path.join(artifactsDir, "tool-output.txt"), "tool output");
			await Bun.write(path.join(locked, "inner.txt"), "inner payload");
			// Read-only directory: the recursive artifact removal cannot empty it,
			// so retirement stops after the artifact tree has already been detached.
			await fsp.chmod(locked, 0o500);
			await writeSession(fixture, "repo-a", "newest", { ageDays: 0 });

			const result = await runGjcGcCommand(["--disk", "--prune", "--json"], fixture.root, fixture.env, [], policy());
			await fsp.chmod(locked, 0o700).catch(() => {});
			const disk = requireDisk(JSON.parse(result.stdout) as GcReport);
			const record = disk.surfaces.sessions.records.find(entry => entry.id === "old-session");

			expect(await Bun.file(transcript).exists()).toBe(true);
			expect(await Bun.file(path.join(artifactsDir, "tool-output.txt")).exists()).toBe(false);
			expect(record?.action).toBe("reclaim_failed");
			expect(record?.reason.startsWith("retention_incomplete: cleanup_pending_")).toBe(true);
			expect(disk.totals.failed).toBe(1);
			expect(result.status).toBe(1);
		} finally {
			await unlockTree(fixture.root);
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("gjc gc --disk (path containment)", () => {
	test("never follows a symlinked project directory or transcript out of the state root", async () => {
		const fixture = await makeTestRoot();
		try {
			const outside = path.join(fixture.root, "outside");
			await fsp.mkdir(outside, { recursive: true });
			const outsideTranscript = path.join(outside, "escapee.jsonl");
			await Bun.write(
				outsideTranscript,
				`${JSON.stringify({ type: "session", version: 3, id: "escapee", timestamp: "2025-01-01T00:00:00Z", cwd: fixture.root })}\n`,
			);
			await backdate(outsideTranscript, 900);

			await writeSession(fixture, "repo-a", "newest", { ageDays: 0 });
			// A session id that tries to traverse, a symlinked project directory and
			// a symlinked transcript: none of them may reach outside the root.
			const traversal = path.join(fixture.sessionsRoot, "repo-a", "..escape.jsonl");
			await Bun.write(
				traversal,
				`${JSON.stringify({ type: "session", version: 3, id: "../../escape", timestamp: "2025-01-01T00:00:00Z", cwd: fixture.root })}\n`,
			);
			await backdate(traversal, 900);
			await fsp.symlink(outside, path.join(fixture.sessionsRoot, "linked-project"));
			await fsp.symlink(outsideTranscript, path.join(fixture.sessionsRoot, "repo-a", "linked.jsonl"));

			const disk = requireDisk(await runDisk(fixture, ["--disk", "--prune", "--json"]));

			for (const record of disk.surfaces.sessions.records) {
				expect(record.path.startsWith(`${fixture.sessionsRoot}${path.sep}`)).toBe(true);
			}
			expect(disk.surfaces.sessions.records.map(record => record.id).sort()).toEqual(["..escape", "newest"]);
			expect(await Bun.file(outsideTranscript).exists()).toBe(true);
			expect((await fsp.lstat(path.join(fixture.sessionsRoot, "linked-project"))).isSymbolicLink()).toBe(true);
			expect((await fsp.lstat(path.join(fixture.sessionsRoot, "repo-a", "linked.jsonl"))).isSymbolicLink()).toBe(
				true,
			);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("gjc gc --disk (natives retention)", () => {
	test("keeps the running version plus the configured number of predecessors", async () => {
		const fixture = await makeTestRoot();
		try {
			for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"]) {
				await writeNativesVersion(fixture, version);
			}
			await fsp.mkdir(path.join(fixture.nativesDir, "not-a-version"), { recursive: true });

			const disk = await collectGcDiskReport({
				agentDir: fixture.agentDir,
				env: fixture.env,
				policy: policy({ natives_keep_versions: 2 }),
				prune: false,
				runningVersion: "0.4.0",
			});
			const reasons = reasonById(disk, "natives");

			expect(reasons.get("0.5.0")).toBe("keep:retained_version(keepVersions=2)");
			expect(reasons.get("0.4.0")).toBe("keep:running_version");
			expect(reasons.get("0.3.0")).toBe("keep:retained_version(keepVersions=2)");
			expect(reasons.get("0.2.0")).toBe("keep:retained_version(keepVersions=2)");
			expect(reasons.get("0.1.0")).toBe("would_reclaim:beyond_keep_versions(2)");
			expect(reasons.get("not-a-version")).toBe("keep:unrecognized_version_directory");
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("prune removes only the versions beyond the retention window", async () => {
		const fixture = await makeTestRoot();
		try {
			for (const version of ["0.1.0", "0.2.0", "0.3.0"]) await writeNativesVersion(fixture, version);

			await collectGcDiskReport({
				agentDir: fixture.agentDir,
				env: fixture.env,
				policy: policy({ natives_keep_versions: 1 }),
				prune: true,
				runningVersion: "0.3.0",
			});

			expect((await fsp.readdir(fixture.nativesDir)).sort()).toEqual(["0.2.0", "0.3.0"]);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});
	test("withholds a version whose tree could not be fully read instead of half-deleting it", async () => {
		const fixture = await makeTestRoot();
		const locked = path.join(fixture.nativesDir, "0.1.0", "locked");
		try {
			for (const version of ["0.1.0", "0.2.0", "0.3.0"]) await writeNativesVersion(fixture, version);
			// An unreadable subdirectory makes the size walk blind, and makes a
			// recursive remove impossible to complete: it can only destroy the
			// readable half.
			await fsp.mkdir(locked, { recursive: true });
			await Bun.write(path.join(locked, "inner.bin"), "z".repeat(2048));
			await fsp.chmod(locked, 0o000);

			const disk = await collectGcDiskReport({
				agentDir: fixture.agentDir,
				env: fixture.env,
				policy: policy({ natives_keep_versions: 1 }),
				prune: true,
				runningVersion: "0.3.0",
			});

			expect(reasonById(disk, "natives").get("0.1.0")).toBe("keep:withheld_evidence_incomplete: tree_unreadable");
			expect(disk.surfaces.natives.records.find(record => record.id === "0.1.0")?.withheld).toBe(true);
			expect(disk.surfaces.natives.reclaimed).toBe(0);
			expect(disk.surfaces.natives.failed).toBe(0);
			// The readable half is what a half-completed remove destroys first.
			expect(await Bun.file(path.join(fixture.nativesDir, "0.1.0", "pi-natives.node")).exists()).toBe(true);
			expect((await fsp.readdir(fixture.nativesDir)).sort()).toEqual(["0.1.0", "0.2.0", "0.3.0"]);
		} finally {
			await fsp.chmod(locked, 0o700).catch(() => {});
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("gjc gc --disk (backups retention)", () => {
	test("ages out backup roots and *.bak siblings, keeping recent ones", async () => {
		const fixture = await makeTestRoot();
		try {
			await fsp.mkdir(fixture.backupsDir, { recursive: true });
			const old = path.join(fixture.backupsDir, "natives-0.1.0-before-update");
			await fsp.mkdir(old, { recursive: true });
			await Bun.write(path.join(old, "payload.bin"), "x".repeat(64));
			await backdate(old, 40);
			const recent = path.join(fixture.backupsDir, "gjc-update-2026-08-01");
			await Bun.write(recent, "recent backup");
			await backdate(recent, 2);
			const agentBak = path.join(fixture.root, "agent.bak");
			await fsp.mkdir(agentBak, { recursive: true });
			await Bun.write(path.join(agentBak, "settings.json"), "{}");
			await backdate(agentBak, 40);

			const disk = await collectGcDiskReport({
				agentDir: fixture.agentDir,
				env: fixture.env,
				policy: policy(),
				prune: true,
			});
			const reasons = reasonById(disk, "backups");

			expect(reasons.get("natives-0.1.0-before-update")).toBe("reclaimed:older_than_max_age(14d)");
			expect(reasons.get("agent.bak")).toBe("reclaimed:older_than_max_age(14d)");
			expect(reasons.get("gjc-update-2026-08-01")).toBe("keep:newer_than_max_age(14d)");
			expect(await fsp.readdir(fixture.backupsDir)).toEqual(["gjc-update-2026-08-01"]);
			expect(await Bun.file(path.join(agentBak, "settings.json")).exists()).toBe(false);
			// The live agent directory is never a backup candidate.
			expect((await fsp.lstat(fixture.agentDir)).isDirectory()).toBe(true);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});
	test("withholds a backup whose tree could not be fully read instead of half-deleting it", async () => {
		const fixture = await makeTestRoot();
		const locked = path.join(fixture.backupsDir, "natives-0.1.0-before-update", "locked");
		try {
			const backup = path.join(fixture.backupsDir, "natives-0.1.0-before-update");
			await fsp.mkdir(locked, { recursive: true });
			await Bun.write(path.join(backup, "payload.bin"), "x".repeat(64));
			await Bun.write(path.join(locked, "inner.bin"), "z".repeat(2048));
			await fsp.chmod(locked, 0o000);
			await backdate(backup, 40);

			const disk = await collectGcDiskReport({
				agentDir: fixture.agentDir,
				env: fixture.env,
				policy: policy(),
				prune: true,
			});

			expect(reasonById(disk, "backups").get("natives-0.1.0-before-update")).toBe(
				"keep:withheld_evidence_incomplete: tree_unreadable",
			);
			expect(
				disk.surfaces.backups.records.find(record => record.id === "natives-0.1.0-before-update")?.withheld,
			).toBe(true);
			expect(disk.surfaces.backups.reclaimed).toBe(0);
			expect(disk.surfaces.backups.failed).toBe(0);
			// A recursive remove destroys the readable entries before it fails on
			// the unreadable one, leaving a backup that is neither intact nor gone.
			expect(await Bun.file(path.join(backup, "payload.bin")).exists()).toBe(true);
		} finally {
			await fsp.chmod(locked, 0o700).catch(() => {});
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("a fully readable backup is still reclaimed when its size walk skipped a symlink", async () => {
		const fixture = await makeTestRoot();
		try {
			const backup = path.join(fixture.backupsDir, "gjc-update-old");
			await fsp.mkdir(backup, { recursive: true });
			await Bun.write(path.join(backup, "payload.bin"), "x".repeat(64));
			// A skipped symlink makes `bytes` a floor, but nothing was unreadable,
			// so the reclaim must still go through.
			await fsp.symlink(path.join(backup, "payload.bin"), path.join(backup, "alias"));
			await backdate(backup, 40);

			const disk = await collectGcDiskReport({
				agentDir: fixture.agentDir,
				env: fixture.env,
				policy: policy(),
				prune: true,
			});

			const record = disk.surfaces.backups.records.find(entry => entry.id === "gjc-update-old");
			expect(record?.partial).toBe(true);
			expect(record?.withheld).toBeUndefined();
			expect(reasonById(disk, "backups").get("gjc-update-old")).toBe("reclaimed:older_than_max_age(14d)");
			expect(await fsp.readdir(fixture.backupsDir)).toEqual([]);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("dry run and prune agree that an unreadable backup tree is withheld", async () => {
		const dry = await makeTestRoot();
		const wet = await makeTestRoot();
		try {
			for (const fixture of [dry, wet]) {
				const backup = path.join(fixture.backupsDir, "gjc-update-old");
				await fsp.mkdir(path.join(backup, "locked"), { recursive: true });
				await Bun.write(path.join(backup, "payload.bin"), "x".repeat(64));
				await fsp.chmod(path.join(backup, "locked"), 0o000);
				await backdate(backup, 40);
			}

			const dryDisk = await collectGcDiskReport({
				agentDir: dry.agentDir,
				env: dry.env,
				policy: policy(),
				prune: false,
			});
			const wetDisk = await collectGcDiskReport({
				agentDir: wet.agentDir,
				env: wet.env,
				policy: policy(),
				prune: true,
			});

			expect(dryDisk.surfaces.backups.reclaimable).toBe(0);
			expect(wetDisk.surfaces.backups.reclaimed).toBe(dryDisk.surfaces.backups.reclaimable);
			expect(wetDisk.surfaces.backups.reclaimed_bytes).toBe(dryDisk.surfaces.backups.reclaimable_bytes);
			expect(await Bun.file(path.join(wet.backupsDir, "gjc-update-old", "payload.bin")).exists()).toBe(true);
		} finally {
			for (const fixture of [dry, wet]) {
				await fsp.chmod(path.join(fixture.backupsDir, "gjc-update-old", "locked"), 0o700).catch(() => {});
				await fsp.rm(fixture.root, { recursive: true, force: true });
			}
		}
	});

	test("withholds a backup that goes unreadable between the size walk and the remove", async () => {
		const fixture = await makeTestRoot();
		const backup = path.join(fixture.backupsDir, "gjc-update-old");
		const locked = path.join(backup, "locked");
		const realLstat = fsp.lstat as unknown as (target: PathLike, options?: { bigint?: false }) => Promise<Stats>;
		// The candidate is lstat'd twice: once to classify it, once to verify it
		// immediately before the remove. Locking the subtree on that second call is
		// a subtree that goes unreadable after the walk, without touching the root's
		// own inode or mtime — exactly the window the measurement-time check misses.
		let candidateStats = 0;
		const spy = spyOn(fsp, "lstat");
		spy.mockImplementation((async (target: PathLike, options?: { bigint?: false }) => {
			if (path.resolve(String(target)) === backup && ++candidateStats === 2) await fsp.chmod(locked, 0o000);
			return await realLstat(target, options);
		}) as unknown as typeof fsp.lstat);
		try {
			// Wide enough that a recursive remove destroys the readable half before
			// it reaches the locked subdirectory and gives up.
			await fsp.mkdir(locked, { recursive: true });
			await fsp.mkdir(path.join(backup, "sibling"), { recursive: true });
			for (let index = 0; index < 200; index++) {
				await Bun.write(path.join(backup, `payload-${index}.bin`), "x".repeat(64));
				await Bun.write(path.join(backup, "sibling", `s-${index}.bin`), "x".repeat(64));
			}
			await Bun.write(path.join(locked, "inner.bin"), "z".repeat(2048));
			await backdate(backup, 40);

			const disk = await collectGcDiskReport({
				agentDir: fixture.agentDir,
				env: fixture.env,
				policy: policy(),
				prune: true,
			});
			spy.mockRestore();

			// The refusal has to land before anything is destroyed, not after.
			expect((await fsp.readdir(backup)).sort()).toEqual(
				["locked", "sibling", ...Array.from({ length: 200 }, (_unused, index) => `payload-${index}.bin`)].sort(),
			);
			expect((await fsp.readdir(path.join(backup, "sibling"))).length).toBe(200);
			expect(reasonById(disk, "backups").get("gjc-update-old")).toBe(
				"keep:withheld_evidence_incomplete: tree_unreadable",
			);
			expect(disk.surfaces.backups.records.find(record => record.id === "gjc-update-old")?.withheld).toBe(true);
			expect(disk.surfaces.backups.reclaimed).toBe(0);
			expect(disk.surfaces.backups.failed).toBe(0);

			// A dry run over the state the prune actually faced withholds it for the
			// same reason, so the two axes never disagree about what is withheld.
			const dryDisk = await collectGcDiskReport({
				agentDir: fixture.agentDir,
				env: fixture.env,
				policy: policy(),
				prune: false,
			});
			expect(reasonById(dryDisk, "backups").get("gjc-update-old")).toBe(
				"keep:withheld_evidence_incomplete: tree_unreadable",
			);
			expect(dryDisk.surfaces.backups.reclaimable).toBe(0);
		} finally {
			spy.mockRestore();
			await fsp.chmod(locked, 0o700).catch(() => {});
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("does not half-delete a backup that goes unreadable inside recursive removal", async () => {
		const fixture = await makeTestRoot();
		const backup = path.join(fixture.backupsDir, "gjc-update-old");
		const locked = path.join(backup, "locked");
		const realLstat = fsp.lstat as unknown as (target: PathLike, options?: { bigint?: boolean }) => Promise<Stats>;
		const realRm = fsp.rm;
		let raceInjected = false;
		const lstatSpy = spyOn(fsp, "lstat");
		lstatSpy.mockImplementation((async (target: PathLike, options?: { bigint?: boolean }) => {
			if (!raceInjected && options?.bigint === true && path.resolve(String(target)) === path.dirname(backup)) {
				raceInjected = true;
				await fsp.chmod(locked, 0o000);
			}
			return await realLstat(target, options);
		}) as unknown as typeof fsp.lstat);
		const rmSpy = spyOn(fsp, "rm");
		rmSpy.mockImplementation((async (target: PathLike, options?: Parameters<typeof fsp.rm>[1]) => {
			if (!raceInjected && path.resolve(String(target)) === backup) {
				raceInjected = true;
				await fsp.chmod(locked, 0o000);
			}
			return await realRm(target, options);
		}) as typeof fsp.rm);
		try {
			await fsp.mkdir(locked, { recursive: true });
			for (let index = 0; index < 200; index++) {
				await Bun.write(path.join(backup, `payload-${index}.bin`), "x".repeat(64));
			}
			await Bun.write(path.join(locked, "inner.bin"), "z".repeat(2048));
			await backdate(backup, 40);

			const disk = await collectGcDiskReport({
				agentDir: fixture.agentDir,
				env: fixture.env,
				policy: policy(),
				prune: true,
			});
			lstatSpy.mockRestore();
			rmSpy.mockRestore();
			expect(raceInjected).toBe(true);

			expect(reasonById(disk, "backups").get("gjc-update-old")).toBe(
				"keep:withheld_evidence_incomplete: tree_unreadable",
			);
			expect(disk.surfaces.backups.records.find(record => record.id === "gjc-update-old")?.withheld).toBe(true);
			expect(disk.surfaces.backups.reclaimed).toBe(0);
			expect(disk.surfaces.backups.failed).toBe(0);
			expect(await Bun.file(path.join(backup, "payload-0.bin")).exists()).toBe(true);
			expect((await fsp.readdir(backup)).length).toBe(201);
		} finally {
			lstatSpy.mockRestore();
			rmSpy.mockRestore();
			await fsp.chmod(locked, 0o700).catch(() => {});
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("withholds a capped walk whose unvisited subtree is unreadable", async () => {
		const dry = await makeTestRoot();
		const wet = await makeTestRoot();
		const syntheticSymlinks = Array.from({ length: 200_000 }, (_unused, index) => {
			return {
				name: `vanished-${index}`,
				isBlockDevice: () => false,
				isCharacterDevice: () => false,
				isDirectory: () => false,
				isFIFO: () => false,
				isFile: () => false,
				isSocket: () => false,
				isSymbolicLink: () => true,
			} as unknown as Dirent;
		});
		const realReaddir = fsp.readdir as unknown as (
			dir: PathLike,
			options?: { withFileTypes?: true },
		) => Promise<Array<string | Dirent>>;
		const roots = new Set<string>();
		const spy = spyOn(fsp, "readdir");
		spy.mockImplementation((async (dir: PathLike, options?: { withFileTypes?: true }) => {
			if (options?.withFileTypes && roots.has(path.resolve(String(dir)))) {
				const entries = await realReaddir(dir, options);
				const locked = entries.find(entry => typeof entry !== "string" && entry.name === "locked");
				if (!locked) throw new Error("Expected locked fixture directory");
				return [...syntheticSymlinks, locked];
			}
			return await realReaddir(dir, options);
		}) as unknown as typeof fsp.readdir);
		try {
			for (const fixture of [dry, wet]) {
				const backup = path.join(fixture.backupsDir, "gjc-update-old");
				roots.add(backup);
				await fsp.mkdir(path.join(backup, "locked"), { recursive: true });
				await Bun.write(path.join(backup, "payload-0.bin"), "x".repeat(64));
				await Bun.write(path.join(backup, "locked", "inner.bin"), "z".repeat(2048));
				await fsp.chmod(path.join(backup, "locked"), 0o000);
				await backdate(backup, 40);
			}

			const dryDisk = await collectGcDiskReport({
				agentDir: dry.agentDir,
				env: dry.env,
				policy: policy(),
				prune: false,
			});
			const wetDisk = await collectGcDiskReport({
				agentDir: wet.agentDir,
				env: wet.env,
				policy: policy(),
				prune: true,
			});
			spy.mockRestore();

			expect(reasonById(dryDisk, "backups").get("gjc-update-old")).toBe(
				"keep:withheld_evidence_incomplete: tree_unreadable",
			);
			expect(reasonById(wetDisk, "backups").get("gjc-update-old")).toBe(
				"keep:withheld_evidence_incomplete: tree_unreadable",
			);
			expect(wetDisk.surfaces.backups.reclaimed).toBe(dryDisk.surfaces.backups.reclaimable);
			expect(wetDisk.surfaces.backups.failed).toBe(0);
			expect(await Bun.file(path.join(wet.backupsDir, "gjc-update-old", "payload-0.bin")).exists()).toBe(true);
			expect((await fsp.readdir(path.join(wet.backupsDir, "gjc-update-old"))).sort()).toEqual([
				"locked",
				"payload-0.bin",
			]);
		} finally {
			spy.mockRestore();
			for (const fixture of [dry, wet]) {
				await fsp.chmod(path.join(fixture.backupsDir, "gjc-update-old", "locked"), 0o700).catch(() => {});
				await fsp.rm(fixture.root, { recursive: true, force: true });
			}
		}
	});

	test("reclaims a capped walk whose unvisited subtree is readable", async () => {
		const dry = await makeTestRoot();
		const wet = await makeTestRoot();
		// The same cap that hides an unreadable subtree also hides a readable one.
		// Running out of sizing budget is not evidence of anything: it must leave
		// `bytes` a floor without ever withholding a tree that can be removed.
		const syntheticSymlinks = Array.from({ length: 200_000 }, (_unused, index) => {
			return {
				name: `skipped-${index}`,
				isBlockDevice: () => false,
				isCharacterDevice: () => false,
				isDirectory: () => false,
				isFIFO: () => false,
				isFile: () => false,
				isSocket: () => false,
				isSymbolicLink: () => true,
			} as unknown as Dirent;
		});
		const realReaddir = fsp.readdir as unknown as (
			dir: PathLike,
			options?: { withFileTypes?: true },
		) => Promise<Array<string | Dirent>>;
		const roots = new Set<string>();
		const spy = spyOn(fsp, "readdir");
		spy.mockImplementation((async (dir: PathLike, options?: { withFileTypes?: true }) => {
			if (options?.withFileTypes && roots.has(path.resolve(String(dir)))) {
				const entries = await realReaddir(dir, options);
				const deep = entries.find(entry => typeof entry !== "string" && entry.name === "deep");
				if (!deep) throw new Error("Expected the deep fixture directory");
				return [...syntheticSymlinks, deep];
			}
			return await realReaddir(dir, options);
		}) as unknown as typeof fsp.readdir);
		try {
			for (const fixture of [dry, wet]) {
				const backup = path.join(fixture.backupsDir, "gjc-update-old");
				roots.add(backup);
				await fsp.mkdir(path.join(backup, "deep"), { recursive: true });
				await Bun.write(path.join(backup, "payload-0.bin"), "x".repeat(64));
				await Bun.write(path.join(backup, "deep", "inner.bin"), "z".repeat(2048));
				await backdate(backup, 40);
			}

			const dryDisk = await collectGcDiskReport({
				agentDir: dry.agentDir,
				env: dry.env,
				policy: policy(),
				prune: false,
			});
			const wetDisk = await collectGcDiskReport({
				agentDir: wet.agentDir,
				env: wet.env,
				policy: policy(),
				prune: true,
			});
			spy.mockRestore();

			expect(reasonById(dryDisk, "backups").get("gjc-update-old")).toBe("would_reclaim:older_than_max_age(14d)");
			expect(reasonById(wetDisk, "backups").get("gjc-update-old")).toBe("reclaimed:older_than_max_age(14d)");
			expect(dryDisk.surfaces.backups.records.find(record => record.id === "gjc-update-old")?.partial).toBe(true);
			expect(wetDisk.surfaces.backups.reclaimed).toBe(dryDisk.surfaces.backups.reclaimable);
			expect(wetDisk.surfaces.backups.failed).toBe(0);
			expect(await fsp.readdir(wet.backupsDir)).toEqual([]);
		} finally {
			spy.mockRestore();
			for (const fixture of [dry, wet]) {
				await fsp.rm(fixture.root, { recursive: true, force: true });
			}
		}
	});

	test("reports a symlinked backup that vanishes under the detach as gone, not failed", async () => {
		const fixture = await makeTestRoot();
		const backup = path.join(fixture.backupsDir, "gjc-update-old");
		const realLstat = fsp.lstat as unknown as (target: PathLike, options?: { bigint?: boolean }) => Promise<Stats>;
		let vanished = false;
		// A tree holding a symlink is detached before it is removed, and the detach
		// re-reads the root's identity. A concurrent cleanup that wins that race
		// must be reported as gone, not crash the whole disk pass.
		const spy = spyOn(fsp, "lstat");
		spy.mockImplementation((async (target: PathLike, options?: { bigint?: boolean }) => {
			if (!vanished && options?.bigint === true && path.resolve(String(target)) === backup) {
				vanished = true;
				await fsp.rm(backup, { recursive: true, force: true });
			}
			return await realLstat(target, options);
		}) as unknown as typeof fsp.lstat);
		try {
			await fsp.mkdir(backup, { recursive: true });
			await Bun.write(path.join(backup, "payload.bin"), "x".repeat(64));
			await fsp.symlink(path.join(backup, "payload.bin"), path.join(backup, "alias"));
			await backdate(backup, 40);

			const disk = await collectGcDiskReport({
				agentDir: fixture.agentDir,
				env: fixture.env,
				policy: policy(),
				prune: true,
			});
			spy.mockRestore();

			expect(vanished).toBe(true);
			expect(reasonById(disk, "backups").get("gjc-update-old")).toBe("keep:entry_disappeared");
			expect(disk.surfaces.backups.records.find(record => record.id === "gjc-update-old")?.withheld).toBeUndefined();
			expect(disk.surfaces.backups.failed).toBe(0);
			expect(disk.surfaces.backups.reclaimed).toBe(0);
		} finally {
			spy.mockRestore();
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});
	test("reclaims a backup whose enumerated files vanished under the walk", async () => {
		const fixture = await makeTestRoot();
		const backup = path.join(fixture.backupsDir, "gjc-update-old");
		const vanishing = path.join(backup, "many");
		const realReaddir = fsp.readdir as unknown as (
			dir: PathLike,
			options?: { withFileTypes?: true },
		) => Promise<Array<string | Dirent>>;
		// Enumerate, then delete: every entry the walk is about to stat answers
		// ENOENT, exactly like a concurrent cleanup of an already-walked tree. Gone
		// is the opposite of unreadable — a vanished file cannot block a remove.
		const spy = spyOn(fsp, "readdir");
		spy.mockImplementation((async (dir: PathLike, options?: { withFileTypes?: true }) => {
			const entries = await realReaddir(dir, options);
			if (path.resolve(String(dir)) === vanishing) {
				for (const entry of entries) {
					const name = typeof entry === "string" ? entry : entry.name;
					await fsp.rm(path.join(vanishing, name), { force: true });
				}
			}
			return entries;
		}) as unknown as typeof fsp.readdir);
		try {
			await fsp.mkdir(vanishing, { recursive: true });
			await Bun.write(path.join(backup, "payload.bin"), "x".repeat(64));
			for (let index = 0; index < 200; index++) {
				await Bun.write(path.join(vanishing, `chunk-${index}.bin`), "y".repeat(32));
			}
			await backdate(backup, 40);

			const disk = await collectGcDiskReport({
				agentDir: fixture.agentDir,
				env: fixture.env,
				policy: policy(),
				prune: true,
			});
			spy.mockRestore();

			const record = disk.surfaces.backups.records.find(entry => entry.id === "gjc-update-old");
			expect(record?.partial).toBe(true);
			expect(record?.withheld).toBeUndefined();
			expect(reasonById(disk, "backups").get("gjc-update-old")).toBe("reclaimed:older_than_max_age(14d)");
			expect(disk.surfaces.backups.reclaimed).toBe(1);
			expect(await fsp.readdir(fixture.backupsDir)).toEqual([]);
		} finally {
			spy.mockRestore();
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("liveness axis is unchanged without --disk", () => {
	test("no disk section is produced and the dry-run report is byte-identical", async () => {
		const fixture = await makeTestRoot();
		try {
			await writeSession(fixture, "repo-a", "stale-session", { ageDays: 900 });
			await writeBlob(fixture, "orphan", 30);

			const before = await snapshotTree(fixture.root);
			const result = await runGjcGcCommand(["--json"], fixture.root, fixture.env, []);
			const report = JSON.parse(result.stdout) as GcReport;

			expect(report.disk).toBeUndefined();
			expect(result.status).toBe(0);
			expect(await snapshotTree(fixture.root)).toEqual(before);

			// Even an explicit prune leaves every byte in place without --disk.
			const pruned = await runGjcGcCommand(["--prune", "--json"], fixture.root, fixture.env, []);
			expect((JSON.parse(pruned.stdout) as GcReport).disk).toBeUndefined();
			expect(await snapshotTree(fixture.root)).toEqual(before);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("exit-code policy for the liveness stores is untouched", async () => {
		const fixture = await makeTestRoot();
		try {
			const record: GcRecord = {
				store: "file_locks",
				id: "lock",
				status: "dead",
				stale: true,
				removable: true,
				action: "none",
				reason: "owner pid is dead",
			};
			const failing = fakeAdapter("file_locks", [record], async () => ({ removed: false, error: "EACCES" }));

			const withoutDisk = await runGjcGcCommand(["--prune", "--json"], fixture.root, fixture.env, [failing]);
			expect(withoutDisk.status).toBe(1);
			expect((JSON.parse(withoutDisk.stdout) as GcReport).counts.failed).toBe(1);

			// The disk axis must not mask or change that outcome.
			const withDisk = await runGjcGcCommand(
				["--prune", "--disk", "--json"],
				fixture.root,
				fixture.env,
				[failing],
				policy(),
			);
			expect(withDisk.status).toBe(1);
			expect((JSON.parse(withDisk.stdout) as GcReport).counts.failed).toBe(1);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("--disk is rejected as an unknown flag nowhere and never implies --prune", async () => {
		const fixture = await makeTestRoot();
		try {
			const stale = await writeSession(fixture, "repo-a", "stale-session", { ageDays: 900 });
			await writeSession(fixture, "repo-a", "recent-session", { ageDays: 1 });

			const result = await runGjcGcCommand(["--disk", "--json"], fixture.root, fixture.env, [], policy());
			expect(result.status).toBe(0);
			expect(await Bun.file(stale).exists()).toBe(true);

			const explicitDryRun = await runGjcGcCommand(
				["--disk", "--prune", "--dry-run", "--json"],
				fixture.root,
				fixture.env,
				[],
				policy(),
			);
			expect(requireDisk(JSON.parse(explicitDryRun.stdout) as GcReport).dry_run).toBe(true);
			expect(await Bun.file(stale).exists()).toBe(true);
		} finally {
			await fsp.rm(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("gc disk policy defaults", () => {
	test("mirror the gc.* settings schema", () => {
		expect(GC_DISK_POLICY_DEFAULTS).toEqual({
			sessions_max_age_days: getDefault("gc.sessions.maxAgeDays"),
			sessions_max_total_bytes: getDefault("gc.sessions.maxTotalBytes"),
			natives_keep_versions: getDefault("gc.natives.keepVersions"),
			backups_max_age_days: getDefault("gc.backups.maxAgeDays"),
		});
		expect(GC_DISK_POLICY_DEFAULTS).toEqual({
			sessions_max_age_days: 60,
			sessions_max_total_bytes: 0,
			natives_keep_versions: 2,
			backups_max_age_days: 30,
		});
	});

	test("overrides replace only the knobs they supply", () => {
		expect(resolveGcDiskPolicy({ natives_keep_versions: 5 })).toEqual({
			...GC_DISK_POLICY_DEFAULTS,
			natives_keep_versions: 5,
		});
		expect(resolveGcDiskPolicy()).toEqual(GC_DISK_POLICY_DEFAULTS);
	});
});
