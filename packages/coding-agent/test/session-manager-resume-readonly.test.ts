import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteSessionPickerCandidate } from "@gajae-code/coding-agent/cli/session-picker";
import {
	createReadonlySessionManager,
	type ResumeSessionIdentity,
	SessionManager,
	type StrictSessionOpenResult,
	sessionArtifactCapability,
} from "@gajae-code/coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorageSnapshot,
	type SessionStorageStat,
	type SessionStorageWriter,
} from "@gajae-code/coding-agent/session/session-storage";
import { getSessionsDir } from "@gajae-code/utils";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-readonly-"));
	tempDirs.push(dir);
	return dir;
}

class WriteTrackingStorage extends MemorySessionStorage {
	writes = 0;

	override writeTextSync(filePath: string, content: string): void {
		this.writes++;
		super.writeTextSync(filePath, content);
	}

	override async writeText(filePath: string, content: string): Promise<void> {
		this.writes++;
		await super.writeText(filePath, content);
	}

	override openWriter(
		filePath: string,
		options?: { flags?: "a" | "w"; onError?: (error: Error) => void },
	): SessionStorageWriter {
		this.writes++;
		return super.openWriter(filePath, options);
	}
}

class UnstableReadStorage extends WriteTrackingStorage {
	unstable = false;
	#statCalls = 0;

