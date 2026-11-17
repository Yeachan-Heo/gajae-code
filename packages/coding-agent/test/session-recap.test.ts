import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	SESSION_RECAP_ENTRY,
	SESSION_RECAP_MAX_CANDIDATES,
	type SessionRecapInput,
	type SessionRecapRejection,
} from "@gajae-code/coding-agent/session/recap";
import {
	BOUNDED_FIRST_OPEN_MAX_LINE_BYTES,
	type SessionInfo,
	SessionManager,
} from "@gajae-code/coding-agent/session/session-manager";
import {
	SESSION_RECAP_MAX_BYTES,
	SESSION_RECAP_MAX_CODEPOINTS,
	type SessionRecapRecord,
} from "../src/sdk/session-recap";
import { assistantMsg, userMsg } from "./utilities";

const GENERATED_AT = "2026-11-02T07:12:00.000Z";
/** U+10400: one code point, two UTF-16 units, four UTF-8 bytes. */
const FOUR_BYTE_CHAR = "𐐀";

interface Turn {
	requestId: string;
	sourceId: string;
}

function completeTurn(manager: SessionManager, request = "버그를 고쳐줘", answer = "고쳤습니다"): Turn {
	const requestId = manager.appendMessage(userMsg(request));
	const sourceId = manager.appendMessage(assistantMsg(answer));
	return { requestId, sourceId };
}

function recapFor(turn: Turn, overrides: Partial<SessionRecapInput> = {}): SessionRecapInput {
	return {
		text: "로그인 리다이렉트 버그를 고쳤다",
		sourceEntryId: turn.sourceId,
		requestEntryId: turn.requestId,
		model: { provider: "test-provider", id: "test-model" },
		generatedAt: GENERATED_AT,
		...overrides,
	};
}

function recapEntryCount(manager: SessionManager): number {
	return manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === SESSION_RECAP_ENTRY)
		.length;
}

function rejected(reason: SessionRecapRejection): { status: "rejected"; reason: SessionRecapRejection } {
	return { status: "rejected", reason };
}

function commit(manager: SessionManager, turn: Turn, overrides: Partial<SessionRecapInput> = {}): string {
	const result = manager.appendSessionRecap(recapFor(turn, overrides));
	if (result.status !== "appended") throw new Error(`Expected recap to commit, got ${result.reason}`);
	return result.entryId;
}

