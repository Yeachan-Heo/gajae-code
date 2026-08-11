import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBlobsDir, getResidentCacheRootDir, getSidecarCacheRootDir, logger, TempDir } from "@gajae-code/utils";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";
import {
	DICTIONARY_PARTITION_COUNT,
	dictionaryPartitionForId,
	PARENT_CHILDREN_BUCKET_COUNT,
	parentBucketForId,
	parseDictionaryArtifactCommit,
	serializeParentBucketRecord,
} from "../../src/session/internal/session-memory-sidecar";
import {
	BOUNDED_FIRST_OPEN_MAX_LINE_BYTES,
	BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES,
	SessionManager,
	SessionManagerTestHooks,
} from "../../src/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorageWriter,
	type StagedStreamingWriter,
} from "../../src/session/session-storage";

const sidecarPath = (sessionFile: string, kind: "idx" | "tail" | "commit"): string =>
	`${sessionFile.slice(0, -6)}/.session-memory.spill.${kind}`;
const parentBucketPath = (sessionFile: string, bucket: number): string =>
	`${sessionFile.slice(0, -6)}/.session-memory.spill.parent-${bucket.toString().padStart(4, "0")}`;
const dictionaryPartitionPath = (sessionFile: string, partition: number): string =>
	`${sessionFile.slice(0, -6)}/.session-memory.spill.dict-part-${partition.toString().padStart(4, "0")}`;
const dictionaryMetaPathFor = (sessionFile: string): string =>
	`${sessionFile.slice(0, -6)}/.session-memory.spill.dict-meta`;
const metadataDeltaPathFor = (sessionFile: string): string =>
	`${sessionFile.slice(0, -6)}/.session-memory.spill.metadata-delta`;

/** Write a compacted tree transcript: root → `parentCount` parents, each with `childrenPerParent` children. */
function writeTreeTranscript(
	storage: MemorySessionStorage,
	sessionFile: string,
	options: { parentCount: number; childrenPerParent: number },
): string[] {
	const parents = Array.from(
		{ length: options.parentCount },
		(_, index) => `parent-${index.toString().padStart(3, "0")}`,
	);
	const records: Array<Record<string, unknown>> = [
		{ type: "session", version: 5, id: "tree-session", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "root", parentId: null, timestamp: "0", customType: "node", data: {} },
	];
	for (const parent of parents) {
		records.push({ type: "custom", id: parent, parentId: "root", timestamp: "0", customType: "node", data: {} });
	}
	for (const parent of parents) {
		for (let index = 0; index < options.childrenPerParent; index++) {
			records.push({
				type: "custom",
				id: `${parent}-child-${index.toString().padStart(2, "0")}`,
				parentId: parent,
				timestamp: "0",
				customType: "node",
				data: {},
			});
		}
	}
	records.push({ type: "custom", id: "active", parentId: "root", timestamp: "0", customType: "node", data: {} });
	records.push({
		type: "compaction",
		id: "active-compaction",
		parentId: "active",
		timestamp: "0",
		summary: "summary",
		firstKeptEntryId: "active",
		tokensBefore: 1,
	});
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	return parents;
}

const itPosix = it.skipIf(process.platform === "win32");
const describePosix = describe.skipIf(process.platform === "win32");

describe("SessionManager cold sidecar integration", () => {
	it("admits a two-GiB transcript plus bounded fork header headroom", () => {
		expect(BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024 + 1024 * 1024);
	});
	it("retires a compacted prefix on resume and lazily reloads exact transcript entries", async () => {
		const tempDir = TempDir.createSync("@pi-session-memory-sidecar-");
		const storage = new FileSessionStorage();
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const now = new Date().toISOString();
		const ids = Array.from({ length: 200 }, (_, index) => `message-${index.toString().padStart(4, "0")}`);
		const entries: Array<Record<string, unknown>> = [
			{ type: "session", version: 5, id: "sidecar-session", timestamp: now, cwd: tempDir.path() },
			...ids.map((id, index) => ({
				type: "message",
				id,
				parentId: index === 0 ? null : ids[index - 1],
				timestamp: now,
				message: { role: "user", content: `cold-${index}-${"x".repeat(256)}`, timestamp: index },
			})),
			{
				type: "model_change",
				id: "reviewer-model",
				parentId: ids.at(-1),
				timestamp: now,
				model: "anthropic/claude-sonnet-4-5",
				role: "reviewer",
			},
			{
				type: "compaction",
				id: "compaction-0001",
				parentId: "reviewer-model",
				timestamp: now,
				summary: "summary",
				firstKeptEntryId: ids.at(-1),
				tokensBefore: 10_000,
			},
		];
		storage.writeTextSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		storage.writeTextSync(`${sessionFile}.spill.idx`, "legacy-index\n");
		storage.writeTextSync(`${sessionFile}.spill.tail`, "legacy-tail\n");
		storage.writeTextSync(`${sessionFile}.spill.commit`, "legacy-commit\n");

		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination(tempDir.path()),
			storage,
		);
		expect(storage.existsSync(`${sessionFile}.spill.idx`)).toBe(false);
		expect(storage.existsSync(`${sessionFile}.spill.tail`)).toBe(false);
		expect(storage.existsSync(`${sessionFile}.spill.commit`)).toBe(false);
		try {
			expect(manager.hotRetainedMessageCharsForTests()).toBeGreaterThan(50_000);
			manager.setSessionMemoryMode("enabled");
			expect(storage.existsSync(sidecarPath(sessionFile, "idx"))).toBe(true);
			expect(storage.existsSync(sidecarPath(sessionFile, "tail"))).toBe(true);
			const memoryStats = manager.getSessionMemoryStats();
			expect(memoryStats.sidecarEnabled).toBe(true);
			expect(memoryStats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
			expect(manager.getLastModelChangeRole()).toBe("reviewer");
			expect(manager.hotRetainedMessageCharsForTests()).toBeLessThan(1024);

			const cold = manager.getEntry(ids[0]);
			expect(cold).toMatchObject({ id: ids[0], type: "message" });
			if (cold?.type !== "message" || !("content" in cold.message)) throw new Error("Expected cold message entry");
			expect(cold.message.content).toBe(`cold-0-${"x".repeat(256)}`);

			const branch = manager.getBranch();
			expect(branch[0]?.id).toBe(ids[0]);
			expect(branch.at(-1)?.type).toBe("compaction");
			expect(manager.getEntriesForExport()).toHaveLength(202);
			await manager.rewriteEntries();
			const rewrittenEntries = storage
				.readTextSync(sessionFile)
				.trimEnd()
				.split("\n")
				.map(line => JSON.parse(line) as { id?: string });
			expect(rewrittenEntries).toHaveLength(203);
			expect(rewrittenEntries.some(entry => entry.id === ids[0])).toBe(true);
			manager.branch(ids[0]);
			expect(manager.getBranch().map(entry => entry.id)).toEqual([ids[0]]);
			expect(manager.getLastModelChangeRole()).toBeUndefined();
			manager.setSessionMemoryMode("off");
			expect(storage.existsSync(sidecarPath(sessionFile, "idx"))).toBe(false);
			expect(storage.existsSync(sidecarPath(sessionFile, "tail"))).toBe(false);
			expect(manager.hotRetainedMessageCharsForTests()).toBeGreaterThan(50_000);
		} finally {
			await manager.close();
			tempDir.removeSync();
		}
	});

	it("keeps the resident hot region flat for a 120k-entry compacted transcript", async () => {
		const tempDir = TempDir.createSync("@pi-session-memory-60k-");
		const storage = new FileSessionStorage();
		const sessionFile = path.join(tempDir.path(), "large.jsonl");
		const writer = storage.openWriter(sessionFile, { flags: "w" });
		const now = new Date().toISOString();
		writer.writeLineSync(
			`${JSON.stringify({ type: "session", version: 5, id: "large-session", timestamp: now, cwd: tempDir.path() })}\n`,
		);
		let priorId: string | null = null;
		const soak = process.env.GJC_SESSION_MEMORY_SOAK === "1";
		const entryCount = soak ? 1_000_000 : 120_000;
		const firstId = soak ? "e0" : "entry-00000000";
		for (let index = 0; index < entryCount; index++) {
			const id = soak ? `e${index.toString(36)}` : `entry-${index.toString().padStart(8, "0")}`;
			writer.writeLineSync(
				`${JSON.stringify(
					soak
						? { type: "custom", id, customType: "x" }
						: {
								type: "message",
								id,
								parentId: priorId,
								timestamp: now,
								message: { role: "user", content: `record-${index}`, timestamp: index },
							},
				)}\n`,
			);
			priorId = id;
		}
		writer.writeLineSync(
			`${JSON.stringify({
				type: "compaction",
				id: "large-compaction",
				parentId: priorId,
				timestamp: now,
				summary: "summary",
				firstKeptEntryId: priorId,
				tokensBefore: 1_000_000,
			})}\n`,
		);
		writer.closeSync();

		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination(tempDir.path()),
			storage,
		);
		try {
			manager.setSessionMemoryMode("enabled");
			expect(manager.hotRetainedMessageCharsForTests()).toBeLessThan(1024);
			const memoryStats = manager.getSessionMemoryStats();
			expect(memoryStats.sidecarEnabled).toBe(true);
			expect(memoryStats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
			const accountedBeforeAppend = memoryStats.totalAccountedBytes;
			manager.appendMessage({ role: "user", content: "post-retirement", timestamp: Date.now() });
			expect(manager.getSessionMemoryStats().totalAccountedBytes).toBeGreaterThan(accountedBeforeAppend);
			expect(manager.getEntry(firstId)).toMatchObject({ id: firstId, type: soak ? "custom" : "message" });
		} finally {
			await manager.close();
			tempDir.removeSync();
		}
	}, 30_000);

	it("retires cold entries immediately after a persisted live compaction", async () => {
		const tempDir = TempDir.createSync("@pi-session-memory-live-");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(
			tempDir.path(),
			SessionManager.explicitDestination(tempDir.path()),
			storage,
		);
		try {
			manager.setSessionMemoryMode("enabled");
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "published" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			let firstKeptEntryId = "";
			for (let index = 0; index < 200; index++) {
				firstKeptEntryId = manager.appendMessage({
					role: "user",
					content: `live-${index}-${"x".repeat(256)}`,
					timestamp: Date.now(),
				});
			}
			manager.appendCompaction("summary", undefined, firstKeptEntryId, 10_000);

			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted live session");
			expect(storage.existsSync(sidecarPath(sessionFile, "idx"))).toBe(true);
			expect(storage.existsSync(sidecarPath(sessionFile, "tail"))).toBe(true);
			expect(manager.hotRetainedMessageCharsForTests()).toBeLessThan(1024);
			expect(manager.getSessionMemoryStats().sidecarEnabled).toBe(true);
		} finally {
			await manager.close();
			tempDir.removeSync();
		}
	});

	itPosix(
		"retires and lazily reloads managed TUI/review-session history through retained range authority",
		async () => {
			const tempDir = TempDir.createSync("@pi-session-memory-managed-");
			const cwd = path.join(tempDir.path(), "project");
			const agentDir = path.join(tempDir.path(), "agent");
			fs.mkdirSync(cwd, { recursive: true });
			const storage = new FileSessionStorage();
			const destination = SessionManager.managedDestination(cwd, agentDir, storage);
			const initial = SessionManager.create(cwd, destination, storage);
			let coldId = "";
			let firstKeptEntryId = "";
			let sessionFile = "";
			try {
				initial.setSessionMemoryMode("enabled");
				initial.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "published" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				for (let index = 0; index < 400; index++) {
					const id = initial.appendMessage({
						role: "user",
						content: `managed-${index}-${"x".repeat(256)}`,
						timestamp: Date.now(),
					});
					coldId ||= id;
					firstKeptEntryId = id;
				}
				initial.appendCompaction("summary", undefined, firstKeptEntryId, 20_000);
				sessionFile = initial.getSessionFile() ?? "";
				expect(sessionFile).not.toBe("");
				expect(initial.getSessionMemoryStats()).toMatchObject({
					coldRetirementActive: true,
					sidecarIneligible: false,
				});
				expect(initial.hotRetainedMessageCharsForTests()).toBeLessThan(1024);
				expect(initial.getEntry(coldId)?.id).toBe(coldId);
				initial.setSessionMemoryMode("shadow");
				expect(initial.getSessionMemoryStats().coldRetirementActive).toBe(true);
				expect(initial.getEntry(coldId)?.id).toBe(coldId);
				initial.setSessionMemoryMode("off");
				expect(initial.getSessionMemoryStats().coldRetirementActive).toBe(true);
				expect(initial.getEntry(coldId)?.id).toBe(coldId);
				const artifactsDir = initial.getArtifactsDir();
				if (!artifactsDir) throw new Error("Expected managed artifacts directory");
				const managedSidecars = fs.existsSync(artifactsDir)
					? fs
							.readdirSync(artifactsDir, { recursive: true })
							.some(entry => String(entry).includes(".session-memory.spill"))
					: false;
				expect(managedSidecars).toBe(false);
			} finally {
				await initial.close();
			}

			const reopened = await SessionManager.open(
				sessionFile,
				SessionManager.managedDestination(cwd, agentDir, storage),
				storage,
				"copy-retain",
				"enabled",
			);
			try {
				expect(reopened.getSessionMemoryStats()).toMatchObject({
					coldRetirementActive: true,
					lazyReopenSucceeded: true,
					lastReopenTransition: { kind: "rebuild", reason: "bounded_first_open" },
				});
				expect(reopened.getSessionMemoryStats().totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
				expect(reopened.hotRetainedMessageCharsForTests()).toBeLessThan(1024);
				const selection = await reopened.stageDefaultModelSelection("provider/model", "high", {
					appendThinkingLevel: true,
				});
				expect(selection.boundedCold).toBe(true);
				expect(reopened.promoteDefaultModelSelection(selection)).toEqual({ kind: "promoted" });
				const reopenedStat = fs.statSync(sessionFile);
				fs.utimesSync(sessionFile, reopenedStat.atime, new Date(reopenedStat.mtimeMs + 2_000));
				expect(reopened.getEntry(coldId)?.id).toBe(coldId);
				expect(reopened.getSessionMemoryStats().rangeReadGenerationMismatchCount).toBeGreaterThan(0);
				reopened.setSessionMemoryMode("enabled");
				expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
			} finally {
				await reopened.close();
				tempDir.removeSync();
			}
		},
		60_000,
	);

	itPosix(
		"retires nested managed review-subagent history without sidecars in the managed tree",
		async () => {
			const tempDir = TempDir.createSync("@pi-session-memory-nested-managed-");
			const cwd = path.join(tempDir.path(), "project");
			const managedRoot = path.join(tempDir.path(), "managed");
			const profileAgentDir = path.join(tempDir.path(), "agent-profile");
			fs.mkdirSync(cwd, { recursive: true });
			fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
			const rootStore = new ManagedSessionDescendantStore(
				managedDirectoryRoot(managedRoot),
				managedRoot,
				undefined,
				undefined,
				profileAgentDir,
			);
			rootStore.ensureDirectory("review");
			const nestedStore = rootStore.deriveSubtree("review");
			const manager = SessionManager.create(
				cwd,
				SessionManager.nestedManagedDestination(nestedStore, nestedStore.dir),
				new FileSessionStorage(),
			);
			let coldId = "";
			let firstKeptEntryId = "";
			try {
				manager.setSessionMemoryMode("enabled");
				manager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "published" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				for (let index = 0; index < 200; index++) {
					const id = manager.appendMessage({
						role: "user",
						content: `review-${index}-${"x".repeat(256)}`,
						timestamp: Date.now(),
					});
					coldId ||= id;
					firstKeptEntryId = id;
				}
				manager.appendCompaction("summary", undefined, firstKeptEntryId, 10_000);
				expect(manager.getSessionMemoryStats()).toMatchObject({
					coldRetirementActive: true,
					sidecarIneligible: false,
				});
				expect(manager.hotRetainedMessageCharsForTests()).toBeLessThan(1024);
				expect(manager.getEntry(coldId)?.id).toBe(coldId);
				expect(
					fs
						.readdirSync(managedRoot, { recursive: true })
						.some(entry => String(entry).includes(".session-memory.spill")),
				).toBe(false);
			} finally {
				await manager.close();
				rootStore.close();
				tempDir.removeSync();
			}
		},
		60_000,
	);
	itPosix(
		"rejects nested managed transcript replacement after capture",
		async () => {
			const tempDir = TempDir.createSync("@pi-session-memory-nested-swap-");
			const cwd = path.join(tempDir.path(), "project");
			const managedRoot = path.join(tempDir.path(), "managed");
			const profileAgentDir = path.join(tempDir.path(), "agent-profile");
			fs.mkdirSync(cwd, { recursive: true });
			fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
			const rootStore = new ManagedSessionDescendantStore(
				managedDirectoryRoot(managedRoot),
				managedRoot,
				undefined,
				undefined,
				profileAgentDir,
			);
			rootStore.ensureDirectory("review");
			const nestedStore = rootStore.deriveSubtree("review");
			const sessionFile = path.join(nestedStore.dir, "review.jsonl");
			const originalDescriptor = nestedStore.descriptorExpected.bind(nestedStore);
			const cacheRoot = getResidentCacheRootDir(profileAgentDir);
			const cacheEntriesBefore = fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).length : 0;
			try {
				nestedStore.publishNoReplaceSync(
					"review.jsonl",
					Buffer.from(
						`${JSON.stringify({ type: "session", version: 5, id: "nested-swap", timestamp: "0", cwd })}\n`,
					),
				);
				let descriptorReads = 0;
				let replaced = false;
				vi.spyOn(nestedStore, "descriptorExpected").mockImplementation(relativePath => {
					descriptorReads++;
					if (!replaced && relativePath === "review.jsonl" && descriptorReads > 1) {
						replaced = true;
						nestedStore.replaceSync(
							"review.jsonl",
							Buffer.from(
								`${JSON.stringify({ type: "session", version: 5, id: "attacker", timestamp: "0", cwd })}\n`,
							),
						);
					}
					return originalDescriptor(relativePath);
				});
				await expect(
					SessionManager.openNestedManaged(
						sessionFile,
						SessionManager.nestedManagedDestination(nestedStore, nestedStore.dir),
						nestedStore,
						new FileSessionStorage(),
						cwd,
						"enabled",
					),
				).rejects.toThrow("source_changed");
				expect(replaced).toBe(true);
				expect(fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).length : 0).toBe(cacheEntriesBefore);
			} finally {
				rootStore.close();
				tempDir.removeSync();
			}
		},
		60_000,
	);
	itPosix(
		"reopens nested managed cold history and disposes its private sidecar cache",
		async () => {
			const tempDir = TempDir.createSync("@pi-session-memory-nested-reopen-");
			const cwd = path.join(tempDir.path(), "project");
			const managedRoot = path.join(tempDir.path(), "managed");
			const profileAgentDir = path.join(tempDir.path(), "agent-profile");
			fs.mkdirSync(cwd, { recursive: true });
			fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
			const rootStore = new ManagedSessionDescendantStore(
				managedDirectoryRoot(managedRoot),
				managedRoot,
				undefined,
				undefined,
				profileAgentDir,
			);
			rootStore.ensureDirectory("review");
			const nestedStore = rootStore.deriveSubtree("review");
			const destination = SessionManager.nestedManagedDestination(nestedStore, nestedStore.dir);
			const manager = SessionManager.create(cwd, destination, new FileSessionStorage());
			let coldId = "";
			let firstKeptEntryId = "";
			let sessionFile = "";
			try {
				manager.setSessionMemoryMode("enabled");
				manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
				manager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "published" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				for (let index = 0; index < 200; index++) {
					const id = manager.appendMessage({
						role: "user",
						content: `nested-reopen-${index}-${"x".repeat(256)}`,
						timestamp: Date.now(),
					});
					coldId ||= id;
					firstKeptEntryId = id;
				}
				manager.appendCompaction("summary", undefined, firstKeptEntryId, 10_000);
				sessionFile = manager.getSessionFile() ?? "";
				expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
			} finally {
				await manager.close();
			}
			const cacheRoot = getResidentCacheRootDir(profileAgentDir);
			const residentEntriesBefore = fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).length : 0;
			const sidecarCacheRoot = getSidecarCacheRootDir(profileAgentDir);
			const beforeReopen = fs.existsSync(sidecarCacheRoot) ? fs.readdirSync(sidecarCacheRoot).length : 0;
			const sessionHash = createHash("sha256").update(sessionFile).digest("hex").slice(0, 32);
			const staleSidecar = path.join(sidecarCacheRoot, `s-${sessionHash}`);
			fs.mkdirSync(sidecarCacheRoot, { recursive: true, mode: 0o700 });
			fs.chmodSync(sidecarCacheRoot, 0o700);
			fs.mkdirSync(staleSidecar, { mode: 0o700 });
			fs.chmodSync(staleSidecar, 0o700);
			fs.writeFileSync(
				path.join(staleSidecar, "owner.json"),
				JSON.stringify({ pid: 2_147_483_647, startTimeMs: 0, nonce: "crashed-sidecar", createdAt: 0 }),
				{ mode: 0o600 },
			);
			fs.chmodSync(path.join(staleSidecar, "owner.json"), 0o600);
			fs.writeFileSync(path.join(staleSidecar, ".session-memory.spill.idx"), "crash debris", { mode: 0o600 });
			const transcriptRead = vi.spyOn(nestedStore, "readExpected");
			SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1;
			let reopened: SessionManager | undefined;
			try {
				reopened = await SessionManager.openNestedManaged(
					sessionFile,
					destination,
					nestedStore,
					new FileSessionStorage(),
					cwd,
					"auto",
				);
				expect(transcriptRead).not.toHaveBeenCalled();
				expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
				expect(reopened.getSessionMemoryStats().totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
				expect(reopened.getEntry(coldId)?.id).toBe(coldId);
				expect(fs.readdirSync(sidecarCacheRoot).length).toBeGreaterThan(beforeReopen);
				expect(fs.readdirSync(sidecarCacheRoot).filter(entry => /^s-[a-f0-9]{32}$/.test(entry))).toHaveLength(1);
				expect(JSON.parse(fs.readFileSync(path.join(staleSidecar, "owner.json"), "utf8"))).toMatchObject({
					pid: process.pid,
				});
				expect(fs.readdirSync(cacheRoot).filter(entry => entry.startsWith("i-")).length).toBe(1);
			} finally {
				SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = undefined;
				await reopened?.close();
			}
			expect(fs.existsSync(sidecarCacheRoot) ? fs.readdirSync(sidecarCacheRoot).length : 0).toBe(beforeReopen);
			expect(fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).length : 0).toBe(residentEntriesBefore);
			expect(
				fs
					.readdirSync(managedRoot, { recursive: true })
					.some(entry => String(entry).includes(".session-memory.spill")),
			).toBe(false);
			rootStore.close();
			transcriptRead.mockRestore();
			tempDir.removeSync();
		},
		60_000,
	);
	itPosix("rejects malformed auto-small nested managed transcripts", async () => {
		const tempDir = TempDir.createSync("@pi-session-memory-nested-malformed-");
		const cwd = path.join(tempDir.path(), "project");
		const managedRoot = path.join(tempDir.path(), "managed");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
		const rootStore = new ManagedSessionDescendantStore(managedDirectoryRoot(managedRoot), managedRoot);
		try {
			rootStore.ensureDirectory("review");
			const nestedStore = rootStore.deriveSubtree("review");
			const destination = SessionManager.nestedManagedDestination(nestedStore, nestedStore.dir);
			const sessionFile = path.join(nestedStore.dir, "malformed.jsonl");
			nestedStore.publishNoReplaceSync(
				path.basename(sessionFile),
				Buffer.from(
					`${JSON.stringify({ type: "session", version: 5, id: "nested-malformed", timestamp: "0", cwd })}\n{malformed}\n`,
					"utf8",
				),
			);
			await expect(
				SessionManager.openNestedManaged(
					sessionFile,
					destination,
					nestedStore,
					new FileSessionStorage(),
					cwd,
					"auto",
				),
			).rejects.toThrow("malformed");
			const descriptor = nestedStore.descriptorExpected(path.basename(sessionFile));
			if (!descriptor) throw new Error("Expected nested descriptor");
			const oversizedDescriptor = vi
				.spyOn(nestedStore, "descriptorExpected")
				.mockReturnValue({ ...descriptor, size: 2 * 1024 * 1024 * 1024 + 2 * 1024 * 1024 });
			try {
				await expect(
					SessionManager.openNestedManaged(
						sessionFile,
						destination,
						nestedStore,
						new FileSessionStorage(),
						cwd,
						"enabled",
					),
				).rejects.toMatchObject({ code: "oversized" });
			} finally {
				oversizedDescriptor.mockRestore();
			}
		} finally {
			rootStore.close();
			tempDir.removeSync();
		}
	});
	it("fails closed when the authoritative cold prefix changes after shadow indexing", async () => {
		const tempDir = TempDir.createSync("@pi-session-memory-mismatch-");
		const storage = new FileSessionStorage();
		const sessionFile = path.join(tempDir.path(), "mismatch.jsonl");
		const now = new Date().toISOString();
		const ids = Array.from({ length: 20 }, (_, index) => `mismatch-${index}`);
		const entries: Array<Record<string, unknown>> = [
			{ type: "session", version: 5, id: "mismatch-session", timestamp: now, cwd: tempDir.path() },
			...ids.map((id, index) => ({
				type: "message",
				id,
				parentId: index === 0 ? null : ids[index - 1],
				timestamp: now,
				message: { role: "user", content: `cold-${index}-${"x".repeat(1024)}`, timestamp: index },
			})),
			{
				type: "compaction",
				id: "mismatch-compaction",
				parentId: ids.at(-1),
				timestamp: now,
				summary: "summary",
				firstKeptEntryId: ids.at(-1),
				tokensBefore: 10_000,
			},
		];
		storage.writeTextSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination(tempDir.path()),
			storage,
		);
		try {
			const changed = storage.readTextSync(sessionFile).replace("cold-0-", "told-0-");
			storage.writeTextSync(sessionFile, changed);
			manager.setSessionMemoryMode("enabled");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
			expect(manager.getEntry(ids[0])).toMatchObject({ id: ids[0], type: "message" });
		} finally {
			await manager.close();
			tempDir.removeSync();
		}
	});

	it("keeps duplicate-id transcripts on the eager path", async () => {
		const tempDir = TempDir.createSync("@pi-session-memory-duplicates-");
		const storage = new FileSessionStorage();
		const sessionFile = path.join(tempDir.path(), "duplicates.jsonl");
		const now = new Date().toISOString();
		const entries: Array<Record<string, unknown>> = [
			{ type: "session", version: 5, id: "duplicate-session", timestamp: now, cwd: tempDir.path() },
			{
				type: "message",
				id: "duplicate",
				parentId: null,
				timestamp: now,
				message: { role: "user", content: "first", timestamp: 1 },
			},
			{
				type: "message",
				id: "duplicate",
				parentId: null,
				timestamp: now,
				message: { role: "user", content: "second", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "duplicate-compaction",
				parentId: "duplicate",
				timestamp: now,
				summary: "summary",
				firstKeptEntryId: "duplicate",
				tokensBefore: 10,
			},
		];
		storage.writeTextSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination(tempDir.path()),
			storage,
		);
		try {
			manager.setSessionMemoryMode("enabled");
			expect(storage.existsSync(sidecarPath(sessionFile, "idx"))).toBe(false);
			expect(manager.getSessionMemoryStats()).toMatchObject({ sidecarEnabled: false, sidecarIneligible: true });
			expect(manager.getEntriesForExport()).toHaveLength(3);
		} finally {
			await manager.close();
			tempDir.removeSync();
		}
	});
});