	override statSync(filePath: string): SessionStorageStat {
		const stat = super.statSync(filePath);
		if (!this.unstable) return stat;
		this.#statCalls++;
		return {
			...stat,
			mtimeMs: stat.mtimeMs + this.#statCalls,
			mtimeNs: stat.mtimeNs + BigInt(this.#statCalls),
			mtime: new Date(stat.mtimeMs + this.#statCalls),
		};
	}
}

class FixedMtimeStorage extends WriteTrackingStorage {
	override statSync(filePath: string): SessionStorageStat {
		return { ...super.statSync(filePath), mtimeMs: 1, mtimeNs: 1_000_000n, mtime: new Date(1) };
	}

	override readSnapshotSync(filePath: string): SessionStorageSnapshot {
		return { ...super.readSnapshotSync(filePath), stat: this.statSync(filePath) };
	}
}

class HandoffMutationStorage extends MemorySessionStorage {
	reads = 0;

	constructor(private readonly replacement: string) {
		super();
	}

	override readSnapshotSync(filePath: string): SessionStorageSnapshot {
		const snapshot = super.readSnapshotSync(filePath);
		this.reads++;
		if (this.reads === 2) queueMicrotask(() => super.writeTextSync(filePath, this.replacement));
		return snapshot;
	}
}

class NonRegularStorage extends WriteTrackingStorage {
	reads = 0;

	override statSync(filePath: string): SessionStorageStat {
		return { ...super.statSync(filePath), isFile: false };
	}

	override readSnapshotSync(filePath: string): SessionStorageSnapshot {
		this.reads++;
		throw new Error(`Non-regular path must be rejected before read: ${filePath}`);
	}
}

class FifoReadTrackingStorage extends FileSessionStorage {
	reads = 0;

	override readBytesSync(filePath: string): Uint8Array {
		this.reads++;
		throw new Error(`FIFO must be rejected before read: ${filePath}`);
	}
}

class ReplaceAfterSnapshotStorage extends FileSessionStorage {
	armed = false;
	writes = 0;

	constructor(private readonly replacementPath: string) {
		super();
	}

	override writeTextSync(filePath: string, content: string): void {
		this.writes++;
		super.writeTextSync(filePath, content);
	}

	override async writeText(filePath: string, content: string): Promise<void> {
		this.writes++;
		await super.writeText(filePath, content);
	}

	override openWriter(
		filePath: string,
		options?: { flags?: "a" | "w"; onError?: (error: Error) => void },
	): SessionStorageWriter {
		this.writes++;
		return super.openWriter(filePath, options);
	}

	override readSnapshotSync(filePath: string): SessionStorageSnapshot {
		const snapshot = super.readSnapshotSync(filePath);
		if (this.armed) {
			this.armed = false;
			fs.renameSync(this.replacementPath, filePath);
		}
		return snapshot;
	}
}
class ReplaceDuringFinalAuthorityInspectionStorage extends FileSessionStorage {
	constructor(
		private readonly replacementPath: string,
		private readonly sourcePath: string,
	) {
		super();
	}

	override async rename(filePath: string, nextPath: string): Promise<void> {
		await super.rename(filePath, nextPath);
		if (path.resolve(nextPath) !== path.resolve(this.sourcePath) && nextPath.endsWith(".jsonl"))
			fs.renameSync(this.replacementPath, this.sourcePath);
	}
}

function expectStrictFailure(
	result: StrictSessionOpenResult,
	reason: "missing" | "malformed" | "unstable" | "read-failed" | "identity-mismatch",
): void {
	expect(result).toEqual({ kind: "error", reason });
}

function sessionText(id: string, role: "user" | "assistant" = "user"): string {
	const header = { type: "session", id, timestamp: new Date(0).toISOString(), cwd: "/cwd", version: 3 };
	const message =
		role === "user"
			? {
					type: "message",
					id: "message",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					message: { role, content: "resume", timestamp: 0 },
				}
			: {
					type: "message",
					id: "message",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					message: { role, content: [], provider: "test", model: "test", timestamp: 0 },
				};
	return `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`;
}

describe("SessionManager read-only resume", () => {
	it("lists and inspects without maintenance writes, then strictly opens the approved identity", async () => {
		const storage = new WriteTrackingStorage();
		const filePath = "/sessions/resume.jsonl";
		storage.writeTextSync(filePath, sessionText("session-a"));
		storage.writes = 0;

		await SessionManager.listForResumePickerReadOnly("/cwd", "/sessions", storage);
		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, storage);
		expect(inspection.kind).toBe("resumable");
		expect(storage.writes).toBe(0);
		if (inspection.kind === "error") throw new Error("Expected resumable inspection");

		const opened = await SessionManager.openExistingStrict(inspection.identity, "/sessions", storage);
		expect(opened.kind).toBe("opened");
		if (opened.kind === "error") throw new Error("Expected strict open success");
		expect(opened.manager.getSessionId()).toBe("session-a");
		expect(storage.writes).toBe(0);
	});

	it("reads v4 entry patches without changing the selected transcript", async () => {
		const root = makeTempDir();
		const sessionDir = path.join(root, "sessions");
		const filePath = path.join(sessionDir, "v4.jsonl");
		const records = [
			{ type: "session", version: 4, id: "v4", timestamp: new Date(0).toISOString(), cwd: root },
			{
				type: "message",
				id: "message",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "before patch", timestamp: 0 },
			},
			{
				type: "entry_patch",
				entryId: "message",
				patch: { message: { role: "user", content: "after patch", timestamp: 0 } },
			},
		];
		fs.mkdirSync(sessionDir);
		fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const before = fs.readFileSync(filePath);
		const beforeMtimeNs = fs.statSync(filePath, { bigint: true }).mtimeNs;

		expect(await SessionManager.listForResumePickerReadOnly(root, sessionDir)).toHaveLength(1);
		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath);
		if (inspection.kind === "error") throw new Error("Expected v4 inspection");
		const opened = await SessionManager.openExistingStrict(inspection.identity, sessionDir);
		if (opened.kind === "error") throw new Error("Expected v4 strict open");
		expect(opened.manager.getEntries()).toMatchObject([
			{ type: "message", message: { role: "user", content: "after patch" } },
		]);
		await opened.manager.close();

		expect(fs.readFileSync(filePath)).toEqual(before);
		expect(fs.statSync(filePath, { bigint: true }).mtimeNs).toBe(beforeMtimeNs);
	});

