import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Broker } from "../src/sdk/broker/broker";
import { SessionIndex } from "../src/sdk/broker/session-index";
import * as sessionDirectory from "../src/sdk/session-directory";
import {
	SESSION_LIST_SAVED_SESSION_OMISSION_DETAIL_CODES,
	type SessionListSavedSessionRecap,
	sessionListSavedSessionRecap,
	traverseSessionList,
} from "../src/sdk/session-list";

afterEach(() => vi.restoreAllMocks());

test("shared session-list traversal rejects after 10,000 continuation pages", async () => {
	let requests = 0;

	await expect(
		traverseSessionList(
			{},
			async () => {
				requests += 1;
				return { sessions: [], continuationCursor: `cursor-${requests}` };
			},
			response => response,
		),
	).rejects.toMatchObject({ kind: "page_budget_exceeded" });

	expect(requests).toBe(10_000);
});

test("shared session-list traversal seeds the seen cursor set from input", async () => {
	const cursors: string[] = [];

	await expect(
		traverseSessionList(
			{ cursor: "initial-cursor" },
			async input => {
				cursors.push(input.cursor);
				return { sessions: [], continuationCursor: "initial-cursor" };
			},
			response => response,
		),
	).rejects.toMatchObject({ kind: "repeated_cursor" });

	expect(cursors).toEqual(["initial-cursor"]);
});

test.each([
	["managed_gc_journal_capacity_exceeded", "Managed cleanup journal replay exceeded its read budget."],
	["permission_denied", "Managed publication was denied before mutation."],
] as const)("broker session.list preserves the %s omission diagnostic", async (code, message) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-session-list-capacity-"));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		await new SessionIndex(agentDir).open();
		const resolveScope = vi.spyOn(sessionDirectory, "resolveManagedSessionScope").mockResolvedValue({
			kind: "error",
			code,
			message,
		});
		const response = await broker.handleRequest("session.list", { cwd, resolveSessionId: "saved-session" });
		expect(resolveScope).toHaveBeenCalledWith({ cwd, agentDir });
		expect(response).toMatchObject({
			ok: true,
			result: {
				sessions: [],
				savedSessionOmission: {
					sessionId: "saved-session",
					reason: "scope_unavailable",
					detailCode: code,
				},
			},
		});
		expect(SESSION_LIST_SAVED_SESSION_OMISSION_DETAIL_CODES).toContain(code);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

const validSavedRecap = (): SessionListSavedSessionRecap => ({
	schemaVersion: 1,
	source: "model",
	text: "Fixed the login bug",
	sourceEntryId: "entry-2",
	requestEntryId: "entry-1",
	model: { provider: "anthropic", id: "claude-x" },
	generatedAt: "2026-01-02T03:04:05.678Z",
	entryId: "recap-1",
});

test("saved-session recap validator returns a detached exact copy", () => {
	const input = validSavedRecap();
	const out = sessionListSavedSessionRecap(input);
	expect(out).toEqual(input);
	expect(out).not.toBe(input);
	expect(out?.model).not.toBe(input.model);
	input.model.id = "mutated";
	expect(out?.model.id).toBe("claude-x");
});

test("saved-session recap validator rejects every boundary violation", () => {
	const bad: Record<string, unknown>[] = [];
	const mutate = (fn: (r: Record<string, unknown>) => void) => {
		const r: Record<string, unknown> = { ...validSavedRecap() };
		fn(r);
		bad.push(r);
	};
	mutate(r => delete r.source);
	mutate(r => {
		r.source = "user";
	});
	mutate(r => {
		r.extra = 1;
	});
	mutate(r => delete r.entryId);
	mutate(r => {
		r.text = "x".repeat(121);
	});
	mutate(r => {
		r.text = "line1\nline2";
	});
	mutate(r => {
		r.schemaVersion = 2;
	});
	mutate(r => {
		r.entryId = "-bad";
	});
	mutate(r => {
		r.entryId = `a${"b".repeat(128)}`;
	});
	mutate(r => {
		r.entryId = "has/slash";
	});
	mutate(r => {
		r.model = { provider: "anthropic", id: "x", extra: true };
	});
	mutate(r => {
		r.model = { provider: "", id: "x" };
	});
	mutate(r => {
		r.generatedAt = "2026-01-02";
	});
	mutate(r => {
		r.generatedAt = "2026-02-30T00:00:00.000Z";
	});
	mutate(r => {
		r.requestEntryId = r.sourceEntryId;
	});
	for (const value of bad) expect(sessionListSavedSessionRecap(value)).toBeUndefined();
	for (const value of [undefined, null, "x", 1, [], [validSavedRecap()]])
		expect(sessionListSavedSessionRecap(value)).toBeUndefined();
});