describe("active branch retirement boundary", () => {
	it("keeps the active branch eager when only an abandoned branch was compacted", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/abandoned-compaction.jsonl";
		const entries = [
			{ type: "session", version: 5, id: "branch-session", timestamp: "0", cwd: "/cwd" },
			{ type: "custom", id: "root", parentId: null, timestamp: "0", customType: "x" },
			{ type: "custom", id: "abandoned", parentId: "root", timestamp: "0", customType: "x" },
			{
				type: "compaction",
				id: "abandoned-compaction",
				parentId: "abandoned",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "abandoned",
				tokensBefore: 10,
			},
			{ type: "custom", id: "active", parentId: "root", timestamp: "0", customType: "x" },
		];
		storage.writeTextSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const manager = await SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage);
		try {
			manager.setSessionMemoryMode("enabled");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
			expect(manager.getEntries()).toHaveLength(4);
			expect(manager.getBranch().map(entry => entry.id)).toEqual(["root", "active"]);
		} finally {
			await manager.close();
		}
	});

	it("invalidates old sidecars before re-enabling on a branch without compaction", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/rebranch.jsonl";
		const entries = [
			{ type: "session", version: 5, id: "rebranch", timestamp: "0", cwd: "/cwd" },
			{ type: "custom", id: "root", parentId: null, timestamp: "0", customType: "x" },
			{ type: "custom", id: "old", parentId: "root", timestamp: "0", customType: "x" },
			{
				type: "compaction",
				id: "old-compaction",
				parentId: "old",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "old",
				tokensBefore: 10,
			},
		];
		storage.writeTextSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const manager = await SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage);
		try {
			manager.setSessionMemoryMode("enabled");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
			manager.branch("root");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
			expect(storage.listFilesSync("/sessions", "*.spill.*")).toEqual([]);
			manager.setSessionMemoryMode("enabled");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
			expect(manager.getEntries()).toHaveLength(3);
			expect(manager.getBranch().map(entry => entry.id)).toEqual(["root"]);
		} finally {
			await manager.close();
		}
	});
});

describe("bounded provider context traversal", () => {
	it("stops at the active compaction boundary without hydrating older cold entries", async () => {
		class CountingStorage extends MemorySessionStorage {
			rangeReads = 0;
			override readRangeSync(filePath: string, offset: number, length: number) {
				this.rangeReads++;
				return super.readRangeSync(filePath, offset, length);
			}
		}
		const storage = new CountingStorage();
		const sessionFile = "/sessions/context-boundary.jsonl";
		const entries = [
			{ type: "session", version: 5, id: "context-boundary", timestamp: "0", cwd: "/cwd" },
			{
				type: "message",
				id: "old-user",
				parentId: null,
				timestamp: "0",
				message: { role: "user", content: "old", timestamp: 1 },
			},
			{
				type: "message",
				id: "old-assistant",
				parentId: "old-user",
				timestamp: "0",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "old answer" }],
					api: "x",
					provider: "x",
					model: "x",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "kept",
				parentId: "old-assistant",
				timestamp: "0",
				message: { role: "user", content: "kept", timestamp: 3 },
			},
			{
				type: "compaction",
				id: "compaction",
				parentId: "kept",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 10,
			},
			{
				type: "message",
				id: "after",
				parentId: "compaction",
				timestamp: "0",
				message: { role: "user", content: "after", timestamp: 4 },
			},
		];
		storage.writeTextSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const manager = await SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage);
		try {
			manager.setSessionMemoryMode("enabled");
			storage.rangeReads = 0;
			const context = manager.buildSessionContext();
			expect(context.messages).toHaveLength(3);
			expect(storage.rangeReads).toBe(0);
		} finally {
			await manager.close();
		}
	});
	it("rejects generated IDs that collide with retired cold entries", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/cold-generated-id-collision.jsonl";
		const records = [
			{ type: "session", version: 5, id: "collision-session", timestamp: "0", cwd: "/cwd" },
			{ type: "custom", id: "deadbeef", parentId: null, timestamp: "0", customType: "node", data: {} },
			{ type: "custom", id: "active", parentId: "deadbeef", timestamp: "0", customType: "node", data: {} },
			{
				type: "compaction",
				id: "active-compaction",
				parentId: "active",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "active",
				tokensBefore: 1,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		const randomUUID = vi
			.spyOn(crypto, "randomUUID")
			.mockReturnValueOnce("00000000-0000-0000-0000-0000deadbeef")
			.mockReturnValueOnce("00000000-0000-0000-0000-0000cafebabe");
		try {
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
			expect(manager.appendMessage({ role: "user", content: "collision check", timestamp: 1 })).toBe("cafebabe");
		} finally {
			randomUUID.mockRestore();
			await manager.close();
		}
	});
	it("falls back eagerly when appended provider state exceeds the fixed slot budget", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/provider-state-append-budget.jsonl";
		writeTreeTranscript(storage, sessionFile, { parentCount: 8, childrenPerParent: 2 });
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
			for (let index = 0; index < 257; index++) {
				manager.appendConfiguredModelChain({
					role: `role-${index}`,
					entries: [`test/model-${index}`],
					origin: "session",
					explicitHead: false,
				});
			}
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
			expect(manager.getSessionMemoryStats().coldMutationPromotions).toBeGreaterThan(0);
			expect(manager.getEntriesForExport().filter(entry => entry.type === "configured_model_chain")).toHaveLength(
				257,
			);
		} finally {
			await manager.close();
		}
	});
	it("preserves pre-compaction provider state across retirement and exact reopen", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/provider-state.jsonl";
		const records = [
			{ type: "session", version: 5, id: "provider-state", timestamp: "0", cwd: "/cwd" },
			{ type: "thinking_level_change", id: "thinking", parentId: null, timestamp: "0", thinkingLevel: "high" },
			{
				type: "model_change",
				id: "model",
				parentId: "thinking",
				timestamp: "0",
				model: "test/default",
				role: "default",
			},
			{
				type: "configured_model_chain",
				id: "chain",
				parentId: "model",
				timestamp: "0",
				role: "reviewer",
				entries: ["test/reviewer"],
				origin: "session",
			},
			{ type: "service_tier_change", id: "tier", parentId: "chain", timestamp: "0", serviceTier: "flex" },
			{ type: "mcp_tool_selection", id: "mcp", parentId: "tier", timestamp: "0", selectedToolNames: ["mcp__docs"] },
			{
				type: "discovered_builtin_tool_selection",
				id: "builtin",
				parentId: "mcp",
				timestamp: "0",
				selectedToolNames: ["search"],
			},
			{
				type: "mode_change",
				id: "mode",
				parentId: "builtin",
				timestamp: "0",
				mode: "plan",
				data: { planFile: "plan.md" },
			},
			{
				type: "message",
				id: "kept",
				parentId: "mode",
				timestamp: "0",
				message: { role: "user", content: "kept", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "compact",
				parentId: "kept",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 10,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage);
		const eager = manager.buildSessionContext();
		manager.setSessionMemoryMode("enabled");
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
		const counters = manager.getSessionMemoryStats();
		expect(counters.coldEntriesRetired).toBeGreaterThan(0);
		expect(counters.coldEntriesReloaded).toBe(0);
		expect(counters.sidecarRebuildCount).toBeGreaterThan(0);
		expect(counters.transcriptGeneration).toBeGreaterThan(0);
		expect(manager.getEntry("thinking")).toMatchObject({ id: "thinking", type: "thinking_level_change" });
		expect(manager.getSessionMemoryStats().coldEntriesReloaded).toBeGreaterThan(0);
		expect(manager.buildSessionContext()).toEqual(eager);
		await manager.close();

		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getSessionMemoryStats().lazyReopenSucceeded).toBe(true);
			expect(reopened.buildSessionContext()).toEqual(eager);
		} finally {
			await reopened.close();
		}
	});
});

it("reopens an enabled explicit session from authenticated hot-tail metadata", async () => {
	class CountingStorage extends MemorySessionStorage {
		rangeReads = 0;
		textReads = 0;
		override readRangeSync(filePath: string, offset: number, length: number) {
			this.rangeReads++;
			return super.readRangeSync(filePath, offset, length);
		}
		override readText(filePath: string) {
			this.textReads++;
			return super.readText(filePath);
		}
	}
	const storage = new CountingStorage();
	const sessionFile = "/sessions/lazy-reopen.jsonl";
	const records = [
		{ type: "session", version: 5, id: "lazy-reopen", timestamp: "0", cwd: "/cwd" },
		{
			type: "message",
			id: "old",
			parentId: null,
			timestamp: "0",
			message: { role: "user", content: "old", timestamp: 1 },
		},
		{
			type: "message",
			id: "kept",
			parentId: "old",
			timestamp: "0",
			message: { role: "user", content: "kept", timestamp: 2 },
		},
		{
			type: "compaction",
			id: "compaction",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 10,
		},
		{
			type: "message",
			id: "after",
			parentId: "compaction",
			timestamp: "0",
			message: { role: "user", content: "after", timestamp: 3 },
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const initial = await SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage);
	initial.setSessionMemoryMode("enabled");
	await initial.close();
	storage.textReads = 0;

	const reopened = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
		expect(reopened.getSessionMemoryStats()).toMatchObject({
			lazyReopenAttempted: true,
			lazyReopenSucceeded: true,
			lazyReopenFallbackReason: undefined,
		});
		storage.rangeReads = 0;
		expect(reopened.buildSessionContext().messages).toHaveLength(3);
		expect(storage.rangeReads).toBe(0);
		expect(storage.textReads).toBe(0);
		expect(reopened.getEntry("old")).toMatchObject({ id: "old" });
	} finally {
		await reopened.close();
	}
	const markerPath = sidecarPath(sessionFile, "commit");
	const marker = JSON.parse(storage.readTextSync(markerPath)) as { reducer: { ttsr: { count: number } } };
	marker.reducer.ttsr.count = Number.NaN;
	storage.writeTextSync(markerPath, `${JSON.stringify(marker)}\n`);
	storage.textReads = 0;
	const fallback = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(storage.textReads).toBe(0);
		expect(fallback.getSessionMemoryStats()).toMatchObject({
			lazyReopenAttempted: true,
			lazyReopenSucceeded: true,
			lazyReopenFallbackReason: undefined,
			lastReopenTransition: { kind: "rebuild", reason: "bounded_first_open" },
		});
		expect(fallback.buildSessionContext().messages).toHaveLength(3);
	} finally {
		await fallback.close();
	}
});

it("applies auto-routed retirement while constructing a direct fork", async () => {
	class ForkCountingStorage extends MemorySessionStorage {
		fullReads = 0;
		override readTextSync(filePath: string): string {
			if (!filePath.includes(".spill.")) this.fullReads++;
			return super.readTextSync(filePath);
		}
		override readBytesSync(filePath: string): Uint8Array {
			if (!filePath.includes(".spill.")) this.fullReads++;
			return super.readBytesSync(filePath);
		}
	}
	const storage = new ForkCountingStorage();
	const source = "/sessions/fork-source.jsonl";
	const records = [
		{ type: "session", version: 5, id: "fork-source", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "x", data: { text: "old" } },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "x", data: { text: "kept" } },
		{
			type: "compaction",
			id: "compaction",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 10,
		},
	];
	storage.writeTextSync(source, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1;
	let forked: SessionManager | undefined;
	try {
		forked = await SessionManager.forkFrom(
			source,
			"/cwd",
			SessionManager.explicitDestination("/forks"),
			storage,
			"copy-retain",
			"auto",
		);
		expect(forked.getSessionMemoryStats().coldRetirementActive).toBe(true);
		expect(storage.fullReads).toBe(0);
		expect(forked.getEntry("old")).toMatchObject({ id: "old" });
	} finally {
		SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = undefined;
		await forked?.close();
	}
});

it("constructs managed cold forks through bounded authority-bound publication", async () => {
	const tempDir = TempDir.createSync("@pi-session-managed-bounded-fork-");
	const storage = new FileSessionStorage();
	const cwd = tempDir.path();
	const agentDir = path.join(cwd, ".gjc");
	const destination = SessionManager.managedDestination(cwd, agentDir, storage);
	const source = SessionManager.create(cwd, destination, storage);
	let forked: SessionManager | undefined;
	SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1;
	try {
		source.setSessionMemoryMode("off");
		await source.ensureOnDisk();
		const old = source.appendCustomEntry("node", { payload: "old" });
		const kept = source.appendCustomEntry("node", { payload: "kept" });
		source.appendCompaction("summary", undefined, kept, 1);
		await source.flush();
		await source.close();
		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("Expected managed source file");
		forked = await SessionManager.forkFrom(sourceFile, cwd, destination, storage, "copy-retain", "auto");
		expect(forked.getSessionFile()).not.toBe(sourceFile);
		expect(forked.getSessionMemoryStats().coldRetirementActive).toBe(true);
		expect(forked.getEntry(old)).toMatchObject({ id: old });
		await forked.close();
		forked = undefined;
		const captured = SessionManager.captureTranscriptStrict(sourceFile, storage);
		if (captured.kind !== "captured") throw new Error("Expected strict managed capture");
		try {
			const capturedFork = await SessionManager.forkFromCaptured(
				captured.snapshot,
				cwd,
				destination,
				"copy-retain",
				"auto",
			);
			if (capturedFork.kind !== "forked") throw new Error(`Captured managed fork failed: ${capturedFork.reason}`);
			forked = capturedFork.manager;
			expect(forked.getSessionMemoryStats().coldRetirementActive).toBe(true);
			expect(forked.getEntry(old)).toMatchObject({ id: old });
		} finally {
			captured.snapshot.close();
		}
	} finally {
		SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = undefined;
		await forked?.close();
		await source.close();
		tempDir.removeSync();
	}
});

itPosix("restores managed cold rollback authority across session directories", async () => {
	const tempDir = TempDir.createSync("@pi-session-managed-rollback-");
	const managedRoot = path.join(tempDir.path(), "managed");
	fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
	const rootStore = new ManagedSessionDescendantStore(managedDirectoryRoot(managedRoot), managedRoot);
	let source: SessionManager | undefined;
	let target: SessionManager | undefined;
	SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1;
	try {
		rootStore.ensureDirectory("source");
		const sourceStore = rootStore.deriveSubtree("source");
		sourceStore.ensureDirectory("target");
		const targetStore = sourceStore.deriveSubtree("target");
		source = SessionManager.create(
			"/cwd",
			SessionManager.nestedManagedDestination(sourceStore, sourceStore.dir),
			new FileSessionStorage(),
		);
		target = SessionManager.create(
			"/cwd",
			SessionManager.nestedManagedDestination(targetStore, targetStore.dir),
			new FileSessionStorage(),
		);
		source.setSessionMemoryMode("auto");
		target.setSessionMemoryMode("auto");
		await source.ensureOnDisk();
		await target.ensureOnDisk();
		const sourceOld = source.appendCustomEntry("node", { payload: "source-old" });
		const sourceKept = source.appendCustomEntry("node", { payload: "source-kept" });
		source.appendCompaction("source summary", undefined, sourceKept, 1);
		const targetOld = target.appendCustomEntry("node", { payload: "target-old" });
		const targetKept = target.appendCustomEntry("node", { payload: "target-kept" });
		target.appendCompaction("target summary", undefined, targetKept, 1);
		await source.flush();
		await target.flush();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected managed target file");
		await target.close();
		const rollback = await source.captureRollbackState();
		await source.setSessionFile(targetFile);
		expect(source.getEntry(targetOld)).toMatchObject({ id: targetOld });
		await source.restoreRollbackState(rollback);
		expect(source.getEntry(sourceOld)).toMatchObject({ id: sourceOld });
	} finally {
		SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = undefined;
		await target?.close();
		await source?.close();
		rootStore.close();
		tempDir.removeSync();
	}
});

