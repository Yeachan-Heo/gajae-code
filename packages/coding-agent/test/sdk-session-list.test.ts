import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Broker } from "../src/sdk/broker/broker";
import { SessionIndex } from "../src/sdk/broker/session-index";
import * as sessionDirectory from "../src/sdk/session-directory";
import { SESSION_LIST_SAVED_SESSION_OMISSION_DETAIL_CODES, traverseSessionList } from "../src/sdk/session-list";

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

test("broker session.list preserves the managed journal capacity omission diagnostic", async () => {
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
			code: "managed_gc_journal_capacity_exceeded",
			message: "Managed cleanup journal replay exceeded its read budget.",
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
					detailCode: "managed_gc_journal_capacity_exceeded",
				},
			},
		});
		expect(SESSION_LIST_SAVED_SESSION_OMISSION_DETAIL_CODES).toContain("managed_gc_journal_capacity_exceeded");
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});
