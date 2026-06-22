/**
 * Deterministic end-to-end QA of the notifications SDK.
 *
 * Drives the REAL stack — napi `NotificationServer` (Rust WS core) + real
 * WebSocket + the real Telegram reference client — with only Telegram's HTTP API
 * faked via the client's injectable `fetchImpl`. Simulates a remote button tap
 * and asserts the full round-trip:
 *   registerAsk -> action_needed broadcast -> reference client renders to
 *   (fake) Telegram with an inline keyboard -> button tap (fake getUpdates
 *   callback_query) -> reference client sends `reply` over WS -> server forwards
 *   it to the host (onReply) -> resolveClient -> action_resolved broadcast.
 */

import { expect, test } from "bun:test";
// Import the workspace-local built napi bindings directly: in this shared-node_modules
// worktree, `@gajae-code/natives` resolves to a sibling checkout that may predate the
// freshly-built NotificationServer. The relative path targets this workspace's own
// built `packages/natives/native` (which CI rebuilds), so the e2e exercises the real core.
import { NotificationServer } from "../../natives/native/index.js";
import { notificationActionPayload } from "../src/notifications/helpers";
import { runTelegramReferenceClient } from "../src/notifications/telegram-reference";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return;
		await sleep(25);
	}
	throw new Error(`timed out waiting for: ${label}`);
}

test("e2e: ask -> Telegram -> button tap -> reply -> resolved", async () => {
	// ---- fake Telegram Bot API ----
	const sent: Array<Record<string, unknown>> = [];
	const pendingUpdates: Array<Record<string, unknown>> = [];
	let askDelivered = false;
	let updateId = 1000;

	const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const u = String(url);
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
		if (u.endsWith("/sendMessage")) {
			sent.push(body);
			const kb = (body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)
				?.inline_keyboard;
			if (kb?.[0]?.[0]) {
				// An ask with options arrived: simulate the user tapping the first option.
				pendingUpdates.push({
					update_id: updateId++,
					callback_query: { id: "cq1", data: kb[0][0].callback_data, message: { chat: { id: 1 } } },
				});
				askDelivered = true;
			}
			return jsonResponse({ ok: true, result: {} });
		}
		if (u.includes("/getUpdates")) {
			const out = pendingUpdates.splice(0, pendingUpdates.length);
			if (out.length === 0) await sleep(40);
			return jsonResponse({ ok: true, result: out });
		}
		return jsonResponse({ ok: true, result: {} });
	}) as unknown as typeof fetch;

	// ---- real server + host gate-resolution simulation ----
	const stateRoot = `/tmp/notif-e2e-${process.pid}-${Date.now()}`;
	const srv = new NotificationServer("e2e", "tok", stateRoot, true);
	let forwarded: { id: string; answerJson: string } | undefined;
	srv.onReply((_err, reply) => {
		if (!reply) return;
		forwarded = { id: reply.id, answerJson: reply.answerJson };
		// Simulate the host resolving the real gate, then confirming.
		srv.resolveClient(reply.id, reply.answerJson, reply.idempotencyKey ?? undefined);
	});
	const ep = await srv.start();
	expect(ep.url).toContain("ws://127.0.0.1:");

	// ---- real reference client (real WS to the server; fake Telegram) ----
	const endpointFile = `${stateRoot}/notifications/e2e.json`;
	const clientDone = runTelegramReferenceClient({
		botToken: "x",
		chatId: "1",
		endpointFile,
		fetchImpl: fakeFetch,
	}).catch(() => {});

	await waitFor(() => srv.clientCount() >= 1, 4000, "reference client WS connect");

	srv.registerAsk(
		JSON.stringify({
			id: "qa-ask-1",
			kind: "ask",
			sessionId: "e2e",
			question: "QA round-trip works?",
			options: ["Yes", "No"],
		}),
		true,
	);

	// ask must reach (fake) Telegram with an inline keyboard
	await waitFor(() => askDelivered, 4000, "ask delivered to Telegram");
	const askMsg = sent.find(m => m.reply_markup);
	expect(String(askMsg?.text)).toContain("QA round-trip works?");

	// the button tap must round-trip back as a reply forwarded to the host
	await waitFor(() => forwarded !== undefined, 4000, "reply forwarded to host");
	expect(forwarded?.id).toBe("qa-ask-1");
	expect(forwarded?.answerJson).toBe("0"); // option index 0 = "Yes"

	// idle ping path
	srv.noteIdle(JSON.stringify({ id: "idle-1", kind: "idle", sessionId: "e2e", summary: "went idle" }));
	await waitFor(() => sent.some(m => String(m.text).includes("went idle")), 4000, "idle ping delivered");

	srv.stop();
	await clientDone;
}, 30000);