	it("exposes descriptor-bound device and inode identity", async () => {
		const storage = new MemorySessionStorage();
		const filePath = "/sessions/identity.jsonl";
		storage.writeTextSync(filePath, sessionText("session-a"));

		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, storage);
		if (inspection.kind === "error") throw new Error("Expected inspection identity");
		expect(inspection.identity).toMatchObject({
			dev: storage.statSync(filePath).dev,
			ino: storage.statSync(filePath).ino,
			size: storage.statSync(filePath).size,
			mtimeMs: storage.statSync(filePath).mtimeMs,
			mtimeNs: storage.statSync(filePath).mtimeNs,
		});
	});

	it("rejects a same-size same-mtime pathname replacement after descriptor snapshot", async () => {
		const root = makeTempDir();
		const filePath = path.join(root, "resume.jsonl");
		const replacementPath = path.join(root, "replacement.jsonl");
		const original = sessionText("session-a");
		const replacement = original.replace("resume", "resumf");
		fs.writeFileSync(filePath, original);
		fs.writeFileSync(replacementPath, replacement);
		const mtime = new Date(1_000);
		fs.utimesSync(filePath, mtime, mtime);
		fs.utimesSync(replacementPath, mtime, mtime);
		const storage = new ReplaceAfterSnapshotStorage(replacementPath);
		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, storage);
		if (inspection.kind === "error") throw new Error("Expected inspection identity");

		storage.armed = true;
		expectStrictFailure(await SessionManager.openExistingStrict(inspection.identity, root, storage), "unstable");
		expect(storage.writes).toBe(0);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(replacement);
	});
	it("removes a newly created fork directory when final source authority changes", async () => {
		const root = makeTempDir();
		const sourcePath = path.join(root, "source.jsonl");
		const replacementPath = path.join(root, "replacement.jsonl");
		const destinationDir = path.join(root, "destination-sessions");
		const targetCwd = path.join(root, "target");
		fs.mkdirSync(targetCwd);
		fs.writeFileSync(sourcePath, sessionText("session-a"));
		fs.writeFileSync(replacementPath, sessionText("session-b"));
		const storage = new ReplaceDuringFinalAuthorityInspectionStorage(replacementPath, sourcePath);
		const captured = SessionManager.captureTranscriptStrict(sourcePath, storage);
		if (captured.kind !== "captured") throw new Error("Expected strict transcript capture");

		expect(await SessionManager.forkFromCaptured(captured.snapshot, targetCwd, destinationDir)).toEqual({
			kind: "error",
			reason: "identity-mismatch",
		});
		expect(fs.existsSync(destinationDir)).toBe(false);
	});

	it("fails closed with typed reasons for replacement, malformed, deletion, and unstable reads", async () => {
		const storage = new WriteTrackingStorage();
		const filePath = "/sessions/resume.jsonl";
		storage.writeTextSync(filePath, sessionText("session-a"));
		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, storage);
		if (inspection.kind === "error") throw new Error("Expected inspection identity");
		const identity: ResumeSessionIdentity = inspection.identity;

		storage.writeTextSync(filePath, sessionText("session-b"));
		storage.writes = 0;
		expectStrictFailure(await SessionManager.openExistingStrict(identity, "/sessions", storage), "identity-mismatch");
		expect(storage.writes).toBe(0);

		storage.writeTextSync(filePath, "not json\n");
		storage.writes = 0;
		expectStrictFailure(await SessionManager.openExistingStrict(identity, "/sessions", storage), "malformed");
		expect(storage.writes).toBe(0);

		storage.unlinkSync(filePath);
		storage.writes = 0;
		expectStrictFailure(await SessionManager.openExistingStrict(identity, "/sessions", storage), "missing");
		expect(storage.writes).toBe(0);
	});

	it("rejects same-size same-mtime byte mutations by digest", async () => {
		const storage = new FixedMtimeStorage();
		const filePath = "/sessions/resume.jsonl";
		const original = sessionText("session-a");
		const mutated = original.replace("resume", "resumf");
		expect(mutated.length).toBe(original.length);
		storage.writeTextSync(filePath, original);
		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, storage);
		if (inspection.kind === "error") throw new Error("Expected inspection identity");

		storage.writeTextSync(filePath, mutated);
		storage.writes = 0;
		expect(storage.statSync(filePath)).toMatchObject({ size: inspection.identity.size, mtimeMs: 1 });
		expectStrictFailure(
			await SessionManager.openExistingStrict(inspection.identity, "/sessions", storage),
			"identity-mismatch",
		);
		expect(storage.writes).toBe(0);
	});

	it("revalidates identity after async hydration before ownership", async () => {
		const filePath = "/sessions/handoff.jsonl";
		const storage = new HandoffMutationStorage(sessionText("session-a", "assistant"));
		storage.writeTextSync(filePath, sessionText("session-a"));
		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, storage);
		if (inspection.kind === "error") throw new Error("Expected inspection identity");

		expectStrictFailure(
			await SessionManager.openExistingStrict(inspection.identity, "/sessions", storage),
			"identity-mismatch",
		);
		expect(storage.reads).toBe(3);
		expect(storage.readTextSync(filePath)).toContain('"role":"assistant"');
	});

	it("fails closed on invalid UTF-8 instead of parsing replacement text", async () => {
		const root = makeTempDir();
		const filePath = path.join(root, "invalid-utf8.jsonl");
		const bytes = Buffer.from(sessionText("session-a"));
		bytes[bytes.length - 2] = 0xff;
		fs.writeFileSync(filePath, bytes);

		expect(await SessionManager.inspectSessionTailReadOnly(filePath)).toEqual({
			kind: "error",
			reason: "malformed",
		});
	});

	it("maps schema-invalid JSONL to malformed during inspection and strict open", async () => {
		const storage = new WriteTrackingStorage();
		const filePath = "/sessions/schema-invalid.jsonl";
		const header = {
			type: "session",
			id: "schema-invalid",
			timestamp: new Date(0).toISOString(),
			cwd: "/cwd",
			version: 3,
		};
		const invalidEntry = { type: "ttsr_injection", id: "bad", parentId: null, timestamp: new Date(0).toISOString() };
		storage.writeTextSync(filePath, `${JSON.stringify(header)}\n${JSON.stringify(invalidEntry)}\n`);
		const stat = storage.statSync(filePath);
		const identity: ResumeSessionIdentity = {
			canonicalPath: filePath,
			sessionId: "schema-invalid",
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			mtimeNs: stat.mtimeNs,
			sha256: "ignored",
		};

		expectStrictFailure(await SessionManager.openExistingStrict(identity, "/sessions", storage), "malformed");
		expect(await SessionManager.inspectSessionTailReadOnly(filePath, storage)).toEqual({
			kind: "error",
			reason: "malformed",
		});
	});

	it("preserves inspected migration state until the first v4 persistence rewrite", async () => {
		const storage = new WriteTrackingStorage();
		const filePath = "/sessions/legacy-v2.jsonl";
		const header = {
			type: "session",
			id: "legacy-v2",
			timestamp: new Date(0).toISOString(),
			cwd: "/cwd",
			version: 2,
		};
		const entry = {
			type: "message",
			id: "legacy-message",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "legacy", timestamp: 0 },
		};
		const legacy = `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
		storage.writeTextSync(filePath, legacy);
		storage.writes = 0;

		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, storage);
		if (inspection.kind === "error") throw new Error("Expected legacy inspection");
		const opened = await SessionManager.openExistingStrict(inspection.identity, "/sessions", storage);
		expect(opened.kind).toBe("opened");
		expect(storage.writes).toBe(0);
		if (opened.kind === "error") throw new Error("Expected strict open");

		opened.manager.appendMessage({ role: "user", content: "after migration", timestamp: 1 });
		await opened.manager.flush();
		const rewritten = storage
			.readTextSync(filePath)
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(rewritten[0]).toMatchObject({ type: "session", version: 4 });
		expect(rewritten).toHaveLength(3);
		expect(rewritten.every(line => line.type === "session" || typeof line.id === "string")).toBe(true);
	});

	it("inspects and strictly opens a checked-in legacy transcript", async () => {
		const root = makeTempDir();
		const filePath = path.join(root, "legacy-session.jsonl");
		fs.copyFileSync(path.join(import.meta.dir, "fixtures", "large-session.jsonl"), filePath);
		const before = fs.readFileSync(filePath);
		const beforeMtime = fs.statSync(filePath).mtimeMs;

		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath);
		if (inspection.kind === "error") throw new Error(`Expected legacy fixture inspection, got ${inspection.reason}`);
		const opened = await SessionManager.openExistingStrict(inspection.identity, root);
		expect(opened.kind).toBe("opened");
		if (opened.kind === "opened") await opened.manager.close();
		expect(fs.readFileSync(filePath)).toEqual(before);
		expect(fs.statSync(filePath).mtimeMs).toBe(beforeMtime);
	});

	it("fails closed when strict stat/read/stat detects an unstable file", async () => {
		const storage = new UnstableReadStorage();
		const filePath = "/sessions/resume.jsonl";
		storage.writeTextSync(filePath, sessionText("session-a"));
		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, storage);
		if (inspection.kind === "error") throw new Error("Expected inspection identity");
		storage.unstable = true;
		storage.writes = 0;
		expectStrictFailure(
			await SessionManager.openExistingStrict(inspection.identity, "/sessions", storage),
			"unstable",
		);
		expect(storage.writes).toBe(0);
	});

	it("rejects non-regular selected paths before invoking the in-memory read seam", async () => {
		const filePath = "/sessions/resume.jsonl";
		const initialStorage = new WriteTrackingStorage();
		initialStorage.writeTextSync(filePath, sessionText("session-a"));
		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, initialStorage);
		if (inspection.kind === "error") throw new Error("Expected inspection identity");

		const replacementStorage = new NonRegularStorage();
		replacementStorage.writeTextSync(filePath, sessionText("session-a"));
		replacementStorage.writes = 0;
		expectStrictFailure(
			await SessionManager.openExistingStrict(inspection.identity, "/sessions", replacementStorage),
			"read-failed",
		);
		expect(replacementStorage.writes).toBe(0);
		expect(replacementStorage.reads).toBe(0);
	});

	it.skipIf(process.platform === "win32")("rejects a FIFO before its read path can block", async () => {
		const root = makeTempDir();
		const fifoPath = path.join(root, "selected.jsonl");
		const mkfifo = Bun.spawnSync(["mkfifo", fifoPath]);
		expect(mkfifo.exitCode).toBe(0);
		const storage = new FifoReadTrackingStorage();

		expect(await SessionManager.inspectSessionTailReadOnly(fifoPath, storage)).toEqual({
			kind: "error",
			reason: "read-failed",
		});
		expect(storage.reads).toBe(0);
	});

	it("freshly inspects a terminal replacement instead of using stale resumability", async () => {
		const storage = new WriteTrackingStorage();
		const filePath = "/sessions/resume.jsonl";
		storage.writeTextSync(filePath, sessionText("session-a"));
		expect((await SessionManager.inspectSessionTailReadOnly(filePath, storage)).kind).toBe("resumable");
		storage.writeTextSync(filePath, sessionText("session-b", "assistant"));
		expect((await SessionManager.inspectSessionTailReadOnly(filePath, storage)).kind).toBe("terminal");
	});
	it("preserves transcript and draft sidecar bytes and mtimes during cancel-path discovery and inspection", async () => {
		const root = makeTempDir();
		const sessionDir = path.join(root, "sessions");
		const manager = SessionManager.create(root, sessionDir);
		manager.appendMessage({ role: "user", content: "resume without mutation", timestamp: 0 });
		await manager.ensureOnDisk();
		await manager.flush();
		await manager.saveDraft("unsent draft");
		const transcriptPath = manager.getSessionFile();
		const artifactsDir = manager.getArtifactsDir();
		if (!transcriptPath || !artifactsDir) throw new Error("Expected persisted transcript and artifacts directory");
		const draftPath = path.join(artifactsDir, "draft.txt");
		await manager.close();

		const beforeTranscript = fs.readFileSync(transcriptPath);
		const beforeDraft = fs.readFileSync(draftPath);
		const beforeTranscriptStat = fs.statSync(transcriptPath);
		const beforeDraftStat = fs.statSync(draftPath);

		const listed = await SessionManager.listForResumePickerReadOnly(root, sessionDir);
		expect(listed).toHaveLength(1);
		const inspection = await SessionManager.inspectSessionTailReadOnly(transcriptPath);
		expect(inspection.kind).toBe("resumable");

		expect(fs.readFileSync(transcriptPath)).toEqual(beforeTranscript);
		expect(fs.readFileSync(draftPath)).toEqual(beforeDraft);
		expect(fs.statSync(transcriptPath).mtimeMs).toBe(beforeTranscriptStat.mtimeMs);
		expect(fs.statSync(draftPath).mtimeMs).toBe(beforeDraftStat.mtimeMs);
	});
	it.skipIf(process.platform === "win32")("binds symlink inspection to its original real target", async () => {
		const root = makeTempDir();
		const targetA = path.join(root, "target-a.jsonl");
		const targetB = path.join(root, "target-b.jsonl");
		const linkPath = path.join(root, "selected.jsonl");
		fs.writeFileSync(targetA, sessionText("session-a"));
		fs.writeFileSync(targetB, sessionText("session-b"));
		fs.symlinkSync(targetA, linkPath);

		const inspection = await SessionManager.inspectSessionTailReadOnly(linkPath);
		if (inspection.kind === "error") throw new Error("Expected symlink inspection");
		expect(inspection.identity.canonicalPath).toBe(fs.realpathSync(targetA));
		fs.unlinkSync(linkPath);
		fs.symlinkSync(targetB, linkPath);

		const opened = await SessionManager.openExistingStrict(inspection.identity, root);
		expect(opened.kind).toBe("opened");
		if (opened.kind === "error") throw new Error("Expected strict open");
		expect(opened.manager.getSessionId()).toBe("session-a");
		await opened.manager.close();
	});

	it("requires explicit directories for custom-storage resume inventory without writes", async () => {
		const storage = new WriteTrackingStorage();
		const cwd = makeTempDir();
		const legacyName = `--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`;
		const legacyPath = path.join(getSessionsDir(), legacyName, "legacy.jsonl");
		const explicitPath = "/explicit/current.jsonl";
		storage.writeTextSync(legacyPath, sessionText("legacy").replace('"cwd":"/cwd"', `"cwd":${JSON.stringify(cwd)}`));
		storage.writeTextSync(explicitPath, sessionText("explicit"));
		storage.writes = 0;

		const defaults = await SessionManager.listForResumePickerReadOnly(cwd, undefined, storage);
		expect(defaults).toEqual([]);
		expect(await SessionManager.listForResumePickerReadOnly(cwd, "/explicit", storage)).toHaveLength(1);
		expect(storage.writes).toBe(0);
	});
});

describe("readonly session artifact authority", () => {
	it("preserves hidden artifact spill authority without exposing mutation methods", async () => {
		const root = makeTempDir();
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const readonly = createReadonlySessionManager(manager);

		expect("saveArtifact" in readonly).toBe(false);
		const capability = sessionArtifactCapability(readonly);
		expect(capability).toBeDefined();
		const artifactId = await capability?.saveArtifact("full SDK tool output", "sdk-tool");
		expect(artifactId).toBeDefined();
		if (artifactId) {
			const artifactPath = await manager.getArtifactPath(artifactId);
			if (!artifactPath) throw new Error("Expected persisted artifact path");
			expect(await Bun.file(artifactPath).text()).toBe("full SDK tool output");
		}
		expect(sessionArtifactCapability({ ...readonly })).toBeUndefined();
	});
});

describe("CLI session picker deletion scope", () => {
	it("deletes candidates from an explicit session directory without managed authorization", async () => {
		const root = makeTempDir();
		const explicitDir = path.join(root, "explicit");
		const sessionFile = path.join(explicitDir, "picked.jsonl");
		const artifactsDir = sessionFile.slice(0, -6);
		await fs.promises.mkdir(artifactsDir, { recursive: true });
		await Bun.write(sessionFile, "session\n");
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "artifact");

		await deleteSessionPickerCandidate(sessionFile, explicitDir);

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(false);
		await expect(deleteSessionPickerCandidate(path.join(root, "outside.jsonl"), explicitDir)).rejects.toThrow(
			"escaped",
		);
	});
});

describe("active managed picker root", () => {
	it("lists from a custom agent root instead of the process-global root", async () => {
		const root = makeTempDir();
		const agentDir = path.join(root, "custom-agent");
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionDir = SessionManager.getDefaultSessionDir(cwd, agentDir);
		const manager = SessionManager.create(cwd, sessionDir);
		manager.appendMessage({ role: "user", content: "custom root", timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.flush();

		const listed = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);

		expect(listed.map(session => session.id)).toContain(manager.getSessionId());
	});
});
