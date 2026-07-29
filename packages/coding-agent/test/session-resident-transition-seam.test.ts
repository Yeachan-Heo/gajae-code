import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { EphemeralBlobStore, MemoryBlobStore } from "@gajae-code/coding-agent/session/blob-store";
import type {
	MemoryGuardParticipantDescriptorV1,
	MemoryGuardSessionManagerCheckpointV1,
} from "@gajae-code/coding-agent/session/memory-guard-checkpoint-participant";
import {
	CURRENT_SESSION_VERSION,
	type SessionDestinationInput,
	SessionManager,
	SessionManagerTestHooks,
} from "@gajae-code/coding-agent/session/session-manager";
import { MemorySessionStorage } from "@gajae-code/coding-agent/session/session-storage";

import type { RecoveryFsRoot } from "@gajae-code/natives";
import * as native from "@gajae-code/natives";
import { getAgentDir, getResidentCacheRootDir, getTerminalSessionsDir, setAgentDir } from "@gajae-code/utils";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";

const originalAgentDir = getAgentDir();
const originalAgentDirOverride = process.env.GJC_CODING_AGENT_DIR;
const originalTmux = process.env.TMUX;
const originalTmuxPane = process.env.TMUX_PANE;
const tempDirs: string[] = [];
const LARGE_DISK_PAYLOAD = `disk-adoption ${"d".repeat(1024 * 1024 + 4096)}`;
const MEMORY_FALLBACK_UNIQUE_BLOB_COUNT = 4097;
const DEMOTION_RECOVERY_PAYLOAD_BYTES = 384 * 1024;
const DEMOTION_RECOVERY_PAYLOAD_COUNT = 24;

beforeEach(() => {
	setAgentDir(path.join(makeTempDir(), "agent"));
	process.env.TMUX = "/tmp/gjc-resident-transition-tmux,1,0";
	process.env.TMUX_PANE = `%resident-transition-${Date.now()}-${Math.random()}`;
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	if (originalAgentDirOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = originalAgentDirOverride;
	if (originalTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = originalTmux;
	if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalTmuxPane;
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
	SessionManagerTestHooks.beforeResidentTransitionIndexBuild = undefined;
});

function makeTempDir(prefix = "gjc-resident-transition-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function residentCacheRoot(): string {
	return getResidentCacheRootDir(getAgentDir());
}

function residentCacheDirs(): string[] {
	const root = residentCacheRoot();
	if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) return [];
	return fs
		.readdirSync(root)
		.map(name => path.join(root, name))
		.filter(dir => {
			const stat = fs.lstatSync(dir);
			return path.basename(dir).startsWith("i-") && stat.isDirectory() && !stat.isSymbolicLink();
		})
		.sort();
}

function activeResidentCacheDir(): string {
	const dirs = residentCacheDirs();
	if (dirs.length !== 1) throw new Error(`Expected one active resident cache directory, got ${dirs.length}`);
	return dirs[0]!;
}

async function createPersistedSession(
	text: string,
): Promise<{ sm: SessionManager; cwd: string; sessionFile: string; cacheDir: string }> {
	const cwd = makeTempDir("gjc-resident-transition-session-");
	const sm = SessionManager.create(cwd, path.join(cwd, "sessions"));
	sm.appendMessage(assistantMessage(text));
	await sm.ensureOnDisk();
	await sm.flush();
	const sessionFile = sm.getSessionFile();
	if (!sessionFile) throw new Error("Expected persisted session file");
	return { sm, cwd, sessionFile, cacheDir: activeResidentCacheDir() };
}

async function createManagedPersistedSession(
	text: string,
): Promise<{ sm: SessionManager; cwd: string; sessionFile: string; cacheDir: string }> {
	const cwd = makeTempDir("gjc-resident-transition-managed-session-");
	const sm = SessionManager.create(cwd);
	sm.appendMessage(assistantMessage(text));
	await sm.ensureOnDisk();
	await sm.flush();
	const sessionFile = sm.getSessionFile();
	if (!sessionFile) throw new Error("Expected persisted session file");
	return { sm, cwd, sessionFile, cacheDir: activeResidentCacheDir() };
}

async function appendResidentPayloads(sm: SessionManager, label: string): Promise<string[]> {
	const texts = Array.from({ length: 3 }, (_, index) => `${label} ${index} ${"r".repeat(4096)}`);
	for (const text of texts) sm.appendMessage(assistantMessage(text));
	await sm.flush();
	return texts;
}

function createLegacyResidentCacheArtifacts(artifactsDir: string, populated: boolean): void {
	fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(artifactsDir, 0o700);
	fs.writeFileSync(path.join(artifactsDir, "kept.txt"), "kept artifact", { mode: 0o600 });
	const legacyCacheDir = path.join(artifactsDir, "resident-cache");
	fs.mkdirSync(legacyCacheDir, { mode: 0o700 });
	fs.chmodSync(legacyCacheDir, 0o700);
	if (populated) fs.writeFileSync(path.join(legacyCacheDir, "legacy.txt"), "legacy cache", { mode: 0o600 });
}

interface ResidentTransitionFailure {
	readonly label: string;
	readonly putNumber?: number | "last";
}

interface InstalledResidentTransitionFailure {
	readonly error: Error;
	restore(): void;
}

const residentTransitionFailures: readonly ResidentTransitionFailure[] = [
	{ label: "first put", putNumber: 1 },
	{ label: "middle put", putNumber: 2 },
	{ label: "last put", putNumber: "last" },
	{ label: "index build" },
];

function installResidentTransitionFailure(
	failure: ResidentTransitionFailure,
	expectedPutCount: number,
): InstalledResidentTransitionFailure {
	const error = new Error(`injected resident transition ${failure.label} failure`);
	const putNumber = failure.putNumber === "last" ? expectedPutCount : failure.putNumber;
	if (putNumber === undefined) {
		const previous = SessionManagerTestHooks.beforeResidentTransitionIndexBuild;
		SessionManagerTestHooks.beforeResidentTransitionIndexBuild = () => {
			throw error;
		};
		return {
			error,
			restore() {
				SessionManagerTestHooks.beforeResidentTransitionIndexBuild = previous;
			},
		};
	}
	let puts = 0;
	const originalPut = EphemeralBlobStore.prototype.putSync;
	const put = vi.spyOn(EphemeralBlobStore.prototype, "putSync").mockImplementation(function (
		this: EphemeralBlobStore,
		data: Buffer,
	) {
		puts++;
		if (puts === putNumber) throw error;
		return originalPut.call(this, data);
	});
	return { error, restore: () => put.mockRestore() };
}

async function expectResidentTransitionFailure(
	failure: ResidentTransitionFailure,
	operation: () => unknown,
	expectedPutCount = 3,
): Promise<void> {
	const installed = installResidentTransitionFailure(failure, expectedPutCount);
	try {
		await expect(Promise.resolve().then(operation)).rejects.toThrow(installed.error.message);
	} finally {
		installed.restore();
	}
}

function installForkIdentityCaptureFailure(destination: "managed" | "explicit"): InstalledResidentTransitionFailure {
	const error = new Error(`injected ${destination} fork transcript identity capture failure`);
	if (destination === "managed") {
		const originalPublish = ManagedSessionDescendantStore.prototype.publishNoReplace;
		let publishedRelativePath: string | undefined;
		const publish = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplace")
			.mockImplementation(async function (
				this: ManagedSessionDescendantStore,
				relativePath: string,
				bytes: Uint8Array,
			) {
				await originalPublish.call(this, relativePath, bytes);
				if (relativePath.endsWith(".jsonl")) publishedRelativePath = relativePath;
			});
		const originalRead = ManagedSessionDescendantStore.prototype.readExpected;
		let injected = false;
		const read = vi.spyOn(ManagedSessionDescendantStore.prototype, "readExpected").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath: string,
		) {
			if (!injected && relativePath === publishedRelativePath) {
				injected = true;
				throw error;
			}
			return originalRead.call(this, relativePath);
		});
		return {
			error,
			restore() {
				read.mockRestore();
				publish.mockRestore();
			},
		};
	}

	const originalChmod = fs.promises.chmod;
	let publishedPath: string | undefined;
	const chmod = vi.spyOn(fs.promises, "chmod").mockImplementation(async (pathname, mode) => {
		await originalChmod(pathname, mode);
		const filename = typeof pathname === "string" ? pathname : pathname.toString();
		if (filename.endsWith(".jsonl") && mode === 0o600) publishedPath = path.resolve(filename);
	});
	const originalOpenSync = fs.openSync.bind(fs);
	let injected = false;
	const openSync = vi.spyOn(fs, "openSync").mockImplementation(((
		file: fs.PathLike,
		flags?: fs.OpenMode,
		mode?: fs.Mode,
	) => {
		const filename = typeof file === "string" ? file : file.toString();
		if (
			!injected &&
			publishedPath !== undefined &&
			path.resolve(filename) === publishedPath &&
			typeof flags === "number" &&
			(flags & fs.constants.O_NOFOLLOW) !== 0
		) {
			injected = true;
			throw error;
		}
		return originalOpenSync(file, flags as never, mode as never);
	}) as typeof fs.openSync);
	return {
		error,
		restore() {
			openSync.mockRestore();
			chmod.mockRestore();
		},
	};
}