describe("session recap storage", () => {
	it("commits a recap as a custom entry linked to its source and reads it back", () => {
		const manager = SessionManager.inMemory();
		const turn = completeTurn(manager);

		const result = manager.appendSessionRecap(recapFor(turn));

		expect(result.status).toBe("appended");
		if (result.status !== "appended") return;
		const entry = manager.getEntry(result.entryId);
		expect(entry).toMatchObject({ type: "custom", customType: SESSION_RECAP_ENTRY, parentId: turn.sourceId });
		expect(manager.getLeafId()).toBe(result.entryId);
		expect(manager.getSessionRecap()).toEqual({
			schemaVersion: 1,
			text: "로그인 리다이렉트 버그를 고쳤다",
			sourceEntryId: turn.sourceId,
			requestEntryId: turn.requestId,
			model: { provider: "test-provider", id: "test-model" },
			generatedAt: GENERATED_AT,
			entryId: result.entryId,
			source: "model",
		});
	});

	it("keeps the recap out of the LLM context and does not create entries on read", () => {
		const manager = SessionManager.inMemory();
		const turn = completeTurn(manager);
		const messagesBefore = manager.buildSessionContext().messages;
		commit(manager, turn);
		const entryCount = manager.getEntries().length;

		expect(manager.buildSessionContext().messages).toEqual(messagesBefore);
		manager.getSessionRecap();
		manager.getSessionRecap();
		expect(manager.getEntries()).toHaveLength(entryCount);
	});

	it("returns detached copies so callers cannot alter the stored recap", () => {
		const manager = SessionManager.inMemory();
		commit(manager, completeTurn(manager));

		const first = manager.getSessionRecap();
		if (!first) throw new Error("Expected recap");
		first.text = "tampered";
		first.model.id = "tampered";

		expect(manager.getSessionRecap()).toMatchObject({
			text: "로그인 리다이렉트 버그를 고쳤다",
			model: { provider: "test-provider", id: "test-model" },
		});
	});

	it("ignores arbitrarily many unrelated metadata entries but bounds forged recap candidates", () => {
		const manager = SessionManager.inMemory();
		const turn = completeTurn(manager);
		commit(manager, turn);
		for (let index = 0; index < SESSION_RECAP_MAX_CANDIDATES + 1; index++) {
			manager.appendCustomEntry("cost", { output: "x".repeat(2048) });
		}
		expect(manager.getSessionRecap()?.sourceEntryId).toBe(turn.sourceId);
		for (let index = 1; index < SESSION_RECAP_MAX_CANDIDATES; index++) {
			manager.appendCustomEntry(SESSION_RECAP_ENTRY, { ...recapFor(turn), schemaVersion: 1 });
		}
		expect(manager.getSessionRecap()?.sourceEntryId).toBe(turn.sourceId);
		manager.appendCustomEntry(SESSION_RECAP_ENTRY, { ...recapFor(turn), schemaVersion: 1 });
		expect(manager.getSessionRecap()).toBeUndefined();
	});

	describe("persistence", () => {
		let tempRoot: string;

		beforeEach(async () => {
			tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-recap-"));
		});

		afterEach(async () => {
			await fs.rm(tempRoot, { recursive: true, force: true });
		});

		async function createPersisted(): Promise<{ manager: SessionManager; sessionFile: string }> {
			const manager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"));
			manager.appendMessage(userMsg("persisted seed"));
			manager.appendMessage(assistantMsg("persisted seed answer"));
			await manager.rewriteEntries();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			return { manager, sessionFile };
		}

		it("survives a process restart without regenerating anything", async () => {
			const { manager, sessionFile } = await createPersisted();
			const turn = completeTurn(manager);
			const entryId = commit(manager, turn);
			await manager.flush();
			await manager.close();

			const reopened = await SessionManager.open(sessionFile, tempRoot);
			try {
				const entriesAfterOpen = reopened.getEntries().length;
				expect(reopened.getSessionRecap()).toEqual({
					...recapFor(turn),
					schemaVersion: 1,
					entryId,
					source: "model",
				});
				expect(reopened.getEntries()).toHaveLength(entriesAfterOpen);
				expect(recapEntryCount(reopened)).toBe(1);
			} finally {
				await reopened.close();
			}
		});

		it("treats a recap as stale after the resumed session continues the conversation", async () => {
			const { manager, sessionFile } = await createPersisted();
			commit(manager, completeTurn(manager));
			await manager.flush();
			await manager.close();

			const reopened = await SessionManager.open(sessionFile, tempRoot);
			try {
				expect(reopened.getSessionRecap()).toBeDefined();
				reopened.appendMessage(userMsg("다음 요청"));
				expect(reopened.getSessionRecap()).toBeUndefined();
				const next = { requestId: reopened.getLeafId() ?? "", sourceId: "" };
				next.sourceId = reopened.appendMessage(assistantMsg("다음 답변"));
				expect(reopened.getSessionRecap()).toBeUndefined();
				const nextEntryId = commit(reopened, next, { text: "다음 요청을 처리했다" });
				expect(reopened.getSessionRecap()).toMatchObject({ entryId: nextEntryId, text: "다음 요청을 처리했다" });
				await reopened.flush();
			} finally {
				await reopened.close();
			}

			const again = await SessionManager.open(sessionFile, tempRoot);
			try {
				expect(again.getSessionRecap()).toMatchObject({ text: "다음 요청을 처리했다" });
				expect(recapEntryCount(again)).toBe(2);
			} finally {
				await again.close();
			}
		});
	});

	describe("freshness", () => {
		it("stays current across non-conversation entries such as cost, model, label, and compaction", () => {
			const manager = SessionManager.inMemory();
			const turn = completeTurn(manager);
			commit(manager, turn);

			manager.appendCustomEntry("cost-snapshot", { total: 0.01 });
			manager.appendModelChange("anthropic/claude-sonnet-4-5");
			manager.appendThinkingLevelChange("high");
			manager.appendModeChange("plan");
			manager.appendLabelChange(turn.requestId, "bookmark");
			manager.appendCompaction("summary", "short", turn.sourceId, 100);

			expect(manager.getSessionRecap()).toMatchObject({ sourceEntryId: turn.sourceId });
		});

		it("accepts a commit after non-conversation entries were appended behind the source", () => {
			const manager = SessionManager.inMemory();
			const turn = completeTurn(manager);
			manager.appendCustomEntry("cost-snapshot", { total: 0.01 });
			manager.appendModelChange("anthropic/claude-sonnet-4-5");

			const entryId = commit(manager, turn);

			expect(manager.getSessionRecap()?.entryId).toBe(entryId);
		});

		it("goes stale when a new message or custom message follows the source", () => {
			const manager = SessionManager.inMemory();
			const first = completeTurn(manager);
			commit(manager, first);

			manager.appendMessage(userMsg("다음 요청"));
			expect(manager.getSessionRecap()).toBeUndefined();

			const second = { requestId: manager.getLeafId() ?? "", sourceId: manager.appendMessage(assistantMsg("답")) };
			expect(manager.getSessionRecap()).toBeUndefined();
			commit(manager, second, { text: "두 번째 턴을 처리했다" });
			expect(manager.getSessionRecap()).toMatchObject({ text: "두 번째 턴을 처리했다" });

			manager.appendCustomMessageEntry("injected", "context", false);
			expect(manager.getSessionRecap()).toBeUndefined();
		});

		it("never falls back to an older recap when the latest turn has none", () => {
			const manager = SessionManager.inMemory();
			commit(manager, completeTurn(manager));
			completeTurn(manager, "두 번째 요청", "두 번째 답변");

			expect(manager.getSessionRecap()).toBeUndefined();
		});

		it("ignores metadata-only sessions with no conversation", () => {
			const manager = SessionManager.inMemory();
			manager.appendCustomEntry("cost-snapshot", { total: 0 });
			manager.appendModelChange("anthropic/claude-sonnet-4-5");

			expect(manager.getSessionRecap()).toBeUndefined();
		});
	});

	describe("branches", () => {
		it("does not leak a recap onto a branch that does not contain its source", () => {
			const manager = SessionManager.inMemory();
			const first = completeTurn(manager, "첫 요청", "첫 답변");
			const firstRecap = commit(manager, first, { text: "첫 턴을 처리했다" });
			const second = completeTurn(manager, "둘째 요청", "둘째 답변");
			const secondRecap = commit(manager, second, { text: "둘째 턴을 처리했다" });

			manager.branch(first.sourceId);
			expect(manager.getSessionRecap()).toBeUndefined();

			const alternative = completeTurn(manager, "다른 요청", "다른 답변");
			expect(manager.getSessionRecap()).toBeUndefined();
			expect(manager.appendSessionRecap(recapFor(second))).toEqual(rejected("source_not_current"));
			expect(manager.appendSessionRecap(recapFor(first))).toEqual(rejected("source_not_current"));
			commit(manager, alternative, { text: "다른 요청을 처리했다" });
			expect(manager.getSessionRecap()).toMatchObject({ text: "다른 요청을 처리했다" });

			manager.branch(secondRecap);
			expect(manager.getSessionRecap()).toMatchObject({ text: "둘째 턴을 처리했다" });
			manager.branch(firstRecap);
			expect(manager.getSessionRecap()).toMatchObject({ text: "첫 턴을 처리했다" });
		});

		it("rejects a late commit whose source was left behind by a leaf change", () => {
			const manager = SessionManager.inMemory();
			const first = completeTurn(manager, "첫 요청", "첫 답변");
			const second = completeTurn(manager, "둘째 요청", "둘째 답변");

			manager.branch(first.sourceId);

			expect(manager.appendSessionRecap(recapFor(second))).toEqual(rejected("source_not_current"));
			expect(recapEntryCount(manager)).toBe(0);
			expect(manager.getLeafId()).toBe(first.sourceId);
		});

		it("rejects a late commit after the conversation moved on", () => {
			const manager = SessionManager.inMemory();
			const first = completeTurn(manager);
			manager.appendMessage(userMsg("새 턴 시작"));

			expect(manager.appendSessionRecap(recapFor(first))).toEqual(rejected("source_not_current"));
			expect(recapEntryCount(manager)).toBe(0);
		});

		it("ignores a recap entry whose source belongs to another turn", () => {
			const manager = SessionManager.inMemory();
			const first = completeTurn(manager, "첫 요청", "첫 답변");
			completeTurn(manager, "둘째 요청", "둘째 답변");
			manager.appendCustomEntry(SESSION_RECAP_ENTRY, { ...recapFor(first), schemaVersion: 1 });

			expect(manager.getSessionRecap()).toBeUndefined();
		});
	});

	describe("rejections", () => {
		it("rejects duplicate commits for the same source and keeps the original", () => {
			const manager = SessionManager.inMemory();
			const turn = completeTurn(manager);
			const entryId = commit(manager, turn);

			const duplicate = manager.appendSessionRecap(
				recapFor(turn, { text: "다른 문장", model: { provider: "other", id: "other-model" } }),
			);

			expect(duplicate).toEqual(rejected("duplicate"));
			expect(recapEntryCount(manager)).toBe(1);
			expect(manager.getSessionRecap()).toMatchObject({ entryId, text: "로그인 리다이렉트 버그를 고쳤다" });
		});

		it("rejects sources that are not a final assistant response", () => {
			for (const stopReason of ["length", "error", "aborted", "toolUse"] as const) {
				const manager = SessionManager.inMemory();
				const requestId = manager.appendMessage(userMsg("요청"));
				const sourceId = manager.appendMessage({ ...assistantMsg("부분 응답"), stopReason });

				expect(manager.appendSessionRecap(recapFor({ requestId, sourceId }))).toEqual(rejected("invalid_source"));
				expect(recapEntryCount(manager)).toBe(0);
			}
		});

		it("rejects a user message as the source", () => {
			const manager = SessionManager.inMemory();
			const earlier = completeTurn(manager);
			const sourceId = manager.appendMessage(userMsg("답변 없는 요청"));

			expect(manager.appendSessionRecap(recapFor({ requestId: earlier.requestId, sourceId }))).toEqual(
				rejected("invalid_source"),
			);
		});

		it("rejects a request that is not a user-message ancestor of the source", () => {
			const manager = SessionManager.inMemory();
			const first = completeTurn(manager, "첫 요청", "첫 답변");
			const second = completeTurn(manager, "둘째 요청", "둘째 답변");

			// A user message that exists but sits on a branch the source does not descend from.
			manager.branch(first.sourceId);
			const sibling = completeTurn(manager, "다른 가지 요청", "다른 가지 답변");
			manager.branch(second.sourceId);

			for (const requestEntryId of [first.sourceId, "missing-entry", sibling.requestId]) {
				expect(manager.appendSessionRecap(recapFor(second, { requestEntryId }))).toEqual(
					rejected("invalid_request"),
				);
			}
			expect(recapEntryCount(manager)).toBe(0);
			expect(manager.appendSessionRecap(recapFor(second, { requestEntryId: first.requestId })).status).toBe(
				"appended",
			);
		});

		it("classifies a request equal to the source as an invalid payload before looking at ancestry", () => {
			const manager = SessionManager.inMemory();
			const turn = completeTurn(manager);

			expect(manager.appendSessionRecap(recapFor(turn, { requestEntryId: turn.sourceId }))).toEqual(
				rejected("invalid_payload"),
			);
			expect(recapEntryCount(manager)).toBe(0);
		});

		it("rejects an unknown source entry", () => {
			const manager = SessionManager.inMemory();
			const turn = completeTurn(manager);

			expect(manager.appendSessionRecap(recapFor(turn, { sourceEntryId: "missing-entry" }))).toEqual(
				rejected("source_not_current"),
			);
		});

		const invalidPayloads: Array<[string, Partial<SessionRecapInput>]> = [
			["empty text", { text: "" }],
			["whitespace-only text", { text: "   " }],
			["padded text", { text: " 앞뒤 공백 " }],
			["newline in text", { text: "첫 줄\n둘째 줄" }],
			["tab in text", { text: "탭\t포함" }],
			["NUL in text", { text: "널\u0000문자" }],
			["bidi override in text", { text: "방향\u202E바꿈" }],
			["zero-width space in text", { text: "보이지\u200B않는" }],
			["lone surrogate in text", { text: "깨진\ud800문자" }],
			["over the code point limit", { text: "a".repeat(SESSION_RECAP_MAX_CODEPOINTS + 1) }],
			[
				"over the code point limit with four-byte characters",
				{ text: FOUR_BYTE_CHAR.repeat(SESSION_RECAP_MAX_CODEPOINTS + 1) },
			],
			["over the byte limit", { text: "a".repeat(SESSION_RECAP_MAX_BYTES + 1) }],
			["non-string text", { text: 42 as unknown as string }],
			["non-canonical timestamp", { generatedAt: "2026-11-02" }],
			["unparseable timestamp", { generatedAt: "yesterday" }],
			["empty model id", { model: { provider: "test-provider", id: "" } }],
			["model with extra keys", { model: { provider: "p", id: "m", extra: true } as never }],
			["source equal to request", { requestEntryId: "same", sourceEntryId: "same" }],
			["extra top-level key", { extra: "value" } as never],
			["caller-supplied schema version", { schemaVersion: 1 } as never],
			["caller-supplied source marker", { source: "model" } as never],
		];

		for (const [name, overrides] of invalidPayloads) {
			it(`rejects invalid payload: ${name}`, () => {
				const manager = SessionManager.inMemory();
				const turn = completeTurn(manager);
				const entryCount = manager.getEntries().length;

				expect(manager.appendSessionRecap(recapFor(turn, overrides))).toEqual(rejected("invalid_payload"));
				expect(manager.getEntries()).toHaveLength(entryCount);
				expect(manager.getSessionRecap()).toBeUndefined();
			});
		}

		it("accepts 120 code points of any script and never truncates", () => {
			const ascii = "a".repeat(SESSION_RECAP_MAX_CODEPOINTS);
			const hangul = "가".repeat(SESSION_RECAP_MAX_CODEPOINTS);
			const fourByte = FOUR_BYTE_CHAR.repeat(SESSION_RECAP_MAX_CODEPOINTS);
			// The store must accept everything the generator's 120 code point bound accepts.
			expect(Buffer.byteLength(FOUR_BYTE_CHAR)).toBe(4);
			expect(Buffer.byteLength(fourByte)).toBeLessThanOrEqual(SESSION_RECAP_MAX_BYTES);

			for (const text of [ascii, hangul, fourByte]) {
				const manager = SessionManager.inMemory();
				commit(manager, completeTurn(manager), { text });
				expect(manager.getSessionRecap()?.text).toBe(text);
			}
		});
	});

	describe("hostile persisted entries", () => {
		it("ignores malformed recap payloads written by other tools", () => {
			const manager = SessionManager.inMemory();
			const turn = completeTurn(manager);
			const valid = recapFor(turn);
			const malformed: unknown[] = [
				undefined,
				"text",
				{ ...valid },
				{ ...valid, schemaVersion: 2 },
				{ ...valid, text: "a".repeat(SESSION_RECAP_MAX_CODEPOINTS + 1), schemaVersion: 1 },
				{ ...valid, text: "줄\n바꿈", schemaVersion: 1 },
				{ ...valid, extra: true, schemaVersion: 1 },
				{ ...valid, source: "model", schemaVersion: 1 },
				{ ...valid, requestEntryId: "missing-entry", schemaVersion: 1 },
				{ ...valid, requestEntryId: turn.sourceId, schemaVersion: 1 },
			];
			for (const data of malformed) manager.appendCustomEntry(SESSION_RECAP_ENTRY, data);

			expect(manager.getSessionRecap()).toBeUndefined();
		});

		it("keeps a valid recap visible behind later malformed recap entries", () => {
			const manager = SessionManager.inMemory();
			const turn = completeTurn(manager);
			const entryId = commit(manager, turn);
			manager.appendCustomEntry(SESSION_RECAP_ENTRY, { text: "garbage" });

			expect(manager.getSessionRecap()?.entryId).toBe(entryId);
		});

		it("rejects a commit when only a malformed recap exists, then accepts a valid one", () => {
			const manager = SessionManager.inMemory();
			const turn = completeTurn(manager);
			manager.appendCustomEntry(SESSION_RECAP_ENTRY, { text: "garbage" });

			const entryId = commit(manager, turn);

			expect(manager.getSessionRecap()?.entryId).toBe(entryId);
		});
	});
});