it("folds direct fork header and entry patches without full transcript reads", async () => {
	class PatchForkStorage extends MemorySessionStorage {
		fullReads = 0;
		override readTextSync(filePath: string): string {
			if (!filePath.includes(".spill.")) this.fullReads++;
			return super.readTextSync(filePath);
		}
		override readBytesSync(filePath: string): Uint8Array {
			if (!filePath.includes(".spill.")) this.fullReads++;
			return super.readBytesSync(filePath);
		}
	}
	const storage = new PatchForkStorage();
	const source = "/sessions/fork-patched-source.jsonl";
	const records = [
		{ type: "session", version: 5, id: "patched-source", timestamp: "0", cwd: "/cwd" },
		{
			type: "message",
			id: "old",
			parentId: null,
			timestamp: "0",
			message: { role: "user", content: "old", timestamp: 1 },
		},
		{
			type: "message",
			id: "kept",
			parentId: "old",
			timestamp: "0",
			message: { role: "user", content: "before", timestamp: 2 },
		},
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 10,
		},
		{ type: "header_patch", patch: { title: "patched title", titleSource: "user" } },
		{
			type: "entry_patch",
			entryId: "kept",
			patch: { message: { role: "user", content: "after", timestamp: 2 } },
		},
	];
	storage.writeTextSync(source, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const forked = await SessionManager.forkFrom(
		source,
		"/cwd",
		SessionManager.explicitDestination("/patched-forks"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(storage.fullReads).toBe(0);
		expect(forked.getSessionMemoryStats().coldRetirementActive).toBe(true);
		expect(forked.getHeader()).toMatchObject({ title: "patched title", titleSource: "user" });
		expect(forked.getEntry("kept")).toMatchObject({ message: { content: "after" } });
	} finally {
		await forked.close();
	}
});

it("bounds the first enabled open with zero full-transcript reads and authentic sidecars", async () => {
	class CountingStorage extends MemorySessionStorage {
		rangeReads = 0;
		textReads = 0;
		textSyncReads = 0;
		bytesReads = 0;
		override readRangeSync(filePath: string, offset: number, length: number) {
			this.rangeReads++;
			return super.readRangeSync(filePath, offset, length);
		}
		override readText(filePath: string) {
			if (!filePath.includes(".spill.")) this.textReads++;
			return super.readText(filePath);
		}
		override readTextSync(filePath: string) {
			if (!filePath.includes(".spill.")) this.textSyncReads++;
			return super.readTextSync(filePath);
		}
		override readBytesSync(filePath: string) {
			if (!filePath.includes(".spill.")) this.bytesReads++;
			return super.readBytesSync(filePath);
		}
	}
	const storage = new CountingStorage();
	const sessionFile = "/sessions/bounded-first-open.jsonl";
	const now = "0";
	const records = [
		{ type: "session", version: 5, id: "bounded-first-open", timestamp: now, cwd: "/cwd" },
		{
			type: "message",
			id: "cold-old",
			parentId: null,
			timestamp: now,
			message: { role: "user", content: "cold old", timestamp: 1 },
		},
		{
			type: "thinking_level_change",
			id: "cold-thinking",
			parentId: "cold-old",
			timestamp: now,
			thinkingLevel: "high",
		},
		{
			type: "custom",
			id: "cold-gap",
			parentId: "cold-thinking",
			timestamp: now,
			customType: "provider-gap",
			data: { value: true },
		},
		{
			type: "message",
			id: "cold-kept",
			parentId: "cold-gap",
			timestamp: now,
			message: { role: "user", content: "cold kept", timestamp: 2 },
		},
		{
			type: "compaction",
			id: "compaction",
			parentId: "cold-kept",
			timestamp: now,
			summary: "summary",
			firstKeptEntryId: "cold-kept",
			tokensBefore: 10,
		},
		{
			type: "message",
			id: "hot-after",
			parentId: "compaction",
			timestamp: now,
			message: {
				role: "assistant",
				content: "hot after",
				timestamp: 3,
				usage: { input: 5, output: 7, cacheRead: 1, cacheWrite: 0, premiumRequests: 0, cost: { total: 12 } },
			},
		},
		{ type: "label", id: "label", parentId: "hot-after", timestamp: now, targetId: "cold-old", label: "cold label" },
	];
	const transcript = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
	storage.writeTextSync(sessionFile, transcript);

	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(storage.textReads).toBe(0);
		expect(storage.textSyncReads).toBe(0);
		expect(storage.bytesReads).toBe(0);
		expect(storage.rangeReads).toBeGreaterThan(0);
		expect(manager.getSessionMemoryStats()).toMatchObject({
			sidecarEnabled: true,
			coldRetirementActive: true,
			lazyReopenAttempted: true,
			lazyReopenSucceeded: true,
			lazyReopenFallbackReason: undefined,
			lastReopenTransition: { kind: "rebuild", reason: "bounded_first_open" },
		});
		const stats = manager.getSessionMemoryStats();
		expect(stats.reservedBudgetBytes).toBeGreaterThan(0);
		expect(stats.allocatedCacheBytes).toBeGreaterThan(0);
		expect(stats.hotResidentBytes).toBeGreaterThan(0);
		expect(stats.metadataResidentBytes).toBeGreaterThan(0);
		expect(stats.sidecarFileBytes).toBeGreaterThan(0);
		expect(stats.firstOpen).toMatchObject({
			attempted: true,
			succeeded: true,
			strategy: "pressure",
			secondaryArtifactMode: "disabled",
		});
		expect(stats.firstOpen.semanticRecordsParsed).toBe(records.length);
		expect(stats.firstOpen.suffixRecordsParsed).toBeGreaterThan(0);
		expect(stats.firstOpen.recordsParsed).toBe(
			stats.firstOpen.semanticRecordsParsed + stats.firstOpen.suffixRecordsParsed,
		);
		expect(stats.firstOpen.transcriptBytesRead).toBeGreaterThanOrEqual(transcript.length);
		expect(stats.firstOpen.indexWriteBytes).toBeGreaterThan(0);
		expect(stats.firstOpen.indexWriteCalls).toBeGreaterThan(0);
		expect(stats.firstOpen.fsyncCount).toBe(2);
		const cold = manager.getEntry("cold-old");
		expect(cold).toMatchObject({ id: "cold-old", type: "message" });
		if (cold?.type !== "message" || !("content" in cold.message)) throw new Error("Expected cold message entry");
		expect(cold.message.content).toBe("cold old");
		expect(manager.buildSessionContext().messages).toHaveLength(3);
		expect(manager.buildSessionContext().thinkingLevel).toBe("high");
		expect(manager.getLabel("cold-old")).toBe("cold label");
		expect(manager.getUsageStatistics()).toMatchObject({
			input: 5,
			output: 7,
			cacheRead: 1,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 12,
		});
		const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
			base: { baseDigest: string; baseEndOffset: number };
			transcriptSize: number;
			retirementFirstKeptEntryId: string;
			leafId: string;
			indexDigest: string;
		};
		expect(marker.base.baseEndOffset).toBe(transcript.indexOf(`${JSON.stringify(records[4])}\n`));
		expect(marker.base.baseDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(marker.transcriptSize).toBe(Buffer.byteLength(transcript, "utf8"));
		expect(marker.retirementFirstKeptEntryId).toBe("cold-kept");
		expect(marker.leafId).toBe("label");

		// The commit authenticates the exact `.spill.idx` bytes (indexDigest).
		expect(marker.indexDigest).toBe(
			createHash("sha256")
				.update(storage.readBytesSync(sidecarPath(sessionFile, "idx")))
				.digest("hex"),
		);
	} finally {
		await manager.close();
	}

	// The marker published by the bounded first open is accepted by the existing
	// authenticated explicit lazy reopen path (exact offsets, digests, and the
	// rolling tail proof all round-trip).
	const exactIndexText = storage.readTextSync(sidecarPath(sessionFile, "idx"));
	storage.textReads = 0;
	storage.textSyncReads = 0;
	storage.bytesReads = 0;
	const reopened = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(storage.textReads).toBe(0);
		expect(storage.textSyncReads).toBe(0);
		expect(storage.bytesReads).toBe(0);
		expect(reopened.getSessionMemoryStats()).toMatchObject({
			sidecarEnabled: true,
			coldRetirementActive: true,
			lazyReopenAttempted: true,
			lazyReopenSucceeded: true,
			lazyReopenFallbackReason: undefined,
			lastReopenTransition: { kind: "exact", reason: "descriptor_and_proof_match" },
		});
		storage.writeTextSync(sidecarPath(sessionFile, "idx"), `${exactIndexText}{}\n`);
		expect(reopened.getEntry("cold-old")).toMatchObject({ id: "cold-old", type: "message" });
		storage.writeTextSync(sidecarPath(sessionFile, "idx"), exactIndexText);
		expect(reopened.getEntry("cold-old")).toMatchObject({ id: "cold-old", type: "message" });
		expect(reopened.buildSessionContext().messages).toHaveLength(3);
		expect(reopened.buildSessionContext().thinkingLevel).toBe("high");
		expect(reopened.getUsageStatistics()).toMatchObject({ cost: 12 });
	} finally {
		await reopened.close();
	}

	// A disposable index that no longer matches the committed indexDigest is
	// never adopted: the open fails closed to the eager authoritative path.
	storage.writeTextSync(
		sidecarPath(sessionFile, "idx"),
		`${storage.readTextSync(sidecarPath(sessionFile, "idx"))}{}\n`,
	);
	storage.textReads = 0;
	storage.textSyncReads = 0;
	storage.bytesReads = 0;
	const corruptIndex = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(corruptIndex.getSessionMemoryStats()).toMatchObject({
			lazyReopenAttempted: true,
			lazyReopenSucceeded: true,
			lazyReopenFallbackReason: undefined,
			lastReopenTransition: { kind: "rebuild", reason: "bounded_first_open" },
		});
		expect(corruptIndex.getEntry("cold-old")).toMatchObject({ id: "cold-old", type: "message" });
	} finally {
		await corruptIndex.close();
	}
});

it("fails closed without sidecar publication for unterminated bounded first-open input", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/unterminated-bounded.jsonl";
	const records = [
		{ type: "session", version: 5, id: "unterminated", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sessionFile, records.map(record => JSON.stringify(record)).join("\n"));
	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
		expect(storage.existsSync(sidecarPath(sessionFile, "commit"))).toBe(false);
		expect(manager.getEntry("kept")).toMatchObject({ id: "kept" });
	} finally {
		await manager.close();
	}
});

it("fails closed when a bounded first-open line exceeds the exact scanner limit", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/oversized-line-bounded.jsonl";
	const oversized = {
		type: "custom",
		id: "oversized",
		parentId: null,
		timestamp: "0",
		customType: "oversized",
		data: { payload: "x".repeat(BOUNDED_FIRST_OPEN_MAX_LINE_BYTES) },
	};
	const records = [
		{ type: "session", version: 5, id: "oversized-line", timestamp: "0", cwd: "/cwd" },
		oversized,
		{ type: "custom", id: "kept", parentId: "oversized", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(Buffer.byteLength(JSON.stringify(oversized), "utf8") + 1).toBeGreaterThan(
			BOUNDED_FIRST_OPEN_MAX_LINE_BYTES,
		);
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
		expect(storage.existsSync(sidecarPath(sessionFile, "commit"))).toBe(false);
	} finally {
		await manager.close();
	}
});

it("fails closed for a missing parent in the bounded first-open chain", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/missing-parent-bounded.jsonl";
	const records = [
		{ type: "session", version: 5, id: "missing-parent", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "kept", parentId: "missing", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
		expect(storage.existsSync(sidecarPath(sessionFile, "commit"))).toBe(false);
		expect(manager.getEntry("kept")).toMatchObject({ parentId: "missing" });
	} finally {
		await manager.close();
	}
});

it("rejects descriptor mutation during the bounded semantic scan", async () => {
	class MutatingStorage extends MemorySessionStorage {
		transcriptReads = 0;
		override readRangeSync(filePath: string, offset: number, length: number) {
			const snapshot = super.readRangeSync(filePath, offset, length);
			if (filePath === "/sessions/mutating-bounded.jsonl" && ++this.transcriptReads === 2)
				super.writeTextSync(filePath, `${super.readTextSync(filePath)}\n`);
			return snapshot;
		}
	}
	const storage = new MutatingStorage();
	const sessionFile = "/sessions/mutating-bounded.jsonl";
	const records = [
		{ type: "session", version: 5, id: "mutating", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(storage.transcriptReads).toBeGreaterThanOrEqual(2);
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
		expect(storage.existsSync(sidecarPath(sessionFile, "commit"))).toBe(false);
	} finally {
		await manager.close();
	}
});

it("serializes concurrent bounded first-open publishers through an owner-bound lock", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/concurrent-bounded.jsonl";
	const records = [
		{ type: "session", version: 5, id: "concurrent", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const [first, second] = await Promise.all([
		SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		),
		SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		),
	]);
	try {
		expect(first.getSessionMemoryStats().coldRetirementActive).toBe(true);
		expect(second.getSessionMemoryStats().coldRetirementActive).toBe(true);
		expect([first, second].map(manager => manager.getSessionMemoryStats().lastReopenTransition?.kind).sort()).toEqual(
			["exact", "rebuild"],
		);
		expect(storage.existsSync(`${sessionFile.slice(0, -6)}/.session-memory.spill.build-lock`)).toBe(false);
	} finally {
		await first.close();
		await second.close();
	}
});

it("binds explicitly enabled secondary artifacts to the discovered first-open session id", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/secondary-session-binding.jsonl";
	const records = [
		{ type: "session", version: 5, id: "secondary-session", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: { term: "old" } },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: { term: "kept" } },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	SessionManagerTestHooks.secondaryArtifactMode = "enabled";
	let first: SessionManager | undefined;
	let reopened: SessionManager | undefined;
	try {
		first = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		expect(first.getSessionMemoryStats().dictionaryArtifactEnabled).toBe(true);
		await first.close();
		first = undefined;
		reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		expect(reopened.getSessionMemoryStats()).toMatchObject({
			coldRetirementActive: true,
			dictionaryArtifactEnabled: true,
			lastReopenTransition: { kind: "exact" },
		});
	} finally {
		SessionManagerTestHooks.secondaryArtifactMode = undefined;
		await first?.close();
		await reopened?.close();
	}
});

