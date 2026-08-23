/** End-to-end QA for the native notification server and session-owned SDK clients. */

import { expect, test } from "bun:test";
// Import the workspace-local built napi bindings directly: in this shared-node_modules
// worktree, `@gajae-code/natives` resolves to a sibling checkout that may predate the
// freshly-built NotificationServer. The relative path targets this workspace's own
// built `packages/natives/native` (which CI rebuilds), so the e2e exercises the real core.
import { NotificationServer } from "../../natives/native/index.js";
import { notificationActionPayload } from "../src/sdk/bus/helpers";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return;
		await sleep(25);
	}
	throw new Error(`timed out waiting for: ${label}`);
}

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
				{ redact: true },
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
test("arbitrated native asks canonicalize recommendation hints for late clients and resolve raw selections once", async () => {
	const sessionId = `arbitrated-recommendation-${process.pid}-${Date.now()}`;
	const token = "tok";
	const srv = new NotificationServer(sessionId, token, `/tmp/${sessionId}`, true);
	const forwarded: Array<{ id: string; answerJson: string; receiptId: string }> = [];
	srv.onReply((_error, reply) => {
		if (!reply) return;
		forwarded.push({ id: reply.id, answerJson: reply.answerJson, receiptId: reply.replyReceiptId });
		srv.resolveClaim(reply.replyReceiptId, reply.answerJson, reply.idempotencyKey ?? undefined);
	});
	const endpoint = await srv.start();
	try {
		// Register before a client connects: the late client must receive the canonical
		// pending action, not the producer's unvalidated JSON.
		srv.registerArbitratedAsk(
			JSON.stringify({
				id: "recommended-ask",
				kind: "ask",
				sessionId,
				question: "Which option is recommended?",
				options: ["first", "second"],
				recommendedIndex: 1,
			}),
			true,
		);
		const ws = new WebSocket(`${endpoint.url}/?token=${token}`);
		const actions: Array<Record<string, unknown>> = [];
		let terminals = 0;
		ws.addEventListener("message", event => {
			const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
			if (frame.type === "action_needed") actions.push(frame);
			if (frame.type === "action_resolved") terminals++;
		});
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
		});
		await waitFor(() => actions.some(action => action.id === "recommended-ask"), 4_000, "late recommendation replay");
		expect(actions.find(action => action.id === "recommended-ask")).toMatchObject({
			options: ["first", "second"],
			recommendedIndex: 1,
		});
		ws.send(JSON.stringify({ type: "reply", id: "recommended-ask", answer: 1, token }));
		await waitFor(() => forwarded.length === 1, 4_000, "recommended raw-index reply");
		expect(forwarded[0]).toMatchObject({ id: "recommended-ask", answerJson: "1" });
		await waitFor(() => terminals === 1, 4_000, "recommended action terminal");
		srv.registerArbitratedAsk(
			JSON.stringify({
				id: "malformed-recommendation-ask",
				kind: "ask",
				sessionId,
				question: "Can malformed advice still be answered?",
				options: ["first", "second"],
				recommendedIndex: 1.5,
			}),
			true,
		);
		await waitFor(
			() => actions.some(action => action.id === "malformed-recommendation-ask"),
			4_000,
			"malformed recommendation action",
		);
		const malformed = actions.find(action => action.id === "malformed-recommendation-ask");
		expect(malformed).toMatchObject({ options: ["first", "second"] });
		expect(malformed).not.toHaveProperty("recommendedIndex");
		ws.send(JSON.stringify({ type: "reply", id: "malformed-recommendation-ask", answer: 1, token }));
		await waitFor(() => forwarded.length === 2, 4_000, "malformed recommendation raw-index reply");
		expect(forwarded[1]).toMatchObject({ id: "malformed-recommendation-ask", answerJson: "1" });
		await waitFor(() => terminals === 2, 4_000, "malformed recommendation terminal");
		ws.send(JSON.stringify({ type: "reply", id: "malformed-recommendation-ask", answer: 1, token }));
		await sleep(100);
		expect(forwarded).toHaveLength(2);
		expect(terminals).toBe(2);
		ws.close();
	} finally {
		srv.stop();
	}
}, 30_000);