describe("session list recap", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-recap-list-"));
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	function sessionsDir(): string {
		return path.join(tempRoot, "sessions");
	}

	async function createPersisted(): Promise<{ manager: SessionManager; sessionFile: string }> {
		const manager = SessionManager.create(tempRoot, sessionsDir());
		manager.appendMessage(userMsg("persisted seed"));
		manager.appendMessage(assistantMsg("persisted seed answer"));
		await manager.rewriteEntries();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		return { manager, sessionFile };
	}

	async function finish(manager: SessionManager): Promise<void> {
		await manager.flush();
		await manager.close();
	}

	async function listed(sessionFile: string): Promise<SessionInfo> {
		const info = (await SessionManager.list(tempRoot, sessionsDir())).find(item => item.path === sessionFile);
		if (!info) throw new Error("Session missing from list");
		return info;
	}

	/** What a freshly opened SessionManager reports for the same transcript. */
	async function openedRecap(sessionFile: string) {
		const reopened = await SessionManager.open(sessionFile, tempRoot);
		try {
			return reopened.getSessionRecap();
		} finally {
			await reopened.close();
		}
	}

	async function longestLineBytes(file: string): Promise<number> {
		const text = await fs.readFile(file, "utf8");
		return text.split("\n").reduce((max, line) => Math.max(max, Buffer.byteLength(line)), 0);
	}

	/**
	 * The native writer caps stored message text well below the reader's parse limit, so a
	 * genuinely oversized line is produced by rewriting one persisted line: `rewrite` receives
	 * the parsed record and returns the record to store. The record's id, parentId, and key
	 * order are preserved by the caller; every other line is left byte-for-byte untouched.
	 */
	async function rewriteTranscriptLine(
		file: string,
		marker: string,
		rewrite: (record: Record<string, unknown>) => Record<string, unknown>,
	): Promise<void> {
		const lines = (await fs.readFile(file, "utf8")).split("\n");
		const matching = lines.flatMap((line, index) => (line.includes(marker) ? [index] : []));
		if (matching.length !== 1) throw new Error(`Expected exactly one transcript line containing ${marker}`);
		const index = matching[0] as number;
		lines[index] = JSON.stringify(rewrite(JSON.parse(lines[index] as string) as Record<string, unknown>));
		await fs.writeFile(file, lines.join("\n"));
	}

	/** Replaces the one line containing `marker` with raw text, for JSON that `JSON.stringify` cannot emit. */
	async function replaceTranscriptLine(
		file: string,
		marker: string,
		build: (record: Record<string, unknown>) => string,
	): Promise<void> {
		const lines = (await fs.readFile(file, "utf8")).split("\n");
		const matching = lines.flatMap((line, index) => (line.includes(marker) ? [index] : []));
		if (matching.length !== 1) throw new Error(`Expected exactly one transcript line containing ${marker}`);
		const index = matching[0] as number;
		lines[index] = build(JSON.parse(lines[index] as string) as Record<string, unknown>);
		await fs.writeFile(file, lines.join("\n"));
	}

	function withMessageContent(record: Record<string, unknown>, content: unknown): Record<string, unknown> {
		return { ...record, message: { ...(record.message as Record<string, unknown>), content } };
	}

	function toolHistory(manager: SessionManager, count: number, resultBytes: number): void {
		for (let index = 0; index < count; index++) {
			const toolCallId = `call-${index}`;
			manager.appendMessage({
				...assistantMsg("using a tool"),
				content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: `f${index}.ts` } }],
				stopReason: "toolUse",
			});
			manager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(resultBytes) }],
				isError: false,
				timestamp: Date.now(),
			});
		}
	}

	it("reads an exact SDK transcript identity without changing bytes or metadata", async () => {
		const { manager, sessionFile } = await createPersisted();
		commit(manager, completeTurn(manager));
		const expected = manager.getSessionRecap();
		await finish(manager);
		const before = await fs.stat(sessionFile, { bigint: true });
		const bytes = await Bun.file(sessionFile).bytes();
		const identity = { ...before, size: Number(before.size) };
		expect(await SessionManager.readSessionRecapReadOnly(sessionFile, identity)).toEqual(expected);
		for (const field of ["dev", "ino", "nlink", "mtimeNs", "ctimeNs"] as const) {
			expect(
				await SessionManager.readSessionRecapReadOnly(sessionFile, {
					...identity,
					[field]: identity[field] + 1n,
				}),
			).toBeUndefined();
		}
		expect(
			await SessionManager.readSessionRecapReadOnly(sessionFile, { ...identity, size: identity.size + 1 }),
		).toBeUndefined();
		expect(await Bun.file(sessionFile).bytes()).toEqual(bytes);
		const after = await fs.stat(sessionFile, { bigint: true });
		expect(after.mtimeNs).toBe(before.mtimeNs);
		expect(after.ctimeNs).toBe(before.ctimeNs);
	});

	it("refuses a symlink or a replacement inode even when transcript bytes are identical", async () => {
		const { manager, sessionFile } = await createPersisted();
		commit(manager, completeTurn(manager));
		await finish(manager);
		const stat = await fs.stat(sessionFile, { bigint: true });
		const identity = { ...stat, size: Number(stat.size) };
		const alias = path.join(tempRoot, "transcript-link.jsonl");
		await fs.symlink(sessionFile, alias);
		expect(await SessionManager.readSessionRecapReadOnly(alias, identity)).toBeUndefined();
		const replacement = path.join(tempRoot, "replacement.jsonl");
		await Bun.write(replacement, await Bun.file(sessionFile).bytes());
		await fs.rename(replacement, sessionFile);
		expect(await SessionManager.readSessionRecapReadOnly(sessionFile, identity)).toBeUndefined();
	});

	it("reads the same recap through list, listAll, the picker listing, and a reopened manager without any model call", async () => {
		const agentDir = path.join(tempRoot, "agent");
		const manager = SessionManager.create(tempRoot, SessionManager.managedDestination(tempRoot, agentDir));
		const turn = completeTurn(manager, "목록에서 보일 요청", "목록에서 보일 답변");
		const entryId = commit(manager, turn, { text: "목록에 표시될 생성문" });
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected managed transcript");
		await finish(manager);
		const before = await fs.readFile(sessionFile);

		const fromPicker = (await SessionManager.listManagedForResumePickerReadOnly(tempRoot, agentDir)).find(
			item => item.path === sessionFile,
		);
		const fromAll = (await SessionManager.listAll(undefined, agentDir)).find(item => item.path === sessionFile);
		expect(Buffer.compare(await fs.readFile(sessionFile), before)).toBe(0);
		const reopened = await SessionManager.open(sessionFile, tempRoot);
		try {
			const expected: SessionRecapRecord = {
				schemaVersion: 1,
				text: "목록에 표시될 생성문",
				sourceEntryId: turn.sourceId,
				requestEntryId: turn.requestId,
				model: { provider: "test-provider", id: "test-model" },
				generatedAt: GENERATED_AT,
				entryId,
				source: "model",
			};
			expect(fromPicker?.recap).toEqual(expected);
			expect(fromAll?.recap).toEqual(expected);
			expect(reopened.getSessionRecap()).toEqual(expected);
			expect(recapEntryCount(reopened)).toBe(1);
		} finally {
			await reopened.close();
		}
	});

	it("lists without touching the transcript bytes, the entry count, or the session directory", async () => {
		const { manager, sessionFile } = await createPersisted();
		commit(manager, completeTurn(manager));
		await finish(manager);
		const bytes = await fs.readFile(sessionFile);
		const mtime = (await fs.stat(sessionFile)).mtimeMs;
		const names = await fs.readdir(sessionsDir());

		for (let index = 0; index < 3; index++) await SessionManager.list(tempRoot, sessionsDir());

		expect(Buffer.compare(await fs.readFile(sessionFile), bytes)).toBe(0);
		expect((await fs.stat(sessionFile)).mtimeMs).toBe(mtime);
		expect(await fs.readdir(sessionsDir())).toEqual(names);
		const reopened = await SessionManager.open(sessionFile, tempRoot);
		try {
			expect(recapEntryCount(reopened)).toBe(1);
		} finally {
			await reopened.close();
		}
	});

	it("omits the recap field for a session without one", async () => {
		const { manager, sessionFile } = await createPersisted();
		await finish(manager);

		const info = await listed(sessionFile);

		expect("recap" in info).toBe(false);
	});

	it("finds a recap whose request and source lie far outside the list prefix and the first tail chunk", async () => {
		const { manager, sessionFile } = await createPersisted();
		const requestId = manager.appendMessage(userMsg("a request followed by a long tool history"));
		toolHistory(manager, 40, 10_000);
		const sourceId = manager.appendMessage(assistantMsg("the final answer"));
		const entryId = commit(manager, { requestId, sourceId }, { text: "긴 도구 기록 뒤의 생성문" });
		await finish(manager);
		expect((await fs.stat(sessionFile)).size).toBeGreaterThan(300_000);

		const info = await listed(sessionFile);

		expect(info.recap).toMatchObject({
			text: "긴 도구 기록 뒤의 생성문",
			sourceEntryId: sourceId,
			requestEntryId: requestId,
			entryId,
			source: "model",
		});
		expect(info.recap).toEqual(await openedRecap(sessionFile));
	});

	it("hides a recap whose request is not on the leaf branch even when the history is long", async () => {
		const { manager, sessionFile } = await createPersisted();
		completeTurn(manager);
		toolHistory(manager, 20, 10_000);
		const sourceId = manager.appendMessage(assistantMsg("the final answer"));
		manager.appendCustomEntry(SESSION_RECAP_ENTRY, {
			schemaVersion: 1,
			text: "요청이 가지 밖인 생성문",
			sourceEntryId: sourceId,
			requestEntryId: "entry-that-does-not-exist",
			model: { provider: "p", id: "m" },
			generatedAt: GENERATED_AT,
		});
		await finish(manager);

		const info = await listed(sessionFile);

		expect(info.recap).toBeUndefined();
		expect(await openedRecap(sessionFile)).toBeUndefined();
	});

	it("reads a recap through a single 4.7 MB transcript line", async () => {
		const { manager, sessionFile } = await createPersisted();
		const requestId = manager.appendMessage(userMsg("request before an enormous tool result"));
		manager.appendMessage({
			...assistantMsg("using a tool"),
			content: [{ type: "toolCall", id: "huge-call", name: "read", arguments: {} }],
			stopReason: "toolUse",
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "huge-call",
			toolName: "read",
			content: [{ type: "text", text: "HUGE_TOOL_RESULT_MARKER" }],
			isError: false,
			timestamp: Date.now(),
		});
		const sourceId = manager.appendMessage(assistantMsg("answer after the enormous result"));
		commit(manager, { requestId, sourceId }, { text: "거대한 줄을 지나친 생성문" });
		await finish(manager);
		await rewriteTranscriptLine(sessionFile, "HUGE_TOOL_RESULT_MARKER", record =>
			withMessageContent(record, [{ type: "text", text: "y".repeat(4_700_000) }]),
		);
		// Guard the premise: the transcript really holds a multi-megabyte line, far past any list prefix.
		expect(await longestLineBytes(sessionFile)).toBeGreaterThan(4 * 1024 * 1024);

		const info = await listed(sessionFile);

		expect(info.recap).toMatchObject({
			text: "거대한 줄을 지나친 생성문",
			sourceEntryId: sourceId,
			requestEntryId: requestId,
		});
		expect(info.recap).toEqual(await openedRecap(sessionFile));
	});

	it("accepts a 4.7 MB user request line as the recap's request", async () => {
		const { manager, sessionFile } = await createPersisted();
		const requestId = manager.appendMessage(userMsg("HUGE_REQUEST_MARKER"));
		const sourceId = manager.appendMessage(assistantMsg("short answer to a huge paste"));
		commit(manager, { requestId, sourceId }, { text: "거대한 붙여넣기에 대한 생성문" });
		await finish(manager);
		await rewriteTranscriptLine(sessionFile, "HUGE_REQUEST_MARKER", record =>
			withMessageContent(record, "z".repeat(4_700_000)),
		);
		expect(await longestLineBytes(sessionFile)).toBeGreaterThan(4 * 1024 * 1024);

		const info = await listed(sessionFile);

		expect(info.recap).toMatchObject({ requestEntryId: requestId, sourceEntryId: sourceId });
		expect(info.recap).toEqual(await openedRecap(sessionFile));
	});

	it("does not let text inside a huge line forge its identity, parent, or role", async () => {
		const { manager, sessionFile } = await createPersisted();
		const requestId = manager.appendMessage(userMsg("FORGERY_REQUEST_MARKER"));
		const sourceId = manager.appendMessage(assistantMsg("answer"));
		commit(manager, { requestId, sourceId }, { text: "위조를 견딘 생성문" });
		await finish(manager);
		const forged =
			'{"type":"message","id":"forged-id","parentId":null,"timestamp":"t","message":{"role":"assistant","stopReason":"stop"}}';
		await rewriteTranscriptLine(sessionFile, "FORGERY_REQUEST_MARKER", record =>
			withMessageContent(record, `${forged}${"q".repeat(4_700_000)}`),
		);
		expect(await longestLineBytes(sessionFile)).toBeGreaterThan(4 * 1024 * 1024);

		const info = await listed(sessionFile);

		expect(info.recap).toMatchObject({ requestEntryId: requestId, sourceEntryId: sourceId });
		expect(info.recap).toEqual(await openedRecap(sessionFile));
	});

	it("reads a huge line whose keys are in a different order exactly as the canonical loader does", async () => {
		const { manager, sessionFile } = await createPersisted();
		const requestId = manager.appendMessage(userMsg("REORDERED_REQUEST_MARKER"));
		const sourceId = manager.appendMessage(assistantMsg("answer"));
		commit(manager, { requestId, sourceId }, { text: "순서가 다른 줄의 생성문" });
		await finish(manager);
		await rewriteTranscriptLine(sessionFile, "REORDERED_REQUEST_MARKER", record => {
			const { id, type, ...rest } = withMessageContent(record, "w".repeat(4_700_000));
			return { id, type, ...rest };
		});
		expect(await longestLineBytes(sessionFile)).toBeGreaterThan(4 * 1024 * 1024);

		const info = await listed(sessionFile);

		expect(info.recap).toMatchObject({ requestEntryId: requestId, sourceEntryId: sourceId });
		expect(info.recap).toEqual(await openedRecap(sessionFile));
	});

	it("gives a duplicate key past the first 4 KiB the last-value meaning of JSON.parse, as the canonical loader does", async () => {
		const { manager, sessionFile } = await createPersisted();
		const requestId = manager.appendMessage(userMsg("DUPLICATE_ROLE_MARKER"));
		const sourceId = manager.appendMessage(assistantMsg("answer"));
		commit(manager, { requestId, sourceId }, { text: "중복 키 뒤의 생성문" });
		await finish(manager);
		const padding = "p".repeat(4_700_000);
		// The first role says assistant; the last says user. Only the last may count.
		await replaceTranscriptLine(sessionFile, "DUPLICATE_ROLE_MARKER", record => {
			const body = `{"role":"assistant","content":${JSON.stringify(padding)},"role":"user","timestamp":1}`;
			return `{"type":"message","id":${JSON.stringify(record.id)},"parentId":${JSON.stringify(record.parentId)},"timestamp":${JSON.stringify(record.timestamp)},"message":${body}}`;
		});
		expect(await longestLineBytes(sessionFile)).toBeGreaterThan(4 * 1024 * 1024);

		const info = await listed(sessionFile);

		expect(info.recap).toMatchObject({ requestEntryId: requestId, sourceEntryId: sourceId });
		expect(info.recap).toEqual(await openedRecap(sessionFile));
	});

	it("hides the recap when a trailing duplicate key turns the request into something else", async () => {
		const { manager, sessionFile } = await createPersisted();
		const requestId = manager.appendMessage(userMsg("DUPLICATE_TAIL_MARKER"));
		const sourceId = manager.appendMessage(assistantMsg("answer"));
		commit(manager, { requestId, sourceId }, { text: "꼬리 중복 키 뒤의 생성문" });
		await finish(manager);
		const padding = "p".repeat(4_700_000);
		// First role is user; the trailing duplicates make the entry an assistant message with another id.
		await replaceTranscriptLine(sessionFile, "DUPLICATE_TAIL_MARKER", record => {
			const body = `{"role":"user","content":${JSON.stringify(padding)},"role":"assistant","timestamp":1}`;
			return `{"type":"message","id":${JSON.stringify(record.id)},"parentId":${JSON.stringify(record.parentId)},"timestamp":${JSON.stringify(record.timestamp)},"message":${body}}`;
		});
		expect(await longestLineBytes(sessionFile)).toBeGreaterThan(4 * 1024 * 1024);

		const info = await listed(sessionFile);

		expect(info.recap).toBeUndefined();
		expect(await openedRecap(sessionFile)).toBeUndefined();
	});

	it("rejects a trailing duplicate id that renames the request, as the canonical loader does", async () => {
		const { manager, sessionFile } = await createPersisted();
		const requestId = manager.appendMessage(userMsg("DUPLICATE_ID_MARKER"));
		const sourceId = manager.appendMessage(assistantMsg("answer"));
		commit(manager, { requestId, sourceId }, { text: "아이디 중복 뒤의 생성문" });
		await finish(manager);
		await replaceTranscriptLine(sessionFile, "DUPLICATE_ID_MARKER", record => {
			const body = `{"role":"user","content":${JSON.stringify("p".repeat(4_700_000))},"timestamp":1}`;
			return `{"type":"message","id":${JSON.stringify(record.id)},"parentId":${JSON.stringify(record.parentId)},"timestamp":${JSON.stringify(record.timestamp)},"message":${body},"id":"renamed-by-trailing-duplicate"}`;
		});

		const info = await listed(sessionFile);

		expect(info.recap).toBeUndefined();
		expect(await openedRecap(sessionFile)).toBeUndefined();
	});

	it("never falls back to a head-only reading when a huge line is truncated JSON", async () => {
		const { manager, sessionFile } = await createPersisted();
		const requestId = manager.appendMessage(userMsg("TRUNCATED_JSON_MARKER"));
		const sourceId = manager.appendMessage(assistantMsg("answer"));
		commit(manager, { requestId, sourceId }, { text: "잘린 거대 줄 앞의 생성문" });
		await finish(manager);
		await replaceTranscriptLine(sessionFile, "TRUNCATED_JSON_MARKER", record => {
			const full = JSON.stringify(withMessageContent(record, "t".repeat(4_700_000)));
			return full.slice(0, -5);
		});
		const bytes = await fs.readFile(sessionFile);

		const info = await listed(sessionFile);

		expect(info.recap).toBeUndefined();
		expect(info.firstMessage).toBe("persisted seed");
		await expect(SessionManager.open(sessionFile, tempRoot)).rejects.toThrow("malformed");
		expect((await fs.readFile(sessionFile)).equals(bytes)).toBe(true);
	});

	it("shows no recap and writes nothing when the walk meets a line above the 8 MiB line limit", async () => {
		const { manager, sessionFile } = await createPersisted();
		const requestId = manager.appendMessage(userMsg("BEYOND_LIMIT_MARKER"));
		const sourceId = manager.appendMessage(assistantMsg("answer"));
		commit(manager, { requestId, sourceId }, { text: "한도를 넘는 줄 앞의 생성문" });
		await finish(manager);
		await rewriteTranscriptLine(sessionFile, "BEYOND_LIMIT_MARKER", record =>
			withMessageContent(record, "b".repeat(BOUNDED_FIRST_OPEN_MAX_LINE_BYTES + 1024)),
		);
		expect(await longestLineBytes(sessionFile)).toBeGreaterThan(BOUNDED_FIRST_OPEN_MAX_LINE_BYTES);
		const bytes = await fs.readFile(sessionFile);
		const names = await fs.readdir(sessionsDir());

		const info = await listed(sessionFile);

		expect(info.recap).toBeUndefined();
		expect(info.firstMessage).toBe("persisted seed");
		expect((await fs.readFile(sessionFile)).equals(bytes)).toBe(true);
		expect(await fs.readdir(sessionsDir())).toEqual(names);
	});

	it("does not read a line above the 8 MiB limit that lies before the summarized turn's request", async () => {
		const { manager, sessionFile } = await createPersisted();
		manager.appendMessage(userMsg("OLD_HUGE_MARKER"));
		manager.appendMessage(assistantMsg("old answer"));
		const turn = completeTurn(manager, "later request", "later answer");
		commit(manager, turn, { text: "오래된 거대 줄 뒤의 생성문" });
		await finish(manager);
		await rewriteTranscriptLine(sessionFile, "OLD_HUGE_MARKER", record =>
			withMessageContent(record, "o".repeat(BOUNDED_FIRST_OPEN_MAX_LINE_BYTES + 1024)),
		);

		const info = await listed(sessionFile);

		expect(info.recap).toMatchObject({ requestEntryId: turn.requestId, sourceEntryId: turn.sourceId });
	});

	it("does not skip a malformed line between the leaf and the request just because it names no wanted id", async () => {
		const { manager, sessionFile } = await createPersisted();
		commit(manager, completeTurn(manager));
		await finish(manager);
		const lines = (await fs.readFile(sessionFile, "utf8")).split("\n");
		const recapIndex = lines.findIndex(line => line.includes(SESSION_RECAP_ENTRY));
		expect(recapIndex).toBeGreaterThan(0);
		lines.splice(recapIndex, 0, '{"type":"message","id":"unrelated","parentId":');
		await fs.writeFile(sessionFile, lines.join("\n"));

		const info = await listed(sessionFile);

		await expect(SessionManager.open(sessionFile, tempRoot)).rejects.toThrow("malformed");
		expect(info.recap).toBeUndefined();
		expect(info.firstMessage).toBe("persisted seed");
	});

	it("never shows a recap that belongs to another branch of the transcript", async () => {
		const { manager, sessionFile } = await createPersisted();
		const first = completeTurn(manager, "첫 요청", "첫 답변");
		commit(manager, first, { text: "첫 턴 생성문" });
		const second = completeTurn(manager, "둘째 요청", "둘째 답변");
		commit(manager, second, { text: "둘째 턴 생성문" });

		manager.branch(first.sourceId);
		const third = completeTurn(manager, "셋째 요청", "셋째 답변");
		await manager.flush();

		expect((await listed(sessionFile)).recap).toBeUndefined();
		expect(manager.getSessionRecap()).toBeUndefined();

		commit(manager, third, { text: "셋째 턴 생성문" });
		await finish(manager);

		const info = await listed(sessionFile);
		expect(info.recap).toMatchObject({ text: "셋째 턴 생성문", sourceEntryId: third.sourceId });
		expect(info.recap).toEqual(await openedRecap(sessionFile));
	});

	it("hides the recap once the conversation moves on, including after a resume", async () => {
		const { manager, sessionFile } = await createPersisted();
		commit(manager, completeTurn(manager));
		await finish(manager);
		expect((await listed(sessionFile)).recap).toBeDefined();

		const resumed = await SessionManager.open(sessionFile, tempRoot);
		resumed.appendMessage(userMsg("재개 후 새 요청"));
		await finish(resumed);

		expect((await listed(sessionFile)).recap).toBeUndefined();
		expect(await openedRecap(sessionFile)).toBeUndefined();
	});

	it("keeps the recap current across cost, model, label, and compaction metadata appended after it", async () => {
		const { manager, sessionFile } = await createPersisted();
		const turn = completeTurn(manager);
		commit(manager, turn);
		manager.appendCustomEntry("cost-snapshot", { total: 0.02 });
		manager.appendModelChange("anthropic/claude-sonnet-4-5");
		manager.appendThinkingLevelChange("high");
		manager.appendLabelChange(turn.requestId, "bookmark");
		manager.appendCompaction("summary", "short", turn.sourceId, 100);
		await finish(manager);

		const info = await listed(sessionFile);

		expect(info.recap).toMatchObject({ sourceEntryId: turn.sourceId, source: "model" });
		expect(info.recap).toEqual(await openedRecap(sessionFile));
	});

	it("ignores a corrupt recap record appended after a valid recap without hiding the valid one", async () => {
		const { manager, sessionFile } = await createPersisted();
		const turn = completeTurn(manager);
		const entryId = commit(manager, turn);
		manager.appendCustomEntry(SESSION_RECAP_ENTRY, { text: "garbage" });
		await finish(manager);

		const info = await listed(sessionFile);

		expect(info.recap?.entryId).toBe(entryId);
		expect(info.recap).toEqual(await openedRecap(sessionFile));
	});

	const damagedTails: Array<[string, Buffer]> = [
		["a torn final line", Buffer.from('{"type":"custom","id":"torn-entry","parentId":"x","timestamp":"')],
		["a complete final line that is not JSON", Buffer.from("this is not json\n")],
		["a final line missing required entry fields", Buffer.from('{"type":"custom","id":"no-parent"}\n')],
		[
			"a final line of an unknown entry type",
			Buffer.from('{"type":"mystery","id":"m","parentId":null,"timestamp":"t"}\n'),
		],
		["a final line that is not valid UTF-8", Buffer.from([0xff, 0xfe, 0x0a])],
	];

	for (const [name, tail] of damagedTails) {
		it(`shows no recap, keeps the session listed, and refuses to open when the transcript ends in ${name}`, async () => {
			const { manager, sessionFile } = await createPersisted();
			commit(manager, completeTurn(manager));
			await finish(manager);
			expect((await listed(sessionFile)).recap).toBeDefined();
			const bytes = Buffer.concat([await fs.readFile(sessionFile), tail]);
			await fs.writeFile(sessionFile, bytes);

			const info = await listed(sessionFile);

			// The canonical loader refuses the transcript, so a recap must not be presented as current.
			await expect(SessionManager.open(sessionFile, tempRoot)).rejects.toThrow("malformed");
			expect(info.recap).toBeUndefined();
			expect(info.firstMessage).toBe("persisted seed");
			expect((await fs.readFile(sessionFile)).equals(bytes)).toBe(true);
		});
	}

	it("judges a valid final line by its content when its newline is missing, as the loader does", async () => {
		const { manager, sessionFile } = await createPersisted();
		commit(manager, completeTurn(manager));
		await finish(manager);
		const text = await fs.readFile(sessionFile, "utf8");
		expect(text.endsWith("\n")).toBe(true);
		await fs.writeFile(sessionFile, text.slice(0, -1));

		const info = await listed(sessionFile);

		expect(info.recap).toBeDefined();
		expect(info.recap).toEqual(await openedRecap(sessionFile));
	});

	it("shows no recap when the only recap record is corrupt", async () => {
		const { manager, sessionFile } = await createPersisted();
		completeTurn(manager);
		manager.appendCustomEntry(SESSION_RECAP_ENTRY, { text: "garbage", schemaVersion: 1 });
		await finish(manager);

		expect((await listed(sessionFile)).recap).toBeUndefined();
		expect(await openedRecap(sessionFile)).toBeUndefined();
	});

	it("does not list a recap for a turn that did not end on a final answer", async () => {
		const { manager, sessionFile } = await createPersisted();
		const requestId = manager.appendMessage(userMsg("request"));
		const sourceId = manager.appendMessage({ ...assistantMsg("cut off"), stopReason: "length" });
		manager.appendCustomEntry(SESSION_RECAP_ENTRY, {
			schemaVersion: 1,
			text: "잘린 답변에 붙은 생성문",
			sourceEntryId: sourceId,
			requestEntryId: requestId,
			model: { provider: "p", id: "m" },
			generatedAt: GENERATED_AT,
		});
		await finish(manager);

		expect((await listed(sessionFile)).recap).toBeUndefined();
	});

	/** Every reader must agree and the transcript bytes and mtime must not move. */
	async function expectNoRecapEverywhere(sessionFile: string, openable = true, listable = true): Promise<void> {
		const bytes = await fs.readFile(sessionFile);
		const stat = await fs.stat(sessionFile, { bigint: true });
		const identity = { ...stat, size: Number(stat.size) };

		if (listable) expect((await listed(sessionFile)).recap).toBeUndefined();
		else
			expect(
				(await SessionManager.list(tempRoot, sessionsDir())).find(item => item.path === sessionFile),
			).toBeUndefined();
		expect(await SessionManager.readSessionRecapReadOnly(sessionFile, identity)).toBeUndefined();
		if (openable) expect(await openedRecap(sessionFile)).toBeUndefined();

		expect((await fs.readFile(sessionFile)).equals(bytes)).toBe(true);
		expect((await fs.stat(sessionFile, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
	}

	async function transcriptLines(file: string): Promise<string[]> {
		return (await fs.readFile(file, "utf8")).split("\n").filter(line => line.length > 0);
	}

	async function writeTranscriptLines(file: string, lines: string[]): Promise<void> {
		await fs.writeFile(file, `${lines.join("\n")}\n`);
	}

	it.skipIf(process.platform === "win32")("does not wait on a FIFO and reports no recap for it", async () => {
		const fifo = path.join(tempRoot, "transcript.fifo");
		const made = Bun.spawn(["mkfifo", fifo], { stdout: "ignore", stderr: "inherit" });
		expect(await made.exited).toBe(0);
		const identity = { dev: 0n, ino: 0n, nlink: 1n, size: 1, mtimeNs: 0n, ctimeNs: 0n };
		let timer: NodeJS.Timeout | undefined;
		try {
			const deadline = Promise.withResolvers<"timeout">();
			timer = setTimeout(() => deadline.resolve("timeout"), 2_000);
			const outcome = await Promise.race([
				SessionManager.readSessionRecapReadOnly(fifo, identity).then(recap => ({ recap })),
				deadline.promise,
			]);
			expect(outcome).toEqual({ recap: undefined });
		} finally {
			if (timer) clearTimeout(timer);
			// Releases a reader still blocked in open(2) so a failing run cannot leave the process hanging.
			const release = await fs.open(fifo, "r+").catch(() => undefined);
			await release?.close();
		}
	});

	it("shows no recap for a transcript whose header is not the current version", async () => {
		for (const header of [
			(record: Record<string, unknown>) => ({ ...record, version: 4 }),
			(record: Record<string, unknown>) => ({ ...record, version: 1 }),
			(record: Record<string, unknown>) => {
				const { version: _version, ...rest } = record;
				return rest;
			},
			(record: Record<string, unknown>) => ({ ...record, type: "not-a-session" }),
		]) {
			const { manager, sessionFile } = await createPersisted();
			commit(manager, completeTurn(manager));
			await finish(manager);
			expect((await listed(sessionFile)).recap).toBeDefined();
			const lines = await transcriptLines(sessionFile);
			const changedHeader: Record<string, unknown> = header(
				JSON.parse(lines[0] as string) as Record<string, unknown>,
			);
			lines[0] = JSON.stringify(changedHeader);
			await writeTranscriptLines(sessionFile, lines);

			await expectNoRecapEverywhere(sessionFile, false, changedHeader.type === "session");
		}
	});

	it("applies the latest entry_patch role and stopReason of the source like the canonical loader", async () => {
		const { manager, sessionFile } = await createPersisted();
		const turn = completeTurn(manager);
		commit(manager, turn);
		await finish(manager);
		const lines = await transcriptLines(sessionFile);
		const source = JSON.parse(
			lines.find(line => line.includes(turn.sourceId) && line.includes('"message"')) as string,
		) as {
			message: Record<string, unknown>;
		};
		const patch = (message: Record<string, unknown>) =>
			JSON.stringify({ type: "entry_patch", entryId: turn.sourceId, patch: { message } });

		// A patch that makes the source a truncated answer hides the recap everywhere.
		await writeTranscriptLines(sessionFile, [...lines, patch({ ...source.message, stopReason: "length" })]);
		await expectNoRecapEverywhere(sessionFile);

		// A newer patch restoring the final answer shows it again, identically everywhere.
		await writeTranscriptLines(sessionFile, [
			...lines,
			patch({ ...source.message, stopReason: "length" }),
			patch({ ...source.message, stopReason: "stop" }),
		]);
		expect((await listed(sessionFile)).recap).toMatchObject({ sourceEntryId: turn.sourceId });
		expect((await listed(sessionFile)).recap).toEqual(await openedRecap(sessionFile));

		// A patch that turns the source into a user message hides it too.
		await writeTranscriptLines(sessionFile, [...lines, patch({ ...source.message, role: "user" })]);
		await expectNoRecapEverywhere(sessionFile);
	});

	it("fails closed on an entry_patch that the canonical loader would not accept", async () => {
		const { manager, sessionFile } = await createPersisted();
		const turn = completeTurn(manager);
		commit(manager, turn);
		await finish(manager);
		const lines = await transcriptLines(sessionFile);
		for (const bad of [
			{ type: "entry_patch", entryId: turn.sourceId, patch: { message: "not-a-record" } },
			{ type: "entry_patch", entryId: turn.sourceId, patch: { other: 1 } },
			{ type: "entry_patch", entryId: 7, patch: {} },
		]) {
			await writeTranscriptLines(sessionFile, [...lines, JSON.stringify(bad)]);
			await expectNoRecapEverywhere(sessionFile, false);
		}
	});

	it("fails closed when a later record reuses the source id with another role, though the recap names it", async () => {
		const { manager, sessionFile } = await createPersisted();
		const turn = completeTurn(manager);
		commit(manager, turn);
		manager.appendCustomEntry("cost-snapshot", { total: 0.01 });
		await finish(manager);
		const lines = await transcriptLines(sessionFile);
		const costIndex = lines.findIndex(line => line.includes("cost-snapshot"));
		const sourceLine = JSON.parse(
			lines.find(line => line.includes(turn.sourceId) && line.includes('"message"')) as string,
		) as {
			message: Record<string, unknown>;
		};
		// u1 user / a1 assistant stop / r1 recap(a1,u1) / a1 as a user message (parent u1) / c1 cost(parent r1)
		const duplicate = JSON.stringify({
			...sourceLine,
			parentId: turn.requestId,
			message: { role: "user", content: "duplicate id as a user message", timestamp: 1 },
		});
		lines.splice(costIndex, 0, duplicate);
		await writeTranscriptLines(sessionFile, lines);

		await expectNoRecapEverywhere(sessionFile);
	});

	it("fails closed on a forward parent reference inside the walked range", async () => {
		const { manager, sessionFile } = await createPersisted();
		const turn = completeTurn(manager);
		commit(manager, turn);
		await finish(manager);
		const lines = await transcriptLines(sessionFile);
		// The recap's parent line now comes after the recap itself.
		const parentIndex = lines.findIndex(line => line.includes(`"id":"${turn.sourceId}"`));
		const [parentLine] = lines.splice(parentIndex, 1);
		const recapIndex = lines.findIndex(line => line.includes(SESSION_RECAP_ENTRY));
		lines.splice(recapIndex + 1, 0, parentLine as string);
		await writeTranscriptLines(sessionFile, lines);

		await expectNoRecapEverywhere(sessionFile, false);
	});

	it("fails closed past the scanned line cap while a small session is unaffected", async () => {
		const { manager, sessionFile } = await createPersisted();
		const turn = completeTurn(manager);
		const recapId = commit(manager, turn);
		await finish(manager);
		expect((await listed(sessionFile)).recap?.entryId).toBe(recapId);
		const lines = await transcriptLines(sessionFile);
		// The scan cap bounds the records one lookup walks (100000), not the transcript size.
		const extra: string[] = [];
		let parentId = recapId;
		for (let index = 0; index < 100_001; index++) {
			const id = `cost-${index}`;
			extra.push(
				JSON.stringify({
					type: "custom",
					id,
					parentId,
					timestamp: GENERATED_AT,
					customType: "cost-snapshot",
					data: { total: 0 },
				}),
			);
			parentId = id;
		}
		await writeTranscriptLines(sessionFile, [...lines, ...extra]);

		await expectNoRecapEverywhere(sessionFile, false);
	});
});
