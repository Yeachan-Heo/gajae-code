import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	loadEntriesFromFile,
	parseSessionEntries,
	type SessionHeader,
	SessionManager,
	SessionManagerTestHooks,
} from "@gajae-code/coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorageWriter } from "@gajae-code/coding-agent/session/session-storage";
import { getConfigRootDir, parseJsonlLenient, setAgentDir } from "@gajae-code/utils";

import { makeAssistantMessage } from "./helpers";
import { injectManagedAppendOutcomeUncertain, injectManagedAppendPreCommit } from "./managed-failure-injection";

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
			writeLineSync: () => {
				throw new Error("entry patch failed");
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
		SessionManagerTestHooks.beforePersistPatchFence = undefined;
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
	it("persists star state through append-only header patches", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "keep this", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sessionFile = session.getSessionFile()!;

		expect(session.isSessionStarred()).toBe(false);
		expect(await session.setSessionStarred(false)).toBe(false);
		expect(await session.setSessionStarred(true)).toBe(true);
		expect(await session.setSessionStarred(true)).toBe(false);
		expect(session.isSessionStarred()).toBe(true);
		expect(await session.setSessionName("Starred session", "user")).toBe(true);

		const rawRecords = fs
			.readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line) as { type?: string; patch?: { starred?: boolean; title?: string } });
		expect(rawRecords.at(-2)).toEqual({ type: "header_patch", patch: { starred: true } });
		expect(rawRecords.at(-1)).toMatchObject({
			type: "header_patch",
			patch: { title: "Starred session" },
		});
		expect(rawRecords.at(-1)?.patch?.starred).toBeUndefined();

		const listedStarred = await SessionManager.listForResumePickerReadOnly(cwd, path.dirname(sessionFile));
		expect(listedStarred.find(candidate => candidate.path === sessionFile)?.starred).toBe(true);

		const reopened = await SessionManager.open(sessionFile);
		expect(reopened.isSessionStarred()).toBe(true);
		expect(await reopened.setSessionStarred(false)).toBe(true);
		expect(reopened.isSessionStarred()).toBe(false);

		const listedUnstarred = await SessionManager.listForResumePickerReadOnly(cwd, path.dirname(sessionFile));
		expect(listedUnstarred.find(candidate => candidate.path === sessionFile)?.starred).toBe(false);
	});

	it("upgrades a pre-star transcript once before appending its first star patch", async () => {
		const sessionFile = path.join(cwd, "pre-star.jsonl");
		const records = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "pre-star",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
			},
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "legacy", timestamp: 1 },
			},
		];
		fs.writeFileSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);

		const session = await SessionManager.open(sessionFile);
		expect(await session.setSessionStarred(true)).toBe(true);

		const persisted = fs
			.readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(persisted[0]).toMatchObject({ type: "session", starredPatchVersion: 1 });
		expect(persisted.at(-1)).toEqual({ type: "header_patch", patch: { starred: true } });
		expect((await SessionManager.listForResumePickerReadOnly(cwd, cwd))[0]?.starred).toBe(true);
	});

	it("restores in-memory star state when persistence fails", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "keep this", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		SessionManagerTestHooks.beforePersistPatchFence = () => {
			throw new Error("star patch failed");
		};
		await expect(session.setSessionStarred(true)).rejects.toThrow("star patch failed");
		expect(session.isSessionStarred()).toBe(false);
		expect(session.getHeader()).not.toHaveProperty("starred");
	});

	it("ignores malformed star header patches", () => {
		const content = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "invalid-star",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			},
			{ type: "header_patch", patch: { starred: "yes" } },
		]
			.map(record => JSON.stringify(record))
			.join("\n");

		expect(parseSessionEntries(content)[0]).not.toHaveProperty("starred");
	});

	it("ignores star patches on transcripts without the star capability", () => {
		const content = [
			{
				type: "session",
				version: 5,
				id: "pre-star-capability",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			},
			{ type: "header_patch", patch: { starred: true } },
		]
			.map(record => JSON.stringify(record))
			.join("\n");

		expect(parseSessionEntries(content)[0]).not.toHaveProperty("starred");
	});

	it("keeps a star set before the first message", async () => {
		const session = SessionManager.create(cwd);
		expect(await session.setSessionStarred(true)).toBe(true);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reopened = await SessionManager.open(sessionFile!);
		expect(reopened.isSessionStarred()).toBe(true);
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
		it("retains the causal error and source authority when the cwd patch append is rejected before commit", async () => {
			const destinationCwd = path.join(testAgentDir, "destination-cwd");
			fs.mkdirSync(destinationCwd, { recursive: true });
			const storage = new FileSessionStorage();
			const session = SessionManager.create(cwd, undefined, storage);
			session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			session.appendMessage(makeAssistantMessage());
			await session.flush();
			const originalFile = session.getSessionFile();
			expect(originalFile).toBeDefined();
			const originalBytes = fs.readFileSync(originalFile!);

			const injection = injectManagedAppendPreCommit((_relativePath, data) =>
				Buffer.from(data).includes(Buffer.from('"type":"header_patch"'))
					? { ok: false, code: "header_patch_write_failed" }
					: "passthrough",
			);
			let failure: Error | undefined;
			try {
				await session.moveTo(destinationCwd);
			} catch (error) {
				failure = error as Error;
			} finally {
				injection.restore();
			}
			expect(failure).toBeInstanceOf(Error);
			if (!failure) throw new Error("Expected moveTo to reject");
			expect(["header_patch_write_failed", "managed_append_committed_outcome_uncertain"]).toContain(failure.message);
			if (failure.message === "managed_append_committed_outcome_uncertain")
				expect((failure as Error & { cause?: unknown }).cause).toMatchObject({
					message: "header_patch_write_failed",
				});
			injection.assertHit();
			expect(session.getCwd()).toBe(cwd);
			expect(session.getSessionFile()).toBe(originalFile);
			expect(fs.readFileSync(originalFile!)).toEqual(originalBytes);
			expect((await loadEntriesFromFile(originalFile!, storage))[0]).toMatchObject({ cwd });
		});

		for (const failureCode of ["identity_mismatch", "not_found"] as const) {
			it.skipIf(process.platform !== "linux")(
				`retains the uncertain ${failureCode} classification without retry after the cwd patch append commits`,
				async () => {
					const destinationCwd = path.join(testAgentDir, `post-commit-${failureCode}-destination-cwd`);
					fs.mkdirSync(destinationCwd, { recursive: true });
					const storage = new FileSessionStorage();
					const session = SessionManager.create(cwd, undefined, storage);
					session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
					session.appendMessage(makeAssistantMessage());
					await session.flush();
					const originalFile = session.getSessionFile();
					expect(originalFile).toBeDefined();
					const originalBytes = fs.readFileSync(originalFile!);
					const destinationFile = path.join(
						SessionManager.getDefaultSessionDir(destinationCwd, testAgentDir, storage),
						path.basename(originalFile!),
					);

					const injection = injectManagedAppendOutcomeUncertain((_relativePath, data) =>
						Buffer.from(data).includes(Buffer.from('"type":"header_patch"'))
							? { ok: false, code: failureCode }
							: "passthrough",
					);
					let failure: Error | undefined;
					try {
						await session.moveTo(destinationCwd);
					} catch (error) {
						failure = error instanceof Error ? error : new Error(String(error));
					} finally {
						injection.restore();
					}
					expect(failure?.message).toBe("managed_append_committed_outcome_uncertain");
					expect(failure?.cause).toBeInstanceOf(Error);
					expect((failure?.cause as Error).message).toBe(failureCode);
					injection.assertHit();
					expect(injection.hits()).toBe(1);
					expect(injection.realAppendCalls()).toBe(1);
					expect(session.getCwd()).toBe(cwd);
					expect(session.getSessionFile()).toBe(originalFile);
					expect(fs.readFileSync(originalFile!)).toEqual(originalBytes);
					const persistedBytes = fs.readFileSync(destinationFile);
					expect(persistedBytes.subarray(0, originalBytes.byteLength)).toEqual(originalBytes);
					const patchLines = persistedBytes
						.toString("utf8")
						.trimEnd()
						.split("\n")
						.filter(line => line.includes('"type":"header_patch"'));
					expect(patchLines).toHaveLength(2);
					expect(patchLines.map(line => JSON.parse(line))).toEqual([
						{ type: "header_patch", patch: { starred: false } },
						{ type: "header_patch", patch: { cwd: destinationCwd } },
					]);
				},
			);
		}
	});
});
