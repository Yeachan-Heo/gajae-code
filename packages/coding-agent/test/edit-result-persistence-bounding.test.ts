import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";
import { makeAssistantMessage } from "./session-manager/helpers";

// ─── #4566: apply_patch full-file result metadata must not amplify transcripts ──

const tempDirs: string[] = [];

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeEditToolSession(cwd: string): unknown {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "apply_patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	};
}

/** ~400 KiB synthetic source file like the reporter's, patchable line by line. */
function writeBigFile(cwd: string, lines: number): { file: string; lineAt: (i: number) => string } {
	const lineAt = (i: number) => `export const v${i} = ${i}; // ${"x".repeat(42)}`;
	const file = path.join(cwd, "big.ts");
	fs.writeFileSync(file, Array.from({ length: lines }, (_, i) => lineAt(i)).join("\n"), "utf8");
	return { file, lineAt };
}

function patchEnvelope(_index: number, oldLine: string, newLine: string): { input: string } {
	return {
		input: `*** Begin Patch\n*** Update File: big.ts\n@@\n-${oldLine}\n+${newLine}\n*** End Patch\n`,
	};
}

function makeEditToolSessionWithMode(cwd: string, mode: string): Record<string, unknown> {
	return {
		...(makeEditToolSession(cwd) as Record<string, unknown>),
		settings: Settings.isolated({ "edit.mode": mode }),
	};
}

