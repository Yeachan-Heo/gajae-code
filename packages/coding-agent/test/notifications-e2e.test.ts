/**
 * Deterministic end-to-end QA of the Gajae-Code SDK notification transport.
 *
 * Drives the REAL stack — napi `NotificationServer` (Rust WS core) + real
 * WebSocket + the real Telegram reference client — with only Telegram's HTTP API
 * faked via the client's injectable `fetchImpl`. Simulates a remote button tap
 * and asserts the full round-trip:
 *   registerAsk -> action_needed broadcast -> reference client renders to
 *   (fake) Telegram with an inline keyboard -> button tap (fake getUpdates
 *   callback_query) -> reference client sends `reply` over WS -> server forwards
 *   it to the host (onReply) -> resolveClaim -> action_resolved broadcast.
 */

import { expect, test } from "bun:test";
// Import the workspace-local built napi bindings directly: in this shared-node_modules
// worktree, `@gajae-code/natives` resolves to a sibling checkout that may predate the
// freshly-built NotificationServer. The relative path targets this workspace's own
// built `packages/natives/native` (which CI rebuilds), so the e2e exercises the real core.
import { NotificationServer } from "../../natives/native/index.js";
import { notificationActionPayload } from "../src/sdk/bus/helpers";
import { runTelegramReferenceClient } from "../src/sdk/bus/telegram-reference";

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
	let forwarded: { id: string; answerJson: string; replyReceiptId: string } | undefined;
	let forwardedCount = 0;
	srv.onReply((_err, reply) => {
		if (!reply) return;
		forwarded = { id: reply.id, answerJson: reply.answerJson, replyReceiptId: reply.replyReceiptId };
		forwardedCount++;
		// Simulate the host resolving the real gate, then confirming.
		srv.resolveClaim(reply.replyReceiptId, reply.answerJson, reply.idempotencyKey ?? undefined);
	});
	const ep = await srv.start();
	expect(ep.url).toContain("ws://127.0.0.1:");

	// ---- real reference client (real WS to the server; fake Telegram) ----
	const endpointFile = `${stateRoot}/sdk/e2e.json`;
	let clientError: unknown;
	const clientDone = runTelegramReferenceClient({
		botToken: "x",
		chatId: "1",
		endpointFile,
		fetchImpl: fakeFetch,
	}).catch(error => {
		clientError = error;
	});
	const observer = new WebSocket(`${ep.url}/?token=tok`);
	let resolvedBroadcast = false;
	await new Promise<void>((resolve, reject) => {
		observer.addEventListener("open", () => resolve());
		observer.addEventListener("error", () => reject(new Error("observer WS error")));
	});
	observer.addEventListener("message", event => {
		const message = JSON.parse(String(event.data)) as { type?: string; id?: string };
		if (message.type === "action_resolved" && message.id === "qa-ask-1") resolvedBroadcast = true;
	});

	await waitFor(() => srv.clientCount() >= 2, 4000, "reference and observer WS connect");

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
	await waitFor(() => resolvedBroadcast, 4000, "resolved broadcast");
	const callbackData = (askMsg?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> })
		.inline_keyboard?.[0]?.[0]?.callback_data;
	if (!callbackData) throw new Error("missing callback data");
	pendingUpdates.push({
		update_id: updateId++,
		callback_query: { id: "cq-replay", data: callbackData, message: { chat: { id: 1 } } },
	});
	await sleep(100);
	expect(forwardedCount).toBe(1);

	// idle ping path
	srv.noteIdle(JSON.stringify({ id: "idle-1", kind: "idle", sessionId: "e2e", summary: "went idle" }));
	await waitFor(() => sent.some(m => String(m.text).includes("went idle")), 4000, "idle ping delivered");

	srv.stop();
	observer.close();
	await clientDone;
	expect(clientError).toBeUndefined();
}, 30000);