function memoryFallbackPayload(index: number): string {
	return `canonical fallback ${index.toString().padStart(4, "0")} ${"m".repeat(1024)}`;
}

function demotionRecoveryPayload(index: number): string {
	const prefix = `demotion transcript fallback ${index.toString().padStart(2, "0")} `;
	return `${prefix}${"d".repeat(DEMOTION_RECOVERY_PAYLOAD_BYTES - prefix.length)}`;
}

function messageTexts(sm: SessionManager): string[] {
	const texts: string[] = [];
	for (const entry of sm.getEntries()) {
		if (entry.type !== "message" || !("content" in entry.message)) continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
			) {
				texts.push(block.text);
			}
		}
	}
	return texts;
}

function writeLargeMemoryFallbackSession(sessionFile: string, cwd: string): void {
	const timestamp = new Date().toISOString();
	const records = [
		JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "canonical-memory-fallback",
			timestamp,
			cwd,
		}),
	];
	let parentId: string | null = null;
	for (let index = 0; index < MEMORY_FALLBACK_UNIQUE_BLOB_COUNT; index++) {
		const id = `memory-fallback-${index}`;
		records.push(
			JSON.stringify({
				type: "custom_message",
				customType: "large",
				content: memoryFallbackPayload(index),
				display: true,
				attribution: "agent",
				id,
				parentId,
				timestamp,
			}),
		);
		parentId = id;
	}
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
	fs.writeFileSync(sessionFile, `${records.join("\n")}\n`, { mode: 0o600 });
}

function expectReadable(sm: SessionManager, text: string): void {
	expect(JSON.stringify(sm.getEntries())).toContain(text);
	expect(JSON.stringify(sm.buildSessionContext())).toContain(text);
}

function poisonResidentCacheRootMode(): () => void {
	const root = residentCacheRoot();
	const originalMode = fs.statSync(root).mode & 0o777;
	fs.chmodSync(root, 0o777);
	return () => fs.chmodSync(root, originalMode);
}

function makeResidentCacheRootReadOnly(): () => void {
	const root = residentCacheRoot();
	const originalMode = fs.statSync(root).mode & 0o777;
	fs.chmodSync(root, 0o500);
	return () => fs.chmodSync(root, originalMode);
}

async function overwriteBreadcrumb(label: string): Promise<{ file: string; content: string }> {
	await Bun.sleep(5);
	const pane = process.env.TMUX_PANE;
	if (!pane) throw new Error("Expected isolated tmux pane");
	const file = path.join(getTerminalSessionsDir(), `tmux-${pane}`);
	const content = `breadcrumb-${label}\n${path.join(makeTempDir(), "unchanged.jsonl")}\n`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, { mode: 0o600 });
	return { file, content };
}

function participantFromCheckpoint(
	checkpoint: MemoryGuardSessionManagerCheckpointV1,
): MemoryGuardParticipantDescriptorV1 {
	return {
		ordinal: 0,
		checkpoint: checkpoint.blob_authority,
		revisions: checkpoint.revisions,
		session_id: checkpoint.session_id,
		session_name: checkpoint.session_name,
		transcript: checkpoint.transcript,
	};
}

function fileBackedRecoveryAuthority(checkpointRoot: string): RecoveryFsRoot {
	return {
		readManaged(relativePath: string) {
			try {
				return { ok: true, data: new Uint8Array(fs.readFileSync(path.join(checkpointRoot, relativePath))) };
			} catch {
				return { ok: false };
			}
		},
	} as RecoveryFsRoot;
}

