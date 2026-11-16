import { afterEach, describe, expect, it, vi } from "bun:test";
import * as sync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { getSessionsDir } from "@gajae-code/utils";
import { deleteEmbeddedSession, forkEmbeddedSession, listEmbeddedProjectSessions } from "../../src/sdk/embedding";
import { resolveEmbeddedResumeCheckpoint } from "../../src/sdk/native-embedding";
import { createCooperativeOwnerInspectors } from "../../src/sdk/native-ownership";
import * as managedInspection from "../../src/sdk/session-readonly/inspection";
import {
	listManagedCandidates,
	MANAGED_INTERNAL_DIRECTORY,
	MANAGED_TOMBSTONES_DIRECTORY,
	resolveManagedScope,
} from "../../src/sdk/session-readonly/scope";
import * as blobStore from "../../src/session/blob-store";
import {
	deleteManagedSessionCandidate,
	prepareManagedSessionScopeForWriteSync,
	resolveManagedScopeForWrite,
} from "../../src/session/internal/managed-session-scope";
import { prepareManagedDirectoryRoot } from "../../src/session/internal/managed-session-storage";
import {
	admitOwnerMembershipSync,
	captureLegacyTakeoverAttestationSync,
	captureOwnerTargetSync,
	getOwnerMembershipEvidence,
	type OwnerMembership,
	type OwnerRecord,
	reserveOwnerTransferSync,
	retireOwnerMembershipSync,
	settleOwnerTransferSync,
} from "../../src/session/owner-group";
import { SessionManager } from "../../src/session/session-manager";
import {
	FileSessionStorage,
	type VerifiedSessionDeleteResult,
	type VerifiedSessionDeleteTarget,
} from "../../src/session/session-storage";
import { ensureManagedTaskArtifactOwner } from "../../src/session/task-artifact-owner";
import {
	parseTaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerStorageContext,
} from "../../src/session/task-artifact-owner-codec";
import * as taskOwnerRetirement from "../../src/session/task-artifact-owner-retirement";

const roots: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const timestamp = "2026-01-01T00:00:00.000Z";
const user = (id: string, parentId: string | null) => ({
	type: "message",
	id,
	parentId,
	timestamp,
	message: { role: "user", content: id, timestamp: 1 },
});
async function fixture(entries: unknown[] = []) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-maintenance-")));
	roots.push(root);
	const cwd = path.join(root, "project");
	const directory = path.join(root, "explicit");
	const agentDir = path.join(root, "profile");
	await fs.mkdir(cwd);
	await fs.mkdir(directory);
	const file = path.join(directory, "selected.jsonl");
	const records = [{ type: "session", version: 5, id: "selected", cwd, timestamp }, ...entries];
	await Bun.write(file, records.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	return { root, cwd, directory, agentDir, file, records };
}
interface Fixture {
	root: string;
	cwd: string;
	directory: string;
	agentDir: string;
	file: string;
	records: unknown[];
}
function checkpoint(file: string) {
	const result = resolveEmbeddedResumeCheckpoint(file);
	if (result.kind !== "resolved") throw new Error(`Fixture checkpoint failed: ${result.reason}`);
	return result.checkpoint;
}
type TreeRow = [string, string | TreeRow[]] | [string, "symlink", string];
async function tree(root: string): Promise<TreeRow[]> {
	const rows: TreeRow[] = [];
	for (const name of (await fs.readdir(root)).sort()) {
		const file = path.join(root, name);
		const stat = await fs.lstat(file);
		rows.push(
			stat.isSymbolicLink()
				? [name, "symlink", await fs.readlink(file)]
				: stat.isDirectory()
					? [name, await tree(file)]
					: [name, Buffer.from(await fs.readFile(file)).toString("base64")],
		);
	}
	return rows;
}
function trackOwnedGuardRetirements(f: Fixture) {
	const original = native.exactUnlink;
	const retained: string[] = [];
	const receipts: Array<{ pathname: string; stat: sync.BigIntStats; bytes: Buffer }> = [];
	const openStaged = FileSessionStorage.prototype.openStagedWriter;
	const staged = vi.spyOn(FileSessionStorage.prototype, "openStagedWriter").mockImplementation(function (
		this: FileSessionStorage,
		pathname,
		options,
	) {
		const writer = openStaged.call(this, pathname, options);
		const publish = writer.publishNoReplace.bind(writer);
		vi.spyOn(writer, "publishNoReplace").mockImplementation(() => {
			const result = publish();
			expect(result.kind).toBe("fsync");
			expect(result.namespaceSynced).toBe(true);
			expect(path.dirname(pathname)).toBe(f.directory);
			const stat = sync.lstatSync(pathname, { bigint: true });
			const bytes = sync.readFileSync(pathname);
			expect([stat.dev, stat.ino, stat.nlink, Number(stat.size), stat.mtimeNs, stat.ctimeNs]).toEqual([
				result.stat.dev,
				result.stat.ino,
				1n,
				result.stat.size,
				result.stat.mtimeNs,
				result.stat.ctimeNs,
			]);
			expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(result.sha256);
			expect(JSON.parse(bytes.toString("utf8")).target.transcriptPath).toBe(f.file);
			receipts.push({ pathname, stat, bytes });
			return result;
		});
		return writer;
	});
	const lock = path.join(f.directory, ".gjc-owners", "selected.json.lock");
	const spy = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
		const planned =
			pathname === lock && identity.quarantineName
				? path.join(path.dirname(lock), identity.quarantineName)
				: undefined;
		if (planned) expect(sync.existsSync(planned)).toBe(false);
		const outcome = original(pathname, identity);
		if (planned && sync.existsSync(planned)) {
			// Only the exact quarantine name issued by our own lock retirement may
			// add a row. Neither a filename pattern nor arbitrary metadata is allowed.
			const stat = sync.lstatSync(planned, { bigint: true });
			expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
			expect([stat.dev, stat.ino, stat.nlink, stat.size]).toEqual([identity.dev, identity.ino, 1n, 0n]);
			retained.push(planned);
		}
		return outcome;
	});
	return {
		assertTree: async (before: TreeRow[]) => {
			spy.mockRestore();
			staged.mockRestore();
			const expected = structuredClone(before);
			for (const receipt of receipts) {
				const current = await fs.lstat(receipt.pathname, { bigint: true });
				expect([current.dev, current.ino, current.nlink, current.size, current.mtimeNs, current.ctimeNs]).toEqual([
					receipt.stat.dev,
					receipt.stat.ino,
					1n,
					receipt.stat.size,
					receipt.stat.mtimeNs,
					receipt.stat.ctimeNs,
				]);
				expect(await fs.readFile(receipt.pathname)).toEqual(Buffer.from(receipt.bytes));
			}
			const additions: Array<[string, string]> = [
				...retained.map(pathname => [pathname, ""] as [string, string]),
				...receipts.map(receipt => [receipt.pathname, receipt.bytes.toString("base64")] as [string, string]),
			];
			for (const [pathname, content] of additions) {
				let parent = expected;
				const parts = path.relative(f.root, pathname).split(path.sep);
				for (const component of parts.slice(0, -1)) {
					const row = parent.find(([name]) => name === component);
					if (!row || !Array.isArray(row[1]))
						throw new Error("Owned guard parent was not in the original snapshot");
					parent = row[1];
				}
				parent.push([parts.at(-1)!, content]);
				parent.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
			}
			expect(await tree(f.root)).toEqual(expected);
		},
	};
}
async function caught(
	operation: Promise<unknown>,
): Promise<Error & { code?: string; retry?: object; outcome?: VerifiedSessionDeleteResult; checkpoint?: unknown }> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("Expected maintenance refusal");
}
function owner(f: Fixture, native = false): OwnerMembership {
	const target = captureOwnerTargetSync({ transcriptPath: f.file, headerId: "selected" });
	const inspectors = createCooperativeOwnerInspectors(f);
	const expected = { snapshotDigest: target.snapshotDigest, resolved: checkpoint(f.file) };
	return admitOwnerMembershipSync(
		target,
		native
			? {
					kind: "exclusive_native",
					expected,
					legacyAttestation: captureLegacyTakeoverAttestationSync(target, inspectors),
				}
			: { kind: "cooperative" },
		{
			...inspectors,
			runtime: "native-maintenance-test",
			capabilities: ["publication", "move"],
		},
	);
}
async function artifacts(f: Fixture) {
	const directory = f.file.slice(0, -6);
	await fs.mkdir(directory);
	await Bun.write(path.join(directory, "retained.txt"), "selected artifacts");
	return directory;
}
async function managedFile(f: Fixture, agentDir: string, id: string, cwd = f.cwd) {
	const resolution = resolveManagedScope({ cwd: f.cwd, agentDir, sessionsRoot: getSessionsDir(agentDir) });
	if (resolution.kind !== "resolved") throw new Error(resolution.message);
	await fs.mkdir(resolution.scope.directoryPath, { recursive: true, mode: 0o700 });
	const file = path.join(resolution.scope.directoryPath, `${id}.jsonl`);
	await Bun.write(file, JSON.stringify({ type: "session", version: 5, id, cwd, timestamp }) + "\n");
	return file;
}

