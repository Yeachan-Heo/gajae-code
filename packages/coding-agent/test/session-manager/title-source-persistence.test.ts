import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	loadEntriesFromFile,
	parseSessionEntries,
	type SessionHeader,
	SessionManager,
} from "@gajae-code/coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorageWriter } from "@gajae-code/coding-agent/session/session-storage";
import * as native from "@gajae-code/natives";
import { getConfigRootDir, parseJsonlLenient, setAgentDir } from "@gajae-code/utils";
import {
	ManagedAppendOutcomeError,
	ManagedSessionDescendantStore,
} from "../../src/session/internal/managed-session-storage";

import { makeAssistantMessage } from "./helpers";
import { injectManagedAppend } from "./managed-failure-injection";

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(entry): entry is SessionHeader =>
			typeof entry === "object" && entry !== null && "type" in entry && entry.type === "session",
	);
}

class FailingPatchStorage extends FileSessionStorage {
	rewrites = 0;
	syncRewrites = 0;

	override writeTextSync(filePath: string, content: string): void {
		this.syncRewrites++;
		super.writeTextSync(filePath, content);
	}

	override async writeText(filePath: string, content: string): Promise<void> {
		this.rewrites++;
		await super.writeText(filePath, content);
	}

	override openWriter(
		filePath: string,
		options?: { flags?: "a" | "w"; onError?: (error: Error) => void },
	): SessionStorageWriter {
		const writer = super.openWriter(filePath, options);
		return {
			writeLine: async () => {
				throw new Error("entry patch failed");
			},
			writeLineSync: line => writer.writeLineSync(line),
			flush: () => writer.flush(),
			fsync: () => writer.fsync(),
			close: () => writer.close(),
			closeSync: () => writer.closeSync(),
			getError: () => writer.getError(),
			getCloseState: () => writer.getCloseState(),
			getCloseError: () => writer.getCloseError(),
		};
	}
}
class CapturingWriterStorage extends FileSessionStorage {
	syncAppends: string[] = [];

	override openWriter(
		filePath: string,
		options?: { flags?: "a" | "w"; onError?: (error: Error) => void },
	): SessionStorageWriter {
		const writer = super.openWriter(filePath, options);
		return {
			writeLine: line => writer.writeLine(line),
			writeLineSync: line => {
				if (options?.flags !== "w") this.syncAppends.push(line);
				writer.writeLineSync(line);
			},
			flush: () => writer.flush(),
			fsync: () => writer.fsync(),
			close: () => writer.close(),
			closeSync: () => writer.closeSync(),
			getError: () => writer.getError(),
			getCloseState: () => writer.getCloseState(),
			getCloseError: () => writer.getCloseError(),
		};
	}
}

