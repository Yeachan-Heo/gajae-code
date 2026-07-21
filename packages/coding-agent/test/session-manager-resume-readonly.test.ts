import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteSessionPickerCandidate } from "@gajae-code/coding-agent/cli/session-picker";
import {
	createReadonlySessionManager,
	parseSessionEntries,
	type ResumeSessionIdentity,
	resolveResumableSession,
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
import * as native from "@gajae-code/natives";
import { getSessionsDir, getTerminalSessionsDir } from "@gajae-code/utils";
import { resolveManagedScope } from "../src/session/internal/managed-session-scope";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
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
	it("keeps strict managed read resolution fail-closed on ACL verification failure", () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		const sessionsRoot = path.join(agentDir, "sessions");
		fs.mkdirSync(cwd);
		fs.mkdirSync(sessionsRoot, { recursive: true });

		const initial = resolveManagedScope({ cwd, agentDir, sessionsRoot });
		if (initial.kind === "error") throw new Error(`Expected initial scope resolution: ${initial.message}`);
		fs.mkdirSync(initial.scope.directoryPath);

		const apply = vi.spyOn(native, "applyOwnerOnlyPathSecurity");
		const repair = vi.spyOn(native, "repairOwnerOnlyPathSecurityExpected");
		const verify = vi.spyOn(native, "verifyOwnerOnlyPathSecurity").mockReturnValue({
			ok: false,
			code: "acl_verify_failed",
		});
		const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
		expect(() => SessionManager.getDefaultSessionDirReadOnly(cwd, agentDir)).toThrow(
			"Could not resolve managed session scope: The managed scope security could not be verified.",
		);

		expect(resolved).toEqual({
			kind: "error",
			code: "binding_invalid",
			message: "The managed scope security could not be verified.",
		});
		expect(verify).toHaveBeenCalledWith(initial.scope.directoryPath, "directory");
		expect(apply).not.toHaveBeenCalled();
		expect(repair).not.toHaveBeenCalled();
	});
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

	it("opens an immutable v4 patch fixture with its final header and message state", async () => {
		const root = makeTempDir();
		const sessionDir = path.join(root, "sessions");
		const filePath = path.join(sessionDir, "v4.jsonl");
		const immutableV4Fixture = `{"type":"session","version":4,"id":"v4","title":"Initial title","timestamp":"1970-01-01T00:00:00.000Z","cwd":"/fixture-v4"}
{"type":"message","id":"message","parentId":null,"timestamp":"1970-01-01T00:00:01.000Z","message":{"role":"user","content":"before patch","timestamp":0}}
{"type":"header_patch","patch":{"title":"Patched title","cwd":"/fixture-v4-patched"}}
{"type":"entry_patch","entryId":"message","patch":{"message":{"role":"user","content":"after patch","timestamp":0}}}
`;
		fs.mkdirSync(sessionDir);
		fs.writeFileSync(filePath, immutableV4Fixture);
		const before = fs.readFileSync(filePath);
		const beforeMtimeNs = fs.statSync(filePath, { bigint: true }).mtimeNs;

		expect(await SessionManager.listForResumePickerReadOnly(root, sessionDir)).toHaveLength(1);
		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath);
		if (inspection.kind === "error") throw new Error("Expected v4 inspection");
		const opened = await SessionManager.openExistingStrict(inspection.identity, sessionDir);
		if (opened.kind === "error") throw new Error("Expected v4 strict open");
		expect(opened.manager.getHeader()).toMatchObject({ title: "Patched title", cwd: "/fixture-v4-patched" });
		expect(opened.manager.getCwd()).toBe("/fixture-v4-patched");
		expect(opened.manager.getEntries()).toMatchObject([
			{ type: "message", message: { role: "user", content: "after patch" } },
		]);
		await opened.manager.close();

		expect(fs.readFileSync(filePath)).toEqual(before);
		expect(fs.statSync(filePath, { bigint: true }).mtimeNs).toBe(beforeMtimeNs);
	});

	it("rejects future-version patch records before replay", () => {
		const content = [
			JSON.stringify({
				type: "session",
				version: 6,
				id: "future",
				timestamp: new Date(0).toISOString(),
				cwd: "/cwd",
			}),
			JSON.stringify({ type: "header_patch", patch: { title: "must-not-apply" } }),
		].join("\n");
		expect(() => parseSessionEntries(content)).toThrow("Unsupported session version: 6");
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

	it("rejects malformed v5 dedicated discovered built-in selections without writes", async () => {
		for (const selectedToolNames of [undefined, "search", ["search", 42]]) {
			const storage = new WriteTrackingStorage();
			const filePath = `/sessions/malformed-dedicated-${String(selectedToolNames)}.jsonl`;
			const header = {
				type: "session",
				id: `malformed-dedicated-${String(selectedToolNames)}`,
				timestamp: new Date(0).toISOString(),
				cwd: "/cwd",
				version: 5,
			};
			const entry = {
				type: "discovered_builtin_tool_selection",
				id: "bad-selection",
				parentId: "message",
				timestamp: new Date(0).toISOString(),
				...(selectedToolNames === undefined ? {} : { selectedToolNames }),
			};
			storage.writeTextSync(
				filePath,
				`${JSON.stringify(header)}\n${sessionText("ignored").split("\n").slice(1, 2)[0]}\n${JSON.stringify(entry)}\n`,
			);
			storage.writes = 0;
			const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, storage);
			expect(inspection).toEqual({ kind: "error", reason: "malformed" });
			const stat = storage.statSync(filePath);
			const identity: ResumeSessionIdentity = {
				canonicalPath: filePath,
				sessionId: header.id,
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				mtimeNs: stat.mtimeNs,
				sha256: "ignored",
			};
			expectStrictFailure(await SessionManager.openExistingStrict(identity, "/sessions", storage), "malformed");
			expect(storage.writes).toBe(0);
		}
	});

	it("preserves an explicit empty v5 dedicated discovered built-in selection without writes", async () => {
		const storage = new WriteTrackingStorage();
		const filePath = "/sessions/empty-discovered-builtins.jsonl";
		const header = {
			type: "session",
			id: "empty-discovered-builtins",
			timestamp: new Date(0).toISOString(),
			cwd: "/cwd",
			version: 5,
		};
		const entry = {
			type: "discovered_builtin_tool_selection",
			id: "empty-selection",
			parentId: "message",
			timestamp: new Date(0).toISOString(),
			selectedToolNames: [],
		};
		storage.writeTextSync(
			filePath,
			`${JSON.stringify(header)}\n${sessionText("ignored").split("\n").slice(1, 2)[0]}\n${JSON.stringify(entry)}\n`,
		);
		storage.writes = 0;
		const inspection = await SessionManager.inspectSessionTailReadOnly(filePath, storage);
		expect(inspection.kind).toBe("resumable");
		if (inspection.kind === "error") throw new Error("Expected resumable inspection");
		const opened = await SessionManager.openExistingStrict(inspection.identity, "/sessions", storage);
		expect(opened.kind).toBe("opened");
		if (opened.kind === "error") throw new Error("Expected opened session");
		expect(opened.manager.buildSessionContext()).toMatchObject({
			hasPersistedDiscoveredBuiltinToolSelection: true,
			selectedDiscoveredBuiltinToolNames: [],
		});
		expect(storage.writes).toBe(0);
	});

	it("preserves inspected migration state until the first v5 persistence rewrite", async () => {
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
		expect(rewritten[0]).toMatchObject({ type: "session", version: 5 });
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
	it("shares a custom managed root between default picker inventory and strict-open preparation", async () => {
		const root = makeTempDir();
		const agentDir = path.join(root, "custom-agent");
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "custom root", timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected managed session file");

		const listed = await SessionManager.listManagedForResumePickerReadOnly(cwd, agentDir);
		expect(listed.map(session => session.id)).toContain(manager.getSessionId());
		const resolvedById = await resolveResumableSession(manager.getSessionId(), cwd, undefined, undefined, agentDir);
		expect(resolvedById).toMatchObject({ scope: "local", session: { path: sessionFile } });
		const inspection = await SessionManager.inspectSessionTailReadOnly(sessionFile);
		if (inspection.kind === "error") throw new Error("Expected resumable inspection");
		const opened = await SessionManager.openExistingStrict(inspection.identity, destination);
		expect(opened.kind).toBe("opened");
		if (opened.kind === "error") throw new Error("Expected strict open");
		await opened.manager.close();
	});
	it("does not let an outside terminal breadcrumb override an explicit resume directory", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const explicitDirectory = path.join(root, "explicit");
		const outsideDirectory = path.join(root, "outside");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(explicitDirectory);
		const outside = SessionManager.create(cwd, SessionManager.explicitDestination(outsideDirectory));
		outside.appendMessage({ role: "user", content: "outside", timestamp: 1 });
		await outside.ensureOnDisk();
		await outside.flush();
		const outsideFile = outside.getSessionFile();
		if (!outsideFile) throw new Error("Expected outside session file");
		await outside.close();
		const originalTmux = process.env.TMUX;
		const originalPane = process.env.TMUX_PANE;
		const pane = `%explicit-resume-${Date.now()}-${Math.random()}`;
		const breadcrumbFile = path.join(getTerminalSessionsDir(), `tmux-${pane}`);
		process.env.TMUX = "/tmp/test-tmux,1,0";
		process.env.TMUX_PANE = pane;
		try {
			fs.mkdirSync(getTerminalSessionsDir(), { recursive: true });
			fs.symlinkSync(
				outsideDirectory,
				path.join(explicitDirectory, "escape"),
				process.platform === "win32" ? "junction" : "dir",
			);
			fs.writeFileSync(
				breadcrumbFile,
				`${cwd}\n${path.join(explicitDirectory, "escape", path.basename(outsideFile))}\n`,
			);
			const resumed = await SessionManager.continueRecent(
				cwd,
				SessionManager.explicitDestination(explicitDirectory),
			);
			try {
				expect(resumed.getSessionFile()).not.toBe(outsideFile);
				expect(resumed.getSessionDir()).toBe(explicitDirectory);
			} finally {
				await resumed.close();
			}
		} finally {
			fs.rmSync(breadcrumbFile, { force: true });
			if (originalTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = originalTmux;
			if (originalPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalPane;
		}
	});
	it("uses manager-bound picker inventory for explicit-only and managed legacy candidates", async () => {
		const root = makeTempDir();
		const agentDir = path.join(root, "custom-agent");
		const cwd = path.join(root, "workspace");
		const sessionsRoot = path.join(agentDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "current", timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.flush();
		const currentPath = manager.getSessionFile();
		if (!currentPath) throw new Error("Expected managed current transcript");
		await manager.close();

		const legacyDirectory = path.join(
			sessionsRoot,
			`--${path
				.resolve(cwd)
				.replace(/^[/\\]/, "")
				.replace(/[/\\:]/g, "-")}--`,
		);
		const legacyPath = path.join(legacyDirectory, "legacy.jsonl");
		fs.mkdirSync(legacyDirectory, { recursive: true });
		fs.writeFileSync(legacyPath, sessionText("legacy").replace('"cwd":"/cwd"', `"cwd":${JSON.stringify(cwd)}`));

		const explicitManager = SessionManager.create(cwd, SessionManager.explicitDestination(destination.directory));
		const explicit = await explicitManager.listForResumePickerReadOnly();
		expect(explicit.map(session => session.path)).toEqual([currentPath]);

		const managed = await manager.listForResumePickerReadOnly();
		expect(managed.map(session => session.path)).toEqual(expect.arrayContaining([currentPath, legacyPath]));
	});
	it("rejects a replacement after managed preparation before strict adoption", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const inspection = await SessionManager.inspectSessionTailReadOnly(sessionFile);
		if (inspection.kind === "error") throw new Error("Expected session inspection");
		const preparedPath = await manager.prepareManagedCandidateForStrictAdoption(
			sessionFile,
			"copy-retain",
			inspection.identity,
		);
		const replacement = path.join(root, "replacement.jsonl");
		fs.writeFileSync(replacement, fs.readFileSync(preparedPath));
		fs.renameSync(replacement, preparedPath);
		await expect(manager.setSessionFile(preparedPath)).rejects.toThrow("changed before strict adoption");
		await manager.close();
	});
	it("rejects source identity drift at the final prepared migration receipt publication guard", async () => {
		const root = makeTempDir();
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "workspace");
		const sessionsRoot = path.join(agentDir, "sessions");
		const legacyDirectory = path.join(
			sessionsRoot,
			`--${path
				.resolve(cwd)
				.replace(/^[/\\]/, "")
				.replace(/[/\\:]/g, "-")}--`,
		);
		const legacyPath = path.join(legacyDirectory, "legacy.jsonl");
		const replacementPath = path.join(root, "same-bytes-replacement.jsonl");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		fs.mkdirSync(legacyDirectory, { recursive: true });
		fs.writeFileSync(legacyPath, sessionText("legacy").replace('"cwd":"/cwd"', `"cwd":${JSON.stringify(cwd)}`));
		const inspection = await SessionManager.inspectSessionTailReadOnly(legacyPath);
		if (inspection.kind === "error") throw new Error("Expected legacy inspection");
		fs.writeFileSync(replacementPath, fs.readFileSync(legacyPath));
		const protocolRoot = path.join(destination.directory, ".gjc-managed-session-internal");
		const before = {
			receipts: fs.readdirSync(path.join(protocolRoot, "receipts")),
			tombstones: fs.readdirSync(path.join(protocolRoot, "tombstones")),
		};
		const assertBound = ManagedSessionDescendantStore.prototype.assertBound;
		let publicationGuards = 0;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "assertBound").mockImplementation(function (
			this: ManagedSessionDescendantStore,
		) {
			assertBound.call(this);
			const stack = new Error().stack ?? "";
			if (
				stack.includes("publishManagedFileNoReplace") &&
				stack.includes("assertPublicationConsent") &&
				++publicationGuards === 2
			)
				fs.renameSync(replacementPath, legacyPath);
		});

		expectStrictFailure(
			await SessionManager.openExistingStrict(inspection.identity, destination),
			"identity-mismatch",
		);
		expect(publicationGuards).toBe(2);
		expect(fs.readdirSync(path.join(protocolRoot, "receipts"))).toEqual(before.receipts);
		expect(fs.readdirSync(path.join(protocolRoot, "tombstones"))).toEqual(before.tombstones);
		expect(fs.existsSync(path.join(destination.directory, path.basename(legacyPath)))).toBe(false);
		expect(fs.existsSync(path.join(destination.directory, path.basename(legacyPath).slice(0, -6)))).toBe(false);
	});

	it("keeps an explicit resume destination explicit without managed preparation or migration", async () => {
		const root = makeTempDir();
		const explicitDirectory = path.join(root, "explicit");
		const selectedPath = path.join(explicitDirectory, "selected.jsonl");
		fs.mkdirSync(explicitDirectory);
		fs.writeFileSync(selectedPath, sessionText("explicit"));
		const inspection = await SessionManager.inspectSessionTailReadOnly(selectedPath);
		if (inspection.kind === "error") throw new Error("Expected explicit inspection");
		const prepare = vi.spyOn(SessionManager, "prepareManagedCandidateForWrite");

		const opened = await SessionManager.openExistingStrict(
			inspection.identity,
			SessionManager.explicitDestination(explicitDirectory),
		);

		expect(opened.kind).toBe("opened");
		if (opened.kind === "opened") await opened.manager.close();
		expect(prepare).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(explicitDirectory, ".gjc-managed-session-scope.v2.json"))).toBe(false);
		expect(fs.existsSync(path.join(explicitDirectory, ".gjc-managed-session-internal"))).toBe(false);
	});

	it("fails closed at the final migration seam when captured managed authority is replaced", async () => {
		const root = makeTempDir();
		const agentDir = path.join(root, "custom-agent");
		const cwd = path.join(root, "workspace");
		const sessionsRoot = path.join(agentDir, "sessions");
		const legacyDirectory = path.join(
			sessionsRoot,
			`--${path
				.resolve(cwd)
				.replace(/^[/\\]/, "")
				.replace(/[/\\:]/g, "-")}--`,
		);
		const legacyPath = path.join(legacyDirectory, "legacy.jsonl");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		fs.mkdirSync(legacyDirectory, { recursive: true });
		fs.writeFileSync(legacyPath, sessionText("legacy").replace('"cwd":"/cwd"', `"cwd":${JSON.stringify(cwd)}`));
		const candidateBefore = fs.readFileSync(legacyPath);
		const protocolRoot = path.join(destination.directory, ".gjc-managed-session-internal");
		const bindingPath = path.join(destination.directory, ".gjc-managed-session-scope.v2.json");
		const bindingBefore = fs.readFileSync(bindingPath);
		const receiptsBefore = fs.readdirSync(path.join(protocolRoot, "receipts"));
		const tombstonesBefore = fs.readdirSync(path.join(protocolRoot, "tombstones"));
		const displacedAgentDir = path.join(root, "displaced-agent");
		const assertBound = ManagedSessionDescendantStore.prototype.assertBound;
		let assertions = 0;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "assertBound").mockImplementation(function (
			this: ManagedSessionDescendantStore,
		) {
			assertBound.call(this);
			assertions++;
			if (assertions === 5) {
				fs.renameSync(agentDir, displacedAgentDir);
				fs.cpSync(displacedAgentDir, agentDir, { recursive: true });
			}
		});

		await expect(
			SessionManager.prepareManagedCandidateForWrite(legacyPath, "copy-retain", destination),
		).rejects.toThrow("Managed descendant root binding changed");

		expect(assertions).toBe(5);
		expect(fs.readFileSync(legacyPath)).toEqual(candidateBefore);
		expect(fs.readFileSync(bindingPath)).toEqual(bindingBefore);
		expect(fs.readdirSync(path.join(protocolRoot, "receipts"))).toEqual(receiptsBefore);
		expect(fs.readdirSync(path.join(protocolRoot, "tombstones"))).toEqual(tombstonesBefore);
		expect(fs.existsSync(path.join(destination.directory, path.basename(legacyPath)))).toBe(false);
		expect(fs.existsSync(path.join(destination.directory, path.basename(legacyPath).slice(0, -6)))).toBe(false);
		expect(fs.existsSync(path.join(legacyDirectory, ".gjc-managed-session-scope.v2.json"))).toBe(false);
	});
});
