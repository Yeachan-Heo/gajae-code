import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	loadEntriesFromFile,
	SessionManager,
	type SessionHeader,
} from "../../../session/session-manager";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import {
	threadDeleteHandler,
	threadForkHandler,
	threadMetadataCustomType,
	threadMetadataUpdateHandler,
	threadMutationHandlers,
	threadNameSetHandler,
} from "../../suites/thread-mutation-handlers";
import type { HandlerContext } from "../../suites/handlers";

const root = mkdtempSync(join(tmpdir(), "gjc-thread-mutation-suite-"));
const sessionDir = join(root, "sessions");
const cwd = join(root, "workspace");
mkdirSync(sessionDir, { recursive: true });
mkdirSync(cwd, { recursive: true });

function context(): HandlerContext & { sessionDir: string; cwd: string } {
	return { connectionId: "thread-mutation-test", sessionDir, cwd } as HandlerContext & {
		sessionDir: string;
		cwd: string;
	};
}

async function fixture(): Promise<{ id: string; file: string }> {
	const manager = SessionManager.create(cwd, SessionManager.explicitDestination(sessionDir));
	const file = manager.getSessionFile();
	if (!file) throw new Error("fixture session file was not allocated");
	await manager.ensureOnDisk();
	manager.appendCustomEntry("fixture.entries", { ordinal: 1, value: "first" });
	manager.appendCustomEntry("fixture.entries", { ordinal: 2, value: "second" });
	const id = manager.getSessionId();
	await manager.close();
	expect(existsSync(file)).toBe(true);
	return { id, file };
}

function resultOf(value: { ok: true; result: unknown } | { ok: false; errorKey: string }): unknown {
	if (!value.ok) throw new Error(`handler failed: ${value.errorKey}`);
	return value.result;
}

function header(entries: Awaited<ReturnType<typeof loadEntriesFromFile>>): SessionHeader {
	const value = entries.find(entry => entry.type === "session");
	if (!value || value.type !== "session") throw new Error("missing session header");
	return value;
}

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

test("thread/delete removes the real persisted transcript and artifacts", async () => {
	const source = await fixture();
	const params = { threadId: source.id };
	expect(stableValidators.clientRequestParams["thread/delete"]?.(params)).toBe(true);
	const result = await threadDeleteHandler(params, context());
	expect(result).toEqual({ ok: true, result: {} });
	expect(stableValidators.clientRequestResults["thread/delete"]?.(resultOf(result))).toBe(true);
	expect(existsSync(source.file)).toBe(false);
});

test("thread/fork uses SessionManager.forkFrom and preserves source entries in a new transcript", async () => {
	const source = await fixture();
	const params = { threadId: source.id };
	expect(stableValidators.clientRequestParams["thread/fork"]?.(params)).toBe(true);
	const result = await threadForkHandler(params, context());
	expect(result.ok).toBe(true);
	const payload = resultOf(result) as { thread: Record<string, unknown>; model: string; modelProvider: string };
	expect(stableValidators.clientRequestResults["thread/fork"]?.(payload)).toBe(true);
	const forkId = payload.thread.id;
	const forkPath = payload.thread.path;
	expect(typeof forkId).toBe("string");
	expect(forkId).not.toBe(source.id);
	expect(typeof forkPath).toBe("string");
	const sourceEntries = await loadEntriesFromFile(source.file);
	const forkEntries = await loadEntriesFromFile(forkPath as string);
	expect(forkEntries.slice(1)).toEqual(sourceEntries.slice(1));
	expect(header(forkEntries).parentSession).toBe(source.id);
	expect(existsSync(forkPath as string)).toBe(true);
});

test("thread/name/set persists a real SessionManager header patch visible after re-read", async () => {
	const source = await fixture();
	const params = { threadId: source.id, name: "Renamed from app-server" };
	expect(stableValidators.clientRequestParams["thread/name/set"]?.(params)).toBe(true);
	const result = await threadNameSetHandler(params, context());
	expect(result).toEqual({ ok: true, result: {} });
	expect(stableValidators.clientRequestResults["thread/name/set"]?.(resultOf(result))).toBe(true);
	const reread = await loadEntriesFromFile(source.file);
	expect(header(reread).title).toBe(params.name);
	expect(header(reread).titleSource).toBe("user");
});

test("thread/metadata/update persists pinned and Git metadata through the native custom-entry seam", async () => {
	const source = await fixture();
	const params = {
		threadId: source.id,
		isPinned: true,
		gitInfo: { sha: "abc123", branch: "feature/thread", originUrl: "https://example.invalid/repo.git" },
	};
	expect(stableValidators.clientRequestParams["thread/metadata/update"]?.(params)).toBe(true);
	const result = await threadMetadataUpdateHandler(params, context());
	expect(result.ok).toBe(true);
	const payload = resultOf(result) as { thread: Record<string, unknown> };
	expect(stableValidators.clientRequestResults["thread/metadata/update"]?.(payload)).toBe(true);
	expect(payload.thread.isPinned).toBe(true);
	expect(payload.thread.gitInfo).toEqual(params.gitInfo);

	const reread = await loadEntriesFromFile(source.file);
	const metadata = reread
		.filter(entry => entry.type === "custom" && entry.customType === threadMetadataCustomType)
		.map(entry => entry.type === "custom" ? entry.data : undefined)
		.at(-1) as Record<string, unknown> | undefined;
	expect(metadata).toEqual({ isPinned: true, gitInfo: params.gitInfo });

	const clearResult = await threadMetadataUpdateHandler({ threadId: source.id, isPinned: null, gitInfo: null }, context());
	expect(clearResult.ok).toBe(true);
	const clearedPayload = resultOf(clearResult) as { thread: Record<string, unknown> };
	expect(clearedPayload.thread.isPinned).toBe(false);
	expect(clearedPayload.thread.gitInfo).toBeNull();
});

test("mutation handlers return notFound for unknown thread ids without touching the temp store", async () => {
	const before = [...(await SessionManager.list(cwd, sessionDir))].map(session => session.path).sort();
	for (const handler of [threadDeleteHandler, threadForkHandler, threadNameSetHandler, threadMetadataUpdateHandler]) {
		const params = handler === threadNameSetHandler
			? { threadId: "missing-thread", name: "name" }
			: handler === threadMetadataUpdateHandler
				? { threadId: "missing-thread", isPinned: true }
				: { threadId: "missing-thread" };
		expect(await handler(params, context())).toEqual({ ok: false, errorKey: "notFound" });
	}
	const after = [...(await SessionManager.list(cwd, sessionDir))].map(session => session.path).sort();
	expect(after).toEqual(before);
});

test("malformed mutation params return invalidParams before any session lookup", async () => {
	expect(await threadDeleteHandler({}, context())).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await threadForkHandler({ threadId: 42 }, context())).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await threadNameSetHandler({ threadId: "x", name: 42 }, context())).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await threadMetadataUpdateHandler({ threadId: "x", isPinned: "yes" }, context())).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
});

test("threadMutationHandlers exposes only the genuinely backed methods", () => {
	expect(Object.keys(threadMutationHandlers)).toEqual([
		"thread/delete",
		"thread/fork",
		"thread/name/set",
		"thread/metadata/update",
	]);
	for (const method of Object.keys(threadMutationHandlers)) expect(typeof threadMutationHandlers[method]).toBe("function");
});
