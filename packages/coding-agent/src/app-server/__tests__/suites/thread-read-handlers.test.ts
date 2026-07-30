import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendAppServerProjection } from "../../../session/app-server-projection";
import { SessionManager } from "../../../session/session-manager";
import { experimentalValidators, stableValidators } from "../../protocol-source/schema-validators.generated";
import {
	threadItemsListHandler,
	threadListHandler,
	threadReadHandler,
	threadReadHandlers,
	threadSearchHandler,
	threadSearchOccurrencesHandler,
	threadTurnsListHandler,
} from "../../suites/thread-read-handlers";
import {
	makeTurnCreatedRecord,
	makeTurnItemCompletedRecord,
	makeTurnTerminalRecord,
} from "../../thread-runtime/turn-projection";

type HandlerSuccess = { ok: true; result: unknown };
type HandlerFailure = { ok: false; errorKey: string };

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "gjc-thread-read-suite-"));
const agentDir = path.join(tempRoot, "agent");
const workspace = path.join(tempRoot, "workspace");
const previousAgentDir = process.env.GJC_AGENT_DIR;
const previousCwd = process.cwd();
let alphaId = "";

function unwrap(value: HandlerSuccess | HandlerFailure): unknown {
	if (!value.ok) throw new Error(`handler failed: ${value.errorKey}`);
	return value.result;
}

function assistant(text: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

async function appendProjectedTurn(manager: SessionManager, turnId: string, marker: string): Promise<void> {
	const userItem = {
		type: "userMessage" as const,
		id: `${turnId}-user-item`,
		clientId: null,
		content: [{ type: "text" as const, text: `${marker} user` }],
	};
	const assistantItem = {
		type: "agentMessage" as const,
		id: `${turnId}-assistant-item`,
		text: `${marker} projected answer`,
		phase: "final_answer" as const,
		memoryCitation: null,
	};
	const createdTurn = {
		id: turnId,
		items: [],
		itemsView: "full" as const,
		status: "inProgress" as const,
		error: null,
		startedAt: 1,
		completedAt: null,
		durationMs: null,
	};
	const terminalTurn = {
		...createdTurn,
		items: [userItem, assistantItem],
		status: "completed" as const,
		completedAt: 2,
		durationMs: 1,
	};
	const mapping = { commandId: `${turnId}-command`, turnId: `${turnId}-child` };
	await appendAppServerProjection(
		manager,
		makeTurnCreatedRecord({
			turn: createdTurn,
			...mapping,
			clientRef: `${turnId}-client`,
		}),
	);
	await appendAppServerProjection(
		manager,
		makeTurnItemCompletedRecord({ turnId, item: userItem, order: 0 }, mapping, turnId),
	);
	await appendAppServerProjection(
		manager,
		makeTurnItemCompletedRecord({ turnId, item: assistantItem, order: 1 }, mapping, turnId),
	);
	await appendAppServerProjection(manager, makeTurnTerminalRecord({ turn: terminalTurn }, mapping));
}

beforeAll(async () => {
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	process.env.GJC_AGENT_DIR = agentDir;
	process.chdir(workspace);

	const alpha = SessionManager.create(workspace, SessionManager.managedDestination(workspace, agentDir));
	alpha.appendMessage({ role: "user", content: "alpha real persisted prompt", timestamp: 1 });
	alpha.appendMessage(assistant("alpha real persisted answer", 2));
	alpha.appendModelChange("openai/gpt-4");
	await alpha.setSessionName("Alpha session");
	await alpha.ensureOnDisk();
	await appendProjectedTurn(alpha, "alpha-turn", "alpha search marker");
	await alpha.flush();
	alphaId = alpha.getSessionId();
	await alpha.close();

	const beta = SessionManager.create(workspace, SessionManager.managedDestination(workspace, agentDir));
	beta.appendMessage({ role: "user", content: "beta real persisted prompt", timestamp: 3 });
	beta.appendMessage(assistant("beta real persisted answer", 4));
	beta.appendModelChange("openai/gpt-4");
	await beta.setSessionName("Beta session");
	await beta.ensureOnDisk();
	await appendProjectedTurn(beta, "beta-turn", "beta search marker");
	await beta.flush();
	await beta.close();
});

afterAll(() => {
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) delete process.env.GJC_AGENT_DIR;
	else process.env.GJC_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
});

test("threadRead exposes only the genuinely backed read methods", () => {
	expect(Object.keys(threadReadHandlers).sort()).toEqual([
		"thread/items/list",
		"thread/list",
		"thread/read",
		"thread/search",
		"thread/searchOccurrences",
		"thread/turns/list",
	]);
	expect(threadReadHandlers["thread/loaded/list"]).toBeUndefined();
});