describe("edit-result persistence bounding (#4566)", () => {
	it("keeps transcript growth bounded independently of file size across repeated apply_patch results", async () => {
		const root = makeTempDir("gjc-4566-bounding-");
		const cwd = path.join(root, "proj");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const LINES = 6400; // ~465 KB, well over the 16 KiB inline snapshot cap
		const { lineAt } = writeBigFile(cwd, LINES);
		const fileSize = fs.statSync(path.join(cwd, "big.ts")).size;
		expect(fileSize).toBeGreaterThan(64 * 1024);

		process.env.GJC_EDIT_VARIANT = "apply_patch";
		const { EditTool } = await import("../src/edit");
		const editTool = new EditTool(makeEditToolSession(cwd) as never);

		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 });
			manager.appendMessage(makeAssistantMessage() as never);
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");
			const sizeAfterOpen = fs.statSync(sessionFile).size;

			const PATCHES = 25;
			for (let i = 0; i < PATCHES; i++) {
				const newLine = `export const v${i} = ${i}; // patched-${i} ${"y".repeat(30)}`;
				const result = await editTool.execute(
					`call-${i}`,
					patchEnvelope(i, lineAt(i), newLine) as never,
					undefined,
					undefined,
					undefined,
				);
				expect(result.isError).toBeFalsy();
				// Live in-process results keep full bodies for ACP diff consumers.
				const live = result.details as { oldText?: string; newText?: string };
				expect(live.oldText?.length ?? 0).toBeGreaterThan(64 * 1024);
				manager.appendMessage({
					role: "toolResult",
					toolCallId: `call-${i}`,
					toolName: "edit",
					content: result.content,
					details: result.details,
					isError: false,
					timestamp: Date.now(),
				});
			}
			await manager.flush();

			const transcript = fs.readFileSync(sessionFile, "utf8");
			const transcriptSize = Buffer.byteLength(transcript, "utf8");
			const perPatch = (transcriptSize - sizeAfterOpen) / PATCHES;

			// Pre-fix behavior was ~2x file size per patch (#4566: 0.76 MiB results
			// for a ~395 KiB file). Bounded evidence must stay a small fraction.
			expect(perPatch).toBeLessThan(fileSize * 0.02);

			// Every persisted edit result carries digest receipts, not full bodies.
			const entries = transcript
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
				.filter(
					e =>
						e.type === "message" &&
						(e.message as { role?: string } | undefined)?.role === "toolResult" &&
						(e.message as { toolName?: string } | undefined)?.toolName === "edit",
				);
			expect(entries.length).toBe(PATCHES);
			for (const entry of entries) {
				const details = entry.message?.details as Record<string, unknown>;
				expect(details).toBeDefined();
				const oldDigest = details.oldTextDigest as { bytes: number; sha256: string } | undefined;
				const newDigest = details.newTextDigest as { bytes: number; sha256: string } | undefined;
				expect(oldDigest).toBeDefined();
				expect(newDigest).toBeDefined();
				// First patch rewrites one line; the receipt records the exact
				// pre-edit snapshot byte length (within a line of the fixture size).
				expect(oldDigest?.bytes).toBeGreaterThan(fileSize - 1024);
				expect(oldDigest?.sha256).toMatch(/^[0-9a-f]{64}$/);
				expect(newDigest?.sha256).toMatch(/^[0-9a-f]{64}$/);
				// The persisted body slots hold the bounded externalization marker.
				expect(details.oldText).toBe(
					"[edit snapshot externalized: see oldTextDigest/newTextDigest; full body omitted from transcript]",
				);
				// Bounded evidence for rendering/replay/accounting is retained.
				expect(typeof details.diff).toBe("string");
				expect((details.diff as string).length).toBeGreaterThan(0);
				expect(typeof details.path).toBe("string");
				expect(details.op).toBe("update");
				expect(typeof details.firstChangedLine).toBe("number");
			}
		} finally {
			delete process.env.GJC_EDIT_VARIANT;
			await manager.close();
		}
	});

	it("computes snapshot receipts before generic 500k persistence truncation", async () => {
		const root = makeTempDir("gjc-4566-exact-digest-");
		const cwd = path.join(root, "proj");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 });
			manager.appendMessage(makeAssistantMessage() as never);
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");

			// Deliberately exceed MAX_PERSIST_CHARS (500k). If generic truncation
			// runs first, the durable receipt would identify only the prefix.
			const oldText = `${"old-snapshot-line\n".repeat(40_000)}tail-old`;
			const newText = `${"new-snapshot-line\n".repeat(40_000)}tail-new`;
			expect(oldText.length).toBeGreaterThan(500_000);
			expect(newText.length).toBeGreaterThan(500_000);

			manager.appendMessage({
				role: "toolResult",
				toolCallId: "call-exact-digest",
				toolName: "edit",
				content: [{ type: "text", text: "Updated large.txt" }],
				details: { diff: "@@\n-old\n+new", path: path.join(cwd, "large.txt"), oldText, newText },
				isError: false,
				timestamp: Date.now(),
			});
			await manager.flush();

			const persisted = fs
				.readFileSync(sessionFile, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
				.find(
					entry =>
						entry.type === "message" &&
						(entry.message as { toolCallId?: string } | undefined)?.toolCallId === "call-exact-digest",
				);
			const details = persisted?.message?.details as Record<string, unknown> | undefined;
			const oldDigest = details?.oldTextDigest as { bytes: number; sha256: string } | undefined;
			const newDigest = details?.newTextDigest as { bytes: number; sha256: string } | undefined;

			expect(oldDigest).toEqual({
				bytes: Buffer.byteLength(oldText, "utf8"),
				sha256: createHash("sha256").update(Buffer.from(oldText, "utf8")).digest("hex"),
			});
			expect(newDigest).toEqual({
				bytes: Buffer.byteLength(newText, "utf8"),
				sha256: createHash("sha256").update(Buffer.from(newText, "utf8")).digest("hex"),
			});
			expect(details?.oldText).toBe(
				"[edit snapshot externalized: see oldTextDigest/newTextDigest; full body omitted from transcript]",
			);
			expect(details?.newText).toBe(
				"[edit snapshot externalized: see oldTextDigest/newTextDigest; full body omitted from transcript]",
			);
		} finally {
			await manager.close();
		}
	});

	it("persists small edit snapshots inline without receipts", async () => {
		const root = makeTempDir("gjc-4566-inline-");
		const cwd = path.join(root, "proj");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(cwd, "small.txt"), "a\n", "utf8");

		const { EditTool } = await import("../src/edit");
		const editTool = new EditTool(makeEditToolSessionWithMode(cwd, "patch") as never);

		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 });
			manager.appendMessage(makeAssistantMessage() as never);
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");

			const result = await editTool.execute(
				"call-small",
				{ path: "small.txt", edits: [{ op: "update", diff: "@@\n-a\n+b" }] } as never,
				undefined,
				undefined,
				undefined,
			);
			expect(result.isError).toBeFalsy();
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "call-small",
				toolName: "edit",
				content: result.content,
				details: result.details,
				isError: false,
				timestamp: Date.now(),
			});
			await manager.flush();

			const entryLine = fs
				.readFileSync(sessionFile, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
				.find(
					e =>
						e.type === "message" &&
						(e.message as { role?: string } | undefined)?.role === "toolResult" &&
						(e.message as { toolName?: string } | undefined)?.toolName === "edit",
				);
			const details = entryLine?.message?.details as Record<string, unknown> | undefined;
			expect(details).toBeDefined();
			// Sub-cap bodies persist verbatim — no receipts, no markers.
			expect(details?.oldText).toBe("a\n");
			expect(details?.newText).toBe("b\n");
			expect("oldTextDigest" in (details ?? {})).toBe(false);
			expect("newTextDigest" in (details ?? {})).toBe(false);
		} finally {
			await manager.close();
		}
	});

	it("bounds per-file copies in multi-file apply_patch results", async () => {
		const root = makeTempDir("gjc-4566-multifile-");
		const cwd = path.join(root, "proj");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const body = `${"line\n".repeat(5000)}`; // ~25 KB > 16 KiB cap
		fs.writeFileSync(path.join(cwd, "one.txt"), `${body}one-old\n`, "utf8");
		fs.writeFileSync(path.join(cwd, "two.txt"), `${body}two-old\n`, "utf8");

		const { EditTool } = await import("../src/edit");
		const editTool = new EditTool(makeEditToolSession(cwd) as never);

		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 });
			manager.appendMessage(makeAssistantMessage() as never);
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");

			const input = [
				"*** Begin Patch",
				"*** Update File: one.txt",
				"@@",
				"-one-old",
				"+one-new",
				"*** Update File: two.txt",
				"@@",
				"-two-old",
				"+two-new",
				"*** End Patch",
			].join("\n");
			const result = await editTool.execute("call-multi", { input } as never, undefined, undefined, undefined);
			expect(result.isError).toBeFalsy();
			// Live per-file results carry full bodies for ACP diff content.
			const livePerFile = (result.details as { perFileResults?: Array<{ oldText?: string }> }).perFileResults;
			expect(livePerFile?.length).toBe(2);
			for (const perFile of livePerFile ?? []) expect(perFile.oldText?.length ?? 0).toBeGreaterThan(16 * 1024);

			manager.appendMessage({
				role: "toolResult",
				toolCallId: "call-multi",
				toolName: "edit",
				content: result.content,
				details: result.details,
				isError: false,
				timestamp: Date.now(),
			});
			await manager.flush();

			const entryLine = fs
				.readFileSync(sessionFile, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
				.find(
					e =>
						e.type === "message" &&
						(e.message as { role?: string } | undefined)?.role === "toolResult" &&
						(e.message as { toolName?: string } | undefined)?.toolName === "edit",
				);
			const details = entryLine?.message?.details as { perFileResults?: Array<Record<string, unknown>> } | undefined;
			const perFile = details?.perFileResults;
			expect(perFile?.length).toBe(2);
			for (const file of perFile ?? []) {
				const digest = file.oldTextDigest as { bytes: number; sha256: string } | undefined;
				expect(digest).toBeDefined();
				expect(digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
				expect(file.oldText).toBe(
					"[edit snapshot externalized: see oldTextDigest/newTextDigest; full body omitted from transcript]",
				);
				expect(typeof file.diff).toBe("string");
				expect(typeof file.path).toBe("string");
			}
		} finally {
			delete process.env.GJC_EDIT_VARIANT;
			await manager.close();
		}
	});
});

