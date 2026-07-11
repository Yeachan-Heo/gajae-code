import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RpcWorkflowGate, RpcWorkflowGateResolution, RpcWorkflowGateResponse } from "../src/modes/rpc/rpc-types";
import type { NotificationGateResolutionOptions } from "../src/modes/shared/agent-wire/unattended-session";
import { createNotificationsExtension } from "../src/notifications/index";
import { getAskAnswerSource, notifyWorkflowGateEmitterChanged } from "../src/tools/ask-answer-registry";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function startInteractiveNotifications() {
	const previous = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	createNotificationsExtension(api);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-selected-ack-"));
	tempDirs.push(cwd);
	const sessionId = `ack-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "Selected ack",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
	} as never;
	await handlers.get("session_start")!({ type: "session_start" }, ctx);
	const endpointPath = path.join(cwd, ".gjc", "state", "notifications", `${sessionId}.json`);
	const endpoint = await waitFor(() => {
		try {
			return JSON.parse(fs.readFileSync(endpointPath, "utf8")) as { url: string; token: string };
		} catch {
			return undefined;
		}
	}, "notification endpoint");
	return {
		handlers,
		ctx,
		sessionId,
		endpoint,
		restore: async () => {
			await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
			if (previous === undefined) delete process.env.GJC_NOTIFICATIONS;
			else process.env.GJC_NOTIFICATIONS = previous;
		},
	};
}

function socketMessages(ws: WebSocket): {
	next(type: string): Promise<Record<string, unknown>>;
	all: Record<string, unknown>[];
} {
	const all: Record<string, unknown>[] = [];
	ws.addEventListener("message", event => {
		all.push(JSON.parse(String(event.data)) as Record<string, unknown>);
	});
	return {
		all,
		next: type =>
			waitFor(() => {
				const index = all.findIndex(message => message.type === type);
				if (index < 0) return undefined;
				return all.splice(index, 1)[0];
			}, type),
	};
}

test("interactive notification settlement awaits Selected result before action resolution", async () => {
	const harness = await startInteractiveNotifications();
	try {
		const ws = new WebSocket(`${harness.endpoint.url}/?token=${encodeURIComponent(harness.endpoint.token)}`);
		const messages = socketMessages(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
		});
		await messages.next("hello");
		ws.send(
			JSON.stringify({
				type: "hello",
				protocolVersion: 3,
				capabilities: ["ask_controls_v1", "ask_selected_ack_v1"],
			}),
		);

		const source = getAskAnswerSource(harness.sessionId);
		expect(source).toBeDefined();
		const answerPromise = source!.awaitAnswerRequest!(
			{ question: "Proceed?", options: ["yes", "no"], interaction: "selector", controls: [] },
			undefined,
		);
		const action = await messages.next("action_needed");
		ws.send(
			JSON.stringify({
				type: "reply",
				id: action.id,
				answer: 0,
				token: harness.endpoint.token,
				idempotencyKey: "answer-1",
			}),
		);
		const receipt = await answerPromise;
		expect(receipt && typeof receipt !== "string" ? receipt.interaction : undefined).toEqual({
			kind: "value",
			value: "yes",
		});
		if (!receipt || typeof receipt === "string") throw new Error("expected typed receipt");
		let settled = false;
		const settlement = receipt.settle({ kind: "commit" }).then(result => {
			settled = true;
			return result;
		});
		const ackRequest = await messages.next("ask_selected_ack_request");
		expect(settled).toBe(false);
		expect(ackRequest).toMatchObject({ mode: "live", actionId: action.id });
		expect(messages.all.some(message => message.type === "action_resolved")).toBe(false);
		ws.send(
			JSON.stringify({
				type: "ask_selected_ack_result",
				requestId: ackRequest.requestId,
				commitKey: ackRequest.commitKey,
				outcome: { status: "delivered", messageId: 77 },
			}),
		);
		expect(await settlement).toEqual({ kind: "committed", ack: { status: "delivered", messageId: 77 } });
		expect(await messages.next("action_resolved")).toMatchObject({ id: action.id, resolvedBy: "client" });
		ws.close();
	} finally {
		await harness.restore();
	}
}, 20_000);

test("unsupported acknowledgement capability fails open without losing the accepted answer", async () => {
	const harness = await startInteractiveNotifications();
	try {
		const ws = new WebSocket(`${harness.endpoint.url}/?token=${encodeURIComponent(harness.endpoint.token)}`);
		const messages = socketMessages(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
		});
		await messages.next("hello");
		const source = getAskAnswerSource(harness.sessionId)!;
		const answerPromise = source.awaitAnswerRequest!(
			{ question: "Proceed?", options: ["yes"], interaction: "selector", controls: [] },
			undefined,
		);
		const action = await messages.next("action_needed");
		ws.send(JSON.stringify({ type: "reply", id: action.id, answer: 0, token: harness.endpoint.token }));
		const receipt = await answerPromise;
		if (!receipt || typeof receipt === "string") throw new Error("expected typed receipt");
		expect(await receipt.settle({ kind: "commit" })).toEqual({
			kind: "committed",
			ack: { status: "failed", reason: "unsupported" },
		});
		expect(await messages.next("action_resolved")).toMatchObject({ id: action.id });
		expect(messages.all.some(message => message.type === "ask_selected_ack_request")).toBe(false);
		ws.close();
	} finally {
		await harness.restore();
	}
}, 20_000);

test("invalid interactive replies close the old claim and reissue a fresh action", async () => {
	const harness = await startInteractiveNotifications();
	try {
		const ws = new WebSocket(`${harness.endpoint.url}/?token=${encodeURIComponent(harness.endpoint.token)}`);
		const messages = socketMessages(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
		});
		await messages.next("hello");
		const source = getAskAnswerSource(harness.sessionId)!;
		const answerPromise = source.awaitAnswerRequest!(
			{ question: "Proceed?", options: ["yes"], interaction: "selector", controls: [] },
			undefined,
		);
		const first = await messages.next("action_needed");
		ws.send(JSON.stringify({ type: "reply", id: first.id, answer: 99, token: harness.endpoint.token }));
		expect(await messages.next("action_resolved")).toMatchObject({ id: first.id });
		const second = await messages.next("action_needed");
		expect(second.id).not.toBe(first.id);
		ws.send(JSON.stringify({ type: "reply", id: second.id, answer: 0, token: harness.endpoint.token }));
		const receipt = await answerPromise;
		if (!receipt || typeof receipt === "string") throw new Error("expected typed receipt");
		expect(receipt.interaction).toEqual({ kind: "value", value: "yes" });
		expect(await receipt.settle({ kind: "resolve_without_commit", reason: "cancelled" })).toEqual({
			kind: "resolved_without_commit",
		});
		expect(await messages.next("action_resolved")).toMatchObject({ id: second.id });
		ws.close();
	} finally {
		await harness.restore();
	}
}, 20_000);

test("attaches unattended workflow gates installed after session_start", async () => {
	const harness = await startInteractiveNotifications();
	try {
		const ws = new WebSocket(`${harness.endpoint.url}/?token=${encodeURIComponent(harness.endpoint.token)}`);
		const messages = socketMessages(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
		});
		await messages.next("hello");
		let emitGate: ((gate: RpcWorkflowGate) => void) | undefined;
		let terminalRegistered = false;
		let recoveryRegistered = false;
		let unattended = false;
		const gate = {
			isUnattended: () => unattended,
			emitGate: async () => undefined,
			onGateEmitted: (listener: (value: RpcWorkflowGate) => void) => {
				emitGate = listener;
				return () => {
					emitGate = undefined;
				};
			},
			resolveGate: async () => ({ gate_id: "gate-1", status: "accepted", answer_hash: "", resolved_at: "now" }),
			registerGateTerminalController: () => {
				terminalRegistered = true;
				return () => {};
			},
			setAckRecoveryParticipant: (participant: unknown) => {
				recoveryRegistered = participant !== null;
			},
		};
		notifyWorkflowGateEmitterChanged(harness.sessionId, gate as never);
		expect(terminalRegistered).toBe(true);
		expect(recoveryRegistered).toBe(true);
		unattended = true;
		emitGate?.({
			type: "workflow_gate",
			gate_id: "gate-1",
			stage: "deep-interview",
			kind: "question",
			schema: { type: "object" },
			schema_hash: "hash",
			options: [{ value: "yes", label: "yes" }],
			context: { prompt: "Late gate?", stage_state: { multi: false, navigation_label: "Done" } },
			created_at: new Date().toISOString(),
			required: true,
		});
		expect(await messages.next("action_needed")).toMatchObject({ kind: "ask", question: "Late gate?" });
		ws.close();
	} finally {
		notifyWorkflowGateEmitterChanged(harness.sessionId, undefined);
		await harness.restore();
	}
}, 20_000);

interface ResolveCall {
	answer: unknown;
}

/**
 * Stand up an unattended workflow gate over a live notification socket. The mock
 * gate records every `resolveGateFromNotification` call so a test can assert that
 * an invalid numeric selector never reaches the durable-accept / ack path.
 */
async function startUnattendedGate(opts: {
	options: string[];
	multi?: boolean;
	onResolve?: (options: NotificationGateResolutionOptions) => Promise<void> | void;
}) {
	const harness = await startInteractiveNotifications();
	const ws = new WebSocket(`${harness.endpoint.url}/?token=${encodeURIComponent(harness.endpoint.token)}`);
	const messages = socketMessages(ws);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
	});
	await messages.next("hello");
	ws.send(
		JSON.stringify({
			type: "hello",
			protocolVersion: 3,
			capabilities: ["ask_controls_v1", "ask_selected_ack_v1"],
		}),
	);

	const calls: ResolveCall[] = [];
	let emitGate: ((gate: RpcWorkflowGate) => void) | undefined;
	const gate = {
		isUnattended: () => true,
		emitGate: async () => undefined,
		onGateEmitted: (listener: (value: RpcWorkflowGate) => void) => {
			emitGate = listener;
			return () => {
				emitGate = undefined;
			};
		},
		resolveGate: async () => ({ gate_id: "gate-1", status: "accepted", answer_hash: "", resolved_at: "now" }),
		resolveGateFromNotification: async (
			response: RpcWorkflowGateResponse,
			resolveOptions: NotificationGateResolutionOptions,
		): Promise<RpcWorkflowGateResolution> => {
			calls.push({ answer: response.answer });
			if (opts.onResolve) await opts.onResolve(resolveOptions);
			else resolveOptions.resolveClaim();
			return { gate_id: response.gate_id, status: "accepted", answer_hash: "", resolved_at: "now" };
		},
		registerGateTerminalController: () => () => {},
		setAckRecoveryParticipant: () => {},
	};
	notifyWorkflowGateEmitterChanged(harness.sessionId, gate as never);
	emitGate?.({
		type: "workflow_gate",
		gate_id: "gate-1",
		stage: "deep-interview",
		kind: "question",
		schema: { type: "object" },
		schema_hash: "hash",
		options: opts.options.map(value => ({ value, label: value })),
		context: {
			prompt: "Proceed?",
			stage_state: { multi: opts.multi === true, navigation_label: "Done" },
		},
		created_at: new Date().toISOString(),
		required: true,
	});
	const first = await messages.next("action_needed");
	return {
		harness,
		ws,
		messages,
		calls,
		firstActionId: String(first.id),
		token: harness.endpoint.token,
		restore: async () => {
			ws.close();
			notifyWorkflowGateEmitterChanged(harness.sessionId, undefined);
			await harness.restore();
		},
	};
}

test("unattended out-of-range numeric reply closes the claim and reissues without a success ack", async () => {
	const gate = await startUnattendedGate({ options: ["yes", "no"] });
	try {
		gate.ws.send(JSON.stringify({ type: "reply", id: gate.firstActionId, answer: 99, token: gate.token }));
		const resolved = await gate.messages.next("action_resolved");
		expect(resolved).toMatchObject({ id: gate.firstActionId, resolvedBy: "client" });
		// Invalid-claim closure carries no accepted answer; only genuine resolution does. This
		// pins closeClaimInvalid vs a regression that resolves the claim with answer:99 and reissues.
		expect(resolved.answer).toBeUndefined();
		const reissued = await gate.messages.next("action_needed");
		expect(reissued.id).not.toBe(gate.firstActionId);
		// The invalid numeric selector must never reach durable accept / Selected! ack.
		expect(gate.calls).toHaveLength(0);
		expect(gate.messages.all.some(message => message.type === "ask_selected_ack_request")).toBe(false);
	} finally {
		await gate.restore();
	}
}, 20_000);

test("unattended in-range numeric reply resolves the gate and requests the Selected ack", async () => {
	const gate = await startUnattendedGate({
		options: ["yes", "no"],
		onResolve: async options => {
			await options.requestSelectedAck({
				replyReceiptId: options.replyReceiptId,
				actionId: options.interactionActionId,
				commitKey: "commit-1",
				daemonDeadlineAt: Date.now() + 8_000,
				hostTimeoutMs: 10_000,
			});
			options.resolveClaim();
		},
	});
	try {
		gate.ws.send(JSON.stringify({ type: "reply", id: gate.firstActionId, answer: 0, token: gate.token }));
		const ackRequest = await gate.messages.next("ask_selected_ack_request");
		gate.ws.send(
			JSON.stringify({
				type: "ask_selected_ack_result",
				requestId: ackRequest.requestId,
				commitKey: ackRequest.commitKey,
				outcome: { status: "delivered", messageId: 42 },
			}),
		);
		expect(await gate.messages.next("action_resolved")).toMatchObject({ id: gate.firstActionId });
		expect(gate.calls).toEqual([{ answer: { selected: ["yes"] } }]);
	} finally {
		await gate.restore();
	}
}, 20_000);

test("unattended multi-select out-of-range numeric reply closes the claim and reissues", async () => {
	const gate = await startUnattendedGate({ options: ["a", "b"], multi: true });
	try {
		gate.ws.send(JSON.stringify({ type: "reply", id: gate.firstActionId, answer: 99, token: gate.token }));
		expect(await gate.messages.next("action_resolved")).toMatchObject({ id: gate.firstActionId });
		const reissued = await gate.messages.next("action_needed");
		expect(reissued.id).not.toBe(gate.firstActionId);
		expect(gate.calls).toHaveLength(0);
	} finally {
		await gate.restore();
	}
}, 20_000);

test("unattended stale/replayed out-of-range reply never resolves the gate", async () => {
	const gate = await startUnattendedGate({ options: ["yes", "no"] });
	try {
		// First invalid reply closes claim #1 and reissues action #2.
		gate.ws.send(JSON.stringify({ type: "reply", id: gate.firstActionId, answer: 99, token: gate.token }));
		expect(await gate.messages.next("action_resolved")).toMatchObject({ id: gate.firstActionId });
		const reissued = await gate.messages.next("action_needed");
		expect(reissued.id).not.toBe(gate.firstActionId);
		// Replaying the stale action id (again out of range) must not durably accept anything.
		gate.ws.send(JSON.stringify({ type: "reply", id: gate.firstActionId, answer: 99, token: gate.token }));
		// A fresh valid reply against the reissued action still resolves cleanly.
		gate.ws.send(JSON.stringify({ type: "reply", id: reissued.id, answer: 1, token: gate.token }));
		expect(await gate.messages.next("action_resolved")).toMatchObject({ id: reissued.id });
		expect(gate.calls).toEqual([{ answer: { selected: ["no"] } }]);
	} finally {
		await gate.restore();
	}
}, 20_000);