describe("session title source persistence", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-title-source-"));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(testAgentDir, { recursive: true, force: true });
	});

	it("persists auto title source across reopen", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.setSessionName("Auto title", "auto");
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();

		const entries = await loadEntriesFromFile(sessionFile!);
		expect(getHeader(entries)?.titleSource).toBe("auto");

		const reopened = await SessionManager.open(sessionFile!);
		expect(reopened.getSessionName()).toBe("Auto title");
		expect(reopened.titleSource).toBe("auto");
	});

	it("persists user title source across reopen", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.setSessionName("Manual title", "user");
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();

		const entries = await loadEntriesFromFile(sessionFile!);
		expect(getHeader(entries)?.titleSource).toBe("user");

		const reopened = await SessionManager.open(sessionFile!);
		expect(reopened.getSessionName()).toBe("Manual title");
		expect(reopened.titleSource).toBe("user");
	});
	it("durably persists a fresh session title before reporting success", async () => {
		const session = SessionManager.create(cwd);
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		await expect(session.setSessionName("Fresh title", "auto")).resolves.toBe(true);
		expect(fs.existsSync(sessionFile!)).toBe(true);

		const reopened = await SessionManager.open(sessionFile!);
		expect(reopened.getSessionName()).toBe("Fresh title");
		expect(reopened.titleSource).toBe("auto");
	});

	it("serializes late auto titles behind a manual rename", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const manual = session.setSessionName("Manual title", "user");
		const lateAuto = session.setSessionName("Generated title", "auto");
		await expect(manual).resolves.toBe(true);
		await expect(lateAuto).resolves.toBe(false);
		expect(session.getSessionName()).toBe("Manual title");
	});

	it("keeps the current UTF-8 title in the bounded tail after transcript growth", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sessionFile = session.getSessionFile()!;
		await session.setSessionName("界 title", "user");

		session.appendMessage({ role: "user", content: "界".repeat(7_000), timestamp: 2 });
		await session.flush();

		const bytes = fs.readFileSync(sessionFile);
		expect(bytes.byteLength).toBeGreaterThan(16 * 1024);
		expect(bytes.subarray(Math.max(0, bytes.byteLength - 16 * 1024)).toString("utf8")).toContain("界 title");
		const listed = await SessionManager.listForResumePickerReadOnly(cwd, path.dirname(sessionFile));
		expect(listed.find(candidate => candidate.path === sessionFile)?.title).toBe("界 title");
	});
	it("anchors title projections only with the entry that crosses the 8KiB interval", async () => {
		const storage = new CapturingWriterStorage();
		const session = SessionManager.create(cwd, path.join(testAgentDir, "sessions"), storage);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		await session.setSessionName("Projected title", "user");
		storage.syncAppends = [];

		for (let timestamp = 2; timestamp <= 4; timestamp++) {
			session.appendMessage({ role: "user", content: "x".repeat(2_000), timestamp });
		}
		await session.flush();
		expect(storage.syncAppends).toHaveLength(3);
		expect(storage.syncAppends.flatMap(batch => batch.trimEnd().split("\n"))).not.toContain(
			expect.stringContaining('"type":"header_patch"'),
		);

		session.appendMessage({ role: "user", content: "x".repeat(3_000), timestamp: 5 });
		await session.flush();
		expect(storage.syncAppends).toHaveLength(4);
		const crossingBatch = storage.syncAppends.at(-1)!;
		const crossingRecords = crossingBatch
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(crossingRecords).toHaveLength(2);
		expect(crossingRecords[0]).toMatchObject({ type: "message", message: { content: "x".repeat(3_000) } });
		expect(crossingRecords[1]).toEqual({
			type: "header_patch",
			patch: { title: "Projected title", titleSource: "user" },
		});

		session.appendMessage({ role: "user", content: "small", timestamp: 6 });
		await session.flush();
		expect(storage.syncAppends.at(-1)?.trimEnd().split("\n")).toHaveLength(1);
	});

	it("uses one managed-authority append payload for a crossing entry and title anchor", async () => {
		const destination = SessionManager.managedDestination(cwd, testAgentDir);
		const session = SessionManager.create(cwd, destination);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		await session.setSessionName("Managed title", "user");

		const append = ManagedSessionDescendantStore.prototype.appendWithOutcomeSync;
		const spy = vi.spyOn(ManagedSessionDescendantStore.prototype, "appendWithOutcomeSync");
		try {
			session.appendMessage({ role: "user", content: "x".repeat(9_000), timestamp: 2 });
			await session.flush();
			expect(spy).toHaveBeenCalledTimes(1);
			const payload = Buffer.from(spy.mock.calls[0]![1]).toString("utf8");
			const records = payload
				.trimEnd()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(records).toHaveLength(2);
			expect(records[0]).toMatchObject({ type: "message", message: { content: "x".repeat(9_000) } });
			expect(records[1]).toEqual({
				type: "header_patch",
				patch: { title: "Managed title", titleSource: "user" },
			});
		} finally {
			spy.mockRestore();
		}
		expect(append).toBe(ManagedSessionDescendantStore.prototype.appendWithOutcomeSync);
	});

	it("repairs a buried v5 title patch with a bounded strict title-only projection", async () => {
		const sessionFile = path.join(cwd, "buried-title.jsonl");
		const records = [
			{ type: "session", version: 5, id: "buried", timestamp: "2026-01-01T00:00:00.000Z", cwd },
			{ type: "header_patch", patch: { title: "Legacy title" } },
			{
				type: "message",
				id: "large",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "x".repeat(20_000), timestamp: 1 },
			},
		];
		fs.writeFileSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		const reopened = await SessionManager.open(sessionFile);
		expect(reopened.getSessionName()).toBe("Legacy title");
		expect(reopened.titleSource).toBeUndefined();

		reopened.appendMessage({ role: "user", content: "repair", timestamp: 2 });
		await reopened.flush();
		const persisted = fs
			.readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(persisted.at(-1)).toEqual({ type: "header_patch", patch: { title: "Legacy title" } });

		const reads: Array<{ length: number; position: number | null }> = [];
		const open = fs.promises.open;
		const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await open(file, flags, mode);
			return {
				read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
					reads.push({ length, position });
					return await handle.read(buffer, offset, length, position);
				},
				close: () => handle.close(),
			} as unknown as fs.promises.FileHandle;
		});
		try {
			const listed = await SessionManager.listForResumePickerReadOnly(cwd, path.dirname(sessionFile));
			expect(listed.find(candidate => candidate.path === sessionFile)?.title).toBe("Legacy title");
		} finally {
			openSpy.mockRestore();
		}
		const prefixReads = reads.filter(read => read.position === 0);
		const trailingReads = reads.filter(read => read.position !== 0);
		expect(prefixReads).toHaveLength(1);
		expect(prefixReads[0]?.length).toBeLessThanOrEqual(4 * 1024);
		expect(trailingReads.reduce((total, read) => total + read.length, 0)).toBeLessThanOrEqual(16 * 1024);

		await expect(reopened.setSessionName("Manual title", "user")).resolves.toBe(true);
		await expect(reopened.setSessionName("Generated title", "auto")).resolves.toBe(false);
	});

	it("throws without publishing a title when managed append is certified not applied", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const injection =
			process.platform === "linux"
				? injectManagedAppend((_relativePath, data) =>
						Buffer.from(data).includes(Buffer.from('"type":"header_patch"'))
							? { ok: false, code: "header_patch_write_failed" }
							: "passthrough",
					)
				: (() => {
						const append = ManagedSessionDescendantStore.prototype.appendWithOutcomeSync;
						const spy = vi
							.spyOn(ManagedSessionDescendantStore.prototype, "appendWithOutcomeSync")
							.mockImplementation(function (this: ManagedSessionDescendantStore, relativePath, data) {
								if (Buffer.from(data).includes(Buffer.from('"type":"header_patch"')))
									throw new ManagedAppendOutcomeError("not_applied", "header_patch_write_failed", undefined);
								return append.call(this, relativePath, data);
							});
						return {
							restore: () => spy.mockRestore(),
							assertHit: () => expect(spy).toHaveBeenCalled(),
						};
					})();
		try {
			await expect(session.setSessionName("will fail", "user")).rejects.toThrow("header_patch_write_failed");
			injection.assertHit();
			expect(session.getSessionName()).toBeUndefined();
			expect(session.titleSource).toBeUndefined();
		} finally {
			injection.restore();
		}

		await expect(session.setSessionName("later", "user")).resolves.toBe(true);
		expect(session.getSessionName()).toBe("later");
	});

	it("fails closed after a managed title append becomes ambiguous", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sessionFile = session.getSessionFile()!;

		let restore: () => void;
		if (process.platform === "linux") {
			const append = native.RecoveryFsRoot.prototype.appendManaged;
			const spy = vi.spyOn(native.RecoveryFsRoot.prototype, "appendManaged").mockImplementation(function (
				this: native.RecoveryFsRoot,
				...args: Parameters<(typeof native.RecoveryFsRoot.prototype)["appendManaged"]>
			) {
				append.apply(this, args);
				throw new Error("post_append_authority_verification_failed");
			});
			restore = () => spy.mockRestore();
		} else {
			const fsync = fs.fsyncSync;
			const spy = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
				fsync(fd);
				throw new Error("post_append_authority_verification_failed");
			});
			restore = () => spy.mockRestore();
		}

		try {
			await expect(session.setSessionName("ambiguous", "user")).rejects.toThrow(
				"post_append_authority_verification_failed",
			);
			expect(session.getSessionName()).toBeUndefined();
			await expect(session.setSessionName("later", "user")).rejects.toThrow(
				"post_append_authority_verification_failed",
			);
		} finally {
			restore();
		}

		const reopened = await SessionManager.open(sessionFile);
		expect(reopened.getSessionName()).toBe("ambiguous");
		expect(reopened.titleSource).toBe("user");
	});

	it("appends a bounded header patch and replays v3 and v4 transcripts deterministically", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "x".repeat(1_000_000), timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sessionFile = session.getSessionFile()!;
		const sizeBeforeRename = fs.statSync(sessionFile).size;

		await session.setSessionName("Patched title", "user");

		const raw = fs.readFileSync(sessionFile, "utf8");
		const records = raw
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line) as { type?: string });
		expect(records.at(-1)).toMatchObject({
			type: "header_patch",
			patch: { title: "Patched title", titleSource: "user" },
		});
		expect(fs.statSync(sessionFile).size - sizeBeforeRename).toBeLessThan(300);
		expect((await loadEntriesFromFile(sessionFile))[0]).toMatchObject({
			version: CURRENT_SESSION_VERSION,
			title: "Patched title",
			titleSource: "user",
		});
		const listed = await SessionManager.listForResumePickerReadOnly(cwd, path.dirname(sessionFile));
		expect(listed.find(candidate => candidate.path === sessionFile)?.title).toBe("Patched title");
		const oversizedTitle = "界".repeat(10_000);
		await session.setSessionName(oversizedTitle, "user");
		expect(session.getSessionName()).toBe("界".repeat(1_000));
		const listedAfterOversizedTitle = await SessionManager.listForResumePickerReadOnly(
			cwd,
			path.dirname(sessionFile),
		);
		expect(listedAfterOversizedTitle.find(candidate => candidate.path === sessionFile)?.title).toBe(
			"界".repeat(1_000),
		);

		const v3 = [
			{ type: "session", version: 3, id: "old", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/old" },
			{ type: "header_patch", patch: { cwd: "/new", title: "New title" } },
			{ type: "header_patch", patch: { title: "Final title" } },
		]
			.map(record => JSON.stringify(record))
			.join("\n");
		expect(parseSessionEntries(v3)[0]).not.toHaveProperty("title");
		const ignoredPatches = `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "strict", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/original" })}\n${JSON.stringify({ type: "message", id: "message", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "original", timestamp: 1 } })}\n${JSON.stringify({ type: "header_patch", patch: { title: "ignored", unexpected: true }, outerUnexpected: true })}\n${JSON.stringify({ type: "entry_patch", entryId: "message", patch: { message: { role: "user", content: "ignored", timestamp: 1 }, unexpected: true }, outerUnexpected: true })}\n`;
		expect(parseSessionEntries(ignoredPatches)).toMatchObject([
			{ type: "session", cwd: "/original" },
			{ type: "message", message: { content: "original" } },
		]);
	});

	it("replays only ordered, valid v4 patches", () => {
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "ordered",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/original",
		};
		const message = {
			type: "message",
			id: "message",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "original", timestamp: 1 },
		};
		const content = [
			{ type: "header_patch", patch: { title: "forward" } },
			header,
			{
				type: "entry_patch",
				entryId: "message",
				patch: { message: { role: "user", content: "forward", timestamp: 1 } },
			},
			message,
			{ type: "header_patch", patch: { title: "first" } },
			{ type: "header_patch", patch: { title: "last" } },
			{
				type: "entry_patch",
				entryId: "message",
				patch: { message: { role: "user", content: "first", timestamp: 1 } },
			},
			{
				type: "entry_patch",
				entryId: "message",
				patch: { message: { role: "user", content: "last", timestamp: 1 } },
			},
			'{"type":"header_patch","patch":',
		]
			.map(record => (typeof record === "string" ? record : JSON.stringify(record)))
			.join("\n");

		expect(parseSessionEntries(content)).toMatchObject([
			{ type: "session", title: "last" },
			{ type: "message", message: { content: "last" } },
		]);
	});

	it("keeps v4 patch records lossless through the pinned pre-v4 reader rewrite", () => {
		const records = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "v4", timestamp: "2026-01-01T00:00:00.000Z", cwd },
			{
				type: "message",
				id: "message",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "original", timestamp: 1 },
			},
			{ type: "header_patch", patch: { title: "patched" } },
			{
				type: "entry_patch",
				entryId: "message",
				patch: { message: { role: "user", content: "patched", timestamp: 1 } },
			},
		];
		const content = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
		const legacyRecords = parseJsonlLenient<Record<string, unknown>>(content);
		const pinnedPreV4Commit = "904eab21c3c7991868c740a6563ccd4fbbbbcf84";
		const rewrittenByPinnedV3Semantics = `${legacyRecords.map(record => JSON.stringify(record)).join("\n")}\n`;

		expect(pinnedPreV4Commit).toHaveLength(40);
		expect(rewrittenByPinnedV3Semantics).toBe(content);
		expect(parseSessionEntries(rewrittenByPinnedV3Semantics)[0]).toMatchObject({ title: "patched" });

		expect(legacyRecords[0]?.version).toBeGreaterThan(3);
		expect(legacyRecords.find(record => record.type === "message")?.message).toEqual({
			role: "user",
			content: "original",
			timestamp: 1,
		});
		expect(parseSessionEntries(content)[0]).toMatchObject({ title: "patched" });
	});

	it("appends an entry patch when replay metadata is sanitized on reopen", async () => {
		const sessionFile = path.join(cwd, "replay.jsonl");
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "replay",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		};
		const entry = {
			type: "message",
			id: "assistant",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "private", thinkingSignature: "stale" }],
				provider: "openai",
				model: "gpt-5",
				timestamp: 1,
				providerPayload: { type: "openaiResponsesHistory", provider: "openai", items: [] },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		};
		fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);

		const session = await SessionManager.open(sessionFile);
		const records = fs
			.readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(records.at(-1)).toMatchObject({ type: "entry_patch", entryId: "assistant" });
		expect(session.getEntries()[0]).toMatchObject({
			type: "message",
			message: { providerPayload: undefined, content: [{ thinkingSignature: undefined }] },
		});
	});

	it("propagates replay patch failures without rewriting the base transcript", async () => {
		const sessionFile = path.join(cwd, "replay-patch-failure.jsonl");
		const base = `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "replay", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n${JSON.stringify({ type: "message", id: "assistant", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "private", thinkingSignature: "stale" }], provider: "openai", model: "gpt-5", timestamp: 1, providerPayload: { type: "openaiResponsesHistory", provider: "openai", items: [] }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } })}\n`;
		fs.writeFileSync(sessionFile, base);
		const storage = new FailingPatchStorage();

		await expect(SessionManager.open(sessionFile, cwd, storage)).rejects.toThrow("entry patch failed");
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(base);
		expect(storage.rewrites).toBe(0);
		expect(storage.syncRewrites).toBe(0);
	});

	describe("moveTo header patch persistence", () => {
		it("rejects when the moved session cwd patch cannot be written", async () => {
			const destinationCwd = path.join(testAgentDir, "destination-cwd");
			fs.mkdirSync(destinationCwd, { recursive: true });
			const storage = new FileSessionStorage();
			const session = SessionManager.create(cwd, undefined, storage);
			session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			session.appendMessage(makeAssistantMessage());
			await session.flush();
			const originalFile = session.getSessionFile();
			expect(originalFile).toBeDefined();

			const injection = injectManagedAppend((_relativePath, data) =>
				Buffer.from(data).includes(Buffer.from('"type":"header_patch"'))
					? { ok: false, code: "header_patch_write_failed" }
					: "passthrough",
			);
			try {
				await expect(session.moveTo(destinationCwd)).rejects.toThrow("header_patch_write_failed");
				injection.assertHit();
			} finally {
				injection.restore();
			}
			expect(session.getCwd()).toBe(cwd);
			expect(session.getSessionFile()).toBe(originalFile);
			expect((await loadEntriesFromFile(originalFile!, storage))[0]).toMatchObject({ cwd });
		});
	});
});