async function stageMemoryGuardRecovery(
	root: string,
	destination: SessionDestinationInput,
	text: string | string[],
): Promise<Extract<Awaited<ReturnType<typeof SessionManager.restoreMemoryGuardCheckpoint>>, { kind: "staged" }>> {
	const source = await SessionManager.open(path.join(root, "source", "checkpoint.jsonl"));
	const checkpointRoot = path.join(root, "checkpoint");
	const texts = typeof text === "string" ? [text] : text;
	let checkpoint: MemoryGuardSessionManagerCheckpointV1;
	try {
		for (const entry of texts) source.appendMessage(assistantMessage(entry));
		await source.flush();
		const lease = source.acquireMemoryGuardParticipantIngressLease();
		try {
			checkpoint = await source.createMemoryGuardCheckpoint({ ingressLease: lease, checkpointRoot });
		} finally {
			lease.release();
		}
	} finally {
		await source.close();
	}
	const restored = await SessionManager.restoreMemoryGuardCheckpoint({
		incidentAuthority: fileBackedRecoveryAuthority(checkpointRoot),
		participant: participantFromCheckpoint(checkpoint!),
		checkpoint: checkpoint!,
		destination,
	});
	if (restored.kind !== "staged") throw new Error(`Expected staged recovery, got ${restored.reason}`);
	return restored;
}