it("refuses unbounded authoritative hydration after bounded sidecar tamper", async () => {
	class CountingStorage extends MemorySessionStorage {
		transcriptTextReads = 0;
		override readTextSync(filePath: string): string {
			if (!filePath.includes(".spill.")) this.transcriptTextReads++;
			return super.readTextSync(filePath);
		}
	}
	const storage = new CountingStorage();
	const sessionFile = "/sessions/no-unbounded-hydration.jsonl";
	const records = [
		{ type: "session", version: 5, id: "no-hydration", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		storage.transcriptTextReads = 0;
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
		storage.writeTextSync(
			sidecarPath(sessionFile, "idx"),
			`${storage.readTextSync(sidecarPath(sessionFile, "idx"))}{}\n`,
		);
		expect(() => manager.getEntry("old")).toThrow("cold_sidecar_rebuild_required_for_bounded_transcript");
		expect(storage.transcriptTextReads).toBe(0);
	} finally {
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
		await manager.close();
	}
});

it("rejects corrupt tail and commit artifacts through manager reopen", async () => {
	class CountingStorage extends MemorySessionStorage {
		transcriptTextReads = 0;
		override readText(filePath: string): Promise<string> {
			if (!filePath.includes(".spill.")) this.transcriptTextReads++;
			return super.readText(filePath);
		}
		override readTextSync(filePath: string): string {
			if (!filePath.includes(".spill.")) this.transcriptTextReads++;
			return super.readTextSync(filePath);
		}
	}
	for (const corruptKind of ["tail", "commit"] as const) {
		const storage = new CountingStorage();
		const sessionFile = `/sessions/corrupt-${corruptKind}.jsonl`;
		const records = [
			{ type: "session", version: 5, id: `corrupt-${corruptKind}`, timestamp: "0", cwd: "/cwd" },
			{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
			{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
			{
				type: "compaction",
				id: "compact",
				parentId: "kept",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 1,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		await built.close();
		storage.writeTextSync(sidecarPath(sessionFile, corruptKind), "corrupt\n");
		storage.transcriptTextReads = 0;

		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(storage.readTextSync(sidecarPath(sessionFile, corruptKind))).not.toBe("corrupt\n");
			expect(reopened.getEntry("old")).toMatchObject({ id: "old" });
			expect(storage.transcriptTextReads).toBe(0);
		} finally {
			await reopened.close();
		}
	}
});

it("refreshes split residency metrics after append and retained off-mode rollback", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/split-metric-transitions.jsonl";
	const records = [
		{ type: "session", version: 5, id: "split-metrics", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		const before = manager.getSessionMemoryStats();
		manager.appendCustomEntry("metric", { payload: "x".repeat(1024) });
		const appended = manager.getSessionMemoryStats();
		expect(appended.reservedBudgetBytes).toBe(before.reservedBudgetBytes);
		expect(appended.hotResidentBytes).toBeGreaterThan(before.hotResidentBytes);
		expect(appended.metadataResidentBytes).toBeGreaterThanOrEqual(before.metadataResidentBytes);
		manager.setSessionMemoryMode("off");
		const disabled = manager.getSessionMemoryStats();
		expect(disabled.reservedBudgetBytes).toBe(appended.reservedBudgetBytes);
		expect(disabled.hotResidentBytes).toBe(appended.hotResidentBytes);
	} finally {
		await manager.close();
	}
});

it("appends after tail overflow without materializing the complete cold index", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/tail-overflow-next-ordinal.jsonl";
	const records = [
		{ type: "session", version: 5, id: "tail-overflow", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	SessionManagerTestHooks.sidecarTailBufferBytesOverride = 1;
	SessionManagerTestHooks.secondaryArtifactMode = "disabled";
	SessionManagerTestHooks.readAllColdEntryIndexesCalls = 0;
	SessionManagerTestHooks.coldIdHashMaxEntriesOverride = 4;
	let manager: SessionManager | undefined;
	try {
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		await built.close();
		manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		expect(SessionManagerTestHooks.lastSidecarInitError).toBeUndefined();
		expect(manager.getSessionMemoryStats()).toMatchObject({
			coldRetirementActive: true,
			dictionaryArtifactEnabled: false,
			lazyReopenSucceeded: true,
		});
		expect(storage.readTextSync(sidecarPath(sessionFile, "tail"))).toBe("");
		SessionManagerTestHooks.readAllColdEntryIndexesCalls = 0;
		const appendedId = manager.appendCustomEntry("after-overflow", {});
		const clearedId = manager.clearModelRole("reviewer");
		const finalId = manager.appendCustomEntry("after-clear", {});
		expect(SessionManagerTestHooks.readAllColdEntryIndexesCalls).toBe(0);
		const expected = [
			{ id: appendedId, ordinal: 3 },
			{ id: clearedId, ordinal: 4 },
			{ id: finalId, ordinal: 5 },
		];
		const finalIndex = storage
			.readTextSync(sidecarPath(sessionFile, "idx"))
			.trimEnd()
			.split("\n")
			.slice(-3)
			.map(line => JSON.parse(line));
		const finalTail = storage
			.readTextSync(sidecarPath(sessionFile, "tail"))
			.trimEnd()
			.split("\n")
			.slice(-3)
			.map(line => JSON.parse(line));
		expect(finalIndex).toMatchObject(expected);
		expect(finalTail).toMatchObject(expected);
	} finally {
		SessionManagerTestHooks.sidecarTailBufferBytesOverride = undefined;
		SessionManagerTestHooks.secondaryArtifactMode = undefined;
		SessionManagerTestHooks.readAllColdEntryIndexesCalls = undefined;
		SessionManagerTestHooks.coldIdHashMaxEntriesOverride = undefined;
		await manager?.close();
	}
});

it("applies benchmark-only GC and secondary-artifact controls to bounded first-open", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/bounded-first-open-controls.jsonl";
	const records = [
		{ type: "session", version: 5, id: "controlled", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	SessionManagerTestHooks.firstOpenGcStrategy = "none";
	SessionManagerTestHooks.secondaryArtifactMode = "disabled";
	let manager: SessionManager | undefined;
	try {
		manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		const stats = manager.getSessionMemoryStats();
		expect(stats.firstOpen).toMatchObject({
			attempted: true,
			succeeded: true,
			strategy: "none",
			secondaryArtifactMode: "disabled",
			gcRequests: 0,
			dictionaryArtifactEnabled: false,
			parentArtifactEnabled: false,
		});
		expect(stats.dictionaryArtifactEnabled).toBe(false);
		expect(stats.parentArtifactEnabled).toBe(false);
	} finally {
		SessionManagerTestHooks.firstOpenGcStrategy = undefined;
		SessionManagerTestHooks.secondaryArtifactMode = undefined;
		await manager?.close();
	}
});

it("routes auto mode eagerly below the threshold and bounded above it", async () => {
	const storage = new MemorySessionStorage();
	const records = [
		{ type: "session", version: 5, id: "auto-route", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	const transcript = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
	const eagerFile = "/sessions/auto-route-eager.jsonl";
	storage.writeTextSync(eagerFile, transcript);
	const eager = await SessionManager.open(
		eagerFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"auto",
	);
	try {
		expect(eager.getSessionMemoryStats()).toMatchObject({
			sidecarEnabled: false,
			lazyReopenAttempted: false,
		});
		expect(eager.getEntry("old")).toMatchObject({ id: "old" });
	} finally {
		await eager.close();
	}

	const boundedFile = "/sessions/auto-route-bounded.jsonl";
	storage.writeTextSync(boundedFile, transcript.replace('"auto-route"', '"auto-route-bounded"'));
	SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1;
	let bounded: SessionManager | undefined;
	try {
		bounded = await SessionManager.open(
			boundedFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"auto",
		);
		expect(bounded.getSessionMemoryStats()).toMatchObject({
			sidecarEnabled: true,
			lazyReopenAttempted: true,
			lazyReopenSucceeded: true,
		});
		expect(bounded.getEntry("old")).toMatchObject({ id: "old" });
	} finally {
		SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = undefined;
		await bounded?.close();
	}
});

it("rejects malformed auto-small explicit resumes through strict inspection", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/auto-small-explicit-malformed.jsonl";
	storage.writeTextSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 5, id: "auto-small-explicit", timestamp: "0", cwd: "/cwd" })}\n{malformed}\n`,
	);
	await expect(
		SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage, "copy-retain", "auto"),
	).rejects.toThrow(/Could not open session|malformed/);
});

it("rejects schema-invalid auto-small explicit resumes", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/auto-small-explicit-schema-invalid.jsonl";
	storage.writeTextSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 5, id: "auto-small-explicit-schema", timestamp: "0", cwd: "/cwd" })}\n${JSON.stringify({ type: "custom", id: "invalid", parentId: null, timestamp: "0", data: {} })}\n`,
	);
	await expect(
		SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage, "copy-retain", "auto"),
	).rejects.toThrow("malformed");
});
it("rejects malformed auto-small managed resumes through the strict eager path", async () => {
	const tempDir = TempDir.createSync("@pi-session-auto-small-");
	const storage = new FileSessionStorage();
	const cwd = tempDir.path();
	const agentDir = path.join(cwd, ".gjc");
	const destination = SessionManager.managedDestination(cwd, agentDir, storage);
	const sessionFile = path.join(agentDir, "sessions", "auto-small-malformed.jsonl");
	storage.writeTextSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 5, id: "auto-small-malformed", timestamp: "0", cwd })}\n{malformed}\n`,
	);
	try {
		await expect(SessionManager.open(sessionFile, destination, storage, "copy-retain", "auto")).rejects.toThrow(
			/Could not open session|malformed/,
		);
	} finally {
		tempDir.removeSync();
	}
});

it("activates cold state when an auto session crosses the threshold on append", async () => {
	const storage = new MemorySessionStorage();
	const manager = SessionManager.create("/cwd", SessionManager.explicitDestination("/sessions"), storage);
	SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1_000;
	try {
		manager.setSessionMemoryMode("auto");
		await manager.ensureOnDisk();
		manager.appendCustomEntry("node", { payload: "old" });
		const first = manager.appendCustomEntry("node", { payload: "small" });
		manager.appendCompaction("summary", undefined, first, 1);
		expect(manager.getSessionMemoryStats().sidecarEnabled).toBe(false);
		manager.appendCustomEntry("node", { payload: "x".repeat(2_000) });
		expect(manager.getSessionMemoryStats().sidecarEnabled).toBe(true);
	} finally {
		SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = undefined;
		await manager.close();
	}
});

it("captures and restores cold rollback state without full hydration", async () => {
	const storage = new MemorySessionStorage();
	const sourceFile = "/sessions/cold-rollback-source.jsonl";
	const targetFile = "/sessions/cold-rollback-target.jsonl";
	const records = [
		{ type: "session", version: 5, id: "cold-rollback", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: { payload: "old" } },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: { payload: "kept" } },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sourceFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	storage.writeTextSync(
		targetFile,
		`${JSON.stringify({ type: "session", version: 5, id: "rollback-target", timestamp: "0", cwd: "/cwd" })}\n`,
	);
	SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1;
	SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
	let manager: SessionManager | undefined;
	try {
		manager = await SessionManager.open(
			sourceFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"auto",
		);
		const rollback = await manager.captureRollbackState();
		expect(rollback.coldRestoreFile).toBe(sourceFile);
		expect(rollback.materializedFileEntries).toEqual([]);
		await manager.setSessionFile(targetFile);
		await manager.restoreRollbackState(rollback);
		expect(manager.getEntry("old")).toMatchObject({ id: "old" });
	} finally {
		SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = undefined;
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
		await manager?.close();
	}
});

it("switches to an oversized-guarded cold target through bounded adoption", async () => {
	const storage = new MemorySessionStorage();
	const targetFile = "/sessions/bounded-switch-target.jsonl";
	const records = [
		{ type: "session", version: 5, id: "bounded-switch", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(targetFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const manager = SessionManager.create("/cwd", SessionManager.explicitDestination("/sessions"), storage);
	SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1;
	SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
	try {
		manager.setSessionMemoryMode("auto");
		await manager.ensureOnDisk();
		await manager.setSessionFile(targetFile);
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
		expect(manager.getEntry("old")).toMatchObject({ id: "old" });
	} finally {
		SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = undefined;
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
		await manager.close();
	}
});

it("continues an oversized-guarded auto session through bounded admission", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/2026-01-01T00-00-00-000Z_bounded-continue.jsonl";
	const records = [
		{ type: "session", version: 5, id: "bounded-continue", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1;
	SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
	let manager: SessionManager | undefined;
	try {
		manager = await SessionManager.continueRecent(
			"/cwd",
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"auto",
		);
		expect(manager.getSessionId()).toBe("bounded-continue");
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
	} finally {
		SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = undefined;
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
		await manager?.close();
	}
});

it("selects the latest exact compaction boundary in one semantic parse pass", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/bounded-first-open-latest-compaction.jsonl";
	const records = [
		{ type: "session", version: 5, id: "latest-compaction", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "a", parentId: null, timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "b", parentId: "a", timestamp: "0", customType: "node", data: {} },
		{ type: "custom", id: "c", parentId: "b", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact-1",
			parentId: "c",
			timestamp: "0",
			summary: "first",
			firstKeptEntryId: "b",
			tokensBefore: 1,
		},
		{ type: "custom", id: "d", parentId: "compact-1", timestamp: "0", customType: "node", data: {} },
		{
			type: "compaction",
			id: "compact-2",
			parentId: "d",
			timestamp: "0",
			summary: "second",
			firstKeptEntryId: "c",
			tokensBefore: 2,
		},
		{ type: "custom", id: "e", parentId: "compact-2", timestamp: "0", customType: "node", data: {} },
	];
	const transcript = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
	storage.writeTextSync(sessionFile, transcript);
	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		const stats = manager.getSessionMemoryStats();
		expect(stats.lazyReopenSucceeded).toBe(true);
		expect(stats.firstOpen.semanticRecordsParsed).toBe(records.length);
		expect(stats.firstOpen.suffixRecordsParsed).toBeGreaterThan(0);
		const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
			base: { baseEndOffset: number };
			retirementFirstKeptEntryId: string;
		};
		expect(marker.retirementFirstKeptEntryId).toBe("c");
		expect(marker.base.baseEndOffset).toBe(transcript.indexOf(`${JSON.stringify(records[3])}\n`));
		expect(manager.getEntry("a")).toMatchObject({ id: "a" });
		expect(manager.getEntry("e")).toMatchObject({ id: "e" });
	} finally {
		await manager.close();
	}
});

it("matches eager replay-metadata sanitation on bounded first open and exact reopen", async () => {
	const missingImageRef = `blob:sha256:${"a".repeat(64)}`;

	const records = [
		{ type: "session", version: 5, id: "replay-sanitize", timestamp: "0", cwd: "/cwd" },
		{
			type: "message",
			id: "assistant",
			parentId: null,
			timestamp: "0",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "reasoning", thinkingSignature: "stale-signature" },
					{ type: "image", data: missingImageRef, mimeType: "image/png" },
				],

				provider: "openai",
				model: "test",
				timestamp: 0,
				providerPayload: { type: "openaiResponsesHistory", provider: "openai", items: [] },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		},
		{
			type: "message",
			id: "user",
			parentId: "assistant",
			timestamp: "0",
			message: { role: "user", content: "continue", timestamp: 1 },
		},
		{
			type: "compaction",
			id: "compact",
			parentId: "user",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "assistant",
			tokensBefore: 10,
		},
	];
	const transcript = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
	const eagerStorage = new MemorySessionStorage();
	const enabledStorage = new MemorySessionStorage();
	eagerStorage.writeTextSync("/eager/session.jsonl", transcript);
	enabledStorage.writeTextSync("/enabled/session.jsonl", transcript);
	const eager = await SessionManager.open(
		"/eager/session.jsonl",
		SessionManager.explicitDestination("/eager"),
		eagerStorage,
		"copy-retain",
		"off",
	);
	const expected = eager.buildSessionContext();
	await eager.close();

	const enabled = await SessionManager.open(
		"/enabled/session.jsonl",
		SessionManager.explicitDestination("/enabled"),
		enabledStorage,
		"copy-retain",
		"enabled",
	);
	expect(enabled.getSessionMemoryStats().coldRetirementActive).toBe(true);
	const coldExportEntries: unknown[] = [];
	enabled.visitEntriesForExport(entry => coldExportEntries.push(entry));
	expect(JSON.stringify(coldExportEntries)).not.toContain("stale-signature");
	expect(JSON.stringify(coldExportEntries)).not.toContain("openaiResponsesHistory");
	expect(JSON.stringify(coldExportEntries)).not.toContain(missingImageRef);
	expect(JSON.stringify(coldExportEntries)).not.toContain("__gjcResidentBlob");
	expect(JSON.stringify(coldExportEntries)).toContain("[Session resident imageData blob missing:");
	expect(enabled.buildSessionContext()).toEqual(expected);
	expect(JSON.stringify(enabled.buildSessionContext())).not.toContain("stale-signature");
	expect(JSON.stringify(enabled.buildSessionContext())).not.toContain("openaiResponsesHistory");
	await enabled.close();

	const reopened = await SessionManager.open(
		"/enabled/session.jsonl",
		SessionManager.explicitDestination("/enabled"),
		enabledStorage,
		"copy-retain",
		"enabled",
	);
	expect(reopened.getSessionMemoryStats().lazyReopenSucceeded).toBe(true);
	enabledStorage.unlinkSync(sidecarPath("/enabled/session.jsonl", "idx"));
	const fallbackEntries = reopened.getEntriesForExport();
	expect(JSON.stringify(fallbackEntries)).not.toContain("stale-signature");
	expect(JSON.stringify(fallbackEntries)).not.toContain("openaiResponsesHistory");
	expect(reopened.buildSessionContext()).toEqual(expected);
	await reopened.close();
});

it("commits cold label clears and appended usage before exact reopen", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/metadata-append.jsonl";
	const records = [
		{ type: "session", version: 5, id: "metadata", timestamp: "0", cwd: "/cwd" },
		{
			type: "message",
			id: "cold",
			parentId: null,
			timestamp: "0",
			message: { role: "user", content: "cold", timestamp: 1 },
		},
		{
			type: "message",
			id: "kept",
			parentId: "cold",
			timestamp: "0",
			message: { role: "user", content: "kept", timestamp: 2 },
		},
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "s",
			firstKeptEntryId: "kept",
			tokensBefore: 2,
		},
		{ type: "label", id: "label", parentId: "compact", timestamp: "0", targetId: "cold", label: "bookmark" },
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(manager.getLabel("cold")).toBe("bookmark");
		manager.appendLabelChange("cold", undefined);
		const assistantId = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			timestamp: 3,
			usage: {
				input: 2,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
			},
		} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
		manager.appendCompaction("checkpoint", undefined, assistantId, 5);
		const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
			labels: Array<[string, string]>;
			usageStatistics: { input: number; output: number; cost: number };
		};
		expect(marker.labels).not.toContainEqual(["cold", "bookmark"]);
		expect(marker.usageStatistics).toMatchObject({ input: 2, output: 3, cost: 5 });
	} finally {
		await manager.close();
	}

	const reopened = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(reopened.getSessionMemoryStats()).toMatchObject({
			lazyReopenSucceeded: true,
			lazyReopenFallbackReason: undefined,
		});
		expect(reopened.getLabel("cold")).toBeUndefined();
		expect(reopened.getUsageStatistics()).toMatchObject({ input: 2, output: 3, cost: 5 });
	} finally {
		await reopened.close();
	}
});

it("fails closed to eager on a branched transcript during enabled first open", async () => {
	class CountingStorage extends MemorySessionStorage {
		textReads = 0;
		override readText(filePath: string) {
			this.textReads++;
			return super.readText(filePath);
		}
	}
	const storage = new CountingStorage();
	const sessionFile = "/sessions/branched-first-open.jsonl";
	const now = "0";
	const records = [
		{ type: "session", version: 5, id: "branched", timestamp: now, cwd: "/cwd" },
		{ type: "custom", id: "root", parentId: null, timestamp: now, customType: "x" },
		{ type: "custom", id: "kept", parentId: "root", timestamp: now, customType: "x" },
		{
			type: "compaction",
			id: "compaction",
			parentId: "kept",
			timestamp: now,
			summary: "s",
			firstKeptEntryId: "kept",
			tokensBefore: 10,
		},
		// The branch jumps back to "root" instead of the adjacent "compaction":
		// the strictly linear parent chain is violated, so the bounded path fails
		// closed and the eager authoritative path loads everything.
		{ type: "custom", id: "branch", parentId: "root", timestamp: now, customType: "x" },
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(storage.textReads).toBeGreaterThan(0);
		expect(manager.getSessionMemoryStats()).toMatchObject({
			lazyReopenAttempted: true,
			lazyReopenSucceeded: false,
			lazyReopenFallbackReason: "bounded_scan_branch",
		});
		expect(manager.getEntry("root")).toMatchObject({ id: "root", type: "custom" });
		expect(manager.getEntry("branch")).toMatchObject({ id: "branch", type: "custom" });
		expect(storage.listFilesSync("/sessions", "*.spill.*")).toEqual([]);
	} finally {
		await manager.close();
	}
});
it("rebuilds bounded state for transcript-ahead and tail-ahead reopen states", async () => {
	class CountingStorage extends MemorySessionStorage {
		textReads = 0;
		override readText(filePath: string) {
			this.textReads++;
			return super.readText(filePath);
		}
	}
	const buildFixture = async (name: string) => {
		const storage = new CountingStorage();
		const sessionFile = `/sessions/${name}.jsonl`;
		const records = [
			{ type: "session", version: 5, id: name, timestamp: "0", cwd: "/cwd" },
			{ type: "custom", id: `${name}-old`, parentId: null, timestamp: "0", customType: "x" },
			{ type: "custom", id: `${name}-kept`, parentId: `${name}-old`, timestamp: "0", customType: "x" },
			{
				type: "compaction",
				id: `${name}-compaction`,
				parentId: `${name}-kept`,
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: `${name}-kept`,
				tokensBefore: 10,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const initial = await SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage);
		initial.setSessionMemoryMode("enabled");
		await initial.close();
		return { storage, sessionFile };
	};

	const transcriptAhead = await buildFixture("transcript-ahead");
	transcriptAhead.storage.writeTextSync(
		transcriptAhead.sessionFile,
		`${transcriptAhead.storage.readTextSync(transcriptAhead.sessionFile)}${JSON.stringify({ type: "custom", id: "new-tail", parentId: "transcript-ahead-compaction", timestamp: "0", customType: "x" })}\n`,
	);
	transcriptAhead.storage.textReads = 0;
	const transcriptFallback = await SessionManager.open(
		transcriptAhead.sessionFile,
		SessionManager.explicitDestination("/sessions"),
		transcriptAhead.storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(transcriptAhead.storage.textReads).toBe(0);
		expect(transcriptFallback.getEntry("new-tail")).toMatchObject({ id: "new-tail" });
		expect(transcriptFallback.getSessionMemoryStats().autoDisabledReason).toBeUndefined();
	} finally {
		await transcriptFallback.close();
	}

	const tailAhead = await buildFixture("tail-ahead");
	const tailPath = sidecarPath(tailAhead.sessionFile, "tail");
	tailAhead.storage.writeTextSync(tailPath, `${tailAhead.storage.readTextSync(tailPath)}{}\n`);
	tailAhead.storage.textReads = 0;
	const tailFallback = await SessionManager.open(
		tailAhead.sessionFile,
		SessionManager.explicitDestination("/sessions"),
		tailAhead.storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(tailAhead.storage.textReads).toBe(0);
		expect(tailFallback.buildSessionContext().messages).toHaveLength(1);
		expect(tailFallback.getSessionMemoryStats().autoDisabledReason).toBeUndefined();
	} finally {
		await tailFallback.close();
	}
});
describe("session memory mode across file transitions", () => {
	it("reapplies enabled retirement and keeps off transitions sidecar-free", async () => {
		const storage = new MemorySessionStorage();
		const writeCompacted = (sessionFile: string, sessionId: string): void => {
			const records = [
				{ type: "session", version: 5, id: sessionId, timestamp: "0", cwd: "/cwd" },
				{ type: "custom", id: `${sessionId}-root`, parentId: null, timestamp: "0", customType: "x" },
				{ type: "custom", id: `${sessionId}-kept`, parentId: `${sessionId}-root`, timestamp: "0", customType: "x" },
				{
					type: "compaction",
					id: `${sessionId}-compaction`,
					parentId: `${sessionId}-kept`,
					timestamp: "0",
					summary: "summary",
					firstKeptEntryId: `${sessionId}-kept`,
					tokensBefore: 10,
				},
			];
			storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		};
		writeCompacted("/sessions/first.jsonl", "first");
		writeCompacted("/sessions/second.jsonl", "second");
		writeCompacted("/sessions/third.jsonl", "third");
		const manager = await SessionManager.open(
			"/sessions/first.jsonl",
			SessionManager.explicitDestination("/sessions"),
			storage,
		);
		try {
			manager.setSessionMemoryMode("enabled");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
			await manager.setSessionFile("/sessions/second.jsonl");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
			expect(manager.getEntry("second-root")).toMatchObject({ id: "second-root" });

			manager.setSessionMemoryMode("off");
			await manager.setSessionFile("/sessions/third.jsonl");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
			expect(storage.listFilesSync("/sessions", "*.spill.*")).toEqual([]);
		} finally {
			await manager.close();
		}
	});
});
it("stages and promotes default model selection without hydrating retired history", async () => {
	const storage = new MemorySessionStorage();
	const sessionFile = "/sessions/bounded-default-selection.jsonl";
	const records = [
		{ type: "session", version: 5, id: "bounded-selection", timestamp: "0", cwd: "/cwd" },
		{
			type: "message",
			id: "cold-old",
			parentId: null,
			timestamp: "0",
			message: { role: "user", content: "x".repeat(100_000), timestamp: 1 },
		},
		{
			type: "message",
			id: "kept",
			parentId: "cold-old",
			timestamp: "0",
			message: { role: "user", content: "kept", timestamp: 2 },
		},
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 10,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		const retainedBefore = manager.hotRetainedMessageCharsForTests();
		const stage = await manager.stageDefaultModelSelection("provider/model", "high", { appendThinkingLevel: true });
		expect(stage.boundedCold).toBe(true);
		expect(manager.hotRetainedMessageCharsForTests()).toBe(retainedBefore);
		expect(manager.promoteDefaultModelSelection(stage)).toEqual({ kind: "promoted" });
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
		expect(manager.getLastModelChangeRole()).toBe("default");
		expect(manager.getEntry("cold-old")).toMatchObject({ id: "cold-old" });
		const staleStage = await manager.stageDefaultModelSelection("provider/other", "low", {
			appendThinkingLevel: true,
		});
		const tailPath = sidecarPath(sessionFile, "tail");
		const tailText = storage.readTextSync(tailPath);
		storage.writeTextSync(tailPath, `${tailText}{}\n`);
		expect(manager.promoteDefaultModelSelection(staleStage)).toEqual({ kind: "not_promoted" });
		storage.writeTextSync(tailPath, tailText);
		await manager.discardDefaultModelSelectionStage(staleStage);
	} finally {
		await manager.close();
	}
	const reopened = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(reopened.getSessionMemoryStats()).toMatchObject({
			coldRetirementActive: true,
			lazyReopenSucceeded: true,
		});
		expect(reopened.getLastModelChangeRole()).toBe("default");
	} finally {
		await reopened.close();
	}
});

it("recovers eagerly when staged selection publication outlives marker publication", async () => {
	class MarkerFailureStorage extends MemorySessionStorage {
		failMarkers = false;
		markerFailures = 0;
		override replaceExactSync(
			sourcePath: string,
			destinationPath: string,
			expected: Parameters<MemorySessionStorage["replaceExactSync"]>[2],
		): boolean {
			const replaced = super.replaceExactSync(sourcePath, destinationPath, expected);
			if (replaced) this.failMarkers = true;
			return replaced;
		}
		override writeTextSync(filePath: string, content: string): void {
			if (this.failMarkers && filePath.endsWith(".spill.commit")) {
				this.markerFailures++;
				throw new Error("injected_marker_failure");
			}
			super.writeTextSync(filePath, content);
		}
	}
	const storage = new MarkerFailureStorage();
	const sessionFile = "/sessions/selection-marker-failure.jsonl";
	const records = [
		{ type: "session", version: 5, id: "selection-marker-failure", timestamp: "0", cwd: "/cwd" },
		{ type: "custom", id: "cold", parentId: null, timestamp: "0", customType: "x", data: {} },
		{ type: "custom", id: "kept", parentId: "cold", timestamp: "0", customType: "x", data: {} },
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "0",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 10,
		},
	];
	storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	const manager = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	const stage = await manager.stageDefaultModelSelection("provider/model", "high", { appendThinkingLevel: true });
	const promotion = manager.promoteDefaultModelSelection(stage);
	storage.failMarkers = false;
	expect(promotion).toEqual({ kind: "promoted" });
	expect(manager.getLastModelChangeRole()).toBe("default");
	expect(storage.markerFailures).toBeGreaterThan(0);
	await manager.close();
	const reopened = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(reopened.getLastModelChangeRole()).toBe("default");
		expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
	} finally {
		await reopened.close();
	}
	const verified = await SessionManager.open(
		sessionFile,
		SessionManager.explicitDestination("/sessions"),
		storage,
		"copy-retain",
		"enabled",
	);
	try {
		expect(verified.getSessionMemoryStats()).toMatchObject({
			lazyReopenSucceeded: true,
			currentCommitTransition: { kind: "exact", reason: "descriptor_and_proof_match" },
		});
		expect(verified.getLastModelChangeRole()).toBe("default");
	} finally {
		await verified.close();
	}
});

describe("malformed transcript sidecar fallback", () => {
	it("keeps malformed known records eager", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/malformed-compaction.jsonl";
		const records = [
			{ type: "session", version: 5, id: "malformed", timestamp: "0", cwd: "/cwd" },
			{
				type: "message",
				id: "old",
				parentId: null,
				timestamp: "0",
				message: { role: "user", content: "old", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "compact",
				parentId: "old",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "old",
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(manager.getSessionMemoryStats()).toMatchObject({
				coldRetirementActive: false,
				sidecarIneligible: true,
				lazyReopenSucceeded: false,
			});
			expect(manager.getEntry("old")).toMatchObject({ id: "old" });
		} finally {
			await manager.close();
		}
	});
});

describe("patch-bearing transcript fallback", () => {
	it("keeps patch-bearing transcripts eager so raw offsets cannot drift", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/patched.jsonl";
		const records = [
			{ type: "session", version: 5, id: "patched", timestamp: "0", cwd: "/cwd" },
			{
				type: "message",
				id: "m0",
				parentId: null,
				timestamp: "0",
				message: { role: "user", content: "original", timestamp: 0 },
			},
			{
				type: "entry_patch",
				entryId: "m0",
				patch: { message: { role: "user", content: "updated", timestamp: 0 } },
			},
			{
				type: "message",
				id: "m1",
				parentId: "m0",
				timestamp: "0",
				message: { role: "user", content: "kept", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "m1",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "m1",
				tokensBefore: 10,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage);
		try {
			manager.setSessionMemoryMode("enabled");
			expect(manager.getSessionMemoryStats()).toMatchObject({
				coldRetirementActive: false,
				sidecarIneligible: true,
			});
			expect(manager.getEntry("m0")).toMatchObject({ message: { content: "updated" } });
		} finally {
			await manager.close();
		}
	});
});

describe("model-change reducer parity", () => {
	const cases = [
		{ name: "reviewer-only", roles: ["reviewer"], legacy: false, expected: "reviewer" },
		{ name: "temporary-only", roles: ["temporary"], legacy: false, expected: "temporary" },
		{ name: "interleaved-nearest", roles: ["reviewer", "temporary"], legacy: false, expected: "temporary" },
		{ name: "absent", roles: [], legacy: false, expected: undefined },
		{ name: "legacy-only", roles: [], legacy: true, expected: undefined },
		{ name: "explicit-default", roles: [undefined], legacy: true, expected: "default" },
	] as const;

	for (const parityCase of cases) {
		it(`matches eager role semantics for ${parityCase.name}`, async () => {
			const storage = new MemorySessionStorage();
			const sessionFile = `/sessions/role-${parityCase.name}.jsonl`;
			const entries: Array<Record<string, unknown>> = [
				{ type: "session", version: 5, id: `role-${parityCase.name}`, timestamp: "0", cwd: "/cwd" },
				{
					type: "message",
					id: "root",
					parentId: null,
					timestamp: "0",
					message: { role: "user", content: "root", timestamp: 1 },
				},
			];
			let parentId = "root";
			for (const [index, role] of parityCase.roles.entries()) {
				const id = `model-${index}`;
				entries.push({
					type: "model_change",
					id,
					parentId,
					timestamp: "0",
					provider: "openai",
					modelId: `model-${index}`,
					...(role === undefined ? {} : { role }),
				});
				parentId = id;
			}
			if (parityCase.legacy) {
				entries.push({
					type: "message",
					id: "legacy-assistant",
					parentId,
					timestamp: "0",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "legacy" }],
						api: "openai-responses",
						provider: "openai",
						model: "legacy-model",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
				});
				parentId = "legacy-assistant";
			}
			entries.push(
				{
					type: "message",
					id: "kept",
					parentId,
					timestamp: "0",
					message: { role: "user", content: "kept", timestamp: 3 },
				},
				{
					type: "compaction",
					id: "compact",
					parentId: "kept",
					timestamp: "0",
					summary: "summary",
					firstKeptEntryId: "kept",
					tokensBefore: 3,
				},
			);
			storage.writeTextSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
			const eager = await SessionManager.open(
				sessionFile,
				SessionManager.explicitDestination("/sessions"),
				storage,
				"copy-retain",
				"off",
			);
			const eagerRole = eager.getLastModelChangeRole();
			await eager.close();
			expect(eagerRole).toBe(parityCase.expected);
			const retired = await SessionManager.open(
				sessionFile,
				SessionManager.explicitDestination("/sessions"),
				storage,
				"copy-retain",
				"enabled",
			);
			try {
				expect(retired.getSessionMemoryStats().coldRetirementActive).toBe(true);
				expect(retired.getLastModelChangeRole()).toBe(eagerRole);
			} finally {
				await retired.close();
			}
			const reopened = await SessionManager.open(
				sessionFile,
				SessionManager.explicitDestination("/sessions"),
				storage,
				"copy-retain",
				"enabled",
			);
			try {
				expect(reopened.getSessionMemoryStats().lazyReopenSucceeded).toBe(true);
				expect(reopened.getLastModelChangeRole()).toBe(eagerRole);
			} finally {
				await reopened.close();
			}
		});
	}
});
describe("branch-heavy retirement", () => {
	beforeEach(() => {
		SessionManagerTestHooks.secondaryArtifactMode = "enabled";
	});
	afterEach(() => {
		SessionManagerTestHooks.secondaryArtifactMode = undefined;
	});
	it("retires inactive branches appended after the active compaction boundary", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/branch-heavy.jsonl";
		const now = "0";
		const inactive = Array.from({ length: 20_000 }, (_, index) => ({
			type: "message",
			id: `inactive-${index.toString().padStart(5, "0")}`,
			parentId: "root",
			timestamp: now,
			message: { role: "user", content: `inactive-${index}-${"x".repeat(1024)}`, timestamp: index + 2 },
		}));
		const records = [
			{ type: "session", version: 5, id: "branch-heavy", timestamp: now, cwd: "/cwd" },
			{
				type: "message",
				id: "root",
				parentId: null,
				timestamp: now,
				message: { role: "user", content: "root", timestamp: 0 },
			},
			{
				type: "message",
				id: "active-kept",
				parentId: "root",
				timestamp: now,
				message: { role: "user", content: "active-kept", timestamp: 1 },
			},
			...inactive,
			{
				type: "message",
				id: "active-tail",
				parentId: "active-kept",
				timestamp: now,
				message: { role: "user", content: "active-tail", timestamp: 30_000 },
			},
			{
				type: "compaction",
				id: "active-compaction",
				parentId: "active-tail",
				timestamp: now,
				summary: "summary",
				firstKeptEntryId: "active-kept",
				tokensBefore: 10_000,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(manager.getSessionMemoryStats()).toMatchObject({
				coldRetirementActive: true,
				retirementFallbackReason: undefined,
				currentCommitTransition: { kind: "exact" },
			});
			expect(manager.hotRetainedMessageCharsForTests()).toBeLessThan(1024);
			expect(manager.getEntry("inactive-19999")).toMatchObject({ id: "inactive-19999" });
			expect(manager.getBranch().map(entry => entry.id)).toEqual([
				"root",
				"active-kept",
				"active-tail",
				"active-compaction",
			]);
			manager.branch("inactive-19999");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
			expect(manager.getBranch().map(entry => entry.id)).toEqual(["root", "inactive-19999"]);
			manager.appendCompaction("inactive summary", undefined, "inactive-19999", 20_000);
			expect(manager.getSessionMemoryStats()).toMatchObject({
				coldRetirementActive: true,
				retirementFallbackReason: undefined,
			});
		} finally {
			await manager.close();
		}
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getSessionMemoryStats()).toMatchObject({
				coldRetirementActive: true,
				lazyReopenSucceeded: true,
				currentCommitTransition: { kind: "exact" },
			});
			expect(reopened.getEntry("inactive-19999")).toMatchObject({ id: "inactive-19999" });
		} finally {
			await reopened.close();
		}
	}, 30_000);

	it("activates a compacted cold branch without hydrating inactive history", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/bounded-branch-activation.jsonl";
		const records = [
			{ type: "session", version: 5, id: "bounded-branch", timestamp: "0", cwd: "/cwd" },
			{
				type: "message",
				id: "root",
				parentId: null,
				timestamp: "0",
				message: { role: "user", content: "root", timestamp: 0 },
			},
			{
				type: "message",
				id: "a-kept",
				parentId: "root",
				timestamp: "0",
				message: { role: "user", content: "a-kept", timestamp: 1 },
			},
			{
				type: "model_change",
				id: "a-model",
				parentId: "a-kept",
				timestamp: "0",
				provider: "p",
				modelId: "m",
				role: "reviewer",
			},
			{
				type: "message",
				id: "a-tail",
				parentId: "a-model",
				timestamp: "0",
				message: { role: "user", content: "a-tail", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "a-compact",
				parentId: "a-tail",
				timestamp: "0",
				summary: "a summary",
				firstKeptEntryId: "a-kept",
				tokensBefore: 100,
			},
			...Array.from({ length: 5_000 }, (_, index) => ({
				type: "message",
				id: `abandoned-${index}`,
				parentId: "root",
				timestamp: "0",
				message: { role: "user", content: `abandoned-${index}-${"x".repeat(512)}`, timestamp: index + 3 },
			})),
			{
				type: "message",
				id: "b-kept",
				parentId: "root",
				timestamp: "0",
				message: { role: "user", content: "b-kept", timestamp: 9_000 },
			},
			{
				type: "message",
				id: "b-tail",
				parentId: "b-kept",
				timestamp: "0",
				message: { role: "user", content: "b-tail", timestamp: 9_001 },
			},
			{
				type: "compaction",
				id: "b-compact",
				parentId: "b-tail",
				timestamp: "0",
				summary: "b summary",
				firstKeptEntryId: "b-kept",
				tokensBefore: 200,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			const commitPath = sidecarPath(sessionFile, "commit");
			const commitBefore = storage.readTextSync(commitPath);
			expect(manager.hotRetainedMessageCharsForTests()).toBeLessThan(1024);
			manager.branch("a-compact");
			expect(manager.getSessionMemoryStats()).toMatchObject({
				coldRetirementActive: true,
				currentCommitTransition: { kind: "rebuild", reason: "branch_activation_unpublished" },
			});
			expect(manager.hotRetainedMessageCharsForTests()).toBeLessThan(1024);
			expect(manager.getBranch().map(entry => entry.id)).toEqual([
				"root",
				"a-kept",
				"a-model",
				"a-tail",
				"a-compact",
			]);
			expect(manager.getLastModelChangeRole()).toBe("reviewer");
			expect(storage.readTextSync(commitPath)).toBe(commitBefore);
			manager.appendMessage({ role: "user", content: "persisted after activation", timestamp: 10_000 });
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
			expect(manager.hotRetainedMessageCharsForTests()).toBeGreaterThan(2_500_000);
		} finally {
			await manager.close();
		}
	}, 20_000);

	it("aborts ordinal prefetch before allocating a sparse interval beyond the fixed cap", async () => {
		class IndexReadCountingStorage extends MemorySessionStorage {
			indexReads = 0;
			override readRangeSync(filePath: string, offset: number, length: number) {
				if (filePath.endsWith(".spill.idx")) this.indexReads++;
				return super.readRangeSync(filePath, offset, length);
			}
		}
		const storage = new IndexReadCountingStorage();
		const sessionFile = "/sessions/sparse-branch-prefetch-cap.jsonl";
		const records = [
			{ type: "session", version: 5, id: "sparse-branch", timestamp: "0", cwd: "/cwd" },
			{ type: "custom", id: "root", parentId: null, timestamp: "0", customType: "node", data: {} },
			{ type: "custom", id: "branch-kept", parentId: "root", timestamp: "0", customType: "node", data: {} },
			...Array.from({ length: 20_000 }, (_, index) => ({
				type: "custom",
				id: `interleaved-${index}`,
				parentId: "root",
				timestamp: "0",
				customType: "node",
				data: {},
			})),
			{
				type: "compaction",
				id: "branch-compact",
				parentId: "branch-kept",
				timestamp: "0",
				summary: "branch summary",
				firstKeptEntryId: "branch-kept",
				tokensBefore: 1,
			},
			{ type: "custom", id: "active", parentId: "root", timestamp: "0", customType: "node", data: {} },
			{
				type: "compaction",
				id: "active-compact",
				parentId: "active",
				timestamp: "0",
				summary: "active summary",
				firstKeptEntryId: "active",
				tokensBefore: 1,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			const indexReadsBefore = storage.indexReads;
			manager.branch("branch-compact");
			// One digest-validation scan is allowed; a second ordinal-prefetch scan would
			// exceed this bound, proving the interval cap returns before Map allocation.
			expect(storage.indexReads - indexReadsBefore).toBeLessThanOrEqual(70);
			expect(manager.getBranch().map(entry => entry.id)).toEqual(["root", "branch-kept", "branch-compact"]);
			expect(manager.getSessionMemoryStats().totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		} finally {
			await manager.close();
		}
	}, 30_000);

	it("falls back eagerly when an authenticated legacy index lacks branch metadata", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/legacy-branch-index.jsonl";
		const records = [
			{ type: "session", version: 5, id: "legacy-branch", timestamp: "0", cwd: "/cwd" },
			{
				type: "message",
				id: "root",
				parentId: null,
				timestamp: "0",
				message: { role: "user", content: "root", timestamp: 0 },
			},
			{
				type: "message",
				id: "a-kept",
				parentId: "root",
				timestamp: "0",
				message: { role: "user", content: "a", timestamp: 1 },
			},
			{
				type: "message",
				id: "a-tail",
				parentId: "a-kept",
				timestamp: "0",
				message: { role: "user", content: "a-tail", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "a-compact",
				parentId: "a-tail",
				timestamp: "0",
				summary: "a",
				firstKeptEntryId: "a-kept",
				tokensBefore: 10,
			},
			{
				type: "message",
				id: "b-kept",
				parentId: "root",
				timestamp: "0",
				message: { role: "user", content: "b", timestamp: 3 },
			},
			{
				type: "message",
				id: "b-tail",
				parentId: "b-kept",
				timestamp: "0",
				message: { role: "user", content: "b-tail", timestamp: 4 },
			},
			{
				type: "compaction",
				id: "b-compact",
				parentId: "b-tail",
				timestamp: "0",
				summary: "b",
				firstKeptEntryId: "b-kept",
				tokensBefore: 20,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const destination = SessionManager.explicitDestination("/sessions");
		const built = await SessionManager.open(sessionFile, destination, storage, "copy-retain", "enabled");
		await built.close();
		const indexPath = sidecarPath(sessionFile, "idx");
		const legacyIndex = `${storage
			.readTextSync(indexPath)
			.trimEnd()
			.split("\n")
			.map(line => {
				const record = JSON.parse(line) as Record<string, unknown>;
				delete record.parentId;
				delete record.entryType;
				return JSON.stringify(record);
			})
			.join("\n")}\n`;
		storage.writeTextSync(indexPath, legacyIndex);
		const commitPath = sidecarPath(sessionFile, "commit");
		const commit = JSON.parse(storage.readTextSync(commitPath)) as Record<string, unknown>;
		commit.indexDigest = createHash("sha256").update(legacyIndex).digest("hex");
		storage.writeTextSync(commitPath, `${JSON.stringify(commit)}\n`);

		const reopened = await SessionManager.open(sessionFile, destination, storage, "copy-retain", "enabled");
		try {
			expect(reopened.getSessionMemoryStats().lazyReopenSucceeded).toBe(false);
			reopened.branch("a-compact");
			expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
			expect(reopened.getBranch().map(entry => entry.id)).toEqual(["root", "a-kept", "a-tail", "a-compact"]);
		} finally {
			await reopened.close();
		}
	});
});
describe("session memory mode scope", () => {
	it("keeps nonpersistent sessions fully eager when enabled mode is requested", () => {
		const manager = SessionManager.inMemory("/cwd");
		manager.setSessionMemoryMode("enabled");
		const first = manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
		manager.appendCompaction("summary", undefined, first, 1);
		expect(manager.getSessionMemoryStats()).toMatchObject({
			sidecarEnabled: false,
			coldRetirementActive: false,
		});
		expect(manager.getEntries()).toHaveLength(2);
	});
});
describe("whole-session persistence freshness", () => {
	it("reprepares a rewrite when a direct append lands during async preparation", async () => {
		class RewriteRaceStorage extends MemorySessionStorage {
			blockNextFlush = false;
			readonly flushStarted = Promise.withResolvers<void>();
			readonly releaseFlush = Promise.withResolvers<void>();
			override openWriter(filePath: string, options?: { flags?: "w" | "a" }): SessionStorageWriter {
				const writer = super.openWriter(filePath, options);
				if (filePath.includes(".spill.")) return writer;
				return {
					writeLine: writer.writeLine.bind(writer),
					writeLineSync: writer.writeLineSync.bind(writer),
					flush: async () => {
						if (this.blockNextFlush) {
							this.blockNextFlush = false;
							this.flushStarted.resolve();
							await this.releaseFlush.promise;
						}
						await writer.flush();
					},
					fsync: writer.fsync.bind(writer),
					fsyncSync: writer.fsyncSync?.bind(writer),
					statSync: writer.statSync?.bind(writer),
					close: writer.close.bind(writer),
					closeSync: writer.closeSync.bind(writer),
					getError: writer.getError.bind(writer),
					getCloseState: writer.getCloseState.bind(writer),
					getCloseError: writer.getCloseError.bind(writer),
				};
			}
		}
		const storage = new RewriteRaceStorage();
		const sessionFile = "/sessions/rewrite-race.jsonl";
		storage.writeTextSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 5, id: "rewrite-race", timestamp: "0", cwd: "/cwd" })}\n`,
		);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"off",
		);
		try {
			manager.appendCustomEntry("before", { value: 1 });
			storage.blockNextFlush = true;
			const rewrite = manager.rewriteEntries();
			await storage.flushStarted.promise;
			const duringId = manager.appendCustomEntry("during", { value: 2 });
			storage.releaseFlush.resolve();
			await rewrite;
			const persisted = storage
				.readTextSync(sessionFile)
				.trimEnd()
				.split("\n")
				.map(line => JSON.parse(line) as { id?: string });
			expect(persisted.filter(entry => entry.id === duringId)).toHaveLength(1);
			expect(manager.getEntry(duringId)).toMatchObject({ id: duringId });
		} finally {
			storage.releaseFlush.resolve();
			await manager.close();
		}
	});
	it("aborts a prepared rewrite when the manager adopts another lifecycle", async () => {
		class LifecycleRaceStorage extends MemorySessionStorage {
			blockNextFlush = false;
			readonly flushStarted = Promise.withResolvers<void>();
			readonly releaseFlush = Promise.withResolvers<void>();
			override openWriter(filePath: string, options?: { flags?: "w" | "a" }): SessionStorageWriter {
				const writer = super.openWriter(filePath, options);
				if (filePath.includes(".spill.")) return writer;
				return {
					writeLine: writer.writeLine.bind(writer),
					writeLineSync: writer.writeLineSync.bind(writer),
					flush: async () => {
						if (this.blockNextFlush) {
							this.blockNextFlush = false;
							this.flushStarted.resolve();
							await this.releaseFlush.promise;
						}
						await writer.flush();
					},
					fsync: writer.fsync.bind(writer),
					fsyncSync: writer.fsyncSync?.bind(writer),
					statSync: writer.statSync?.bind(writer),
					close: writer.close.bind(writer),
					closeSync: writer.closeSync.bind(writer),
					getError: writer.getError.bind(writer),
					getCloseState: writer.getCloseState.bind(writer),
					getCloseError: writer.getCloseError.bind(writer),
				};
			}
		}
		const storage = new LifecycleRaceStorage();
		const sourceFile = "/sessions/rewrite-lifecycle-source.jsonl";
		const destinationFile = "/sessions/rewrite-lifecycle-destination.jsonl";
		storage.writeTextSync(
			sourceFile,
			`${JSON.stringify({ type: "session", version: 5, id: "rewrite-source", timestamp: "0", cwd: "/cwd" })}\n`,
		);
		storage.writeTextSync(
			destinationFile,
			`${JSON.stringify({ type: "session", version: 5, id: "rewrite-destination", timestamp: "0", cwd: "/cwd" })}\n`,
		);
		const destinationManager = await SessionManager.open(
			destinationFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"off",
		);
		const destinationSnapshot = destinationManager.captureState();
		await destinationManager.close();
		const manager = await SessionManager.open(
			sourceFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"off",
		);
		try {
			const sourceEntryId = manager.appendCustomEntry("before-lifecycle-switch", { value: 1 });
			await manager.flush();
			const sourceBeforeRewrite = storage.readTextSync(sourceFile);
			storage.blockNextFlush = true;
			const rewrite = manager.rewriteEntries();
			await storage.flushStarted.promise;
			manager.restoreState(destinationSnapshot);
			storage.releaseFlush.resolve();
			await expect(rewrite).rejects.toThrow("session_persistence_lifecycle_changed");
			expect(storage.readTextSync(sourceFile)).toBe(sourceBeforeRewrite);
			expect(storage.readTextSync(destinationFile)).not.toContain(sourceEntryId);
			expect(manager.getSessionId()).toBe("rewrite-destination");
			expect(manager.getEntry(sourceEntryId)).toBeUndefined();
		} finally {
			storage.releaseFlush.resolve();
			await expect(manager.close()).rejects.toThrow("session_persistence_lifecycle_changed");
		}
	});
	it("reprepares queued patches when a direct append invalidates their persistence token", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/patch-race.jsonl";
		storage.writeTextSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 5, id: "patch-race", timestamp: "0", cwd: "/cwd" })}\n`,
		);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"off",
		);
		let hookCalls = 0;
		let appendedId: string | undefined;
		try {
			SessionManagerTestHooks.beforePersistPatchFence = attempt => {
				hookCalls++;
				if (attempt === 0) appendedId = manager.appendCustomEntry("during-patch-prepare", { value: 1 });
			};
			expect(await manager.setSessionName("race-safe", "user")).toBe(true);
			const persisted = storage
				.readTextSync(sessionFile)
				.trimEnd()
				.split("\n")
				.map(line => JSON.parse(line) as { type: string; id?: string; patch?: { title?: string } });
			expect(hookCalls).toBe(2);
			expect(persisted.filter(entry => entry.id === appendedId)).toHaveLength(1);
			expect(
				persisted.filter(entry => entry.type === "header_patch" && entry.patch?.title === "race-safe"),
			).toHaveLength(1);
		} finally {
			SessionManagerTestHooks.beforePersistPatchFence = undefined;
			await manager.close();
		}
	});
});
describe("sidecar I/O fallback", () => {
	beforeEach(() => {
		SessionManagerTestHooks.secondaryArtifactMode = "enabled";
	});
	afterEach(() => {
		SessionManagerTestHooks.secondaryArtifactMode = undefined;
	});
	it("preserves eager authoritative state when disposable sidecar creation fails", async () => {
		const sessionFile = "/sessions/sidecar-failure.jsonl";
		const now = "0";
		const entries = [
			{ type: "session", version: 5, id: "failure-session", timestamp: now, cwd: "/cwd" },
			...Array.from({ length: 4 }, (_, index) => ({
				type: "message",
				id: `cold-${index.toString().padStart(4, "0")}`,
				parentId: index === 0 ? null : `cold-${(index - 1).toString().padStart(4, "0")}`,
				timestamp: now,
				message: { role: "user", content: `cold-${index}`, timestamp: index },
			})),
			{
				type: "compaction",
				id: "failure-compaction",
				parentId: "cold-0003",
				timestamp: now,
				summary: "summary",
				firstKeptEntryId: "cold-0003",
				tokensBefore: 10,
			},
		];
		const storage = new (class extends MemorySessionStorage {
			override openWriter(filePath: string, options?: { flags?: "w" | "a" }) {
				if (filePath.includes(".spill.")) throw new Error("injected_sidecar_failure");
				return super.openWriter(filePath, options);
			}
		})();
		storage.writeTextSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const manager = await SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage);
		try {
			manager.setSessionMemoryMode("enabled");
			expect(manager.getSessionMemoryStats()).toMatchObject({
				coldRetirementActive: false,
				sidecarIneligible: true,
				autoDisabledReason: "sidecar_build_failures",
				consecutiveBuildFailures: 2,
			});
			expect(manager.getEntries()).toHaveLength(5);
			expect(manager.getEntry("cold-0000")).toMatchObject({ id: "cold-0000" });
			manager.setSessionMemoryMode("off");
			expect(manager.getSessionMemoryStats()).toMatchObject({
				autoDisabledReason: undefined,
				consecutiveBuildFailures: 0,
			});
		} finally {
			await manager.close();
		}
	});

	it("publishes append markers from the post-fsync writer descriptor without pathname stat", async () => {
		const tempDir = TempDir.createSync("@pi-writer-descriptor-");
		const storage = new FileSessionStorage();
		const sessionFile = path.join(tempDir.path(), "writer-descriptor.jsonl");
		const records = [
			{ type: "session", version: 5, id: "writer-descriptor", timestamp: "0", cwd: "/cwd" },
			{
				type: "message",
				id: "cold",
				parentId: null,
				timestamp: "0",
				message: { role: "user", content: "cold", timestamp: 1 },
			},
			{
				type: "message",
				id: "kept",
				parentId: "cold",
				timestamp: "0",
				message: { role: "user", content: "kept", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "compact",
				parentId: "kept",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 10,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination(tempDir.path()),
			storage,
		);
		manager.setSessionMemoryMode("enabled");
		const realStat = storage.statSync.bind(storage);
		const statSpy = vi.spyOn(storage, "statSync").mockImplementation(filePath => {
			if (filePath === sessionFile) throw new Error("pathname transcript stat forbidden");
			return realStat(filePath);
		});
		try {
			manager.appendMessage({ role: "user", content: "after", timestamp: 3 });
			expect(manager.getSessionMemoryStats()).toMatchObject({
				coldRetirementActive: true,
				currentCommitTransition: { kind: "exact", reason: "descriptor_and_proof_match" },
			});
			expect(statSpy.mock.calls.some(([filePath]) => filePath === sessionFile)).toBe(false);
		} finally {
			statSpy.mockRestore();
			await manager.close();
			tempDir.removeSync();
		}
	});

	it("recovers from tail fsync followed by append marker publication failure", async () => {
		class AppendMarkerFailureStorage extends MemorySessionStorage {
			failMarkers = false;
			markerFailures = 0;
			override writeTextSync(filePath: string, content: string): void {
				if (this.failMarkers && filePath.endsWith(".spill.commit")) {
					this.markerFailures++;
					throw new Error("injected_append_marker_failure");
				}
				super.writeTextSync(filePath, content);
			}
		}
		const storage = new AppendMarkerFailureStorage();
		const sessionFile = "/sessions/append-marker-failure.jsonl";
		const records = [
			{ type: "session", version: 5, id: "append-marker-failure", timestamp: "0", cwd: "/cwd" },
			{
				type: "message",
				id: "cold",
				parentId: null,
				timestamp: "0",
				message: { role: "user", content: "cold", timestamp: 1 },
			},
			{
				type: "message",
				id: "kept",
				parentId: "cold",
				timestamp: "0",
				message: { role: "user", content: "kept", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "compact",
				parentId: "kept",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 10,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const destination = SessionManager.explicitDestination("/sessions");
		const manager = await SessionManager.open(sessionFile, destination, storage, "copy-retain", "enabled");
		storage.failMarkers = true;
		const appendedId = manager.appendMessage({ role: "user", content: "after-tail-fsync", timestamp: 3 });
		storage.failMarkers = false;
		expect(storage.markerFailures).toBeGreaterThan(0);
		expect(manager.getSessionMemoryStats()).toMatchObject({
			coldRetirementActive: true,
			currentCommitTransition: { kind: "rebuild", reason: "commit_marker_publication_failed" },
		});
		expect(manager.getEntry(appendedId)).toMatchObject({ id: appendedId });
		await manager.close();
		const repaired = await SessionManager.open(sessionFile, destination, storage, "copy-retain", "enabled");
		expect(repaired.getEntry(appendedId)).toMatchObject({ id: appendedId });
		expect(repaired.getSessionMemoryStats().currentCommitTransition).toEqual({
			kind: "exact",
			reason: "descriptor_and_proof_match",
		});
		await repaired.close();

		const verified = await SessionManager.open(sessionFile, destination, storage, "copy-retain", "enabled");
		try {
			expect(verified.getSessionMemoryStats().lazyReopenSucceeded).toBe(true);
			expect(verified.getEntry(appendedId)).toMatchObject({ id: appendedId });
		} finally {
			await verified.close();
		}
	});
	it("recovers from transcript publication followed by tail journal failure", async () => {
		class TailFailureStorage extends MemorySessionStorage {
			failTail = false;
			tailFailures = 0;
			override openWriter(filePath: string, options?: { flags?: "w" | "a" }): SessionStorageWriter {
				const writer = super.openWriter(filePath, options);
				if (!this.failTail || !filePath.endsWith(".spill.tail")) return writer;
				return {
					writeLine: writer.writeLine.bind(writer),
					writeLineSync: () => {
						this.tailFailures++;
						throw new Error("injected_tail_failure");
					},
					flush: writer.flush.bind(writer),
					fsync: writer.fsync.bind(writer),
					fsyncSync: writer.fsyncSync?.bind(writer),
					statSync: writer.statSync?.bind(writer),
					close: writer.close.bind(writer),
					closeSync: writer.closeSync.bind(writer),
					getError: writer.getError.bind(writer),
					getCloseState: writer.getCloseState.bind(writer),
					getCloseError: writer.getCloseError.bind(writer),
				};
			}
		}
		const storage = new TailFailureStorage();
		const sessionFile = "/sessions/tail-failure.jsonl";
		const records = [
			{ type: "session", version: 5, id: "tail-failure", timestamp: "0", cwd: "/cwd" },
			{
				type: "message",
				id: "cold",
				parentId: null,
				timestamp: "0",
				message: { role: "user", content: "cold", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "compact",
				parentId: "cold",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "cold",
				tokensBefore: 1,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		const appendedId = (() => {
			storage.failTail = true;
			return manager.appendCustomEntry("crash-window", { durable: true });
		})();
		expect(storage.tailFailures).toBe(1);
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
		expect(manager.getEntry(appendedId)).toMatchObject({ id: appendedId });
		await manager.close();
		storage.failTail = false;
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getEntry(appendedId)).toMatchObject({ id: appendedId });
			expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
		} finally {
			await reopened.close();
		}
	});

	it("reads direct children from the authenticated cold index without hydrating the session", async () => {
		class CountingStorage extends MemorySessionStorage {
			rangeReads = 0;
			indexRangeReads = 0;
			override readRangeSync(filePath: string, offset: number, length: number) {
				this.rangeReads++;
				if (filePath.endsWith(".spill.idx")) this.indexRangeReads++;
				return super.readRangeSync(filePath, offset, length);
			}
		}
		const storage = new CountingStorage();
		const sessionFile = "/sessions/cold-children.jsonl";
		storage.writeTextSync(
			sessionFile,
			`${[
				{ type: "session", version: 5, id: "cold-children", timestamp: "0", cwd: "/cwd" },
				{ type: "custom", id: "root", parentId: null, timestamp: "0", customType: "node", data: {} },
				{ type: "custom", id: "abandoned", parentId: "root", timestamp: "0", customType: "node", data: {} },
				{
					type: "custom",
					id: "abandoned-child",
					parentId: "abandoned",
					timestamp: "0",
					customType: "node",
					data: {},
				},
				{ type: "custom", id: "active", parentId: "root", timestamp: "0", customType: "node", data: {} },
				{
					type: "compaction",
					id: "active-compaction",
					parentId: "active",
					timestamp: "0",
					summary: "summary",
					firstKeptEntryId: "active",
					tokensBefore: 1,
				},
			]
				.map(record => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
			expect(manager.getChildren("root").map(entry => entry.id)).toEqual(["abandoned", "active"]);
			expect(manager.parentChildrenCacheKeysForTests()).toContain("root");
			const indexReadsAfterFirstLookup = storage.indexRangeReads;
			expect(manager.getChildren("root").map(entry => entry.id)).toEqual(["abandoned", "active"]);
			expect(storage.indexRangeReads).toBe(indexReadsAfterFirstLookup);
			expect(manager.getChildren("abandoned").map(entry => entry.id)).toEqual(["abandoned-child"]);
			expect(storage.indexRangeReads).toBe(indexReadsAfterFirstLookup);
			const indexPath = sidecarPath(sessionFile, "idx");
			const indexText = storage.readTextSync(indexPath);
			// Different-length replacement so the descriptor (size + mtime) always
			// changes; a same-length same-millisecond write would be indistinguishable
			// from the validated descriptor (out-of-scope same-descriptor tampering).
			storage.writeTextSync(indexPath, indexText.replace('"abandoned"', '"XX"'));
			expect(
				manager
					.getChildren("root")
					.map(entry => entry.id)
					.sort(),
			).toEqual(["abandoned", "active"]);
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
		} finally {
			await manager.close();
		}
	});
	it("hydrates the authoritative transcript when an authenticated flat index omits a prefix", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/partial-authenticated-index.jsonl";
		writeTreeTranscript(storage, sessionFile, { parentCount: 4, childrenPerParent: 2 });
		const expectedIds = storage
			.readTextSync(sessionFile)
			.trimEnd()
			.split("\n")
			.slice(1)
			.map(line => (JSON.parse(line) as { id: string }).id);
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		await built.close();
		const indexPath = sidecarPath(sessionFile, "idx");
		const partialLines = storage
			.readTextSync(indexPath)
			.trimEnd()
			.split("\n")
			.slice(1)
			.map((line, ordinal) => JSON.stringify({ ...JSON.parse(line), ordinal }));
		const partialIndex = `${partialLines.join("\n")}\n`;
		storage.writeTextSync(indexPath, partialIndex);
		const markerPath = sidecarPath(sessionFile, "commit");
		const marker = JSON.parse(storage.readTextSync(markerPath)) as Record<string, unknown>;
		marker.indexDigest = createHash("sha256").update(partialIndex).digest("hex");
		delete marker.parentIndex;
		delete marker.dictionary;
		delete marker.metadataDelta;
		storage.writeTextSync(markerPath, JSON.stringify(marker));
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getEntriesForExport().map(entry => entry.id)).toEqual(expectedIds);
			expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(false);
			expect(storage.existsSync(indexPath)).toBe(false);
		} finally {
			await reopened.close();
		}
	});
	it("does not cache a truncated neighboring parent block", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/cold-children-overflow.jsonl";
		const children = Array.from({ length: 257 }, (_, index) => ({
			type: "custom",
			id: `overflow-child-${index}`,
			parentId: "overflow-parent",
			timestamp: "0",
			customType: "node",
			data: {},
		}));
		storage.writeTextSync(
			sessionFile,
			`${[
				{ type: "session", version: 5, id: "cold-children-overflow", timestamp: "0", cwd: "/cwd" },
				{ type: "custom", id: "root", parentId: null, timestamp: "0", customType: "node", data: {} },
				{ type: "custom", id: "overflow-parent", parentId: "root", timestamp: "0", customType: "node", data: {} },
				...children,
				{ type: "custom", id: "active", parentId: "root", timestamp: "0", customType: "node", data: {} },
				{
					type: "compaction",
					id: "active-compaction",
					parentId: "active",
					timestamp: "0",
					summary: "summary",
					firstKeptEntryId: "active",
					tokensBefore: 1,
				},
			]
				.map(record => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		await built.close();
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.parentArtifactEnabledForTests()).toBe(true);
			expect(reopened.getChildren("root").map(entry => entry.id)).toEqual(["overflow-parent", "active"]);
			expect(reopened.parentChildrenCacheKeysForTests()).not.toContain("overflow-parent");
			expect(reopened.getChildren("overflow-parent")).toHaveLength(257);
			expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(false);
		} finally {
			await reopened.close();
		}
	});

	it("serves arbitrary disjoint parent lookups after reopen without scanning .spill.idx", async () => {
		class CountingStorage extends MemorySessionStorage {
			indexRangeReads = 0;
			bucketRangeReads = 0;
			override readRangeSync(filePath: string, offset: number, length: number) {
				if (filePath.endsWith(".spill.idx")) this.indexRangeReads++;
				if (filePath.includes(".spill.parent-")) this.bucketRangeReads++;
				return super.readRangeSync(filePath, offset, length);
			}
		}
		const storage = new CountingStorage();
		const sessionFile = "/sessions/disjoint-parents.jsonl";
		const parents = writeTreeTranscript(storage, sessionFile, { parentCount: 24, childrenPerParent: 4 });
		const first = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		expect(first.getSessionMemoryStats().coldRetirementActive).toBe(true);
		await first.close();
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getSessionMemoryStats().currentCommitTransition).toEqual({
				kind: "exact",
				reason: "descriptor_and_proof_match",
			});
			expect(reopened.parentArtifactEnabledForTests()).toBe(true);
			expect(reopened.getSessionMemoryStats().coldIndexBytes).toBeGreaterThan(0);
			expect(reopened.getSessionMemoryStats().coldIndexBlockCacheBytes).toBeGreaterThan(0);
			const readsAfterReopen = storage.indexRangeReads;
			const readsBeforeLookups = storage.bucketRangeReads;
			for (const parent of parents) {
				expect(reopened.getChildren(parent).map(entry => entry.id)).toEqual([
					`${parent}-child-00`,
					`${parent}-child-01`,
					`${parent}-child-02`,
					`${parent}-child-03`,
				]);
			}
			// No `.spill.idx` range read happens for any disjoint parent lookup.
			expect(storage.indexRangeReads).toBe(readsAfterReopen);
			// Each disjoint parent costs exactly one bounded bucket read.
			expect(storage.bucketRangeReads - readsBeforeLookups).toBe(parents.length);
			expect(reopened.getSessionMemoryStats().totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		} finally {
			await reopened.close();
		}
	});

	it("preserves transcript physical order for artifact parent lookups across reopen", async () => {
		class CountingStorage extends MemorySessionStorage {
			indexRangeReads = 0;
			override readRangeSync(filePath: string, offset: number, length: number) {
				if (filePath.endsWith(".spill.idx")) this.indexRangeReads++;
				return super.readRangeSync(filePath, offset, length);
			}
		}
		const storage = new CountingStorage();
		const sessionFile = "/sessions/parent-order.jsonl";
		storage.writeTextSync(
			sessionFile,
			`${[
				{ type: "session", version: 5, id: "parent-order", timestamp: "0", cwd: "/cwd" },
				{ type: "custom", id: "root", parentId: null, timestamp: "0", customType: "node", data: {} },
				{ type: "custom", id: "zeta", parentId: "root", timestamp: "0", customType: "node", data: {} },
				{ type: "custom", id: "alpha", parentId: "root", timestamp: "0", customType: "node", data: {} },
				{ type: "custom", id: "mid", parentId: "root", timestamp: "0", customType: "node", data: {} },
				{ type: "custom", id: "active", parentId: "root", timestamp: "0", customType: "node", data: {} },
				{
					type: "compaction",
					id: "active-compaction",
					parentId: "active",
					timestamp: "0",
					summary: "summary",
					firstKeptEntryId: "active",
					tokensBefore: 1,
				},
			]
				.map(record => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		expect(built.getChildren("root").map(entry => entry.id)).toEqual(["zeta", "alpha", "mid", "active"]);
		await built.close();
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			const readsAfterReopen = storage.indexRangeReads;
			expect(reopened.getChildren("root").map(entry => entry.id)).toEqual(["zeta", "alpha", "mid", "active"]);
			expect(storage.indexRangeReads).toBe(readsAfterReopen);
		} finally {
			await reopened.close();
		}
	});

	it("fails closed to authoritative children when the parent artifact is corrupt, missing, or stale", async () => {
		class CountingStorage extends MemorySessionStorage {
			indexRangeReads = 0;
			override readRangeSync(filePath: string, offset: number, length: number) {
				if (filePath.endsWith(".spill.idx")) this.indexRangeReads++;
				return super.readRangeSync(filePath, offset, length);
			}
		}
		const storage = new CountingStorage();
		const sessionFile = "/sessions/parent-fallback.jsonl";
		const parents = writeTreeTranscript(storage, sessionFile, { parentCount: 6, childrenPerParent: 3 });
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		expect(built.getChildren("root")).toHaveLength(7);
		await built.close();
		const rootBucket = parentBucketForId("root", PARENT_CHILDREN_BUCKET_COUNT);
		const parentBucket = parentBucketForId(parents[0], PARENT_CHILDREN_BUCKET_COUNT);

		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.parentArtifactEnabledForTests()).toBe(true);
			// Corrupt: overwrite the root bucket with garbage → digest mismatch → fallback scan.
			const rootBucketPath = parentBucketPath(sessionFile, rootBucket);
			storage.writeTextSync(rootBucketPath, "corrupt-parent-bucket\n");
			const indexReadsBefore = storage.indexRangeReads;
			const rootChildren = reopened
				.getChildren("root")
				.map(entry => entry.id)
				.sort();
			expect(rootChildren).toEqual(["active", ...parents.map(parent => parent).sort()]);
			expect(storage.indexRangeReads).toBeGreaterThan(indexReadsBefore);

			// Missing: unlink a parent bucket → authoritative children still served.
			const parentBucketPathForParent = parentBucketPath(sessionFile, parentBucket);
			storage.unlinkSync(parentBucketPathForParent);
			expect(reopened.getChildren(parents[0]).map(entry => entry.id)).toEqual([
				`${parents[0]}-child-00`,
				`${parents[0]}-child-01`,
				`${parents[0]}-child-02`,
			]);

			// Stale: replace the bucket for `parents[1]` with valid-looking but
			// different bytes → digest mismatch → authoritative fallback.
			const staleBucket = parentBucketForId(parents[1], PARENT_CHILDREN_BUCKET_COUNT);
			storage.writeTextSync(
				parentBucketPath(sessionFile, staleBucket),
				serializeParentBucketRecord({
					parentId: "root",
					childId: "active",
					ordinal: 0,
					seq: 0,
					byteOffset: 0,
					byteLength: 1,
					recordDigest: "0".repeat(64),
				}),
			);
			expect(reopened.getChildren(parents[1]).map(entry => entry.id)).toEqual([
				`${parents[1]}-child-00`,
				`${parents[1]}-child-01`,
				`${parents[1]}-child-02`,
			]);
			expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
		} finally {
			await reopened.close();
		}
	});

	it("binds the parent artifact into the commit marker and reopens exactly", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/parent-marker.jsonl";
		writeTreeTranscript(storage, sessionFile, { parentCount: 4, childrenPerParent: 2 });
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		await built.close();
		const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
			indexDigest: string;
			parentIndex?: { bucketCount: number; indexDigest: string; buckets: Array<{ size: number; digest: string }> };
		};
		expect(marker.parentIndex).toBeDefined();
		expect(marker.parentIndex!.bucketCount).toBe(PARENT_CHILDREN_BUCKET_COUNT);
		expect(marker.parentIndex!.buckets).toHaveLength(PARENT_CHILDREN_BUCKET_COUNT);
		// The artifact is bound to the exact index bytes the marker authenticates.
		expect(marker.parentIndex!.indexDigest).toBe(marker.indexDigest);
		// Every non-empty bucket's committed digest matches its exact on-disk bytes.
		for (let bucket = 0; bucket < PARENT_CHILDREN_BUCKET_COUNT; bucket++) {
			const committed = marker.parentIndex!.buckets[bucket];
			if (committed.size === 0) continue;
			const bytes = storage.readBytesSync(parentBucketPath(sessionFile, bucket));
			expect(bytes.byteLength).toBe(committed.size);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(committed.digest);
		}
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getSessionMemoryStats().currentCommitTransition).toEqual({
				kind: "exact",
				reason: "descriptor_and_proof_match",
			});
			expect(reopened.parentArtifactEnabledForTests()).toBe(true);
		} finally {
			await reopened.close();
		}
	});

	it("appends parent records before publishing the commit marker and serves them after reopen", async () => {
		class CountingStorage extends MemorySessionStorage {
			indexRangeReads = 0;
			override readRangeSync(filePath: string, offset: number, length: number) {
				if (filePath.endsWith(".spill.idx")) this.indexRangeReads++;
				return super.readRangeSync(filePath, offset, length);
			}
		}
		const storage = new CountingStorage();
		const sessionFile = "/sessions/append-parent.jsonl";
		writeTreeTranscript(storage, sessionFile, { parentCount: 4, childrenPerParent: 2 });
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(manager.parentArtifactEnabledForTests()).toBe(true);
			const leafId = manager.getLeafId()!;
			const appendedId = manager.appendCustomEntry("node", {});
			// The appended entry's parent is the previous leaf; its bucket record must
			// be durable before the commit marker claims the new parent metadata.
			const bucket = parentBucketForId(leafId, PARENT_CHILDREN_BUCKET_COUNT);
			const bucketPath = parentBucketPath(sessionFile, bucket);
			expect(storage.readTextSync(bucketPath)).toContain(`"c":"${appendedId}"`);
			const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
				parentIndex?: { indexDigest: string; buckets: Array<{ size: number; digest: string }> };
			};
			expect(marker.parentIndex).toBeDefined();
			expect(createHash("sha256").update(storage.readBytesSync(bucketPath)).digest("hex")).toBe(
				marker.parentIndex!.buckets[bucket].digest,
			);
			// Compaction republishes the marker; the artifact stays current (no stale proof).
			manager.appendCompaction("checkpoint", undefined, appendedId, 1);
			const markerAfterCompaction = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
				parentIndex?: { buckets: Array<{ size: number; digest: string }> };
			};
			expect(markerAfterCompaction.parentIndex).toBeDefined();
			expect(createHash("sha256").update(storage.readBytesSync(bucketPath)).digest("hex")).toBe(
				markerAfterCompaction.parentIndex!.buckets[bucket].digest,
			);
		} finally {
			await manager.close();
		}
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			const readsAfterReopen = storage.indexRangeReads;
			expect(reopened.parentArtifactEnabledForTests()).toBe(true);
			const lastLine = storage.readTextSync(sidecarPath(sessionFile, "idx")).trimEnd().split("\n").at(-1);
			const parentId = (JSON.parse(lastLine!) as { parentId: string | null }).parentId!;
			expect(reopened.getChildren(parentId)).toHaveLength(1);
			expect(storage.indexRangeReads).toBe(readsAfterReopen);
		} finally {
			await reopened.close();
		}
	});

	it("publishes appended reducer ordinals in the flat-index coordinate space", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/append-reducer-ordinal.jsonl";
		writeTreeTranscript(storage, sessionFile, { parentCount: 4, childrenPerParent: 2 });
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			manager.appendModelChange("model-next", "reviewer");
			const indexRecord = JSON.parse(
				storage.readTextSync(sidecarPath(sessionFile, "idx")).trimEnd().split("\n").at(-1)!,
			) as {
				ordinal: number;
			};
			const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
				reducer: { modelChange: { latest?: { ordinal: number; role?: string } } };
			};
			expect(marker.reducer.modelChange.latest).toEqual({ ordinal: indexRecord.ordinal, role: "reviewer" });
		} finally {
			await manager.close();
		}
	});
	it("invalidates the parent artifact when an append cannot be safely recorded", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/append-overflow.jsonl";
		writeTreeTranscript(storage, sessionFile, { parentCount: 4, childrenPerParent: 2 });
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(manager.parentArtifactEnabledForTests()).toBe(true);
			// Shrink the append cap below one record: the next append cannot be
			// covered, so the artifact must fail closed and the marker must be
			// republished WITHOUT any parent binding.
			manager.setParentArtifactBudgetForTests(1);
			manager.appendCustomEntry("node", {});
			expect(manager.parentArtifactEnabledForTests()).toBe(false);
			const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
				parentIndex?: unknown;
			};
			expect(marker.parentIndex).toBeUndefined();
			for (let bucket = 0; bucket < PARENT_CHILDREN_BUCKET_COUNT; bucket++) {
				expect(storage.existsSync(parentBucketPath(sessionFile, bucket))).toBe(false);
			}
		} finally {
			await manager.close();
		}
	});

	it("removes the parent artifact buckets on cold deactivation and verified deletion", async () => {
		const tempDir = TempDir.createSync("@pi-session-memory-parent-cleanup-");
		const storage = new FileSessionStorage();
		const sessionFile = path.join(tempDir.path(), "cleanup.jsonl");
		const records: Array<Record<string, unknown>> = [
			{ type: "session", version: 5, id: "cleanup", timestamp: "0", cwd: tempDir.path() },
			{ type: "custom", id: "root", parentId: null, timestamp: "0", customType: "node", data: {} },
			{ type: "custom", id: "child", parentId: "root", timestamp: "0", customType: "node", data: {} },
			{ type: "custom", id: "active", parentId: "root", timestamp: "0", customType: "node", data: {} },
			{
				type: "compaction",
				id: "active-compaction",
				parentId: "active",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "active",
				tokensBefore: 1,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination(tempDir.path()),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(manager.parentArtifactEnabledForTests()).toBe(true);
			expect(
				fs.existsSync(parentBucketPath(sessionFile, parentBucketForId("root", PARENT_CHILDREN_BUCKET_COUNT))),
			).toBe(true);
			// Branching to the pre-compaction root deactivates cold and removes every
			// disposable sidecar, including the parent artifact buckets.
			manager.branch("root");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
			for (const kind of ["idx", "tail", "commit"] as const) {
				expect(fs.existsSync(sidecarPath(sessionFile, kind))).toBe(false);
			}
			for (let bucket = 0; bucket < PARENT_CHILDREN_BUCKET_COUNT; bucket++) {
				expect(fs.existsSync(parentBucketPath(sessionFile, bucket))).toBe(false);
			}
		} finally {
			await manager.close();
		}
		// Verified deletion removes the whole artifacts directory (buckets included).
		await storage.deleteSessionWithArtifacts(sessionFile);
		expect(fs.existsSync(sessionFile.slice(0, -6))).toBe(false);
		tempDir.removeSync();
	});
	it("preserves the tail truncation fsync error when close also fails", async () => {
		class TailTruncationFailureStorage extends MemorySessionStorage {
			tailWriterCount = 0;
			override openWriter(filePath: string, options?: { flags?: "w" | "a" }): SessionStorageWriter {
				const writer = super.openWriter(filePath, options);
				if (!filePath.endsWith(".spill.tail") || ++this.tailWriterCount !== 2) return writer;
				return {
					writeLine: writer.writeLine.bind(writer),
					writeLineSync: writer.writeLineSync.bind(writer),
					flush: writer.flush.bind(writer),
					fsync: writer.fsync.bind(writer),
					fsyncSync: () => {
						throw new Error("injected_tail_truncation_fsync_failure");
					},
					statSync: writer.statSync?.bind(writer),
					close: writer.close.bind(writer),
					closeSync: () => {
						throw new Error("injected_tail_truncation_close_failure");
					},
					getError: writer.getError.bind(writer),
					getCloseState: writer.getCloseState.bind(writer),
					getCloseError: writer.getCloseError.bind(writer),
				};
			}
		}
		const storage = new TailTruncationFailureStorage();
		const sessionFile = "/sessions/tail-truncation-finalizer.jsonl";
		const entries = Array.from({ length: 16_000 }, (_, index) => ({
			type: "custom",
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: "0",
			customType: "tail-overflow",
			data: { index },
		}));
		storage.writeTextSync(
			sessionFile,
			`${[
				{ type: "session", version: 5, id: "tail-truncation-finalizer", timestamp: "0", cwd: "/cwd" },
				...entries,
				{
					type: "compaction",
					id: "tail-truncation-compaction",
					parentId: "entry-15999",
					timestamp: "0",
					summary: "summary",
					firstKeptEntryId: "entry-0",
					tokensBefore: 16_000,
				},
			]
				.map(record => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"shadow",
		);
		try {
			expect(storage.tailWriterCount).toBe(2);
			expect(warning).toHaveBeenCalledWith(
				"Session memory sidecar build failed; preserving eager transcript state",
				expect.objectContaining({ error: "injected_tail_truncation_fsync_failure" }),
			);
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
		} finally {
			warning.mockRestore();
			await manager.close();
		}
	}, 30_000);
	it("recovers when tail fsync fails after the journal write", async () => {
		class TailFsyncFailureStorage extends MemorySessionStorage {
			failTailFsync = false;
			tailFsyncFailures = 0;
			override openWriter(filePath: string, options?: { flags?: "w" | "a" }): SessionStorageWriter {
				const writer = super.openWriter(filePath, options);
				if (!filePath.endsWith(".spill.tail")) return writer;
				return {
					writeLine: writer.writeLine.bind(writer),
					writeLineSync: writer.writeLineSync.bind(writer),
					flush: writer.flush.bind(writer),
					fsync: writer.fsync.bind(writer),
					fsyncSync: () => {
						if (this.failTailFsync) {
							this.tailFsyncFailures++;
							throw new Error("injected_tail_fsync_failure");
						}
						writer.fsyncSync?.();
					},
					statSync: writer.statSync?.bind(writer),
					close: writer.close.bind(writer),
					closeSync: writer.closeSync.bind(writer),
					getError: writer.getError.bind(writer),
					getCloseState: writer.getCloseState.bind(writer),
					getCloseError: writer.getCloseError.bind(writer),
				};
			}
		}
		const storage = new TailFsyncFailureStorage();
		const sessionFile = "/sessions/tail-fsync-failure.jsonl";
		const records = [
			{ type: "session", version: 5, id: "tail-fsync-failure", timestamp: "0", cwd: "/cwd" },
			{
				type: "message",
				id: "old",
				parentId: null,
				timestamp: "0",
				message: { role: "user", content: "old", timestamp: 1 },
			},
			{
				type: "message",
				id: "kept",
				parentId: "old",
				timestamp: "0",
				message: { role: "user", content: "kept", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "compact",
				parentId: "kept",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 2,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		storage.failTailFsync = true;
		const appendedId = manager.appendCustomEntry("tail-fsync", { durable: true });
		expect(storage.tailFsyncFailures).toBe(1);
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
		await manager.close();
		storage.failTailFsync = false;
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getEntry(appendedId)).toMatchObject({ id: appendedId });
			expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
		} finally {
			await reopened.close();
		}
	});
	it("fsyncs transcript, index, and tail in publication order", async () => {
		class DurabilityOrderStorage extends MemorySessionStorage {
			readonly events: string[] = [];
			override openWriter(filePath: string, options?: { flags?: "w" | "a" }): SessionStorageWriter {
				const writer = super.openWriter(filePath, options);
				return {
					writeLine: async line => {
						this.events.push(`write:${filePath}`);
						await writer.writeLine(line);
					},
					writeLineSync: line => {
						this.events.push(`write:${filePath}`);
						writer.writeLineSync(line);
					},
					flush: writer.flush.bind(writer),
					fsync: async () => {
						this.events.push(`fsync:${filePath}`);
						await writer.fsync();
					},
					fsyncSync: () => {
						this.events.push(`fsync:${filePath}`);
						writer.fsyncSync?.();
					},
					statSync: writer.statSync?.bind(writer),
					close: writer.close.bind(writer),
					closeSync: writer.closeSync.bind(writer),
					getError: writer.getError.bind(writer),
					getCloseState: writer.getCloseState.bind(writer),
					getCloseError: writer.getCloseError.bind(writer),
				};
			}
		}
		const storage = new DurabilityOrderStorage();
		const sessionFile = "/sessions/durability-order.jsonl";
		const records = [
			{ type: "session", version: 5, id: "durability-order", timestamp: "0", cwd: "/cwd" },
			{
				type: "message",
				id: "old",
				parentId: null,
				timestamp: "0",
				message: { role: "user", content: "old", timestamp: 1 },
			},
			{
				type: "message",
				id: "kept",
				parentId: "old",
				timestamp: "0",
				message: { role: "user", content: "kept", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "compact",
				parentId: "kept",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 2,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			storage.events.length = 0;
			manager.appendCustomEntry("durable", { value: true });
			const transcriptFsync = storage.events.indexOf(`fsync:${sessionFile}`);
			const indexWrite = storage.events.indexOf(`write:${sidecarPath(sessionFile, "idx")}`);
			const indexFsync = storage.events.indexOf(`fsync:${sidecarPath(sessionFile, "idx")}`);
			const tailWrite = storage.events.indexOf(`write:${sidecarPath(sessionFile, "tail")}`);
			const tailFsync = storage.events.indexOf(`fsync:${sidecarPath(sessionFile, "tail")}`);
			expect(transcriptFsync).toBeGreaterThanOrEqual(0);
			expect(indexWrite).toBeGreaterThan(transcriptFsync);
			expect(indexFsync).toBeGreaterThan(indexWrite);
			expect(tailWrite).toBeGreaterThan(indexFsync);
			expect(tailFsync).toBeGreaterThan(tailWrite);
			expect(manager.getSessionMemoryStats().currentCommitTransition).toEqual({
				kind: "exact",
				reason: "descriptor_and_proof_match",
			});
		} finally {
			await manager.close();
		}
	});
});

describePosix("managed session memory authority", () => {
	it("retires managed history while keeping disposable sidecars outside managed authority", async () => {
		const tempDir = TempDir.createSync("@pi-managed-memory-eager-");
		const cwd = path.join(tempDir.path(), "workspace");
		const agentDir = path.join(tempDir.path(), "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		let sessionFile: string;
		try {
			manager.setSessionMemoryMode("enabled");
			const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
			const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
			await manager.ensureOnDisk();
			manager.appendCompaction("summary", undefined, keptId, 10);
			manager.appendLabelChange(firstId, "managed label");
			const appendedId = manager.appendMessage({ role: "user", content: "after", timestamp: 3 });
			sessionFile = manager.getSessionFile()!;
			expect(manager.getSessionMemoryStats()).toMatchObject({
				sidecarEnabled: true,
				coldRetirementActive: true,
				sidecarIneligible: false,
			});
			for (const kind of ["idx", "tail", "commit"] as const)
				expect(fs.existsSync(sidecarPath(sessionFile, kind))).toBe(false);
			expect(manager.getEntry(firstId)).toMatchObject({ id: firstId });
			expect(manager.getEntry(appendedId)).toMatchObject({ id: appendedId });
		} finally {
			await manager.close();
		}
		try {
			SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1;
			let reopened: SessionManager | undefined;
			try {
				reopened = await SessionManager.open(sessionFile, destination, undefined, "copy-retain", "auto");
				expect(reopened.getSessionMemoryStats()).toMatchObject({
					sidecarEnabled: true,
					coldRetirementActive: true,
					lazyReopenSucceeded: true,
					lastReopenTransition: { kind: "rebuild", reason: "bounded_first_open" },
				});
				expect(reopened.getLabel(reopened.getEntries()[0]!.id)).toBe("managed label");
				expect(reopened.buildSessionContext().messages).toHaveLength(3);
			} finally {
				SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = undefined;
				await reopened?.close();
			}
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("persistent dictionary and metadata-delta artifacts", () => {
	beforeEach(() => {
		SessionManagerTestHooks.secondaryArtifactMode = "enabled";
	});
	afterEach(() => {
		SessionManagerTestHooks.secondaryArtifactMode = undefined;
	});
	it("publishes the dictionary artifact bound in the commit marker and reopens exactly", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/dict-marker.jsonl";
		writeTreeTranscript(storage, sessionFile, { parentCount: 4, childrenPerParent: 2 });
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		await built.close();
		expect(storage.existsSync(dictionaryMetaPathFor(sessionFile))).toBe(true);
		for (let partition = 0; partition < DICTIONARY_PARTITION_COUNT; partition++)
			expect(storage.existsSync(dictionaryPartitionPath(sessionFile, partition))).toBe(true);
		const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
			indexDigest: string;
			dictionary?: {
				indexDigest: string;
				partitions: Array<{ size: number; digest: string; records: number; complete: boolean }>;
				metaSize: number;
				metaDigest: string;
				recordCount: number;
				uniqueTerms: number;
				totalBytes: number;
				duplicateIds: string[];
				sidecarIneligible: boolean;
			};
		};
		expect(marker.dictionary).toBeDefined();
		// The artifact covers exactly the entry set of the bound index digest.
		expect(marker.dictionary!.indexDigest).toBe(marker.indexDigest);
		expect(marker.dictionary!.sidecarIneligible).toBe(false);
		expect(marker.dictionary!.duplicateIds).toEqual([]);
		// Every partition's committed digest matches its exact on-disk bytes.
		for (let partition = 0; partition < marker.dictionary!.partitions.length; partition++) {
			const committed = marker.dictionary!.partitions[partition]!;
			const bytes = storage.readBytesSync(dictionaryPartitionPath(sessionFile, partition));
			expect(bytes.byteLength).toBe(committed.size);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(committed.digest);
		}
		const metaBytes = storage.readBytesSync(dictionaryMetaPathFor(sessionFile));
		expect(metaBytes.byteLength).toBe(marker.dictionary!.metaSize);
		expect(createHash("sha256").update(metaBytes).digest("hex")).toBe(marker.dictionary!.metaDigest);
		const parsedMeta = parseDictionaryArtifactCommit(Buffer.from(metaBytes).toString("utf8"));
		expect(parsedMeta?.indexDigest).toBe(marker.indexDigest);
		expect(parsedMeta?.recordCount).toBe(marker.dictionary!.recordCount);
		expect(parsedMeta?.uniqueTerms).toBe(marker.dictionary!.uniqueTerms);
		expect(parsedMeta?.uniqueTerms).toBe(parsedMeta?.recordCount);

		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getSessionMemoryStats().lazyReopenSucceeded).toBe(true);
			expect(reopened.getSessionMemoryStats().dictionaryArtifactEnabled).toBe(true);
			// Cold lookups resolve through the adopted dictionary-backed partition.
			expect(reopened.getEntry("root")).toMatchObject({ id: "root", type: "custom" });
			expect(reopened.getEntry("parent-000")).toMatchObject({ id: "parent-000" });
		} finally {
			await reopened.close();
		}
	});

	it("fails closed to the authoritative cold scan when dictionary artifacts are corrupt or missing", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/dict-corrupt.jsonl";
		writeTreeTranscript(storage, sessionFile, { parentCount: 4, childrenPerParent: 2 });
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		await built.close();
		// Corrupt one partition: the session still reopens exactly on index/tail
		// proof, but the dictionary fast path is disabled (idx scan authoritative).
		storage.writeTextSync(dictionaryPartitionPath(sessionFile, 0), "junk\n");
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getSessionMemoryStats().lazyReopenSucceeded).toBe(true);
			expect(reopened.getSessionMemoryStats().dictionaryArtifactEnabled).toBe(false);
			expect(reopened.getEntry("root")).toMatchObject({ id: "root", type: "custom" });
			expect(reopened.getChildren("root")).toHaveLength(5);
		} finally {
			await reopened.close();
		}
		// A missing meta file also disables the dictionary while the session reopens exactly.
		storage.unlinkSync(dictionaryMetaPathFor(sessionFile));
		const missingMeta = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(missingMeta.getSessionMemoryStats().lazyReopenSucceeded).toBe(true);
			expect(missingMeta.getSessionMemoryStats().dictionaryArtifactEnabled).toBe(false);
			expect(missingMeta.getEntry("parent-001")).toMatchObject({ id: "parent-001" });
		} finally {
			await missingMeta.close();
		}
	});

	it("safely updates the dictionary on append and rebinds the marker", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/dict-append.jsonl";
		writeTreeTranscript(storage, sessionFile, { parentCount: 4, childrenPerParent: 2 });
		const manager = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(manager.getSessionMemoryStats().dictionaryArtifactEnabled).toBe(true);
			const appendedId = manager.appendCustomEntry("node", {});
			const partition = dictionaryPartitionForId(appendedId, DICTIONARY_PARTITION_COUNT);
			const partitionFile = dictionaryPartitionPath(sessionFile, partition);
			// The appended entry's record must be durable and rebound before the
			// commit marker claims the new dictionary bytes.
			expect(storage.readTextSync(partitionFile)).toContain(`"t":"${appendedId}"`);
			const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
				dictionary?: { partitions: Array<{ size: number; digest: string; records: number }> };
			};
			expect(marker.dictionary).toBeDefined();
			const committed = marker.dictionary!.partitions[partition]!;
			const bytes = storage.readBytesSync(partitionFile);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(committed.digest);
			// Compaction republishes the marker; the dictionary stays current.
			manager.appendCompaction("checkpoint", undefined, appendedId, 1);
			expect(manager.getSessionMemoryStats().dictionaryArtifactEnabled).toBe(true);
		} finally {
			await manager.close();
		}
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getSessionMemoryStats().dictionaryArtifactEnabled).toBe(true);
			expect(reopened.getEntry("root")).toMatchObject({ id: "root" });
		} finally {
			await reopened.close();
		}
	});

	it("demotes oversized provider values into the metadata-delta and reproduces them on exact reopen", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/provider-delta.jsonl";
		const records = [
			{ type: "session", version: 5, id: "provider-delta", timestamp: "0", cwd: "/cwd" },
			{ type: "thinking_level_change", id: "thinking", parentId: null, timestamp: "0", thinkingLevel: "high" },
			{
				type: "model_change",
				id: "model",
				parentId: "thinking",
				timestamp: "0",
				model: "test/default",
				role: "default",
			},
			{
				type: "configured_model_chain",
				id: "chain",
				parentId: "model",
				timestamp: "0",
				role: "reviewer",
				entries: ["test/reviewer"],
				origin: "session",
			},
			{ type: "service_tier_change", id: "tier", parentId: "chain", timestamp: "0", serviceTier: "flex" },
			{
				type: "mode_change",
				id: "mode",
				parentId: "tier",
				timestamp: "0",
				mode: "plan",
				data: { planFile: "plan.md" },
			},
			{
				type: "mcp_tool_selection",
				id: "large-selection",
				parentId: "mode",
				timestamp: "0",
				selectedToolNames: Array.from({ length: 600 }, (_, index) => `mcp__tool_${index}`),
			},
			{
				type: "message",
				id: "kept",
				parentId: "large-selection",
				timestamp: "0",
				message: { role: "user", content: "kept", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "compact",
				parentId: "kept",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 10,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage);
		const eager = manager.buildSessionContext();
		manager.setSessionMemoryMode("enabled");
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
		expect(manager.getSessionMemoryStats().metadataDeltaDescriptorBytes).toBeGreaterThan(0);
		expect(manager.buildSessionContext()).toEqual(eager);
		await manager.close();
		// The delta file exists and the committed binding authenticates its exact bytes.
		const deltaPath = metadataDeltaPathFor(sessionFile);
		expect(storage.existsSync(deltaPath)).toBe(true);
		const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
			indexDigest: string;
			metadataDelta?: {
				indexDigest: string;
				size: number;
				sha256: string;
				values: Array<{ key: string; kind: string; position: number }>;
			};
		};
		expect(marker.metadataDelta).toBeDefined();
		expect(marker.metadataDelta!.indexDigest).toBe(marker.indexDigest);
		const deltaBytes = storage.readBytesSync(deltaPath);
		expect(deltaBytes.byteLength).toBe(marker.metadataDelta!.size);
		expect(createHash("sha256").update(deltaBytes).digest("hex")).toBe(marker.metadataDelta!.sha256);
		expect(marker.metadataDelta!.values.map(value => value.key)).toContain("mcp_tool_selection");

		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getSessionMemoryStats().lazyReopenSucceeded).toBe(true);
			expect(reopened.getSessionMemoryStats().metadataDeltaDescriptorBytes).toBeGreaterThan(0);
			expect(reopened.buildSessionContext()).toEqual(eager);
		} finally {
			await reopened.close();
		}
		const runtimeCorrupt = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			storage.writeTextSync(deltaPath, "{runtime-corrupt\n");
			runtimeCorrupt.appendLabelChange("kept", "runtime-corruption-check");
			expect(runtimeCorrupt.buildSessionContext()).toEqual(eager);
			expect(runtimeCorrupt.getSessionMemoryStats().coldRetirementActive).toBe(false);
		} finally {
			await runtimeCorrupt.close();
		}
	});

	it("rebuilds bounded state when the metadata-delta binding is corrupt or missing", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/provider-delta-corrupt.jsonl";
		const records = [
			{ type: "session", version: 5, id: "provider-delta-corrupt", timestamp: "0", cwd: "/cwd" },
			{
				type: "mcp_tool_selection",
				id: "selection",
				parentId: null,
				timestamp: "0",
				selectedToolNames: Array.from({ length: 600 }, (_, index) => `mcp__tool_${index}`),
			},
			{
				type: "message",
				id: "kept",
				parentId: "selection",
				timestamp: "0",
				message: { role: "user", content: "kept", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "compact",
				parentId: "kept",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 10,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const manager = await SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage);
		const eager = manager.buildSessionContext();
		manager.setSessionMemoryMode("enabled");
		expect(manager.getSessionMemoryStats().metadataDeltaDescriptorBytes).toBeGreaterThan(0);
		await manager.close();
		storage.writeTextSync(metadataDeltaPathFor(sessionFile), "{corrupt\n");
		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getSessionMemoryStats().lazyReopenSucceeded).toBe(true);
			expect(reopened.getSessionMemoryStats().currentCommitTransition).toEqual({
				kind: "exact",
				reason: "descriptor_and_proof_match",
			});
			expect(reopened.buildSessionContext()).toEqual(eager);
		} finally {
			await reopened.close();
		}
		const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as Record<string, unknown>;
		marker.metadataDelta = { malformed: true };
		storage.writeTextSync(sidecarPath(sessionFile, "commit"), JSON.stringify(marker));
		const malformedBinding = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(malformedBinding.getSessionMemoryStats().lazyReopenSucceeded).toBe(true);
			expect(malformedBinding.buildSessionContext()).toEqual(eager);
		} finally {
			await malformedBinding.close();
		}
	});

	itPosix("keeps managed dictionary and delta acceleration outside the managed tree", async () => {
		const tempDir = TempDir.createSync("@pi-managed-dict-exclusion-");
		const cwd = path.join(tempDir.path(), "workspace");
		const agentDir = path.join(tempDir.path(), "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		try {
			manager.setSessionMemoryMode("enabled");
			const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
			await manager.ensureOnDisk();
			manager.appendCompaction("summary", undefined, keptId, 10);
			const sessionFile = manager.getSessionFile()!;
			expect(fs.existsSync(dictionaryMetaPathFor(sessionFile))).toBe(false);
			expect(fs.existsSync(metadataDeltaPathFor(sessionFile))).toBe(false);
			for (let partition = 0; partition < DICTIONARY_PARTITION_COUNT; partition++)
				expect(fs.existsSync(dictionaryPartitionPath(sessionFile, partition))).toBe(false);
			expect(manager.getSessionMemoryStats().dictionaryArtifactEnabled).toBe(true);
			expect(manager.getSessionMemoryStats().metadataDeltaDescriptorBytes).toBe(0);
		} finally {
			await manager.close();
			tempDir.removeSync();
		}
	});

	it("rejects a dictionary artifact rebound to a different session id", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/dict-session-mismatch.jsonl";
		writeTreeTranscript(storage, sessionFile, { parentCount: 4, childrenPerParent: 2 });
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		await built.close();

		const meta = JSON.parse(storage.readTextSync(dictionaryMetaPathFor(sessionFile))) as {
			header: { sessionId: string };
		};
		meta.header.sessionId = "different-session";
		const metaBytes = Buffer.from(`${JSON.stringify(meta)}\n`, "utf8");
		storage.writeTextSync(dictionaryMetaPathFor(sessionFile), metaBytes.toString("utf8"));
		const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as {
			dictionary?: { header: { sessionId: string }; metaSize: number; metaDigest: string };
		};
		expect(marker.dictionary).toBeDefined();
		marker.dictionary!.header.sessionId = "different-session";
		marker.dictionary!.metaSize = metaBytes.byteLength;
		marker.dictionary!.metaDigest = createHash("sha256").update(metaBytes).digest("hex");
		storage.writeTextSync(sidecarPath(sessionFile, "commit"), JSON.stringify(marker));

		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getSessionMemoryStats()).toMatchObject({
				lazyReopenSucceeded: true,
				dictionaryArtifactEnabled: false,
			});
			expect(reopened.getEntry("root")).toMatchObject({ id: "root" });
		} finally {
			await reopened.close();
		}
	});

	it("removes stale secondary files when a rebuild uses disabled artifacts", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/secondary-rebuild-disabled.jsonl";
		writeTreeTranscript(storage, sessionFile, { parentCount: 4, childrenPerParent: 2 });
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		await built.close();
		expect(storage.existsSync(dictionaryMetaPathFor(sessionFile))).toBe(true);
		expect(
			Array.from({ length: PARENT_CHILDREN_BUCKET_COUNT }, (_, bucket) =>
				parentBucketPath(sessionFile, bucket),
			).some(path => storage.existsSync(path)),
		).toBe(true);

		SessionManagerTestHooks.secondaryArtifactMode = "disabled";
		storage.writeTextSync(
			sidecarPath(sessionFile, "idx"),
			`${storage.readTextSync(sidecarPath(sessionFile, "idx"))}{}\n`,
		);
		const rebuilt = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(rebuilt.getSessionMemoryStats()).toMatchObject({
				coldRetirementActive: true,
				dictionaryArtifactEnabled: false,
				parentArtifactEnabled: false,
			});
			expect(storage.existsSync(dictionaryMetaPathFor(sessionFile))).toBe(false);
			for (let partition = 0; partition < DICTIONARY_PARTITION_COUNT; partition++)
				expect(storage.existsSync(dictionaryPartitionPath(sessionFile, partition))).toBe(false);
			for (let bucket = 0; bucket < PARENT_CHILDREN_BUCKET_COUNT; bucket++)
				expect(storage.existsSync(parentBucketPath(sessionFile, bucket))).toBe(false);
			const primarySidecarBytes = (["idx", "tail", "commit"] as const)
				.map(kind => storage.statSync(sidecarPath(sessionFile, kind)).size)
				.reduce((total, size) => total + size, 0);
			const metadataDeltaBytes = storage.existsSync(metadataDeltaPathFor(sessionFile))
				? storage.statSync(metadataDeltaPathFor(sessionFile)).size
				: 0;
			expect(rebuilt.getSessionMemoryStats().sidecarFileBytes).toBe(primarySidecarBytes + metadataDeltaBytes);
		} finally {
			await rebuilt.close();
		}
	});

	it("guards full-hot-view work before reading a commit-rebound tampered index", async () => {
		class CountingStorage extends MemorySessionStorage {
			indexRangeReads = 0;
			override readRangeSync(filePath: string, offset: number, length: number) {
				if (filePath.endsWith(".spill.idx")) this.indexRangeReads++;
				return super.readRangeSync(filePath, offset, length);
			}
		}
		const storage = new CountingStorage();
		const sessionFile = "/sessions/rebound-index-full-view.jsonl";
		const records = [
			{ type: "session", version: 5, id: "rebound-index", timestamp: "0", cwd: "/cwd" },
			{ type: "custom", id: "old", parentId: null, timestamp: "0", customType: "node", data: {} },
			{ type: "custom", id: "kept", parentId: "old", timestamp: "0", customType: "node", data: {} },
			{
				type: "compaction",
				id: "compact",
				parentId: "kept",
				timestamp: "0",
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 1,
			},
		];
		storage.writeTextSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		SessionManagerTestHooks.secondaryArtifactMode = "disabled";
		const built = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		await built.close();
		const originalIndex = storage.readTextSync(sidecarPath(sessionFile, "idx"));
		const tamperedIndex = originalIndex.replaceAll('"old"', '"bad"');
		expect(tamperedIndex).not.toBe(originalIndex);
		storage.writeTextSync(sidecarPath(sessionFile, "idx"), tamperedIndex);
		const marker = JSON.parse(storage.readTextSync(sidecarPath(sessionFile, "commit"))) as { indexDigest: string };
		marker.indexDigest = createHash("sha256").update(Buffer.from(tamperedIndex, "utf8")).digest("hex");
		storage.writeTextSync(sidecarPath(sessionFile, "commit"), JSON.stringify(marker));

		const reopened = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination("/sessions"),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
			const readsBefore = storage.indexRangeReads;
			expect(() => reopened.getEntriesForExport()).toThrow("cold_sidecar_rebuild_required_for_bounded_transcript");
			expect(storage.indexRangeReads).toBe(readsBefore);
		} finally {
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
			await reopened.close();
		}
	});
});
describe("descriptor-bound capture and staged fork publication", () => {
	function writeColdTranscript(
		storage: FileSessionStorage | MemorySessionStorage,
		sessionFile: string,
		root: string,
		entryCount = 60,
		blobRef?: string,
	): { ids: string[]; now: string } {
		const now = new Date().toISOString();
		const ids = Array.from({ length: entryCount }, (_, index) => `cold-${index.toString().padStart(4, "0")}`);
		const entries: Array<Record<string, unknown>> = [
			{ type: "session", version: 5, id: "fork-source", timestamp: now, cwd: root },
			...ids.map((id, index) => ({
				type: "message",
				id,
				parentId: index === 0 ? null : ids[index - 1],
				timestamp: now,
				message: {
					role: "user",
					content:
						index === 0 && blobRef
							? [{ type: "image", data: blobRef, mimeType: "image/png" }]
							: `cold-${index}-${"x".repeat(256)}`,
					timestamp: index,
				},
			})),
			{
				type: "compaction",
				id: "fork-compaction",
				parentId: ids.at(-1),
				timestamp: now,
				summary: "summary",
				firstKeptEntryId: ids.at(-1),
				tokensBefore: 10_000,
			},
		];
		storage.writeTextSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		return { ids, now };
	}

	it("forks a compacted cold transcript with every entry, fresh identity, and no source-sidecar copying", async () => {
		const tempDir = TempDir.createSync("@pi-memory-fork-cold-");
		const storage = new FileSessionStorage();
		const sessionFile = path.join(tempDir.path(), "source.jsonl");
		const { ids } = writeColdTranscript(storage, sessionFile, tempDir.path());
		const source = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination(tempDir.path()),
			storage,
		);
		try {
			source.setSessionMemoryMode("enabled");
			expect(storage.existsSync(sidecarPath(sessionFile, "idx"))).toBe(true);
			expect(source.hotRetainedMessageCharsForTests()).toBeLessThan(1024);

			const captured = SessionManager.captureTranscriptStrict(sessionFile, storage);
			expect(captured.kind).toBe("captured");
			if (captured.kind !== "captured") throw new Error("Expected strict capture");
			// The descriptor-bound handle must not expose a whole-transcript buffer.
			expect("content" in captured.snapshot).toBe(false);

			const forked = await SessionManager.forkFromCaptured(
				captured.snapshot,
				tempDir.path(),
				SessionManager.explicitDestination(path.join(tempDir.path(), "forked")),
			);
			expect(forked.kind).toBe("forked");
			if (forked.kind !== "forked") throw new Error("Expected strict fork success");
			try {
				expect(forked.manager.getSessionId()).not.toBe("fork-source");
				expect(forked.manager.getSessionDir()).toBe(path.join(tempDir.path(), "forked"));
				// 60 messages + 1 compaction, all preserved.
				expect(forked.manager.getEntries()).toHaveLength(ids.length + 1);
				expect(forked.manager.getEntry(ids[0])).toMatchObject({ id: ids[0], type: "message" });
				expect(forked.manager.getEntry(ids.at(-1)!)).toMatchObject({ id: ids.at(-1), type: "message" });

				const forkedSessionFile = forked.manager.getSessionFile();
				expect(forkedSessionFile).toBeTruthy();
				if (forkedSessionFile) {
					// No cold sidecars are copied into the fork destination.
					const forkSidecars = storage.listFilesSync(path.dirname(forkedSessionFile), "*.spill.*");
					expect(forkSidecars.every(candidate => candidate.startsWith(`${forkedSessionFile}.spill.`))).toBe(true);
					const lines = storage
						.readTextSync(forkedSessionFile)
						.trimEnd()
						.split("\n")
						.map(line => JSON.parse(line) as { id?: string; type?: string });
					// fresh header + 60 messages + 1 compaction.
					expect(lines).toHaveLength(ids.length + 2);
					expect(lines[0]).toMatchObject({ type: "session", id: forked.manager.getSessionId() });
					expect(lines[0]?.id).not.toBe("fork-source");
					expect(lines.some(entry => entry.id === ids[0])).toBe(true);
					expect(lines.some(entry => entry.id === ids.at(-1))).toBe(true);
					expect(lines.some(entry => entry.id === "fork-compaction")).toBe(true);
				}
			} finally {
				await forked.manager.close();
			}
		} finally {
			await source.close();
			tempDir.removeSync();
		}
	});

	it("hydrates retired authority before preparing an internal successor", async () => {
		const tempDir = TempDir.createSync("@pi-memory-prepared-fork-cold-");
		const storage = new FileSessionStorage();
		const sessionFile = path.join(tempDir.path(), "source.jsonl");
		const { ids } = writeColdTranscript(storage, sessionFile, tempDir.path());
		const source = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination(tempDir.path()),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(source.getSessionMemoryStats().coldRetirementActive).toBe(true);
			const prepared = await source.prepareFork();
			expect(prepared?.sessionFile).toBeTruthy();
			if (!prepared?.sessionFile) throw new Error("Expected prepared successor");
			const transcript = storage.readTextSync(prepared.sessionFile);
			expect(transcript).toContain(ids[0]!);
			expect(transcript).toContain(ids.at(-1)!);
			await source.discardPreparedNewSession(prepared);
		} finally {
			await source.close();
			tempDir.removeSync();
		}
	});

	it("hydrates retired authority before capturing rollback state", async () => {
		const tempDir = TempDir.createSync("@pi-memory-rollback-cold-");
		const storage = new FileSessionStorage();
		const sessionFile = path.join(tempDir.path(), "source.jsonl");
		const { ids } = writeColdTranscript(storage, sessionFile, tempDir.path());
		const source = await SessionManager.open(
			sessionFile,
			SessionManager.explicitDestination(tempDir.path()),
			storage,
			"copy-retain",
			"enabled",
		);
		try {
			expect(source.getSessionMemoryStats().coldRetirementActive).toBe(true);
			const snapshotIds = source
				.captureState()
				.fileEntries.filter(entry => entry.type !== "session")
				.map(entry => entry.id);
			expect(snapshotIds).toContain(ids[0]!);
			expect(snapshotIds).toContain(ids.at(-1)!);
		} finally {
			await source.close();
			tempDir.removeSync();
		}
	});

	it("publishes through bounded range reads and staged writers without whole-buffer reads", async () => {
		const tempDir = TempDir.createSync("@pi-memory-fork-bounded-");
		const storage = new FileSessionStorage();
		const sessionFile = path.join(tempDir.path(), "source.jsonl");
		const blobBytes = Buffer.from("bounded captured fork blob authority", "utf8");
		const blobHash = createHash("sha256").update(blobBytes).digest("hex");
		fs.mkdirSync(getBlobsDir(), { recursive: true });
		fs.writeFileSync(path.join(getBlobsDir(), blobHash), blobBytes);
		writeColdTranscript(storage, sessionFile, tempDir.path(), 8, `blob:sha256:${blobHash}`);

		const readRangeSync = vi.spyOn(storage, "readRangeSync");
		const openStagedWriter = vi.spyOn(storage, "openStagedWriter");
		const readSnapshotSync = vi.spyOn(storage, "readSnapshotSync");

		const captured = SessionManager.captureTranscriptStrict(sessionFile, storage);
		expect(captured.kind).toBe("captured");
		if (captured.kind !== "captured") throw new Error("Expected strict capture");
		expect(readSnapshotSync).not.toHaveBeenCalled();

		const forked = await SessionManager.forkFromCaptured(
			captured.snapshot,
			tempDir.path(),
			SessionManager.explicitDestination(path.join(tempDir.path(), "forked-bounded")),
		);
		expect(forked.kind).toBe("forked");
		if (forked.kind !== "forked") throw new Error("Expected strict fork success");
		try {
			expect(readRangeSync).toHaveBeenCalled();
			expect(openStagedWriter).toHaveBeenCalled();
			expect(readSnapshotSync).not.toHaveBeenCalled();
			expect(storage.readTextSync(forked.manager.getSessionFile()!)).toContain(blobBytes.toString("base64"));
		} finally {
			await forked.manager.close();
			fs.rmSync(path.join(getBlobsDir(), blobHash), { force: true });
			tempDir.removeSync();
		}
	});

	it("rolls back cleanly and removes its private staging directory when source authority changes during publication", async () => {
		const tempDir = TempDir.createSync("@pi-memory-fork-rollback-");
		const sourcePath = path.join(tempDir.path(), "source.jsonl");
		const replacementPath = path.join(tempDir.path(), "replacement.jsonl");
		const destDir = path.join(tempDir.path(), "dest");
		const base = new FileSessionStorage();
		writeColdTranscript(base, sourcePath, tempDir.path(), 4);
		fs.writeFileSync(
			replacementPath,
			`${JSON.stringify({ type: "session", version: 5, id: "replacement", timestamp: new Date().toISOString(), cwd: tempDir.path() })}\n${JSON.stringify({ type: "message", id: "other", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "other", timestamp: 0 } })}\n`,
		);

		const storage = new (class extends FileSessionStorage {
			override openStagedWriter(filePath: string): StagedStreamingWriter {
				fs.renameSync(replacementPath, sourcePath);
				return super.openStagedWriter(filePath);
			}
		})();

		const captured = SessionManager.captureTranscriptStrict(sourcePath, storage);
		expect(captured.kind).toBe("captured");
		if (captured.kind !== "captured") throw new Error("Expected strict capture");
		expect(
			await SessionManager.forkFromCaptured(
				captured.snapshot,
				tempDir.path(),
				SessionManager.explicitDestination(destDir),
			),
		).toEqual({ kind: "error", reason: "identity-mismatch" });
		// The private staging directory was removed; the destination was never published.
		expect(fs.existsSync(destDir)).toBe(false);
		expect(
			fs.readdirSync(tempDir.path()).filter(name => name.includes(".fork-staging-") && !name.endsWith(".removing")),
		).toEqual([]);
	});

	it("never overwrites existing destination content (no-replace publication)", async () => {
		const tempDir = TempDir.createSync("@pi-memory-fork-noreplace-");
		const storage = new FileSessionStorage();
		const sessionFile = path.join(tempDir.path(), "source.jsonl");
		writeColdTranscript(storage, sessionFile, tempDir.path(), 4);
		const destDir = path.join(tempDir.path(), "dest");
		fs.mkdirSync(destDir);
		const foreignFile = path.join(destDir, "foreign.jsonl");
		fs.writeFileSync(foreignFile, `${JSON.stringify({ type: "session", id: "foreign" })}\n`);

		const captured = SessionManager.captureTranscriptStrict(sessionFile, storage);
		expect(captured.kind).toBe("captured");
		if (captured.kind !== "captured") throw new Error("Expected strict capture");
		const forked = await SessionManager.forkFromCaptured(
			captured.snapshot,
			tempDir.path(),
			SessionManager.explicitDestination(destDir),
		);
		expect(forked.kind).toBe("forked");
		if (forked.kind !== "forked") throw new Error("Expected strict fork success");
		try {
			// The foreign transcript is preserved byte-for-byte (never overwritten).
			expect(fs.readFileSync(foreignFile, "utf8")).toBe(`${JSON.stringify({ type: "session", id: "foreign" })}\n`);
			// The fork added its own fresh session alongside without touching foreign content.
			const forkedSessionFile = forked.manager.getSessionFile();
			expect(forkedSessionFile).toBeTruthy();
			if (forkedSessionFile) {
				expect(forkedSessionFile).not.toBe(foreignFile);
				expect(fs.readFileSync(foreignFile, "utf8")).toBe(
					`${JSON.stringify({ type: "session", id: "foreign" })}\n`,
				);
			}
		} finally {
			await forked.manager.close();
			tempDir.removeSync();
		}
	});

	it("forks through memory storage with staged-publication parity and no copied sidecars", async () => {
		class CapturedForkCountingStorage extends MemorySessionStorage {
			fullReads = 0;
			override readTextSync(filePath: string): string {
				if (!filePath.includes(".spill.")) this.fullReads++;
				return super.readTextSync(filePath);
			}
			override readBytesSync(filePath: string): Uint8Array {
				if (!filePath.includes(".spill.")) this.fullReads++;
				return super.readBytesSync(filePath);
			}
		}
		const storage = new CapturedForkCountingStorage();
		const sessionFile = "/sessions/source.jsonl";
		writeColdTranscript(storage, sessionFile, "/cwd", 12);
		storage.writeTextSync(
			sessionFile,
			`${storage.readTextSync(sessionFile)}${JSON.stringify({ type: "header_patch", patch: { title: "captured patch" } })}\n${JSON.stringify(
				{
					type: "entry_patch",
					entryId: "cold-0011",
					patch: { message: { role: "user", content: "captured patched message", timestamp: 11 } },
				},
			)}\n`,
		);
		storage.fullReads = 0;

		const captured = SessionManager.captureTranscriptStrict(sessionFile, storage);
		expect(captured.kind).toBe("captured");
		if (captured.kind !== "captured") throw new Error("Expected strict capture");
		expect("content" in captured.snapshot).toBe(false);
		const capturedLines: unknown[] = [];
		captured.snapshot.forEachLine(line => {
			capturedLines.push(JSON.parse(Buffer.from(line).toString("utf8")));
		});
		expect(capturedLines).toHaveLength(16);

		const forked = await SessionManager.forkFromCaptured(
			captured.snapshot,
			"/cwd",
			SessionManager.explicitDestination("/sessions/forked-memory"),
			"copy-retain",
			"enabled",
		);
		expect(forked).toMatchObject({ kind: "forked" });
		if (forked.kind !== "forked") throw new Error("Expected strict fork success");
		try {
			expect(forked.manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
			expect(storage.fullReads).toBe(0);
			expect(forked.manager.getSessionId()).not.toBe("fork-source");
			expect(forked.manager.getHeader()).toMatchObject({ title: "captured patch" });
			expect(forked.manager.getEntry("cold-0011")).toMatchObject({
				message: { content: "captured patched message" },
			});
			expect(forked.manager.getEntries()).toHaveLength(13);
			const forkedSessionFile = forked.manager.getSessionFile();
			expect(forkedSessionFile).toContain("/sessions/forked-memory");
			if (forkedSessionFile) {
				const lines = storage
					.readTextSync(forkedSessionFile)
					.trimEnd()
					.split("\n")
					.map(line => JSON.parse(line) as { id?: string });
				expect(lines).toHaveLength(14);
				expect(lines.some(entry => entry.id === "cold-0000")).toBe(true);
			}
		} finally {
			await forked.manager.close();
		}
	});

	it("restores eager state before an append would exceed the hot-suffix budget", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = "/sessions/append-budget.jsonl";
		writeColdTranscript(storage, sessionFile, "/cwd", 12);
		const manager = await SessionManager.open(sessionFile, SessionManager.explicitDestination("/sessions"), storage);
		try {
			manager.setSessionMemoryMode("enabled");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
			manager.setSidecarHotSuffixBudgetForTests(1);
			manager.appendMessage({ role: "user", content: "budget overflow", timestamp: 1 });
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(false);
			expect(manager.getSessionMemoryStats().hotOverflowTransitions).toBeGreaterThan(0);
			expect(manager.getEntry("cold-0000")).toMatchObject({ id: "cold-0000" });
			expect(manager.getEntries()).toHaveLength(14);
		} finally {
			await manager.close();
		}
	});

	it("preserves a valid final record without a trailing newline and rejects a truncated one", async () => {
		const storage = new MemorySessionStorage();
		const sourcePath = "/sessions/no-newline.jsonl";
		storage.writeTextSync(
			sourcePath,
			`${JSON.stringify({ type: "session", version: 5, id: "no-newline", timestamp: "0", cwd: "/cwd" })}\n${JSON.stringify({ type: "custom", id: "final", parentId: null, timestamp: "0", customType: "x" })}`,
		);
		const captured = SessionManager.captureTranscriptStrict(sourcePath, storage);
		expect(captured.kind).toBe("captured");
		if (captured.kind !== "captured") throw new Error("Expected strict capture");
		const forked = await SessionManager.forkFromCaptured(
			captured.snapshot,
			"/cwd",
			SessionManager.explicitDestination("/sessions/no-newline-fork"),
		);
		expect(forked.kind).toBe("forked");
		if (forked.kind === "forked") {
			expect(forked.manager.getEntry("final")).toMatchObject({ id: "final", type: "custom" });
			await forked.manager.close();
		}

		storage.writeTextSync(
			"/sessions/truncated.jsonl",
			`${JSON.stringify({ type: "session", version: 5, id: "bad", timestamp: "0", cwd: "/cwd" })}\n{"type":`,
		);
		const truncated = SessionManager.captureTranscriptStrict("/sessions/truncated.jsonl", storage);
		expect(truncated.kind).toBe("captured");
		if (truncated.kind !== "captured") throw new Error("Expected descriptor capture");
		expect(
			await SessionManager.forkFromCaptured(
				truncated.snapshot,
				"/cwd",
				SessionManager.explicitDestination("/sessions/truncated-fork"),
			),
		).toEqual({ kind: "error", reason: "malformed" });
	});
});