test("interactive ask answered remotely via answer source (no RPC)", async () => {
	// Mirrors what the notifications extension's AskAnswerSource does, against the
	// real server: a pending interactive ask is registered repliable and resolved
	// by a remote reply mapped to the chosen option label — proving asks can be
	// answered remotely without RPC/unattended mode.
	const stateRoot = `/tmp/notif-e2e-ans-${process.pid}-${Date.now()}`;
	const srv = new NotificationServer("ans", "tok", stateRoot, true);

	const pending = new Map<string, { resolve: (label: string | undefined) => void; options: string[] }>();
	srv.onReply((_err, reply) => {
		if (!reply) return;
		const p = pending.get(reply.id);
		if (!p) return;
		pending.delete(reply.id);
		const idx = Number(JSON.parse(reply.answerJson));
		srv.resolveClient(reply.id, reply.answerJson, reply.idempotencyKey ?? undefined);
		p.resolve(p.options[idx]);
	});
	const ep = await srv.start();

	// emulate AskAnswerSource.awaitAnswer
	const options = ["Yes", "No"];
	const askId = "ask:interactive-1";
	const answerPromise = new Promise<string | undefined>(resolve => {
		pending.set(askId, { resolve, options });
		srv.registerAsk(
			JSON.stringify({ id: askId, kind: "ask", sessionId: "ans", question: "Proceed?", options }),
			true,
		);
	});

	// a raw client connects, sees the ask, replies with option index 0
	const ws = new WebSocket(`${ep.url}/?token=tok`);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("ws error")));
	});
	let resolvedBroadcast = false;
	ws.addEventListener("message", ev => {
		const msg = JSON.parse(String(ev.data)) as { type: string; id?: string; kind?: string };
		if (msg.type === "action_needed" && msg.kind === "ask" && msg.id === askId) {
			ws.send(JSON.stringify({ type: "reply", id: askId, answer: 0, token: "tok" }));
		} else if (msg.type === "action_resolved" && msg.id === askId) {
			resolvedBroadcast = true;
		}
	});

	const answer = await Promise.race([
		answerPromise,
		new Promise<string | undefined>((_, rej) => setTimeout(() => rej(new Error("answer timeout")), 5000)),
	]);
	expect(answer).toBe("Yes");
	await waitFor(() => resolvedBroadcast, 3000, "action_resolved broadcast");

	ws.close();
	srv.stop();
}, 30000);

test("redacted ask frame hides raw text and numeric answer still maps to local option", async () => {
	const stateRoot = `/tmp/notif-e2e-redact-${process.pid}-${Date.now()}`;
	const srv = new NotificationServer("redact", "tok", stateRoot, true);
	const options = ["Ship secret alpha", "Abort secret beta"];
	let resolvedLabel: string | undefined;

	srv.onReply((_err, reply) => {
		if (!reply) return;
		const idx = Number(JSON.parse(reply.answerJson));
		resolvedLabel = options[idx];
		srv.resolveClient(reply.id, reply.answerJson, reply.idempotencyKey ?? undefined);
	});
	const ep = await srv.start();
	const ws = new WebSocket(`${ep.url}/?token=tok`);
	let actionFrame: Record<string, unknown> | undefined;
	let resolvedBroadcast = false;

	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("ws error")));
	});
	ws.addEventListener("message", ev => {
		const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
		if (msg.type === "action_needed" && msg.kind === "ask") {
			actionFrame = msg;
			ws.send(JSON.stringify({ type: "reply", id: msg.id, answer: 0, token: "tok" }));
		} else if (msg.type === "action_resolved") {
			resolvedBroadcast = true;
		}
	});

	srv.registerAsk(
		JSON.stringify(
			notificationActionPayload(
				{
					id: "redacted-ask-1",
					kind: "ask",
					sessionId: "session-sensitive-abcdef",
					question: "Deploy secret project Alpha?",
					options,
				},
				{ redact: true, sessionTag: "abcdef" },
			),
		),
		true,
	);

	await waitFor(() => actionFrame !== undefined, 4000, "redacted action frame");
	expect(String(actionFrame?.question)).not.toContain("Alpha");
	expect(JSON.stringify(actionFrame)).not.toContain("Ship secret alpha");
	expect(actionFrame?.options).toEqual(["1", "2"]);
	await waitFor(() => resolvedBroadcast, 3000, "redacted action resolved");
	expect(resolvedLabel).toBe("Ship secret alpha");

	ws.close();
	srv.stop();
}, 30000);