describe("resident-store transition seam", () => {
	it("B1-T1 adopts a managed session from a different workspace under the same agent directory and persists to it", async () => {
		const aText = `cross-workspace A ${"a".repeat(4096)}`;
		const a = await createManagedPersistedSession(aText);
		await a.sm.close();
		const bText = `cross-workspace B ${"b".repeat(4096)}`;
		const b = await createManagedPersistedSession(bText);
		try {
			expect(path.dirname(a.sessionFile)).not.toBe(path.dirname(b.sessionFile));
			expect(a.cwd).not.toBe(b.cwd);
			await expect(b.sm.setSessionFile(a.sessionFile)).resolves.toBeUndefined();
			expect(b.sm.getSessionFile()).toBe(a.sessionFile);
			expectReadable(b.sm, aText);
			const appended = `cross-workspace appended ${"x".repeat(4096)}`;
			b.sm.appendMessage(assistantMessage(appended));
			await b.sm.flush();
			expect(fs.readFileSync(a.sessionFile, "utf8")).toContain(appended);
			expect(residentCacheDirs()).toHaveLength(1);
			await b.sm.close();
			const reopened = await SessionManager.open(a.sessionFile);
			try {
				expectReadable(reopened, aText);
				expectReadable(reopened, appended);
			} finally {
				await reopened.close();
			}
		} finally {
			await b.sm.close().catch(() => {});
		}
	});

	it.skipIf(process.platform !== "linux")(
		"B1-T2 releases the derived managed authority when a cross-workspace switch fails",
		async () => {
			const a = await createManagedPersistedSession(`cross-workspace rollback A ${"a".repeat(4096)}`);
			await a.sm.close();
			const bText = `cross-workspace rollback B ${"b".repeat(4096)}`;
			const b = await createManagedPersistedSession(bText);
			const closes = vi.spyOn(native.RecoveryFsRoot.prototype, "close");
			try {
				fs.chmodSync(residentCacheRoot(), 0o777);
				try {
					await expect(b.sm.setSessionFile(a.sessionFile)).rejects.toThrow(
						"Resident cache trust validation failed",
					);
				} finally {
					fs.chmodSync(residentCacheRoot(), 0o700);
				}
				expect(closes).toHaveBeenCalledTimes(1);
				expect(b.sm.getSessionFile()).toBe(b.sessionFile);
				expectReadable(b.sm, bText);
				const appended = `cross-workspace rollback appended ${"r".repeat(4096)}`;
				b.sm.appendMessage(assistantMessage(appended));
				await b.sm.flush();
				expect(fs.readFileSync(b.sessionFile, "utf8")).toContain(appended);
			} finally {
				await b.sm.close().catch(() => {});
			}
		},
	);

	it("B1-T3 rejects a managed session-file switch to a directory outside the managed root", async () => {
		const managedText = `containment ${"c".repeat(4096)}`;
		const managed = await createManagedPersistedSession(managedText);
		const outsideCwd = makeTempDir("gjc-resident-transition-outside-");
		const outside = SessionManager.create(outsideCwd, path.join(outsideCwd, "sessions"));
		outside.appendMessage(assistantMessage(`outside ${"o".repeat(4096)}`));
		await outside.ensureOnDisk();
		await outside.flush();
		const outsideFile = outside.getSessionFile();
		if (!outsideFile) throw new Error("Expected outside session file");
		await outside.close();
		const closes = vi.spyOn(native.RecoveryFsRoot.prototype, "close");
		try {
			await expect(managed.sm.setSessionFile(outsideFile)).rejects.toThrow();
			expect(managed.sm.getSessionFile()).toBe(managed.sessionFile);
			expectReadable(managed.sm, managedText);
			if (process.platform === "linux") expect(closes).toHaveBeenCalledTimes(0);
		} finally {
			await managed.sm.close().catch(() => {});
		}
	});

	it("B1-T4 fails closed when a new session is started after a cross-workspace adoption", async () => {
		const aText = `cross-workspace fork A ${"a".repeat(4096)}`;
		const a = await createManagedPersistedSession(aText);
		await a.sm.close();
		const b = await createManagedPersistedSession(`cross-workspace fork B ${"b".repeat(4096)}`);
		try {
			await expect(b.sm.setSessionFile(a.sessionFile)).resolves.toBeUndefined();
			await expect(b.sm.fork()).rejects.toThrow("Managed transcript escaped its session directory");
			expect(b.sm.getSessionFile()).toBe(a.sessionFile);
			expect(fs.readFileSync(a.sessionFile, "utf8")).toContain(aText);
			expect(fs.readdirSync(path.dirname(a.sessionFile)).filter(name => name.includes("fork-staging"))).toEqual([]);
		} finally {
			await b.sm.close().catch(() => {});
		}
	});

	it("T5a installs the staged prepared-session pair after candidate disk failure and disposes the predecessor", async () => {
		const predecessor = await createPersistedSession(`prepared predecessor ${"p".repeat(4096)}`);
		const prepared = await predecessor.sm.prepareNewSession();
		predecessor.sm.appendPreparedCustomMessageEntry(prepared, "large", LARGE_DISK_PAYLOAD, true);
		const restoreRootMode = poisonResidentCacheRootMode();
		try {
			expect(() => predecessor.sm.commitPreparedNewSession(prepared)).not.toThrow();
			expect(predecessor.sm.getSessionFile()).toBe(prepared.sessionFile);
			expectReadable(predecessor.sm, LARGE_DISK_PAYLOAD);
			expect(fs.existsSync(predecessor.cacheDir)).toBe(false);
			expect(residentCacheDirs()).toEqual([]);
			expect(predecessor.sm.getObservabilityStatsForTests().residentCacheAdoptFallbackCount).toBe(1);
			expect(predecessor.sm.getObservabilityStatsForTests().residentCacheTrustRejectCount).toBe(1);
		} finally {
			restoreRootMode();
			await predecessor.sm.close();
		}
	});

	it("T5a verifies staged resident references before installing a fallback", async () => {
		const predecessorText = `staged verification predecessor ${"p".repeat(4096)}`;
		const predecessor = await createPersistedSession(predecessorText);
		const prepared = await predecessor.sm.prepareNewSession();
		predecessor.sm.appendPreparedCustomMessageEntry(prepared, "large", LARGE_DISK_PAYLOAD, true);
		const restoreRootMode = poisonResidentCacheRootMode();
		try {
			const stagedRead = vi.spyOn(MemoryBlobStore.prototype, "getSync").mockReturnValue(null);
			try {
				expect(() => predecessor.sm.commitPreparedNewSession(prepared)).toThrow("Missing resident text blob");
			} finally {
				stagedRead.mockRestore();
			}
			expect(predecessor.sm.getSessionFile()).toBe(predecessor.sessionFile);
			expectReadable(predecessor.sm, predecessorText);
			expect(residentCacheDirs()).toEqual([predecessor.cacheDir]);
		} finally {
			restoreRootMode();
			await predecessor.sm.discardPreparedNewSession(prepared);
			await predecessor.sm.close();
		}
	});

	it("T5a rethrows generic preparation errors without replacing the predecessor", async () => {
		const predecessorText = `generic prepare predecessor ${"p".repeat(4096)}`;
		const predecessor = await createPersistedSession(predecessorText);
		const prepared = await predecessor.sm.prepareNewSession();
		predecessor.sm.appendPreparedCustomMessageEntry(prepared, "large", LARGE_DISK_PAYLOAD, true);
		const before = predecessor.sm.getObservabilityStatsForTests();
		const injected = new Error("injected generic resident prepare failure");
		try {
			const diskPut = vi.spyOn(EphemeralBlobStore.prototype, "putSync").mockImplementation(() => {
				throw injected;
			});
			try {
				expect(() => predecessor.sm.commitPreparedNewSession(prepared)).toThrow(injected.message);
			} finally {
				diskPut.mockRestore();
			}
			expect(predecessor.sm.getSessionFile()).toBe(predecessor.sessionFile);
			expectReadable(predecessor.sm, predecessorText);
			const after = predecessor.sm.getObservabilityStatsForTests();
			expect(after.residentCacheAdoptFallbackCount).toBe(before.residentCacheAdoptFallbackCount);
			expect(after.residentCacheTrustRejectCount).toBe(before.residentCacheTrustRejectCount);
		} finally {
			await predecessor.sm.discardPreparedNewSession(prepared);
			await predecessor.sm.close();
		}
	});

	it("T5a round-trips a >1 MiB prepared payload from the committed disk store and disposes the predecessor last", async () => {
		const predecessor = await createPersistedSession(`prepared success predecessor ${"p".repeat(4096)}`);
		const prepared = await predecessor.sm.prepareNewSession();
		predecessor.sm.appendPreparedCustomMessageEntry(prepared, "large", LARGE_DISK_PAYLOAD, true);
		try {
			expect(() => predecessor.sm.commitPreparedNewSession(prepared)).not.toThrow();
			const successorCacheDir = activeResidentCacheDir();
			expect(successorCacheDir).not.toBe(predecessor.cacheDir);
			expect(fs.existsSync(predecessor.cacheDir)).toBe(false);
			expect(residentCacheDirs()).toEqual([successorCacheDir]);
			expectReadable(predecessor.sm, LARGE_DISK_PAYLOAD);

			const blobRef = JSON.stringify(predecessor.sm.captureState().fileEntries).match(/blob:sha256:([a-f0-9]{64})/);
			expect(blobRef).not.toBeNull();
			expect(fs.readFileSync(path.join(successorCacheDir, blobRef![1]!), "utf8")).toBe(LARGE_DISK_PAYLOAD);
		} finally {
			await predecessor.sm.close();
		}
	});

	it("T5b retains the live session, resident store, and breadcrumb when setSessionFile preparation fails", async () => {
		const target = await createPersistedSession(`switch target ${"t".repeat(4096)}`);
		await target.sm.close();
		const predecessorText = `switch predecessor ${"p".repeat(4096)}`;
		const predecessor = await createPersistedSession(predecessorText);
		const breadcrumb = await overwriteBreadcrumb("set-session-file");
		const restoreRootMode = poisonResidentCacheRootMode();
		try {
			await expect(predecessor.sm.setSessionFile(target.sessionFile)).rejects.toThrow(
				"Resident cache trust validation failed",
			);
			expect(predecessor.sm.getSessionFile()).toBe(predecessor.sessionFile);
			expect(fs.existsSync(predecessor.sessionFile)).toBe(true);
			expect(fs.readFileSync(breadcrumb.file, "utf8")).toBe(breadcrumb.content);
			expectReadable(predecessor.sm, predecessorText);
			expect(residentCacheDirs()).toEqual([predecessor.cacheDir]);
			expect(predecessor.sm.getObservabilityStatsForTests().residentCacheTrustRejectCount).toBe(1);
		} finally {
			restoreRootMode();
			await predecessor.sm.close();
		}
	});

	it("T5b rejects a malformed switch candidate without mutating the live predecessor", async () => {
		const predecessorText = `malformed switch predecessor ${"p".repeat(4096)}`;
		const predecessor = await createPersistedSession(predecessorText);
		const corruptFile = path.join(makeTempDir("gjc-resident-transition-corrupt-"), "corrupt.jsonl");
		fs.writeFileSync(corruptFile, "{ malformed JSONL\n", { mode: 0o600 });
		const entriesBefore = JSON.stringify(predecessor.sm.getEntries());
		try {
			await expect(predecessor.sm.setSessionFile(corruptFile)).rejects.toThrow("malformed");
			expect(predecessor.sm.getSessionFile()).toBe(predecessor.sessionFile);
			expect(JSON.stringify(predecessor.sm.getEntries())).toBe(entriesBefore);
			expectReadable(predecessor.sm, predecessorText);
			expect(residentCacheDirs()).toEqual([predecessor.cacheDir]);
		} finally {
			await predecessor.sm.close();
		}
	});

	it("T5b preserves cached resident content after a live cache-root symlink swap", async () => {
		const firstText = `symlink-swap first ${"a".repeat(4096)}`;
		const secondText = `symlink-swap second ${"b".repeat(4096)}`;
		const predecessor = await createPersistedSession(firstText);
		const cacheRoot = residentCacheRoot();
		const backup = path.join(makeTempDir("gjc-resident-transition-cache-backup-"), "verified-cache");
		const attacker = path.join(makeTempDir("gjc-resident-transition-attacker-"), "cache");
		fs.mkdirSync(attacker, { mode: 0o700 });
		fs.renameSync(cacheRoot, backup);
		fs.symlinkSync(attacker, cacheRoot, "dir");
		try {
			predecessor.sm.appendMessage(assistantMessage(secondText));
			expectReadable(predecessor.sm, firstText);
			expectReadable(predecessor.sm, secondText);
			expect(JSON.stringify(predecessor.sm.getEntries())).not.toContain("original content unavailable");
			expect(fs.readdirSync(attacker)).toEqual([]);
			expect(predecessor.sm.getObservabilityStatsForTests()).toMatchObject({
				residentCacheTrustRejectCount: 1,
				residentCacheDegradedReason: "blob_create_failed",
			});
		} finally {
			await predecessor.sm.close().catch(() => {});
		}
	});

	it("T5b recovers every persisted resident blob beyond the buffer LRU after a cache-root swap", async () => {
		const firstText = `demotion fallback first ${"f".repeat(4096)}`;
		const predecessor = await createPersistedSession(firstText);
		const payloads = Array.from({ length: DEMOTION_RECOVERY_PAYLOAD_COUNT }, (_, index) =>
			demotionRecoveryPayload(index),
		);
		for (const payload of payloads) predecessor.sm.appendMessage(assistantMessage(payload));
		await predecessor.sm.flush();
		const persisted = fs.readFileSync(predecessor.sessionFile, "utf8");
		expect(persisted).toContain(payloads[0]!);
		expect(persisted).toContain(payloads.at(-1)!);

		const cacheRoot = residentCacheRoot();
		const backup = path.join(makeTempDir("gjc-resident-transition-cache-backup-"), "verified-cache");
		const attacker = path.join(makeTempDir("gjc-resident-transition-attacker-"), "cache");
		fs.mkdirSync(attacker, { mode: 0o700 });
		fs.renameSync(cacheRoot, backup);
		fs.symlinkSync(attacker, cacheRoot, "dir");
		const triggerText = `demotion fallback trigger ${"t".repeat(4096)}`;
		try {
			predecessor.sm.appendMessage(assistantMessage(triggerText));
			expect(messageTexts(predecessor.sm)).toEqual([firstText, ...payloads, triggerText]);
			expect(JSON.stringify(predecessor.sm.getEntries())).not.toContain("original content unavailable");
			expect(fs.readdirSync(attacker)).toEqual([]);
			expect(predecessor.sm.getObservabilityStatsForTests()).toMatchObject({
				residentCacheTrustRejectCount: 1,
				residentCacheDegradedReason: "blob_create_failed",
			});
		} finally {
			await predecessor.sm.close().catch(() => {});
		}
	});

	it("T5b falls back to memory when a live switch cannot create a resident cache instance", async () => {
		const target = await createPersistedSession(`readonly switch target ${"t".repeat(4096)}`);
		await target.sm.close();
		const predecessor = await createPersistedSession(`readonly switch predecessor ${"p".repeat(4096)}`);
		const restoreRootMode = makeResidentCacheRootReadOnly();
		try {
			await expect(predecessor.sm.setSessionFile(target.sessionFile)).resolves.toBeUndefined();
			expect(predecessor.sm.getSessionFile()).toBe(target.sessionFile);
			expectReadable(predecessor.sm, `readonly switch target ${"t".repeat(4096)}`);
			expect(predecessor.sm.getObservabilityStatsForTests().residentCacheAdoptFallbackCount).toBe(1);
			expect(predecessor.sm.getObservabilityStatsForTests().residentCacheTrustRejectCount).toBe(1);
		} finally {
			restoreRootMode();
			await predecessor.sm.close();
		}
	});

	it("T5b retains the predecessor after fork and restoreState preparation failures", async () => {
		const forkText = `fork predecessor ${"f".repeat(4096)}`;
		const forkPredecessor = await createPersistedSession(forkText);
		const forkInventoryBefore = fs
			.readdirSync(path.dirname(forkPredecessor.sessionFile))
			.filter(name => name.endsWith(".jsonl"))
			.sort();

		const restoreForkRootMode = poisonResidentCacheRootMode();
		try {
			await expect(forkPredecessor.sm.fork()).rejects.toThrow("Resident cache trust validation failed");
			expect(forkPredecessor.sm.getSessionFile()).toBe(forkPredecessor.sessionFile);
			expect(fs.existsSync(forkPredecessor.sessionFile)).toBe(true);
			expect(
				fs
					.readdirSync(path.dirname(forkPredecessor.sessionFile))
					.filter(name => name.endsWith(".jsonl"))
					.sort(),
			).toEqual(forkInventoryBefore);
			expectReadable(forkPredecessor.sm, forkText);
			expect(residentCacheDirs()).toEqual([forkPredecessor.cacheDir]);
		} finally {
			restoreForkRootMode();
			await forkPredecessor.sm.close();
		}

		const restoreText = `restore predecessor ${"r".repeat(4096)}`;
		const restorePredecessor = await createPersistedSession(restoreText);
		const snapshot = restorePredecessor.sm.captureState();
		const restoreStateRootMode = poisonResidentCacheRootMode();
		try {
			expect(() => restorePredecessor.sm.restoreState(snapshot)).toThrow("Resident cache trust validation failed");
			expect(restorePredecessor.sm.getSessionFile()).toBe(restorePredecessor.sessionFile);
			expect(fs.existsSync(restorePredecessor.sessionFile)).toBe(true);
			expectReadable(restorePredecessor.sm, restoreText);
			expect(residentCacheDirs()).toEqual([restorePredecessor.cacheDir]);
		} finally {
			restoreStateRootMode();
			await restorePredecessor.sm.close();
		}
	});

	it("T5b opens a poisoned-root session with a memory fallback and no resident cache directory", async () => {
		const text = `open fallback ${"o".repeat(4096)}`;
		const source = await createPersistedSession(text);
		await source.sm.close();
		const root = residentCacheRoot();
		fs.rmSync(root, { recursive: true, force: true });
		fs.writeFileSync(root, "poisoned resident cache root", { mode: 0o600 });

		const opened = await SessionManager.open(source.sessionFile);
		try {
			expectReadable(opened, text);
			expect(opened.getObservabilityStatsForTests().residentCacheAdoptFallbackCount).toBe(1);
			expect(fs.lstatSync(root).isFile()).toBe(true);
			expect(residentCacheDirs()).toEqual([]);
		} finally {
			await opened.close();
		}
	});

	it("T5b retains every >4096 unique resident payload in forced memory fallback", async () => {
		const cwd = makeTempDir("gjc-resident-transition-large-fallback-");
		const sessionFile = path.join(cwd, "sessions", "large-fallback.jsonl");
		writeLargeMemoryFallbackSession(sessionFile, cwd);
		const root = residentCacheRoot();
		fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
		fs.writeFileSync(root, "poisoned resident cache root", { mode: 0o600 });
		const opened = await SessionManager.open(sessionFile);
		try {
			const entries = opened.getEntries();
			expect(entries).toHaveLength(MEMORY_FALLBACK_UNIQUE_BLOB_COUNT);
			for (const [index, entry] of entries.entries()) {
				if (entry.type !== "custom_message" || typeof entry.content !== "string") {
					throw new Error("Expected a materialized custom message entry.");
				}
				expect(entry.content).toBe(memoryFallbackPayload(index));
			}
			const serialized = JSON.stringify(entries);
			expect(serialized).not.toContain("original content unavailable");
			expect(serialized).not.toContain("blob:sha256:");
			expect(opened.getObservabilityStatsForTests()).toMatchObject({
				residentCacheAdoptFallbackCount: 1,
				residentCacheTrustRejectCount: 1,
			});
			expect(fs.lstatSync(root).isFile()).toBe(true);
			expect(residentCacheDirs()).toEqual([]);
		} finally {
			await opened.close();
		}
	});

	it("T5d rolls back live-switch candidates for every resident write and index-build failure seam", async () => {
		for (const failure of residentTransitionFailures) {
			const target = await createPersistedSession(`switch target ${failure.label} ${"t".repeat(4096)}`);
			await appendResidentPayloads(target.sm, `switch target ${failure.label}`);
			await target.sm.close();
			const predecessorText = `switch predecessor ${failure.label} ${"p".repeat(4096)}`;
			const predecessor = await createPersistedSession(predecessorText);
			try {
				await expectResidentTransitionFailure(failure, () => predecessor.sm.setSessionFile(target.sessionFile), 4);
				expect(predecessor.sm.getSessionFile()).toBe(predecessor.sessionFile);
				expectReadable(predecessor.sm, predecessorText);
				expect(residentCacheDirs()).toEqual([predecessor.cacheDir]);
			} finally {
				await predecessor.sm.close();
			}
			expect(residentCacheDirs()).toEqual([]);
		}
	});

	it("T5d removes fork publications for every resident write and index-build failure seam", async () => {
		for (const destination of ["explicit", "managed"] as const) {
			for (const failure of residentTransitionFailures) {
				const predecessor =
					destination === "managed"
						? await createManagedPersistedSession(`fork managed ${failure.label} ${"m".repeat(4096)}`)
						: await createPersistedSession(`fork explicit ${failure.label} ${"e".repeat(4096)}`);
				await appendResidentPayloads(predecessor.sm, `fork ${destination} ${failure.label}`);
				const transcriptDirectory = path.dirname(predecessor.sessionFile);
				const transcriptInventory = fs
					.readdirSync(transcriptDirectory)
					.filter(name => name.endsWith(".jsonl"))
					.sort();
				try {
					await expectResidentTransitionFailure(failure, () => predecessor.sm.fork(), 4);
					expect(predecessor.sm.getSessionFile()).toBe(predecessor.sessionFile);
					expectReadable(predecessor.sm, `fork ${destination} ${failure.label}`);
					expect(
						fs
							.readdirSync(transcriptDirectory)
							.filter(name => name.endsWith(".jsonl"))
							.sort(),
					).toEqual(transcriptInventory);
					expect(residentCacheDirs()).toEqual([predecessor.cacheDir]);
				} finally {
					await predecessor.sm.close();
				}
				expect(residentCacheDirs()).toEqual([]);
			}
		}
	});

	it("T5d removes fork transcripts when post-publication identity capture fails", async () => {
		for (const destination of ["explicit", "managed"] as const) {
			const text = `fork identity capture ${destination} ${"f".repeat(4096)}`;
			const predecessor =
				destination === "managed" ? await createManagedPersistedSession(text) : await createPersistedSession(text);
			const transcriptDirectory = path.dirname(predecessor.sessionFile);
			const transcriptInventory = fs
				.readdirSync(transcriptDirectory)
				.filter(name => name.endsWith(".jsonl"))
				.sort();
			const installed = installForkIdentityCaptureFailure(destination);
			try {
				await expect(predecessor.sm.fork()).rejects.toThrow(installed.error.message);
				expect(predecessor.sm.getSessionFile()).toBe(predecessor.sessionFile);
				expectReadable(predecessor.sm, text);
				expect(
					fs
						.readdirSync(transcriptDirectory)
						.filter(name => name.endsWith(".jsonl"))
						.sort(),
				).toEqual(transcriptInventory);
				expect(residentCacheDirs()).toEqual([predecessor.cacheDir]);
			} finally {
				installed.restore();
				await predecessor.sm.close();
			}
			expect(residentCacheDirs()).toEqual([]);
		}
	});

	it("T5d removes custom-storage fork transcripts when post-publication snapshot capture fails", async () => {
		const storage = new MemorySessionStorage();
		const predecessorText = `custom storage fork predecessor ${"c".repeat(4096)}`;
		const predecessor = SessionManager.create("/custom-storage", "/sessions", storage);
		predecessor.appendMessage(assistantMessage(predecessorText));
		await predecessor.ensureOnDisk();
		await predecessor.flush();
		const predecessorSessionFile = predecessor.getSessionFile();
		if (!predecessorSessionFile) throw new Error("Expected persisted session file");
		const transcriptInventory = storage.listFilesSync("/sessions", "*.jsonl").sort();
		const snapshotError = new Error("injected custom storage fork snapshot failure");
		const originalReadSnapshot = storage.readSnapshotSync.bind(storage);
		let injected = false;
		const readSnapshot = vi.spyOn(storage, "readSnapshotSync").mockImplementation(filePath => {
			if (!injected && filePath !== predecessorSessionFile) {
				injected = true;
				throw snapshotError;
			}
			return originalReadSnapshot(filePath);
		});
		try {
			await expect(predecessor.fork()).rejects.toThrow(snapshotError.message);
			expect(injected).toBe(true);
			expect(predecessor.getSessionFile()).toBe(predecessorSessionFile);
			expect(storage.listFilesSync("/sessions", "*.jsonl").sort()).toEqual(transcriptInventory);
			expectReadable(predecessor, predecessorText);

			const continuedText = `custom storage fork recovery ${"r".repeat(4096)}`;
			predecessor.appendMessage(assistantMessage(continuedText));
			await predecessor.flush();
			expectReadable(predecessor, continuedText);
			expect(storage.existsSync(predecessorSessionFile)).toBe(true);
		} finally {
			readSnapshot.mockRestore();
			await predecessor.close();
		}
	});

	it("T5d retains move and restore predecessors for every resident write and index-build failure seam", async () => {
		for (const failure of residentTransitionFailures) {
			const moveText = `move predecessor ${failure.label} ${"m".repeat(4096)}`;
			const movePredecessor = await createPersistedSession(moveText);
			await appendResidentPayloads(movePredecessor.sm, `move ${failure.label}`);
			const newCwd = makeTempDir("gjc-resident-transition-move-target-");
			try {
				await expectResidentTransitionFailure(failure, () => movePredecessor.sm.moveTo(newCwd), 4);
				expect(movePredecessor.sm.getCwd()).toBe(movePredecessor.cwd);
				expect(movePredecessor.sm.getSessionFile()).toBe(movePredecessor.sessionFile);
				expectReadable(movePredecessor.sm, moveText);
				expect(residentCacheDirs()).toEqual([movePredecessor.cacheDir]);
			} finally {
				await movePredecessor.sm.close();
			}
			expect(residentCacheDirs()).toEqual([]);

			const restoreText = `restore predecessor ${failure.label} ${"r".repeat(4096)}`;
			const restorePredecessor = await createPersistedSession(restoreText);
			await appendResidentPayloads(restorePredecessor.sm, `restore ${failure.label}`);
			const snapshot = restorePredecessor.sm.captureState();
			try {
				await expectResidentTransitionFailure(failure, () => restorePredecessor.sm.restoreState(snapshot), 4);
				expect(restorePredecessor.sm.getSessionFile()).toBe(restorePredecessor.sessionFile);
				expectReadable(restorePredecessor.sm, restoreText);
				expect(residentCacheDirs()).toEqual([restorePredecessor.cacheDir]);
			} finally {
				await restorePredecessor.sm.close();
			}
			expect(residentCacheDirs()).toEqual([]);
		}
	});

	it("T5d retains recovery staging for every resident write and index-build promotion failure seam", async () => {
		for (const failure of residentTransitionFailures) {
			const root = makeTempDir("gjc-resident-transition-promotion-");
			const texts = Array.from(
				{ length: 3 },
				(_, index) => `promotion predecessor ${failure.label} ${index} ${"p".repeat(4096)}`,
			);
			const staged = await stageMemoryGuardRecovery(root, path.join(root, "restore"), texts);
			const stagingFile = staged.manager.getSessionFile();
			if (!stagingFile) throw new Error("Expected staged recovery transcript");
			try {
				await expectResidentTransitionFailure(failure, () =>
					staged.manager.promoteRecoveryHydrationAfterOwnershipReadyFence(staged.hydrationContext, {
						ownershipReady: true,
					}),
				);
				expect(staged.manager.getSessionFile()).toBe(stagingFile);
				expectReadable(staged.manager, texts[0]!);
				expectReadable(staged.manager, texts[2]!);
				expect(residentCacheDirs()).toEqual([]);
			} finally {
				await staged.cleanup();
			}
			expect(residentCacheDirs()).toEqual([]);
		}
	});

	it("T5e prunes empty and populated legacy resident-cache artifacts for managed and explicit forks", async () => {
		for (const destination of ["explicit", "managed"] as const) {
			for (const populated of [false, true]) {
				const predecessor =
					destination === "managed"
						? await createManagedPersistedSession(`legacy managed ${String(populated)} ${"m".repeat(4096)}`)
						: await createPersistedSession(`legacy explicit ${String(populated)} ${"e".repeat(4096)}`);
				const sourceArtifacts = predecessor.sm.getArtifactsDir();
				if (!sourceArtifacts) throw new Error("Expected source artifacts directory");
				createLegacyResidentCacheArtifacts(sourceArtifacts, populated);
				try {
					const forked = await predecessor.sm.fork();
					if (!forked) throw new Error("Expected forked session");
					const destinationArtifacts = forked.newSessionFile.slice(0, -6);
					expect(fs.readFileSync(path.join(destinationArtifacts, "kept.txt"), "utf8")).toBe("kept artifact");
					expect(fs.existsSync(path.join(destinationArtifacts, "resident-cache"))).toBe(false);
					expect(fs.existsSync(path.join(sourceArtifacts, "resident-cache"))).toBe(true);
					if (populated) {
						expect(fs.readFileSync(path.join(sourceArtifacts, "resident-cache", "legacy.txt"), "utf8")).toBe(
							"legacy cache",
						);
					}
				} finally {
					await predecessor.sm.close();
				}
				expect(residentCacheDirs()).toEqual([]);
			}
		}
	});

	it("T5e preserves artifact_source_changed cleanup for managed and explicit legacy-cache manifests", async () => {
		for (const destination of ["explicit", "managed"] as const) {
			const sourceText = `legacy source change ${destination} ${"s".repeat(4096)}`;
			const predecessor =
				destination === "managed"
					? await createManagedPersistedSession(sourceText)
					: await createPersistedSession(sourceText);
			const sourceArtifacts = predecessor.sm.getArtifactsDir();
			if (!sourceArtifacts) throw new Error("Expected source artifacts directory");
			createLegacyResidentCacheArtifacts(sourceArtifacts, true);
			const sessionDirectory = path.dirname(predecessor.sessionFile);
			const transcriptsBefore = fs
				.readdirSync(sessionDirectory)
				.filter(name => name.endsWith(".jsonl"))
				.sort();

			let changed = false;
			let restoreMutation: () => void;
			if (destination === "managed") {
				const originalRead = ManagedSessionDescendantStore.prototype.readExpected;
				const artifactsName = path.basename(sourceArtifacts);
				const read = vi.spyOn(ManagedSessionDescendantStore.prototype, "readExpected").mockImplementation(function (
					this: ManagedSessionDescendantStore,
					relativePath: string,
				) {
					const result = originalRead.call(this, relativePath);
					if (!changed && relativePath === path.posix.join(artifactsName, "kept.txt")) {
						fs.writeFileSync(path.join(this.dir, relativePath), "source changed", { mode: 0o600 });
						changed = true;
					}
					return result;
				});
				restoreMutation = () => read.mockRestore();
			} else {
				const originalCopy = fs.promises.cp;
				const copy = vi.spyOn(fs.promises, "cp").mockImplementation(async (...args) => {
					await originalCopy(...args);
					fs.writeFileSync(path.join(sourceArtifacts, "kept.txt"), "source changed", { mode: 0o600 });
					changed = true;
				});
				restoreMutation = () => copy.mockRestore();
			}
			try {
				await expect(predecessor.sm.fork()).rejects.toThrow("artifact_source_changed");
				expect(changed).toBe(true);
				expect(predecessor.sm.getSessionFile()).toBe(predecessor.sessionFile);
				expectReadable(predecessor.sm, sourceText);
				expect(fs.readFileSync(path.join(sourceArtifacts, "kept.txt"), "utf8")).toBe("source changed");
				expect(fs.existsSync(path.join(sourceArtifacts, "resident-cache", "legacy.txt"))).toBe(true);
				expect(
					fs
						.readdirSync(sessionDirectory)
						.filter(name => name.endsWith(".jsonl"))
						.sort(),
				).toEqual(transcriptsBefore);
				expect(residentCacheDirs()).toEqual([predecessor.cacheDir]);
			} finally {
				restoreMutation();
				await predecessor.sm.close();
			}
			expect(residentCacheDirs()).toEqual([]);
		}
	});

	it("T5c keeps resident-store and entry installation inside the transition seams", () => {
		const source = fs.readFileSync(path.join(import.meta.dir, "../src/session/session-manager.ts"), "utf8");
		const commitStart = source.indexOf("\t#commitResidentTextStoreTransition(");
		const releaseStart = source.indexOf("\t#releaseResidentTextStore(): void {");
		const demoteStart = source.indexOf("\t#demoteResidentTextStoreAfterTrustReject(");
		const setSessionFileStart = source.indexOf("\tasync setSessionFile(");
		const setSessionFileEnd = source.indexOf("\n\t/** Start a new session.", setSessionFileStart);
		expect(commitStart).toBeGreaterThanOrEqual(0);
		expect(releaseStart).toBeGreaterThan(commitStart);
		expect(demoteStart).toBeGreaterThan(releaseStart);
		expect(setSessionFileStart).toBeGreaterThanOrEqual(0);
		expect(setSessionFileEnd).toBeGreaterThan(setSessionFileStart);

		const residentStoreAssignments = [...source.matchAll(/this\.#residentTextBlobStore\s*=(?!=)/g)];
		expect(residentStoreAssignments).toHaveLength(2);
		for (const assignment of residentStoreAssignments) {
			const offset = assignment.index!;
			expect(
				(offset >= commitStart && offset < releaseStart) || (offset >= releaseStart && offset < demoteStart),
			).toBe(true);
		}

		const fileEntryAssignments = [...source.matchAll(/this\.#fileEntries\s*=(?!=)/g)];
		expect(fileEntryAssignments).toHaveLength(1);
		expect(fileEntryAssignments[0]!.index!).toBeGreaterThanOrEqual(commitStart);
		expect(fileEntryAssignments[0]!.index!).toBeLessThan(releaseStart);
		expect(source.slice(setSessionFileStart, setSessionFileEnd)).not.toMatch(/this\.#fileEntries\s*=(?!=)/);
	});

	it("T6 aborts recovery promotion before staging removal when candidate preparation cannot trust the cache root", async () => {
		const root = makeTempDir("gjc-resident-transition-recovery-prepare-");
		const text = `recovery prepare predecessor ${"m".repeat(4096)}`;
		const staged = await stageMemoryGuardRecovery(root, path.join(root, "restore"), text);
		const stagingFile = staged.manager.getSessionFile();
		if (!stagingFile) throw new Error("Expected staged recovery transcript");
		const entriesBefore = JSON.stringify(staged.manager.getEntries());
		fs.rmSync(residentCacheRoot(), { recursive: true, force: true });
		fs.writeFileSync(residentCacheRoot(), "poisoned resident cache root", { mode: 0o600 });
		try {
			await expect(
				staged.manager.promoteRecoveryHydrationAfterOwnershipReadyFence(staged.hydrationContext, {
					ownershipReady: true,
				}),
			).rejects.toThrow("Resident cache trust validation failed");
			expect(staged.manager.getSessionFile()).toBe(stagingFile);
			expect(JSON.stringify(staged.manager.getEntries())).toBe(entriesBefore);
			expectReadable(staged.manager, text);
			expect(fs.existsSync(stagingFile)).toBe(true);
			expect(residentCacheDirs()).toEqual([]);
			expect(staged.manager.getObservabilityStatsForTests().residentCacheTrustRejectCount).toBe(1);
		} finally {
			await staged.cleanup();
		}
	});

	it("T6 disposes a prepared candidate and retains staging state when managed publication collides", async () => {
		const root = makeTempDir("gjc-resident-transition-recovery-publish-");
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, getAgentDir());
		const text = `recovery publish predecessor ${"m".repeat(4096)}`;
		const staged = await stageMemoryGuardRecovery(root, destination, text);
		const stagingFile = staged.manager.getSessionFile();
		if (!stagingFile) throw new Error("Expected staged recovery transcript");
		const entriesBefore = JSON.stringify(staged.manager.getEntries());
		let collisionPath: string | undefined;
		const originalPublishNoReplace = ManagedSessionDescendantStore.prototype.publishNoReplace;
		const publishNoReplace = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplace")
			.mockImplementation(async function (
				this: ManagedSessionDescendantStore,
				relativePath: string,
				bytes: Uint8Array,
			) {
				if (relativePath.startsWith(".")) return await originalPublishNoReplace.call(this, relativePath, bytes);
				collisionPath = path.join(this.dir, relativePath);
				await originalPublishNoReplace.call(this, relativePath, Buffer.from("pre-existing collision"));
				await originalPublishNoReplace.call(this, relativePath, bytes);
			});
		const adopted = vi.spyOn(EphemeralBlobStore, "adoptVerifiedDir");
		const disposed = vi.spyOn(EphemeralBlobStore.prototype, "dispose");
		try {
			await expect(
				staged.manager.promoteRecoveryHydrationAfterOwnershipReadyFence(staged.hydrationContext, {
					ownershipReady: true,
				}),
			).rejects.toThrow("destination_conflict");
			expect(publishNoReplace).toHaveBeenCalledTimes(1);
			expect(adopted).toHaveBeenCalledTimes(1);
			expect(disposed).toHaveBeenCalledTimes(1);
			expect(collisionPath).toBeDefined();
			expect(fs.existsSync(collisionPath!)).toBe(true);
			expect(staged.manager.getSessionFile()).toBe(stagingFile);
			expect(JSON.stringify(staged.manager.getEntries())).toBe(entriesBefore);
			expectReadable(staged.manager, text);
			expect(fs.existsSync(stagingFile)).toBe(true);
			expect(residentCacheDirs()).toEqual([]);
		} finally {
			await staged.cleanup();
		}
	});
});