test("interactive ask answered remotely via SDK answer source", async () => {
	// Mirrors the SDK bus AskAnswerSource against the real server: a pending
	// interactive ask is registered repliable and resolved by a remote SDK reply
	// mapped to the chosen option label.
	const stateRoot = `/tmp/notif-e2e-ans-${process.pid}-${Date.now()}`;
	const srv = new NotificationServer("ans", "tok", stateRoot, true);

	const pending = new Map<string, { resolve: (label: string | undefined) => void; options: string[] }>();
	srv.onReply((_err, reply) => {
		if (!reply) return;
		const p = pending.get(reply.id);
		if (!p) return;
		pending.delete(reply.id);
		const idx = Number(JSON.parse(reply.answerJson));
		srv.resolveClaim(reply.replyReceiptId, reply.answerJson, reply.idempotencyKey ?? undefined);
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

test("ask frames are exempt from redaction so they stay readable and answerable", async () => {
	const stateRoot = `/tmp/notif-e2e-redact-${process.pid}-${Date.now()}`;
	const srv = new NotificationServer("redact", "tok", stateRoot, true);
	const options = ["Ship secret alpha", "Abort secret beta"];
	let resolvedLabel: string | undefined;

	srv.onReply((_err, reply) => {
		if (!reply) return;
		const idx = Number(JSON.parse(reply.answerJson));
		resolvedLabel = options[idx];
		srv.resolveClaim(reply.replyReceiptId, reply.answerJson, reply.idempotencyKey ?? undefined);
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

	await waitFor(() => actionFrame !== undefined, 4000, "ask action frame");
	// Asks are exempt from redaction even with redact:true — both the question and
	// the options reach the remote intact so the prompt is readable and answerable.
	expect(String(actionFrame?.question)).toBe("Deploy secret project Alpha?");
	expect(actionFrame?.options).toEqual(options);
	await waitFor(() => resolvedBroadcast, 3000, "redacted action resolved");
	expect(resolvedLabel).toBe("Ship secret alpha");

	ws.close();
	srv.stop();
}, 30000);

test("arbitrated native ask lets a generic claim win exactly once over a direct retirement and ignores stale replies", async () => {
	const sessionId = `arbitrated-${process.pid}-${Date.now()}`;
	const token = "tok";
	const srv = new NotificationServer(sessionId, token, `/tmp/${sessionId}`, true);
	let forwarded: { receiptId: string; answerJson: string } | undefined;
	let forwardedCount = 0;
	srv.onReply((_error, reply) => {
		if (!reply) return;
		forwardedCount++;
		forwarded = { receiptId: reply.replyReceiptId, answerJson: reply.answerJson };
	});
	const endpoint = await srv.start();
	const ws = new WebSocket(`${endpoint.url}/?token=${token}`);
	let actionsSeen = 0;
	let terminals = 0;
	ws.addEventListener("message", event => {
		const frame = JSON.parse(String(event.data)) as { type?: string; id?: string; kind?: string };
		if (frame.type === "action_needed" && frame.kind === "ask") actionsSeen++;
		if (frame.type === "action_resolved") terminals++;
	});
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
	});
	try {
		const lease = srv.registerArbitratedAsk(
			JSON.stringify({
				id: "arbitrated-ask",
				kind: "ask",
				sessionId,
				question: "Which path wins?",
				options: ["generic", "direct"],
			}),
			true,
		);
		await waitFor(() => actionsSeen === 1, 4_000, "arbitrated ask action");
		ws.send(JSON.stringify({ type: "reply", id: "arbitrated-ask", answer: 0, token }));
		await waitFor(() => forwarded !== undefined, 4_000, "generic reply claim");

		// The native generic claim owns this exact lease, so direct workflow control
		// cannot retire it and create a second terminal path.
		expect(srv.retireIfUnclaimed(lease)).toEqual({ status: "claimed" });
		srv.resolveClaim(forwarded!.receiptId, forwarded!.answerJson);
		await waitFor(() => terminals === 1, 4_000, "single action terminal");

		// A delayed duplicate of the old generic action cannot create an orphan receipt
		// or emit another terminal after the receipt-bound resolution above.
		ws.send(JSON.stringify({ type: "reply", id: "arbitrated-ask", answer: 1, token }));
		await sleep(100);
		expect(forwardedCount).toBe(1);
		expect(terminals).toBe(1);

		const directLease = srv.registerArbitratedAsk(
			JSON.stringify({
				id: "direct-retired-ask",
				kind: "ask",
				sessionId,
				question: "Can a stale reply revive this?",
				options: ["no"],
			}),
			true,
		);
		await waitFor(() => actionsSeen === 2, 4_000, "direct-retired ask action");
		expect(srv.retireIfUnclaimed(directLease)).toEqual({ status: "retired" });
		ws.send(JSON.stringify({ type: "reply", id: "direct-retired-ask", answer: 0, token }));
		await sleep(100);
		expect(forwardedCount).toBe(1);
		expect(terminals).toBe(2);
	} finally {
		ws.close();
		srv.stop();
	}
}, 30_000);