async function preparedManagedFixture() {
	const f = await fixture();
	await fs.mkdir(f.agentDir, { mode: 0o700 });
	await fs.mkdir(getSessionsDir(f.agentDir), { mode: 0o700 });
	const policy = process.platform === "win32" ? "windows-existing-verify-first" : "default";
	const context: TaskArtifactOwnerStorageContext = {
		profileAgentDir: f.agentDir,
		sessionsRoot: getSessionsDir(f.agentDir),
		rootAuthority: prepareManagedDirectoryRoot(f.agentDir, policy),
		securityPolicy: policy,
	};
	const resolved = resolveManagedScopeForWrite({
		cwd: f.cwd,
		agentDir: f.agentDir,
		sessionsRoot: context.sessionsRoot,
	});
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope, policy);
	if (prepared.kind !== "resolved") throw new Error(prepared.message);
	const file = path.join(resolved.scope.directoryPath, "selected.jsonl");
	await Bun.write(file, f.records.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	await fs.rm(f.file);
	return { ...f, file, directory: resolved.scope.directoryPath, context, scope: resolved.scope };
}

describe("native read-only maintenance inventory", () => {
	it("certifies confirmed absent roots as empty without creating any profile or project state", async () => {
		const f = await fixture();
		await fs.rm(f.file);
		await fs.rmdir(f.directory);
		const before = await tree(f.root);
		const result = await listEmbeddedProjectSessions(f);
		expect(result.outcome.kind).toBe("complete");
		expect(result.inventory).toEqual({
			managed: { kind: "complete", candidates: [] },
			local: { kind: "complete", candidates: [] },
		});
		expect(result.managed).toEqual([]);
		expect(result.local).toEqual([]);
		expect(await tree(f.root)).toEqual(before);
	});

	it("uses only the selected cwd and profile while retaining the display arrays", async () => {
		const f = await fixture([user("a", null)]);
		const selected = await managedFile(f, f.agentDir, "in-profile");
		const other = await managedFile(f, path.join(f.root, "other-profile"), "other-profile");
		const foreignCwd = path.join(f.root, "foreign-project");
		await fs.mkdir(foreignCwd);
		await managedFile(f, f.agentDir, "foreign-project", foreignCwd);
		const before = await tree(f.root);
		const result = await listEmbeddedProjectSessions(f);
		expect(result.outcome.kind).toBe("complete");
		if (result.inventory.managed.kind !== "complete" || result.inventory.local.kind !== "complete")
			throw new Error("Expected complete inventories");
		expect(result.inventory.managed.candidates.map(item => item.path)).toEqual([selected]);
		expect(result.inventory.local.candidates.map(item => item.path)).toEqual([f.file]);
		expect(result.managed.some(item => item.path === other)).toBe(false);
		expect(result.local).toHaveLength(1);
		expect(await tree(f.root)).toEqual(before);
	});

	it("reports malformed actual transcripts as incomplete even when display parsing is forgiving", async () => {
		const f = await fixture();
		await Bun.write(path.join(f.directory, "malformed.jsonl"), "{not-json\n");
		const before = await tree(f.root);
		const result = await listEmbeddedProjectSessions(f);
		expect(result.outcome.kind).toBe("incomplete");
		expect(result.inventory.local.kind).toBe("failure");
		expect(await tree(f.root)).toEqual(before);
	});

	it("does not mistake dangling roots or dangling transcript names for confirmed absence", async () => {
		const f = await fixture();
		await fs.symlink(path.join(f.root, "absent"), path.join(f.directory, "dangling.jsonl"));
		expect((await listEmbeddedProjectSessions(f)).inventory.local.kind).toBe("failure");
		await fs.symlink(path.join(f.root, "missing-profile"), f.agentDir);
		const before = await tree(f.root);
		expect((await listEmbeddedProjectSessions(f)).inventory.managed.kind).toBe("failure");
		expect(await tree(f.root)).toEqual(before);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"reports an actually inaccessible directory as incomplete",
		async () => {
			const f = await fixture();
			await fs.chmod(f.directory, 0);
			try {
				expect((await listEmbeddedProjectSessions(f)).inventory.local.kind).toBe("failure");
			} finally {
				await fs.chmod(f.directory, 0o700);
			}
		},
	);

	it("refuses a project directory renamed during actual transcript inspection", async () => {
		const f = await fixture();
		const directory = path.join(f.cwd, ".gjc", "sessions");
		await fs.mkdir(directory, { recursive: true });
		const selected = path.join(directory, "inside.jsonl");
		await fs.copyFile(f.file, selected);
		const original = SessionManager.captureTranscriptStrict;
		let replaced = false;
		const spy = vi.spyOn(SessionManager, "captureTranscriptStrict").mockImplementation((file, storage) => {
			const capture = original(file, storage);
			if (!replaced && path.resolve(file) === selected) {
				replaced = true;
				sync.renameSync(directory, `${directory}.old`);
				sync.mkdirSync(directory);
			}
			return capture;
		});
		const result = await listEmbeddedProjectSessions(f);
		spy.mockRestore();
		expect(replaced).toBe(true);
		expect(result.inventory.managed.kind).toBe("failure");
		expect(await Bun.file(path.join(`${directory}.old`, "inside.jsonl")).text()).toBe(await Bun.file(f.file).text());
	});
});

describe("checkpoint-selected full-history native forks", () => {
	for (const recorded of [false, true]) {
		it(`returns the actual ${recorded ? "ambiguous" : "legacy"} selector before destination effects`, async () => {
			const f = await fixture([
				user("a", null),
				...(recorded
					? [
							{
								type: "custom",
								id: "old-cursor",
								parentId: "a",
								timestamp,
								customType: "gjc.resume_cursor",
								data: {
									v: 1,
									bind: "selected",
									op: "old",
									idx: 0,
									member: "old",
									reason: "pin",
									supersedes: [],
								},
							},
						]
					: []),
				user("b", null),
			]);
			const before = await tree(f.root);
			const error = await caught(forkEmbeddedSession({ ...f, directory: path.join(f.root, "new-fork") }));
			expect(error.code).toBe("selector_required");
			expect(error.checkpoint).toEqual(checkpoint(f.file));
			expect(checkpoint(f.file).kind).toBe(recorded ? "ambiguous" : "legacy_tail");
			expect(await tree(f.root)).toEqual(before);
		});
	}

	for (const target of [null, "a"] as const) {
		it(`preserves all original records with a separate ${target === null ? "root" : "non-tail"} target and independent owner`, async () => {
			const f = await fixture([
				user("a", null),
				user("b", null),
				...Array.from({ length: 200 }, (_, index) =>
					user(`history-${index}`, index === 0 ? "b" : `history-${index - 1}`),
				),
			]);
			const source = owner(f);
			const sourceEvidence = getOwnerMembershipEvidence(source);
			const before = await Bun.file(f.file).text();
			const sourceOwner = await Bun.file(sourceEvidence.authorityKey).text();
			const directory = path.join(f.root, `fork-${target ?? "root"}`);
			const issuedCacheRoots = new Set<string>();
			const openCache = blobStore.openVerifiedResidentCacheInstanceDir;
			const cache = vi.spyOn(blobStore, "openVerifiedResidentCacheInstanceDir").mockImplementation((...args) => {
				const issued = openCache(...args);
				issuedCacheRoots.add(issued);
				return issued;
			});
			try {
				const manager = await forkEmbeddedSession({
					...f,
					directory,
					selection: { snapshotDigest: checkpoint(f.file).snapshotDigest, targetLeafId: target },
				});
				managers.push(manager);
				const file = manager.getSessionFile()!;
				const lines = (await Bun.file(file).text()).trim().split("\n");
				const rows = lines.map(line => JSON.parse(line));
				expect(f.records).toHaveLength(203);
				expect(rows[0].id).not.toBe("selected");
				expect(rows.slice(1, f.records.length)).toEqual(f.records.slice(1));
				expect(lines.slice(1, f.records.length).join("\n") + "\n").toBe(before.slice(before.indexOf("\n") + 1));
				expect(rows.filter(row => row.type === "session")).toHaveLength(1);
				const enroll = rows.find(
					row => row.customType === "gjc.owner_enroll" && row.data.bind === manager.getSessionId(),
				);
				const cursor = rows.find(
					row => row.customType === "gjc.resume_cursor" && row.data.bind === manager.getSessionId(),
				);
				expect(enroll.data.member).not.toBe(sourceEvidence.memberId);
				expect(enroll.data.epoch).not.toBe(sourceEvidence.epoch);
				expect(cursor).toMatchObject({ parentId: target, data: { reason: "fork_init" } });
				expect(checkpoint(file)).toMatchObject({ kind: "recorded", conversationLeafId: target });
				const destinationOwner = captureOwnerTargetSync({ transcriptPath: file, headerId: manager.getSessionId() });
				const record = (await Bun.file(destinationOwner.authorityKey).json()) as OwnerRecord;
				expect(record.state).toBe("live");
				expect(record.epoch).toBe(enroll.data.epoch);
				expect(record.members.map(member => member.memberId)).toEqual([enroll.data.member]);
				expect(await Bun.file(f.file).text()).toBe(before);
				expect(await Bun.file(sourceEvidence.authorityKey).text()).toBe(sourceOwner);
				// Account only for cache authorities actually issued to this fork,
				// never arbitrary profile files or name-pattern allowances.
				const expectedCache: TreeRow[] = [];
				for (const issued of issuedCacheRoots) {
					expect(path.dirname(issued)).toBe(path.join(f.agentDir, "resident-cache"));
					const stat = await fs.lstat(issued).catch((error: unknown) => {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
						throw error;
					});
					if (!stat) continue;
					expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
					const bytes = await Bun.file(path.join(issued, "owner.json")).text();
					const ownerRecord = JSON.parse(bytes);
					expect(ownerRecord).toMatchObject({ pid: process.pid, nonce: path.basename(issued).slice(2) });
					expect(Object.keys(ownerRecord).sort()).toEqual([
						"createdAt",
						"nonce",
						"pid",
						"startTimeBasis",
						"startTimeMs",
					]);
					expect(Number.isFinite(ownerRecord.startTimeMs)).toBe(true);
					expectedCache.push([path.basename(issued), [["owner.json", Buffer.from(bytes).toString("base64")]]]);
				}
				expectedCache.sort(([left], [right]) => left.localeCompare(right));
				expect(await tree(f.agentDir)).toEqual([["resident-cache", expectedCache]]);
			} finally {
				cache.mockRestore();
				retireOwnerMembershipSync(source);
			}
		});
	}

	it("uses the actual unique checkpoint rather than the physical metadata tail", async () => {
		const f = await fixture([
			user("a", null),
			{
				type: "custom",
				id: "inert",
				parentId: "a",
				timestamp,
				customType: "gjc.owner_enroll",
				data: {
					v: 1,
					bind: "selected",
					member: "old",
					runtime: "legacy",
					pid: 2_147_483_647,
					processIncarnation: "old",
					hostId: "old",
					epoch: "old",
				},
			},
		]);
		expect(checkpoint(f.file).leafEntryId).toBe("a");
		const before = await Bun.file(f.file).text();
		const manager = await forkEmbeddedSession({ ...f, directory: path.join(f.root, "unique") });
		managers.push(manager);
		const rows = (await Bun.file(manager.getSessionFile()!).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(rows.slice(1, 3)).toEqual(f.records.slice(1));
		expect(rows.some(row => row.customType === "gjc.resume_cursor" && row.data.bind === manager.getSessionId())).toBe(
			false,
		);
		expect(checkpoint(manager.getSessionFile()!)).toMatchObject({
			kind: "tail_unambiguous",
			leafEntryId: "a",
			conversationLeafId: "a",
		});
		const enrollment = rows.find(
			row => row.customType === "gjc.owner_enroll" && row.data.bind === manager.getSessionId(),
		);
		expect(enrollment).toBeDefined();
		const destination = captureOwnerTargetSync({
			transcriptPath: manager.getSessionFile()!,
			headerId: manager.getSessionId(),
		});
		const probed = createCooperativeOwnerInspectors(f).readMarkers(destination);
		expect(probed.kind).toBe("present");
		expect(probed.members.map(member => member.memberId)).toEqual([enrollment.data.member]);
		expect(await Bun.file(f.file).text()).toBe(before);
	});

	it("forks an empty checkpoint and atomically publishes into an existing empty directory", async () => {
		const f = await fixture();
		const directory = path.join(f.root, "empty-destination");
		await fs.mkdir(directory);
		const manager = await forkEmbeddedSession({ ...f, directory });
		managers.push(manager);
		expect(checkpoint(manager.getSessionFile()!)).toMatchObject({
			kind: "empty",
			leafEntryId: null,
			conversationLeafId: null,
		});
		const rows = (await Bun.file(manager.getSessionFile()!).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(rows.some(row => row.customType === "gjc.owner_enroll" && row.data.bind === manager.getSessionId())).toBe(
			true,
		);
		expect(rows.some(row => row.customType === "gjc.resume_cursor" && row.data.bind === manager.getSessionId())).toBe(
			false,
		);
		expect((await fs.readdir(directory)).length).toBeGreaterThan(0);
		expect(await Bun.file(f.file).text()).toBe(f.records.map(row => JSON.stringify(row)).join("\n") + "\n");
	});

	it("refuses stale consent and invalid selected IDs without creating destination state", async () => {
		const f = await fixture([user("a", null)]);
		const digest = checkpoint(f.file).snapshotDigest;
		await Bun.write(f.file, (await Bun.file(f.file).text()) + JSON.stringify(user("b", "a")) + "\n");
		const before = await tree(f.root);
		expect(
			(
				await caught(
					forkEmbeddedSession({
						...f,
						directory: path.join(f.root, "stale"),
						selection: { snapshotDigest: digest, targetLeafId: "a" },
					}),
				)
			).code,
		).toBe("stale_snapshot");
		expect(
			(
				await caught(
					forkEmbeddedSession({
						...f,
						directory: path.join(f.root, "invalid"),
						selection: { snapshotDigest: checkpoint(f.file).snapshotDigest, targetLeafId: "missing" },
					}),
				)
			).code,
		).toBe("invalid_target");
		expect(await tree(f.root)).toEqual(before);
	});

	it("preserves a colliding destination and source without publication effects", async () => {
		const f = await fixture([user("a", null)]);
		const directory = path.join(f.root, "collision");
		await Bun.write(directory, "foreign destination");
		const before = await tree(f.root);
		expect((await caught(forkEmbeddedSession({ ...f, directory }))).code).toBe("destination_unavailable");
		expect(await tree(f.root)).toEqual(before);
	});
});

describe("owner-checked native deletion", () => {
	for (const native of [false, true]) {
		it(`vetoes an actual live ${native ? "native" : "cooperative"} owner before artifact cleanup`, async () => {
			const f = await fixture([user("a", null)]);
			await artifacts(f);
			const token = owner(f, native);
			try {
				const before = await tree(f.root);
				const error = await caught(deleteEmbeddedSession(f.file, { cwd: f.cwd, agentDir: f.agentDir }));
				expect(error.code).toBe("owned_by_other");
				expect(await tree(f.root)).toEqual(before);
			} finally {
				retireOwnerMembershipSync(token);
			}
		});
	}

	it("preserves a foreign-host unknown owner and its artifacts", async () => {
		const f = await fixture();
		await artifacts(f);
		const token = owner(f);
		const evidence = getOwnerMembershipEvidence(token);
		const record = (await Bun.file(evidence.authorityKey).json()) as OwnerRecord;
		await Bun.write(
			evidence.authorityKey,
			JSON.stringify({ ...record, members: record.members.map(member => ({ ...member, hostId: "f".repeat(64) })) }) +
				"\n",
		);
		const before = await tree(f.root);
		expect((await caught(deleteEmbeddedSession(f.file, f))).code).toBe("unknown_ownership");
		expect(await tree(f.root)).toEqual(before);
	});

	for (const body of [
		"{malformed",
		JSON.stringify({ version: 1, sessionId: "selected", pid: process.pid, stale: true, url: "ws://127.0.0.1:1" }),
	]) {
		it("vetoes actual unknown/live TUI endpoint evidence before cleanup", async () => {
			const f = await fixture();
			await artifacts(f);
			await Bun.write(path.join(f.cwd, ".gjc", "state", "sdk", "selected.json"), body);
			const before = await tree(f.root);
			expect((await caught(deleteEmbeddedSession(f.file, f))).code).toBe("unknown_ownership");
			expect(await tree(f.root)).toEqual(before);
		});
	}

	it("vetoes an actual reserved transfer before deleting either root", async () => {
		const f = await fixture();
		await artifacts(f);
		const token = owner(f);
		const next = path.join(f.root, "next");
		await fs.mkdir(next);
		const transfer = reserveOwnerTransferSync(
			token,
			captureOwnerTargetSync({ transcriptPath: path.join(next, "selected.jsonl"), headerId: "selected" }),
		);
		try {
			const before = await tree(f.root);
			expect((await caught(deleteEmbeddedSession(f.file, f))).code).toBe("transfer_in_progress");
			expect(await tree(f.root)).toEqual(before);
		} finally {
			settleOwnerTransferSync(transfer, "abort");
			retireOwnerMembershipSync(token);
		}
	});

	for (const recordedOwner of [false, true]) {
		it(`completes real nonempty external ordinary artifacts with ${recordedOwner ? "retired" : "absent"} C6 authority`, async () => {
			const f = await fixture([user("a", null)]);
			const directory = await artifacts(f);
			const rootIdentity = await fs.lstat(directory, { bigint: true });
			const payloadIdentity = await fs.lstat(path.join(directory, "retained.txt"), { bigint: true });
			const token = recordedOwner ? owner(f) : undefined;
			const evidence = token ? getOwnerMembershipEvidence(token) : undefined;
			if (token) retireOwnerMembershipSync(token);
			const original = FileSessionStorage.prototype.deleteSessionVerified;
			const outcomes: VerifiedSessionDeleteResult[] = [];
			const targets: VerifiedSessionDeleteTarget[] = [];
			vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified").mockImplementation(async function (
				this: FileSessionStorage,
				target,
				inspectProtocol,
			) {
				targets.push(structuredClone(target));
				if (target.artifactsRemoved) {
					const records = (await fs.readdir(f.directory)).filter(name => name.endsWith("-receipt"));
					const completed = await Promise.all(records.map(name => Bun.file(path.join(f.directory, name)).json()));
					expect(
						completed.some(
							record =>
								record.target.artifactsRemoved === true &&
								record.target.transcriptIdentity.ino === String(target.transcriptIdentity.ino),
						),
					).toBe(true);
				}
				const result = await original.call(this, target, inspectProtocol);
				outcomes.push(structuredClone(result));
				return result;
			});
			await deleteEmbeddedSession(f.file, f);
			expect(targets).toHaveLength(2);
			expect(targets[1].artifactsRemoved).toBe(true);
			expect(targets[1].transcriptIdentity).toEqual(targets[0].transcriptIdentity);
			expect(outcomes[1].kind).toBe("deleted");
			expect(await Bun.file(f.file).exists()).toBe(false);
			expect(sync.existsSync(directory)).toBe(false);
			if (evidence) expect(await Bun.file(evidence.authorityKey).exists()).toBe(false);
			if (process.platform !== "win32") {
				const outcome = outcomes[0];
				if (outcome.kind !== "cleanup_pending" || outcome.phase !== "artifacts")
					throw new Error("Expected actual native retained-artifact disposition");
				expect(outcome.artifactsPayloadDurable).toBe(true);
				expect(outcome.detachedArtifactsPath).toBe(`${targets[0].plannedArtifactsPath}.removing`);
				const retained = await fs.lstat(outcome.detachedArtifactsPath, { bigint: true });
				const payload = await fs.lstat(path.join(outcome.detachedArtifactsPath, "retained.txt"), { bigint: true });
				expect([retained.dev, retained.ino]).toEqual([rootIdentity.dev, rootIdentity.ino]);
				expect([payload.dev, payload.ino, payload.size]).toEqual([payloadIdentity.dev, payloadIdentity.ino, 0n]);
				expect(native.snapshotDirectoryTree(outcome.detachedArtifactsPath).snapshot).toEqual(outcome.artifactsTree);
			} else expect(outcomes[0].kind).toBe("artifacts_removed");
			expect(sync.existsSync(f.agentDir)).toBe(false);
		});
	}

	for (const recordedOwner of [false, true]) {
		it(`completes a cold prepared managed nonempty artifact deletion with ${recordedOwner ? "retired" : "absent"} C6 record`, async () => {
			const f = await preparedManagedFixture();
			await artifacts(f);
			const token = recordedOwner ? owner(f) : undefined;
			const evidence = token ? getOwnerMembershipEvidence(token) : undefined;
			if (token) retireOwnerMembershipSync(token);
			const original = FileSessionStorage.prototype.deleteSessionVerified;
			const targets: VerifiedSessionDeleteTarget[] = [];
			vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified").mockImplementation(function (
				this: FileSessionStorage,
				target,
				inspector,
			) {
				targets.push(structuredClone(target));
				return original.call(this, target, inspector);
			});
			await deleteEmbeddedSession(f.file, { ...f, managed: true });
			expect(await Bun.file(f.file).exists()).toBe(false);
			expect(sync.existsSync(f.file.slice(0, -6))).toBe(false);
			expect(targets.some(target => target.artifactsRemoved === true)).toBe(true);
			expect(targets.every(target => target.sessionsRoot === f.context.sessionsRoot)).toBe(true);
			if (evidence) expect(await Bun.file(evidence.authorityKey).exists()).toBe(false);
		});
	}

	for (const side of ["retainedSuccessorPath", "retainedPlaceholderPath", "retainedUnknownPath"] as const) {
		it.skipIf(process.platform === "win32")(
			`blocks managed artifact promotion for an actual native nonempty ${side}`,
			async () => {
				const f = await preparedManagedFixture();
				const directory = await artifacts(f);
				const rootIdentity = await fs.lstat(directory, { bigint: true });
				const transcriptIdentity = await fs.lstat(f.file, { bigint: true });
				const transcript = await Bun.file(f.file).text();
				const token = owner(f);
				const evidence = getOwnerMembershipEvidence(token);
				retireOwnerMembershipSync(token);
				const ownerRecord = await Bun.file(evidence.authorityKey).text();
				const sidePath = path.join(f.directory, ".gjc-native-side");
				const originalRemove = native.exactRemoveDirectoryTree;
				vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementationOnce((...args) => {
					const result = originalRemove(...args);
					expect(result).toMatchObject({ ok: false, code: "cleanup_pending", payloadDurable: true });
					sync.mkdirSync(sidePath, { mode: 0o700 });
					sync.writeFileSync(path.join(sidePath, "foreign.txt"), "foreign side payload", { mode: 0o600 });
					return { ...result, [side]: sidePath };
				});
				const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
				const targets: VerifiedSessionDeleteTarget[] = [];
				const outcomes: VerifiedSessionDeleteResult[] = [];
				vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified").mockImplementation(async function (
					this: FileSessionStorage,
					target,
					inspector,
				) {
					targets.push(structuredClone(target));
					const result = await originalDelete.call(this, target, inspector);
					outcomes.push(structuredClone(result));
					return result;
				});
				const unlink = vi.spyOn(native, "exactUnlink");
				const refused = await caught(deleteEmbeddedSession(f.file, { ...f, managed: true }));
				expect(refused.code).toBe("durability_failed");
				expect(refused.retry).toBeDefined();
				const retained = outcomes[0];
				if (retained.kind !== "cleanup_pending" || retained.phase !== "artifacts")
					throw new Error("Expected actual native artifact retirement");
				expect(retained).toMatchObject({ artifactsPayloadDurable: true, [side]: sidePath });
				const identity = await fs.lstat(retained.detachedArtifactsPath, { bigint: true });
				expect([identity.dev, identity.ino]).toEqual([rootIdentity.dev, rootIdentity.ino]);
				expect(await Bun.file(path.join(retained.detachedArtifactsPath, "retained.txt")).text()).toBe("");
				expect(await Bun.file(path.join(sidePath, "foreign.txt")).text()).toBe("foreign side payload");
				const sideIdentity = await fs.lstat(sidePath, { bigint: true });
				const sideTree = await tree(sidePath);
				const journalDirectory = path.join(f.directory, MANAGED_INTERNAL_DIRECTORY, MANAGED_TOMBSTONES_DIRECTORY);
				const journals: Array<{
					artifactsPayloadDurable?: true;
					retainedArtifactsSuccessorPath?: string;
					retainedArtifactsPlaceholderPath?: string;
					retainedArtifactsUnknownPath?: string;
				}> = [];
				for (const name of await fs.readdir(journalDirectory)) {
					expect(name.includes(".cleanup-artifacts_removed-") || name.includes(".cleanup-completed-")).toBe(false);
					if (name.includes(".cleanup-pending-"))
						journals.push(await Bun.file(path.join(journalDirectory, name)).json());
				}
				const field = (
					{
						retainedSuccessorPath: "retainedArtifactsSuccessorPath",
						retainedPlaceholderPath: "retainedArtifactsPlaceholderPath",
						retainedUnknownPath: "retainedArtifactsUnknownPath",
					} as const
				)[side];
				expect(journals.some(record => record[field] === sidePath && record.artifactsPayloadDurable === true)).toBe(
					true,
				);
				await caught(deleteEmbeddedSession(f.file, { ...f, managed: true, retry: refused.retry }));
				expect(targets.every(target => target.artifactsRemoved !== true)).toBe(true);
				expect(
					unlink.mock.calls.some(
						([, identity]) => identity.dev === transcriptIdentity.dev && identity.ino === transcriptIdentity.ino,
					),
				).toBe(false);
				expect(await Bun.file(f.file).text()).toBe(transcript);
				expect(await Bun.file(evidence.authorityKey).text()).toBe(ownerRecord);
				const after = await fs.lstat(sidePath, { bigint: true });
				expect([after.dev, after.ino, after.mtimeNs, after.ctimeNs]).toEqual([
					sideIdentity.dev,
					sideIdentity.ino,
					sideIdentity.mtimeNs,
					sideIdentity.ctimeNs,
				]);
				expect(await tree(sidePath)).toEqual(sideTree);
			},
		);
	}

	for (const alias of ["canonical", "planned"] as const) {
		it.skipIf(process.platform === "win32")(
			`refuses a managed ${alias} artifact alias after the real artifacts_removed response`,
			async () => {
				const f = await preparedManagedFixture();
				const token = owner(f);
				const evidence = getOwnerMembershipEvidence(token);
				retireOwnerMembershipSync(token);
				const ownerRecord = await Bun.file(evidence.authorityKey).text();
				const transcript = await Bun.file(f.file).text();
				const original = FileSessionStorage.prototype.deleteSessionVerified;
				let changed = "";
				const remove = vi
					.spyOn(FileSessionStorage.prototype, "deleteSessionVerified")
					.mockImplementation(async function (this: FileSessionStorage, target, inspector) {
						const result = await original.call(this, target, inspector);
						expect(result.kind).toBe("artifacts_removed");
						const directory = alias === "canonical" ? f.file.slice(0, -6) : target.plannedArtifactsPath!;
						sync.mkdirSync(directory, { mode: 0o700 });
						changed = path.join(directory, "foreign.txt");
						sync.writeFileSync(changed, "foreign alias payload", { mode: 0o600 });
						return result;
					});
				const refused = await caught(deleteEmbeddedSession(f.file, { ...f, managed: true }));
				expect(refused.code).toBe("durability_failed");
				expect(remove).toHaveBeenCalledTimes(1);
				expect(await Bun.file(f.file).text()).toBe(transcript);
				expect(await Bun.file(changed).text()).toBe("foreign alias payload");
				expect(await Bun.file(evidence.authorityKey).text()).toBe(ownerRecord);
				const journalDirectory = path.join(f.directory, MANAGED_INTERNAL_DIRECTORY, MANAGED_TOMBSTONES_DIRECTORY);
				expect(
					(await fs.readdir(journalDirectory)).some(
						name => name.includes(".cleanup-artifacts_removed-") || name.includes(".cleanup-completed-"),
					),
				).toBe(false);
			},
		);
	}

	for (const managed of [false, true]) {
		for (const empty of [false, true]) {
			it(`refuses ${managed ? "managed" : "external"} actual native deletion when the canonical name returns ${empty ? "empty" : "with foreign bytes"}`, async () => {
				const f = managed ? await preparedManagedFixture() : await fixture();
				await artifacts(f);
				const token = owner(f);
				const evidence = getOwnerMembershipEvidence(token);
				retireOwnerMembershipSync(token);
				const ownerRecord = await Bun.file(evidence.authorityKey).text();
				const originalIdentity = await fs.lstat(f.file, { bigint: true });
				const replacement = empty
					? ""
					: `${JSON.stringify({ ...(f.records[0] as object), id: "foreign" })}\n${JSON.stringify(user("foreign", null))}\n`;
				const unlink = native.exactUnlink;
				const dispositions: Array<{ ok: boolean; payloadDurable?: boolean; detachedPath?: string }> = [];
				const dispatch = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
					const result = unlink(pathname, identity);
					if (pathname === f.file) {
						expect(result.ok || result.payloadDurable === true).toBe(true);
						dispositions.push(structuredClone(result));
						// Return the authentic result unchanged, after replacing only the
						// canonical name. The issued quarantine is not the replacement.
						sync.writeFileSync(f.file, replacement, { mode: 0o600 });
					}
					return result;
				});
				const remove = vi.spyOn(native, "exactRemoveDirectoryTree");
				const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
				const outcomes: VerifiedSessionDeleteResult[] = [];
				const lower = vi
					.spyOn(FileSessionStorage.prototype, "deleteSessionVerified")
					.mockImplementation(async function (this: FileSessionStorage, target, inspector) {
						const result = await originalDelete.call(this, target, inspector);
						outcomes.push(structuredClone(result));
						return result;
					});
				const options = { ...f, ...(managed ? { managed: true as const } : {}) };
				const refused = await caught(deleteEmbeddedSession(f.file, options));
				expect(refused.code).toBe("cleanup_pending");
				expect(refused.retry).toBeDefined();
				expect(dispositions).toHaveLength(1);
				const last = outcomes.at(-1);
				if (last?.kind !== "cleanup_pending" || last.phase !== "transcript")
					throw new Error("Expected canonical reappearance to retain transcript cleanup evidence");
				expect(last.transcriptPayloadDurable).toBe(dispositions[0].payloadDurable === true ? true : undefined);
				expect(last.detachedTranscriptPath).toBe(dispositions[0].detachedPath);
				expect(last.taskArtifactOwnerTranscriptDeleted).toBeUndefined();
				expect(await Bun.file(f.file).text()).toBe(replacement);
				const replacementIdentity = await fs.lstat(f.file, { bigint: true });
				expect([replacementIdentity.dev, replacementIdentity.ino]).not.toEqual([
					originalIdentity.dev,
					originalIdentity.ino,
				]);
				expect(await Bun.file(evidence.authorityKey).text()).toBe(ownerRecord);
				if (managed) {
					const directory = path.join(f.directory, MANAGED_INTERNAL_DIRECTORY, MANAGED_TOMBSTONES_DIRECTORY);
					expect((await fs.readdir(directory)).some(name => name.includes(".cleanup-completed-"))).toBe(false);
				}
				const beforeRetry = await tree(f.root);
				const calls = [dispatch.mock.calls.length, remove.mock.calls.length, lower.mock.calls.length];
				const retried = await caught(deleteEmbeddedSession(f.file, { ...options, retry: refused.retry }));
				expect(retried.retry).toBe(refused.retry);
				expect([dispatch.mock.calls.length, remove.mock.calls.length, lower.mock.calls.length]).toEqual(calls);
				expect(await tree(f.root)).toEqual(beforeRetry);
			});
		}

		for (const boundary of ["lower-return", "completion-publication", "completion-reread"] as const) {
			it(`refuses ${managed ? "managed" : "external"} canonical reappearance at ${boundary}`, async () => {
				const f = managed ? await preparedManagedFixture() : await fixture();
				await artifacts(f);
				const token = owner(f);
				const evidence = getOwnerMembershipEvidence(token);
				retireOwnerMembershipSync(token);
				const ownerRecord = await Bun.file(evidence.authorityKey).text();
				const replacement = `${JSON.stringify({ ...(f.records[0] as object), id: "foreign" })}\n${JSON.stringify(user("foreign", null))}\n`;
				let injected = false;
				const inject = () => {
					expect(sync.existsSync(f.file)).toBe(false);
					injected = true;
					sync.writeFileSync(f.file, replacement, { mode: 0o600 });
				};
				const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
				const outcomes: VerifiedSessionDeleteResult[] = [];
				vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified").mockImplementation(async function (
					this: FileSessionStorage,
					target,
					inspector,
				) {
					const result = await originalDelete.call(this, target, inspector);
					outcomes.push(structuredClone(result));
					if (result.kind === "deleted" && boundary === "lower-return") inject();
					return result;
				});
				if (boundary === "completion-publication" && managed) {
					const rename = native.renameNoReplacePathAsync;
					vi.spyOn(native, "renameNoReplacePathAsync").mockImplementation(async (source, destination) => {
						const result = await rename(source, destination);
						if (result.ok && destination.includes(".cleanup-completed-")) {
							expect(JSON.parse(sync.readFileSync(destination, "utf8"))).toMatchObject({
								state: "cleanup_completed",
								target: { path: f.file },
							});
							inject();
						}
						return result;
					});
				} else if (boundary === "completion-publication") {
					const open = FileSessionStorage.prototype.openStagedWriter;
					vi.spyOn(FileSessionStorage.prototype, "openStagedWriter").mockImplementation(function (
						this: FileSessionStorage,
						pathname,
						options,
					) {
						const writer = open.call(this, pathname, options);
						const publish = writer.publishNoReplace.bind(writer);
						vi.spyOn(writer, "publishNoReplace").mockImplementation(() => {
							const result = publish();
							if (JSON.parse(sync.readFileSync(pathname, "utf8")).outcome?.kind === "deleted") inject();
							return result;
						});
						return writer;
					});
				} else if (boundary === "completion-reread" && managed) {
					const capture = managedInspection.captureManagedFileNoFollow;
					vi.spyOn(managedInspection, "captureManagedFileNoFollow").mockImplementation(pathname => {
						const result = capture(pathname);
						if (!injected && pathname.includes(".cleanup-completed-")) {
							expect(JSON.parse(result.bytes.toString("utf8"))).toMatchObject({
								state: "cleanup_completed",
								target: { path: f.file },
							});
							inject();
						}
						return result;
					});
				} else if (boundary === "completion-reread") {
					const inspect = managedInspection.inspectManagedFileNoFollow;
					vi.spyOn(managedInspection, "inspectManagedFileNoFollow").mockImplementation((pathname, limit) => {
						const result = inspect(pathname, limit);
						if (!injected && pathname.endsWith("-receipt") && result.bytes.length > 0) {
							if (JSON.parse(result.bytes.toString("utf8")).outcome?.kind === "deleted") inject();
						}
						return result;
					});
				}
				const dispatch = vi.spyOn(native, "exactUnlink");
				const remove = vi.spyOn(native, "exactRemoveDirectoryTree");
				const options = { ...f, ...(managed ? { managed: true as const } : {}) };
				const operation = deleteEmbeddedSession(f.file, options);
				await Promise.allSettled([operation]);
				expect(injected).toBe(true);
				const refused = await caught(operation);
				expect(refused.code).toBe("cleanup_pending");
				expect(refused.retry).toBeDefined();
				expect(outcomes.at(-1)?.kind).toBe("deleted");
				expect(dispatch.mock.calls.filter(([pathname]) => pathname === f.file)).toHaveLength(1);
				expect(await Bun.file(f.file).text()).toBe(replacement);
				expect(await Bun.file(evidence.authorityKey).text()).toBe(ownerRecord);
				const beforeRetry = await tree(f.root);
				const calls = [dispatch.mock.calls.length, remove.mock.calls.length];
				const retried = await caught(deleteEmbeddedSession(f.file, { ...options, retry: refused.retry }));
				expect(retried.retry).toBe(refused.retry);
				expect([dispatch.mock.calls.length, remove.mock.calls.length]).toEqual(calls);
				expect(await tree(f.root)).toEqual(beforeRetry);
			});
		}
	}

	for (const empty of [false, true]) {
		it(`refuses completed managed cleanup replay with a new ${empty ? "empty" : "nonempty"} canonical inode`, async () => {
			const f = await preparedManagedFixture();
			await artifacts(f);
			const listing = listManagedCandidates(f.scope);
			if (listing.kind !== "complete" || listing.owned.length !== 1)
				throw new Error("Expected one prepared managed candidate");
			const candidate = listing.owned[0];
			await deleteEmbeddedSession(f.file, { ...f, managed: true });
			const replacement = empty ? "" : `${JSON.stringify({ ...(f.records[0] as object), id: "foreign" })}\n`;
			await Bun.write(f.file, replacement);
			const beforeReplay = await tree(f.root);
			const dispatch = vi.spyOn(native, "exactUnlink");
			const remove = vi.spyOn(native, "exactRemoveDirectoryTree");
			const replay = await deleteManagedSessionCandidate(f.scope, candidate);
			expect(replay).toMatchObject({ kind: "error", code: "durability_failed" });
			expect(dispatch).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
			expect(await tree(f.root)).toEqual(beforeReplay);
		});
	}

	for (const boundary of ["promotion", "transcript"] as const) {
		it.skipIf(process.platform === "win32")(
			`rechecks managed native side reappearance after ${boundary}`,
			async () => {
				const f = await preparedManagedFixture();
				await artifacts(f);
				const token = owner(f);
				const evidence = getOwnerMembershipEvidence(token);
				retireOwnerMembershipSync(token);
				const ownerRecord = await Bun.file(evidence.authorityKey).text();
				const sidePath = path.join(f.directory, ".gjc-native-side");
				const remove = native.exactRemoveDirectoryTree;
				vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementationOnce((...args) => {
					const result = remove(...args);
					expect(result).toMatchObject({ ok: false, code: "cleanup_pending", payloadDurable: true });
					return { ...result, retainedUnknownPath: sidePath };
				});
				let injected = false;
				const inject = () => {
					injected = true;
					sync.mkdirSync(sidePath, { mode: 0o700 });
					sync.writeFileSync(path.join(sidePath, "foreign.txt"), "late foreign side payload", { mode: 0o600 });
				};
				const rename = native.renameNoReplacePathAsync;
				vi.spyOn(native, "renameNoReplacePathAsync").mockImplementation(async (source, destination) => {
					const result = await rename(source, destination);
					if (result.ok && boundary === "promotion" && destination.includes(".cleanup-artifacts_removed-")) {
						const record = JSON.parse(sync.readFileSync(destination, "utf8"));
						expect(record).toMatchObject({ state: "artifacts_removed", target: { path: f.file } });
						inject();
					}
					return result;
				});
				const unlink = native.exactUnlink;
				let transcriptCalls = 0;
				vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
					const result = unlink(pathname, identity);
					if (pathname === f.file) {
						transcriptCalls++;
						if (boundary === "transcript") {
							expect(result.ok || result.payloadDurable === true).toBe(true);
							inject();
						}
					}
					return result;
				});
				const operation = deleteEmbeddedSession(f.file, { ...f, managed: true });
				await Promise.allSettled([operation]);
				// Assert the native publication/transcript interception actually ran
				// before checking refusal, so a missed seam cannot mimic a regression.
				expect(injected).toBe(true);
				const refused = await caught(operation);
				expect(refused.code).toMatch(/^(durability_failed|cleanup_pending)$/);
				expect(transcriptCalls).toBe(boundary === "promotion" ? 0 : 1);
				expect(await Bun.file(f.file).exists()).toBe(boundary === "promotion");
				expect(await Bun.file(path.join(sidePath, "foreign.txt")).text()).toBe("late foreign side payload");
				expect(await Bun.file(evidence.authorityKey).text()).toBe(ownerRecord);
				const journalDirectory = path.join(f.directory, MANAGED_INTERNAL_DIRECTORY, MANAGED_TOMBSTONES_DIRECTORY);
				expect((await fs.readdir(journalDirectory)).some(name => name.includes(".cleanup-completed-"))).toBe(false);
			},
		);
	}

	it.skipIf(process.platform === "win32")(
		"keeps actual task-owner payload retirement non-success across managed retries",
		async () => {
			const f = await preparedManagedFixture();
			const taskOwner = await ensureManagedTaskArtifactOwner(f.context, "selected", undefined);
			try {
				await taskOwner.manager.getManagedStore()!.publishNoReplace("payload.bin", Buffer.from("task payload"));
			} finally {
				taskOwner.manager.getManagedStore()!.close();
			}
			await Bun.write(
				f.file,
				JSON.stringify({ ...(f.records[0] as object), taskArtifactOwner: taskOwner.locator }) + "\n",
			);
			await artifacts(f);
			const token = owner(f);
			const evidence = getOwnerMembershipEvidence(token);
			retireOwnerMembershipSync(token);
			const before = await Bun.file(evidence.authorityKey).text();
			const retire = vi.spyOn(taskOwnerRetirement, "retireTaskArtifactOwner");
			const unlink = native.exactUnlink;
			const transcriptOutcomes: Array<{
				ok: boolean;
				issuedQuarantinePath: string;
				detachedPath?: string;
				retainedPlaceholderPath?: string;
				payloadDurable?: boolean;
			}> = [];
			vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
				const result = unlink(pathname, identity);
				if (pathname === f.file)
					transcriptOutcomes.push({
						...structuredClone(result),
						issuedQuarantinePath: path.join(path.dirname(pathname), identity.quarantineName!),
					});
				return result;
			});
			const pending = await caught(deleteEmbeddedSession(f.file, { ...f, managed: true }));
			expect(pending.code).toBe("cleanup_pending");
			expect(
				retire.mock.results.some(result => result.type === "return" && result.value.kind === "payload_retired"),
			).toBe(true);
			expect(sync.existsSync(taskOwner.manager.dir) || sync.existsSync(`${taskOwner.manager.dir}.removing`)).toBe(
				true,
			);
			expect(await Bun.file(evidence.authorityKey).text()).toBe(before);
			// The retry must use the retained candidate and authenticated journals,
			// not rediscover a header or run generic open-time reconciliation.
			expect(await Bun.file(f.file).exists()).toBe(false);
			const pendingDiagnostic = pending.outcome as unknown as { tombstonePath?: string } | undefined;
			if (!pendingDiagnostic?.tombstonePath) throw new Error("Expected exact managed tombstone path");
			const tombstone = await Bun.file(pendingDiagnostic.tombstonePath).json();
			expect(tombstone.state).toBe("retired");
			expect(tombstone.targets).toHaveLength(1);
			expect(parseTaskArtifactOwnerDeletionEvidence(tombstone.targets[0].taskArtifactOwnerDeletionEvidence)).toEqual(
				retire.mock.calls[0][1],
			);
			const journals: Array<{
				attempt: number;
				artifactsRemovedAttempt?: number;
				taskArtifactOwnerTranscriptDeleted?: true;
				detachedTranscriptPath?: string;
				retainedTranscriptPlaceholderPath?: string;
				transcriptPayloadDurable?: true;
			}> = [];
			const artifactCheckpoints = new Map<number, { target: { path: string }; tombstone: string; state: string }>();
			for (const name of await fs.readdir(path.dirname(pendingDiagnostic.tombstonePath))) {
				if (!name.includes(".cleanup-pending-") && !name.includes(".cleanup-artifacts_removed-")) continue;
				const record = await Bun.file(path.join(path.dirname(pendingDiagnostic.tombstonePath), name)).json();
				if (record.tombstone !== pendingDiagnostic.tombstonePath || record.target.path !== f.file) continue;
				if (record.state === "artifacts_removed") artifactCheckpoints.set(record.attempt, record);
				else {
					expect(record.state).toBe("cleanup_pending");
					journals.push(record);
				}
			}
			journals.sort((left, right) => left.attempt - right.attempt);
			expect(journals.at(-1)).toMatchObject({ taskArtifactOwnerTranscriptDeleted: true });
			const latest = journals.at(-1)!;
			expect(transcriptOutcomes).toHaveLength(1);
			const nativeTranscript = transcriptOutcomes[0];
			expect(nativeTranscript.ok || nativeTranscript.payloadDurable === true).toBe(true);
			expect(latest.transcriptPayloadDurable).toBe(nativeTranscript.payloadDurable === true ? true : undefined);
			expect(latest.detachedTranscriptPath).toBe(nativeTranscript.detachedPath);
			const issuedPlaceholder = nativeTranscript.retainedPlaceholderPath ?? nativeTranscript.issuedQuarantinePath;
			expect(latest.retainedTranscriptPlaceholderPath).toBe(issuedPlaceholder);
			expect((await fs.lstat(issuedPlaceholder)).size).toBe(0);
			expect(latest.artifactsRemovedAttempt).toBeDefined();
			expect(latest.artifactsRemovedAttempt!).toBeLessThan(latest.attempt);
			expect(artifactCheckpoints.get(latest.artifactsRemovedAttempt!)).toMatchObject({
				state: "artifacts_removed",
				tombstone: pendingDiagnostic.tombstonePath,
				target: { path: f.file },
			});
			const attempts = retire.mock.calls.length;
			const previous = retire.mock.results.at(-1);
			if (!previous || previous.type !== "return" || previous.value.kind === "completed")
				throw new Error("Expected a real retained owner continuation");
			const retry = await caught(deleteEmbeddedSession(f.file, { ...f, managed: true, retry: pending.retry }));
			const causes: string[] = [];
			for (let current: unknown = retry; current instanceof Error && causes.length < 16; current = current.cause)
				causes.push(current.message);
			expect({ code: retry.code, causes, outcome: retry.outcome }).toMatchObject({ code: "cleanup_pending" });
			expect(retry.retry).toBe(pending.retry);
			expect({
				retirementRedispatched: retire.mock.calls.length > attempts,
				message: retry.message,
				outcome: retry.outcome,
			}).toMatchObject({ retirementRedispatched: true });
			expect(retire.mock.calls[attempts][2]).toEqual(previous.value.continuation);
			expect(await Bun.file(evidence.authorityKey).text()).toBe(before);
			// Native evidence authorizes only fresh scrubbed placeholders, never
			// nonempty foreign content installed at that same historical name.
			const placeholder = issuedPlaceholder;
			await Bun.write(placeholder, "foreign transcript payload");
			const attempted = retire.mock.calls.length;
			await caught(deleteEmbeddedSession(f.file, { ...f, managed: true, retry: pending.retry }));
			expect(retire.mock.calls).toHaveLength(attempted);
			expect(await Bun.file(placeholder).text()).toBe("foreign transcript payload");
			expect(await Bun.file(evidence.authorityKey).text()).toBe(before);
		},
	);

	for (const tamper of ["root", "alias", "canonical", "payload"] as const) {
		it.skipIf(process.platform === "win32")(
			`refuses ${tamper} tampering after the actual ordinary-artifact native result`,
			async () => {
				const f = await fixture([user("a", null)]);
				await artifacts(f);
				const before = await Bun.file(f.file).text();
				const original = FileSessionStorage.prototype.deleteSessionVerified;
				let calls = 0;
				let changed = "";
				vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified").mockImplementation(async function (
					this: FileSessionStorage,
					target,
					inspector,
				) {
					calls++;
					const outcome = await original.call(this, target, inspector);
					if (outcome.kind !== "cleanup_pending" || outcome.phase !== "artifacts")
						throw new Error("Expected real native artifact payload retirement");
					const retained = outcome.detachedArtifactsPath;
					if (tamper === "root") {
						await fs.rename(retained, `${retained}.original`);
						await fs.mkdir(retained);
						changed = path.join(retained, "foreign.txt");
					} else if (tamper === "payload") changed = path.join(retained, "retained.txt");
					else {
						const alias = tamper === "canonical" ? f.file.slice(0, -6) : target.plannedArtifactsPath!;
						await fs.mkdir(alias);
						changed = path.join(alias, "foreign.txt");
					}
					await Bun.write(changed, "foreign payload");
					return outcome;
				});
				await caught(deleteEmbeddedSession(f.file, f));
				expect(calls).toBe(1);
				expect(await Bun.file(changed).text()).toBe("foreign payload");
				expect(await Bun.file(f.file).text()).toBe(before);
			},
		);
	}

	it.skipIf(process.platform === "win32")(
		"rechecks canonical reappearance after the durable completion checkpoint is published",
		async () => {
			const f = await fixture([user("a", null)]);
			await artifacts(f);
			const original = native.renameNoReplacePath;
			let injected = false;
			vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => {
				const result = original(source, destination);
				if (result.ok && destination.endsWith("-receipt")) {
					const record = JSON.parse(sync.readFileSync(destination, "utf8"));
					if (!injected && record.target.artifactsRemoved === true) {
						injected = true;
						sync.mkdirSync(f.file.slice(0, -6));
						sync.writeFileSync(path.join(f.file.slice(0, -6), "foreign.txt"), "late canonical payload");
					}
				}
				return result;
			});
			const storage = vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified");
			await caught(deleteEmbeddedSession(f.file, f));
			expect(injected).toBe(true);
			expect(storage).toHaveBeenCalledTimes(1);
			expect(await Bun.file(f.file).exists()).toBe(true);
			expect(await Bun.file(path.join(f.file.slice(0, -6), "foreign.txt")).text()).toBe("late canonical payload");
		},
	);

	for (const side of ["retainedSuccessorPath", "retainedPlaceholderPath", "retainedUnknownPath"] as const) {
		it.skipIf(process.platform === "win32")(
			`preserves an actual native ${side} rather than promoting artifact completion`,
			async () => {
				const f = await fixture([user("a", null)]);
				await artifacts(f);
				const sidePath = path.join(f.directory, "foreign-side");
				const original = native.exactRemoveDirectoryTree;
				vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementationOnce((...args) => {
					const result = original(...args);
					sync.writeFileSync(sidePath, "foreign side payload");
					return { ...result, [side]: sidePath };
				});
				const pending = await caught(deleteEmbeddedSession(f.file, f));
				expect(pending.code).toBe("cleanup_pending");
				expect(pending.outcome).toMatchObject({ kind: "cleanup_pending", phase: "artifacts", [side]: sidePath });
				expect(await Bun.file(f.file).exists()).toBe(true);
				expect(await Bun.file(sidePath).text()).toBe("foreign side payload");
			},
		);
	}

	it("never promotes raw payloadDurable while authorized payload remains nonempty", async () => {
		const f = await fixture([user("a", null)]);
		await artifacts(f);
		vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementationOnce(pathname => ({
			ok: false,
			code: "cleanup_pending",
			detachedPath: pathname,
			payloadDurable: true,
		}));
		const pending = await caught(deleteEmbeddedSession(f.file, f));
		expect(pending.code).toBe("cleanup_pending");
		if (pending.outcome?.kind !== "cleanup_pending" || pending.outcome.phase !== "artifacts")
			throw new Error("Expected nonempty retained artifact disposition");
		expect(await Bun.file(path.join(pending.outcome.detachedArtifactsPath, "retained.txt")).text()).toBe(
			"selected artifacts",
		);
		expect(await Bun.file(f.file).exists()).toBe(true);
	});

	for (const linked of [false, true]) {
		it(`binds projected link count to the original descriptor and ${linked ? "rejects hardlinks" : "accepts actual single-link authority"}`, async () => {
			const f = await fixture([user("a", null)]);
			if (linked) await fs.link(f.file, path.join(f.root, "external-link.jsonl"));
			const storage = new FileSessionStorage();
			const snapshot = storage.readSnapshotSync(f.file);
			const parent = await fs.lstat(f.directory, { bigint: true });
			const target: VerifiedSessionDeleteTarget = {
				sessionsRoot: f.directory,
				transcriptPath: f.file,
				sessionId: "selected",
				cwd: f.cwd,
				transcriptParentIdentity: { dev: parent.dev, ino: parent.ino },
				transcriptIdentity: {
					dev: snapshot.stat.dev,
					ino: snapshot.stat.ino,
					size: snapshot.stat.size,
					mtimeNs: snapshot.stat.mtimeNs,
					sha256: new Bun.CryptoHasher("sha256").update(snapshot.bytes).digest("hex"),
				},
				plannedArtifactsPath: path.join(f.directory, ".gjc-delete-projected-artifacts"),
				plannedTranscriptPath: path.join(f.directory, ".gjc-delete-projected-transcript"),
			};
			const before = await tree(f.root);
			if (linked)
				await expect(storage.deleteSessionVerified(target)).rejects.toThrow("Single-link transcript authority");
			else expect(await storage.deleteSessionVerified(target)).toMatchObject({ kind: "artifacts_removed" });
			expect(await tree(f.root)).toEqual(before);
		});
	}

	it("rejects unchanged nonempty retained payload even with artifactsRemoved at the lower seam", async () => {
		const f = await fixture([user("a", null)]);
		await artifacts(f);
		const original = FileSessionStorage.prototype.deleteSessionVerified;
		const targets: VerifiedSessionDeleteTarget[] = [];
		vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified").mockImplementation(function (
			this: FileSessionStorage,
			target,
			inspector,
		) {
			targets.push(structuredClone(target));
			return original.call(this, target, inspector);
		});
		vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementationOnce(pathname => ({
			ok: false,
			code: "cleanup_pending",
			detachedPath: pathname,
		}));
		const pending = await caught(deleteEmbeddedSession(f.file, f));
		if (pending.outcome?.kind !== "cleanup_pending" || pending.outcome.phase !== "artifacts")
			throw new Error("Expected retained artifact disposition");
		const outcome = pending.outcome;
		await expect(
			original.call(new FileSessionStorage(), {
				...targets[0],
				artifactsRemoved: true,
				plannedArtifactsPath: path.join(f.directory, ".gjc-delete-nonempty-proof-fresh-artifacts"),
				expectedArtifactsIdentity: outcome.artifactsIdentity,
				expectedArtifactsTree: outcome.artifactsTree,
				detachedArtifactsPath: outcome.detachedArtifactsPath,
			}),
		).rejects.toThrow("payload absence");
		expect(await Bun.file(f.file).exists()).toBe(true);
		expect(await Bun.file(path.join(outcome.detachedArtifactsPath, "retained.txt")).text()).toBe(
			"selected artifacts",
		);
	});

	it("authenticates the durable ordinary-artifact checkpoint before retry dispatch", async () => {
		const f = await fixture([user("a", null)]);
		await artifacts(f);
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementationOnce(pathname => ({
			ok: false,
			code: "cleanup_pending",
			detachedPath: pathname,
		}));
		const pending = await caught(deleteEmbeddedSession(f.file, f));
		remove.mockRestore();
		const records = (await fs.readdir(f.directory)).filter(name => name.endsWith("-receipt"));
		let receipt: string | undefined;
		for (const name of records) {
			const pathname = path.join(f.directory, name);
			if ((await Bun.file(pathname).json()).outcome?.kind === "cleanup_pending") receipt = pathname;
		}
		if (!receipt) throw new Error("Expected durable post-effect checkpoint");
		await Bun.write(receipt, "tampered receipt\n");
		const dispatch = vi.spyOn(native, "exactRemoveDirectoryTree");
		const rejected = await caught(deleteEmbeddedSession(f.file, { ...f, retry: pending.retry }));
		expect(rejected.code).toBe("authority_changed");
		expect(rejected.retry).toBe(pending.retry);
		expect(dispatch).not.toHaveBeenCalled();
		expect(await Bun.file(f.file).exists()).toBe(true);
	});

	it("does not redispatch after a post-effect storage exception", async () => {
		const f = await fixture([user("a", null)]);
		await artifacts(f);
		const original = FileSessionStorage.prototype.deleteSessionVerified;
		const dispatch = vi
			.spyOn(FileSessionStorage.prototype, "deleteSessionVerified")
			.mockImplementationOnce(async function (this: FileSessionStorage, target, inspector) {
				await original.call(this, target, inspector);
				throw new Error("post-effect verification failed");
			});
		const first = await caught(deleteEmbeddedSession(f.file, f));
		expect(first.message).toBe("post-effect verification failed");
		const retry = await caught(deleteEmbeddedSession(f.file, { ...f, retry: first.retry }));
		expect(retry.code).toBe("deletion_uncertain");
		expect(retry.retry).toBe(first.retry);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(await Bun.file(f.file).exists()).toBe(true);
	});

	it("refuses a managed candidate outside the supplied profile and a mismatched cwd", async () => {
		const f = await fixture();
		const foreign = await managedFile(f, path.join(f.root, "other-profile"), "foreign");
		const before = await tree(f.root);
		await caught(deleteEmbeddedSession(foreign, { ...f, managed: true }));
		await caught(deleteEmbeddedSession(f.file, { cwd: f.root, agentDir: f.agentDir }));
		expect(await tree(f.root)).toEqual(before);
	});

	for (const replacement of ["none", "artifacts", "owner", "transcript"] as const) {
		it(`retains exactly bound opaque cleanup retry and ${replacement === "none" ? "replays the actual native disposition" : `refuses foreign ${replacement} replacement`}`, async () => {
			const f = await fixture([user("a", null)]);
			await artifacts(f);
			const token = owner(f);
			const evidence = getOwnerMembershipEvidence(token);
			retireOwnerMembershipSync(token);
			const remove = vi
				.spyOn(native, "exactRemoveDirectoryTree")
				.mockImplementationOnce(pathname => ({ ok: false, code: "cleanup_pending", detachedPath: pathname }));
			const first = await caught(deleteEmbeddedSession(f.file, f));
			remove.mockRestore();
			expect(first.code).toBe("cleanup_pending");
			expect(first.retry).toBeDefined();
			expect(Object.keys(first.retry!)).toEqual([]);
			expect(first.outcome?.kind).toBe("cleanup_pending");
			if (first.outcome?.kind !== "cleanup_pending" || first.outcome.phase !== "artifacts")
				throw new Error("Expected actual retained artifact quarantine");
			const detached = first.outcome.detachedArtifactsPath;
			expect(await Bun.file(path.join(detached, "retained.txt")).text()).toBe("selected artifacts");
			await caught(deleteEmbeddedSession(f.file, { ...f, retry: {} }));
			await caught(
				deleteEmbeddedSession(f.file, {
					...f,
					agentDir: path.join(f.root, "different-profile"),
					retry: first.retry,
				}),
			);
			if (replacement === "none") {
				// Caller-visible diagnostics are not the retained authority object.
				first.outcome.detachedArtifactsPath = path.join(f.root, "caller-changed-diagnostic");
				if (process.platform === "win32") {
					await deleteEmbeddedSession(f.file, { ...f, retry: first.retry });
					expect(await Bun.file(f.file).exists()).toBe(false);
					expect(sync.existsSync(detached)).toBe(false);
					await caught(deleteEmbeddedSession(f.file, { ...f, retry: first.retry }));
				} else {
					const rootIdentity = await fs.lstat(detached, { bigint: true });
					const payloadIdentity = await fs.lstat(path.join(detached, "retained.txt"), { bigint: true });
					await deleteEmbeddedSession(f.file, { ...f, retry: first.retry });
					const retained = await fs.lstat(`${detached}.removing`, { bigint: true });
					const payload = await fs.lstat(path.join(`${detached}.removing`, "retained.txt"), { bigint: true });
					expect([retained.dev, retained.ino]).toEqual([rootIdentity.dev, rootIdentity.ino]);
					expect([payload.dev, payload.ino, payload.size]).toEqual([payloadIdentity.dev, payloadIdentity.ino, 0n]);
					expect(await Bun.file(f.file).exists()).toBe(false);
					expect(await Bun.file(evidence.authorityKey).exists()).toBe(false);
					await caught(deleteEmbeddedSession(f.file, { ...f, retry: first.retry }));
				}
			} else {
				const selected =
					replacement === "artifacts" ? detached : replacement === "owner" ? evidence.authorityKey : f.file;
				const original = replacement === "artifacts" ? undefined : await fs.readFile(selected);
				await fs.rename(selected, `${selected}.retained`);
				if (replacement === "artifacts") {
					await fs.mkdir(selected);
					await Bun.write(path.join(selected, "foreign.txt"), "foreign");
				} else await fs.writeFile(selected, original!, { mode: 0o600 });
				const before = await tree(f.root);
				const guards = trackOwnedGuardRetirements(f);
				const removeAgain = vi.spyOn(native, "exactRemoveDirectoryTree");
				await caught(deleteEmbeddedSession(f.file, { ...f, retry: first.retry }));
				expect(removeAgain).not.toHaveBeenCalled();
				removeAgain.mockRestore();
				await guards.assertTree(before);
			}
		});
	}

	it("never treats an absent transcript and absent owner bytes as deletion authority", async () => {
		const f = await fixture();
		await fs.rm(f.file);
		const before = await tree(f.root);
		await caught(deleteEmbeddedSession(f.file, f));
		expect(await tree(f.root)).toEqual(before);
	});
});