describe("near-limit edit append after committed mutation (#4566)", () => {
	it("recovers the append via full rewrite, keeps the committed edit durable, and states the recovery path", async () => {
		const root = makeTempDir("gjc-4566-nearlimit-");
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const { lineAt } = writeBigFile(cwd, 6400);

		process.env.GJC_EDIT_VARIANT = "apply_patch";
		const { EditTool } = await import("../src/edit");
		const editTool = new EditTool(makeEditToolSession(cwd) as never);

		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 });
			manager.appendMessage(makeAssistantMessage() as never);
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");

			// The first edit applies on disk, then its result append hits the
			// emulated per-file cap exactly as appendManagedFileStreamingSync does
			// when predecessor.size > MANAGED_ARTIFACT_MAX_FILE_BYTES - appended.
			const TEST_CAP = 6000; // far below the post-open transcript size
			const overCap = (bytes: Uint8Array): boolean => fs.statSync(sessionFile).size > TEST_CAP - bytes.byteLength;
			const proto = ManagedSessionDescendantStore.prototype as unknown as Record<string, unknown>;
			const realAppendExpectedIdentitySync = proto.appendExpectedIdentitySync as (
				this: unknown,
				p: string,
				b: Uint8Array,
				...r: unknown[]
			) => unknown;
			const realAppendExpectedIdentity = proto.appendExpectedIdentity as (
				this: unknown,
				p: string,
				b: Uint8Array,
				...r: unknown[]
			) => Promise<unknown>;
			const realAppendSync = proto.appendSync as (this: unknown, p: string, b: Uint8Array) => unknown;
			const rejectIfOverCap = (b: Uint8Array): void => {
				if (overCap(b)) throw new Error("content_too_large");
			};
			proto.appendExpectedIdentitySync = function (this: unknown, p: string, b: Uint8Array, ...r: unknown[]) {
				rejectIfOverCap(b);
				return realAppendExpectedIdentitySync.call(this, p, b, ...r);
			};
			proto.appendExpectedIdentity = async function (this: unknown, p: string, b: Uint8Array, ...r: unknown[]) {
				rejectIfOverCap(b);
				return await realAppendExpectedIdentity.call(this, p, b, ...r);
			};
			proto.appendSync = function (this: unknown, p: string, b: Uint8Array) {
				rejectIfOverCap(b);
				return realAppendSync.call(this, p, b);
			};

			// Committed source mutation: the patch writes disk BEFORE append.
			const newLine = `export const v0 = 0; // patched-0 ${"y".repeat(30)}`;
			const result = await editTool.execute(
				"call-0",
				patchEnvelope(0, lineAt(0), newLine) as never,
				undefined,
				undefined,
				undefined,
			);
			expect(result.isError).toBeFalsy();
			const committed = fs.readFileSync(path.join(cwd, "big.ts"), "utf8").includes("patched-0");
			expect(committed).toBe(true);

			// The near-limit append must not strand the committed edit: the
			// content_too_large fallback rewrites live entries, entry included.
			expect(() =>
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "edit",
					content: result.content,
					details: result.details,
					isError: false,
					timestamp: Date.now(),
				}),
			).not.toThrow();
			await manager.flush();

			const transcript = fs.readFileSync(sessionFile, "utf8");
			// Effect + receipt are both durable: the edit result entry exists with
			// its bounded evidence, and no unclassified SessionAppendPersistenceError
			// surfaced to abort the turn.
			expect(transcript).toContain("Updated big.ts");
			const persistedEdit = transcript
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
				.find(
					e =>
						e.type === "message" &&
						(e.message as { role?: string } | undefined)?.role === "toolResult" &&
						(e.message as { toolCallId?: string } | undefined)?.toolCallId === "call-0",
				);
			expect(persistedEdit).toBeDefined();
			const details = persistedEdit?.message?.details as Record<string, unknown> | undefined;
			expect(details?.oldTextDigest).toBeDefined();
			expect(details?.diff).toBeDefined();

			// The session is not poisoned: the next append after recovery succeeds.
			proto.appendExpectedIdentitySync = realAppendExpectedIdentitySync;
			proto.appendExpectedIdentity = realAppendExpectedIdentity;
			proto.appendSync = realAppendSync;
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "continue" }], timestamp: 3 });
			await manager.flush();
			expect(fs.readFileSync(sessionFile, "utf8")).toContain("continue");
		} finally {
			delete process.env.GJC_EDIT_VARIANT;
			await manager.close();
		}
	});
	it("surfaces the typed near-limit outcome when even the rewrite cannot hold the entry", async () => {
		const root = makeTempDir("gjc-4566-typed-");
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const { lineAt } = writeBigFile(cwd, 6400);

		process.env.GJC_EDIT_VARIANT = "apply_patch";
		const { EditTool } = await import("../src/edit");
		const { SessionNearLimitAppendError: SessionNearLimitAppendErrorValue } = await import(
			"../src/session/session-manager"
		);

		const editTool = new EditTool(makeEditToolSession(cwd) as never);

		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 });
			manager.appendMessage(makeAssistantMessage() as never);
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");

			// Committed source mutation happens BEFORE the append that fails.
			const newLine = `export const v0 = 0; // typed-0 ${"y".repeat(30)}`;
			const result = await editTool.execute(
				"call-0",
				patchEnvelope(0, lineAt(0), newLine) as never,
				undefined,
				undefined,
				undefined,
			);
			expect(result.isError).toBeFalsy();
			expect(fs.readFileSync(path.join(cwd, "big.ts"), "utf8")).toContain("typed-0");

			// Reject EVERY append/replace path deterministically: neither the
			// streaming append nor the recovery full rewrite can fit, which is
			// exactly the state where the old code either aborted with an
			// unclassified error or silently succeeded without the receipt.
			const proto = ManagedSessionDescendantStore.prototype as unknown as Record<string, unknown>;
			const realAppendExpectedIdentitySync = proto.appendExpectedIdentitySync as (
				this: unknown,
				p: string,
				b: Uint8Array,
				...r: unknown[]
			) => unknown;
			const realAppendExpectedIdentity = proto.appendExpectedIdentity as (
				this: unknown,
				p: string,
				b: Uint8Array,
				...r: unknown[]
			) => Promise<unknown>;
			const realAppendSync = proto.appendSync as (this: unknown, p: string, b: Uint8Array) => unknown;
			const realReplaceSync = proto.replaceSync as (this: unknown, p: string, b: Uint8Array) => unknown;
			const realReplaceExpectedIdentitySync = proto.replaceExpectedIdentitySync as (
				this: unknown,
				p: string,
				b: Uint8Array,
				...r: unknown[]
			) => unknown;
			const realReplaceExpectedIdentity = proto.replaceExpectedIdentity as (
				this: unknown,
				p: string,
				b: Uint8Array,
				...r: unknown[]
			) => Promise<unknown>;
			let appendCalls = 0;
			const rejectTooLarge = (): never => {
				appendCalls++;
				throw new Error("content_too_large");
			};
			proto.appendExpectedIdentitySync = function (this: unknown, _p: string, _b: Uint8Array, ..._r: unknown[]) {
				return rejectTooLarge();
			};
			proto.appendExpectedIdentity = async function (this: unknown, _p: string, _b: Uint8Array, ..._r: unknown[]) {
				return rejectTooLarge();
			};
			proto.appendSync = function (this: unknown, _p: string, _b: Uint8Array) {
				return rejectTooLarge();
			};
			proto.replaceSync = function (this: unknown, _p: string, _b: Uint8Array) {
				return rejectTooLarge();
			};
			proto.replaceExpectedIdentitySync = function (this: unknown, _p: string, _b: Uint8Array, ..._r: unknown[]) {
				return rejectTooLarge();
			};
			proto.replaceExpectedIdentity = async function (this: unknown, _p: string, _b: Uint8Array, ..._r: unknown[]) {
				return rejectTooLarge();
			};
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "call-0",
				toolName: "edit",
				content: result.content,
				details: result.details,
				isError: false,
				timestamp: Date.now(),
			});
			let thrown: unknown;
			try {
				await manager.flush();
			} catch (error) {
				thrown = error;
			}

			proto.appendExpectedIdentitySync = realAppendExpectedIdentitySync;
			proto.appendExpectedIdentity = realAppendExpectedIdentity;
			proto.appendSync = realAppendSync;
			proto.replaceSync = realReplaceSync;
			proto.replaceExpectedIdentitySync = realReplaceExpectedIdentitySync;
			proto.replaceExpectedIdentity = realReplaceExpectedIdentity;

			expect(thrown).toBeInstanceOf(SessionNearLimitAppendErrorValue);
			const typed = thrown as InstanceType<typeof SessionNearLimitAppendErrorValue>;
			// Deterministic, structured fields — not an unclassified
			// SessionAppendPersistenceError abort.
			expect(typed.code).toBe("near_limit_append");
			expect(typed.capBytes).toBe(128 * 1024 * 1024);
			expect(typed.entryBytes).toBeGreaterThan(0);
			expect(typed.entryRetained).toBe(true);
			expect(typed.message).toContain("compact");
			expect(typed.message).toContain("gjc export");
			// The committed edit is still in memory; the next successful persist
			// (after compaction) records it — the effect/receipt gap is stated,
			// not silent.
			const entries = manager.getBranch();
			expect(
				entries.some(
					entry => entry.type === "message" && (entry.message as { toolCallId?: string }).toolCallId === "call-0",
				),
			).toBe(true);
			expect(appendCalls).toBeGreaterThanOrEqual(1);
		} finally {
			delete process.env.GJC_EDIT_VARIANT;
			await manager.close();
		}
	});
});