test("thread/list enumerates both real persisted sessions and honors pinned params", async () => {
	const response = unwrap(
		await threadListHandler({
			useStateDbOnly: false,
			cursor: null,
			limit: 10,
			sortKey: "created_at",
			sortDirection: "asc",
			modelProviders: ["openai"],
			sourceKinds: null,
			archived: false,
			isPinned: false,
			cwd: workspace,
			searchTerm: "session",
		}),
	) as { data: Array<Record<string, unknown>>; nextCursor: string | null; backwardsCursor: string | null };
	expect(stableValidators.clientRequestResults["thread/list"](response)).toBe(true);
	expect(response.data).toHaveLength(2);
	expect(response.data.map(thread => thread.name)).toEqual(["Alpha session", "Beta session"]);
	expect(response.data.every(thread => thread.sessionId === thread.id)).toBe(true);
	expect(response.data.every(thread => thread.cwd === workspace)).toBe(true);
	expect(response.data.every(thread => thread.modelProvider === "openai")).toBe(true);
	expect(response.data.every(thread => Array.isArray(thread.turns) && thread.turns.length === 0)).toBe(true);
});

test("thread/read returns one real thread with reconstructed turns and notFound for an unknown id", async () => {
	const response = unwrap(await threadReadHandler({ threadId: alphaId, includeTurns: true })) as {
		thread: {
			id: string;
			preview: string;
			name: string | null;
			turns: Array<{ items: Array<Record<string, unknown>> }>;
		};
	};
	expect(stableValidators.clientRequestResults["thread/read"](response)).toBe(true);
	expect(response.thread.id).toBe(alphaId);
	expect(response.thread.name).toBe("Alpha session");
	expect(response.thread.preview).toContain("alpha real persisted prompt");
	expect(response.thread.turns).toHaveLength(1);
	expect(response.thread.turns[0]?.items.map(item => item.type)).toEqual(["userMessage", "agentMessage"]);
	expect(await threadReadHandler({ threadId: "missing-thread", includeTurns: true })).toEqual({
		ok: false,
		errorKey: "notFound",
	});
});

test("thread/items/list and thread/turns/list expose persisted projection content with pagination", async () => {
	const items = unwrap(
		await threadItemsListHandler({
			threadId: alphaId,
			turnId: "alpha-turn",
			cursor: null,
			limit: 10,
			sortDirection: "asc",
		}),
	) as { data: Array<{ turnId: string; item: Record<string, unknown> }> };
	expect(experimentalValidators.clientRequestResults["thread/items/list"](items)).toBe(true);
	expect(items.data).toHaveLength(2);
	expect(items.data[1]?.item).toMatchObject({ type: "agentMessage", text: "alpha search marker projected answer" });

	const turns = unwrap(
		await threadTurnsListHandler({
			threadId: alphaId,
			cursor: null,
			limit: 10,
			sortDirection: "asc",
			itemsView: "full",
		}),
	) as { data: Array<{ id: string; items: Array<Record<string, unknown>>; itemsView: string }> };
	expect(experimentalValidators.clientRequestResults["thread/turns/list"](turns)).toBe(true);
	expect(turns.data).toHaveLength(1);
	expect(turns.data[0]).toMatchObject({ id: "alpha-turn", itemsView: "full" });
	expect(turns.data[0]?.items[0]).toMatchObject({ type: "userMessage" });
});

test("thread/search finds real persisted content and misses an absent string", async () => {
	const found = unwrap(
		await threadSearchHandler({
			searchTerm: "alpha search marker",
			cursor: null,
			limit: 10,
			sortKey: "created_at",
			sortDirection: "desc",
			sourceKinds: null,
			archived: false,
		}),
	) as { data: Array<{ thread: { id: string }; snippet: string }> };
	expect(experimentalValidators.clientRequestResults["thread/search"](found)).toBe(true);
	expect(found.data).toHaveLength(1);
	expect(found.data[0]?.thread.id).toBe(alphaId);
	expect(found.data[0]?.snippet).toContain("alpha search marker");

	const missing = unwrap(await threadSearchHandler({ searchTerm: "not present anywhere", limit: 10 })) as {
		data: unknown[];
	};
	expect(missing.data).toEqual([]);
});

test("thread/searchOccurrences reports real item ranges and unknown threads return notFound", async () => {
	const response = unwrap(
		await threadSearchOccurrencesHandler({
			threadId: alphaId,
			searchTerm: "projected answer",
			cursor: null,
			limit: 10,
		}),
	) as {
		data: Array<{
			turnId: string;
			itemId: string;
			snippet: string;
			snippetMatchRange: { start: number; end: number };
			turnCursor: string;
		}>;
	};
	expect(experimentalValidators.clientRequestResults["thread/searchOccurrences"](response)).toBe(true);
	expect(response.data).toHaveLength(1);
	expect(response.data[0]).toMatchObject({ turnId: "alpha-turn", itemId: "alpha-turn-assistant-item" });
	expect(response.data[0]?.snippet).toContain("projected answer");
	expect(response.data[0]?.snippetMatchRange.end).toBeGreaterThan(response.data[0]?.snippetMatchRange.start ?? 0);
	expect(await threadSearchOccurrencesHandler({ threadId: "missing-thread", searchTerm: "anything" })).toEqual({
		ok: false,
		errorKey: "notFound",
	});
});

test("pinned parameter names are enforced at the handler boundary", async () => {
	expect(await threadListHandler({ stateDbOnly: false })).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await threadReadHandler({ threadId: alphaId, include_turns: true })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	const wrongAlias = unwrap(await threadItemsListHandler({ threadId: alphaId, turn_id: "alpha-turn", limit: 10 })) as {
		data: unknown[];
	};
	expect(wrongAlias.data).toHaveLength(2);
});
