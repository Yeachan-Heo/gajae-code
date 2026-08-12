import { expect, test } from "bun:test";

import { waitForTerminalStatus } from "../src/sdk/cli/session-cli";
import { SdkClientError } from "../src/sdk/client";
import type { SessionAttachment, SessionRouter } from "../src/sdk/router";
import { SESSION_REQUEST_TIMEOUT_MS } from "../src/sdk/session-reconnect";

const SESSION_ID = "wait-budget-session";

function statusRouter(): { router: SessionRouter; budgets: (number | undefined)[] } {
	const budgets: (number | undefined)[] = [];
	const attachment: SessionAttachment = {
		sessionId: SESSION_ID,
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
	};
	const router = {
		attachment: () => attachment,
		request: async (
			_sessionId: string,
			_frame: Record<string, unknown>,
			_generation?: number,
			_attachment?: SessionAttachment,
			options?: { timeoutMs?: number },
		) => {
			budgets.push(options?.timeoutMs);
			// A host that never settles the turn: the wait window, not the reply
			// budget, has to be what ends this loop.
			return { ok: true, result: { status: "in_flight" } };
		},
	} as unknown as SessionRouter;
	return { router, budgets };
}

test("send --wait polls turn.result inside its own wait window, not the session reply budget", async () => {
	const { router, budgets } = statusRouter();
	const waitMs = 300;
	const started = Date.now();
	const outcome = await waitForTerminalStatus(router, SESSION_ID, "client-ref", waitMs);
	const elapsed = Date.now() - started;

	expect(outcome).toMatchObject({ terminal: false, status: "in_flight" });
	expect(budgets.length).toBeGreaterThanOrEqual(2);
	// Without a per-poll budget every status query inherits the Router default, so a
	// wedged reply would outlive the wait the caller asked for.
	for (const timeoutMs of budgets) {
		expect(timeoutMs).toBeDefined();
		expect(timeoutMs!).toBeGreaterThan(0);
		expect(timeoutMs!).toBeLessThanOrEqual(waitMs);
		expect(timeoutMs!).toBeLessThan(SESSION_REQUEST_TIMEOUT_MS);
	}
	// Later polls get the remainder, never a fresh window.
	for (let index = 1; index < budgets.length; index++)
		expect(budgets[index]!).toBeLessThanOrEqual(budgets[index - 1]!);
	expect(elapsed).toBeLessThan(SESSION_REQUEST_TIMEOUT_MS);
});

test("a wait window that ends on a stalled poll reports the wait outcome, not a transport failure", async () => {
	const budgets: (number | undefined)[] = [];
	let polls = 0;
	const attachment: SessionAttachment = {
		sessionId: SESSION_ID,
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
	};
	const router = {
		attachment: () => attachment,
		request: async (
			_sessionId: string,
			_frame: Record<string, unknown>,
			_generation?: number,
			_attachment?: SessionAttachment,
			options?: { timeoutMs?: number },
		) => {
			budgets.push(options?.timeoutMs);
			polls++;
			// First poll answers; every later poll is the wedged host the reviewer
			// described: accepted on the wire, never answered.
			if (polls === 1) return { ok: true, result: { status: "in_flight" } };
			return await new Promise<never>(() => {});
		},
	} as unknown as SessionRouter;

	const waitMs = 400;
	const started = Date.now();
	const outcome = await waitForTerminalStatus(router, SESSION_ID, "client-ref", waitMs);
	const elapsed = Date.now() - started;

	// The documented contract is wait_timeout with the last observed status.
	expect(outcome).toMatchObject({ terminal: false, status: "in_flight" });
	expect(polls).toBeGreaterThanOrEqual(2);
	// The stalled poll is abandoned at the window, not at the session reply budget,
	// so a reconnecting transport cannot dispatch past the caller's deadline.
	expect(elapsed).toBeLessThan(waitMs * 4);
	expect(elapsed).toBeLessThan(SESSION_REQUEST_TIMEOUT_MS);
});

test("a transport failure inside the wait window still surfaces to the caller", async () => {
	const attachment: SessionAttachment = {
		sessionId: SESSION_ID,
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
	};
	const router = {
		attachment: () => attachment,
		request: async () => {
			throw new SdkClientError("endpoint_stale", "SDK session endpoint is stale.");
		},
	} as unknown as SessionRouter;

	await expect(waitForTerminalStatus(router, SESSION_ID, "client-ref", 500)).rejects.toMatchObject({
		code: "endpoint_stale",
	});
});

test("an unbounded wait leaves the status poll on the transport default", async () => {
	const { router, budgets } = statusRouter();
	const settled = await Promise.race([
		waitForTerminalStatus(router, SESSION_ID, "client-ref", undefined).then(() => "returned" as const),
		Bun.sleep(250).then(() => "still-polling" as const),
	]);

	expect(settled).toBe("still-polling");
	expect(budgets.length).toBeGreaterThanOrEqual(1);
	expect(budgets.every(timeoutMs => timeoutMs === undefined)).toBe(true);
});
