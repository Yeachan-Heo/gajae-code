/**
 * Runnable safety smoke for the Telegram Remote gateway. Drives adversarial text
 * messages AND inline-keyboard callbacks through the gateway with an in-memory
 * coordinator (no bot token, no network, no real session backend) and asserts the
 * v0 + rich-message safety invariants hold. Prints a single deterministic line on
 * success so it can be replayed as CLI evidence; throws (non-zero exit) on any
 * violation.
 *
 *   bun packages/telegram-remote/examples/safety-smoke.ts
 */
import { unlink } from "node:fs/promises";
import type { AgentMessage } from "@gajae-code/agent-core";
import { TelegramRemoteGateway } from "../src/gateway";
import { UNAUTHORIZED_REFUSAL } from "../src/messages";
import { TelegramRemoteNotifier } from "../src/notifier";
import { RpcAttachmentStore } from "../src/rpc-attachment-store";
import { FakeRpcBackend } from "../src/rpc-backend";
import { TelegramRpcGateway } from "../src/rpc-gateway";
import { SubscriptionStore } from "../src/subscriptions";
import type {
	ChatReply,
	CoordinationStatus,
	CoordinatorClient,
	IncomingCallbackQuery,
	IncomingMessage,
	OutgoingReply,
	ReportStatusResult,
	StartSessionResult,
	TelegramInlineKeyboardButton,
	WatchEventsInput,
	WatchEventsResult,
} from "../src/types";

const HOSTILE_STATUS: CoordinationStatus = {
	ok: true,
	sessions: [
		{
			session_id: "sess-1",
			branch: "feat/x",
			repo: "proj",
			cwd: "/secret/abs/path",
			tail_preview: ["SECRET_TAIL", "export TOKEN=sk-LEAK"],
			final_response: { text: "TRANSCRIPT_LEAK" },
		},
	],
	sessionStates: [{ session_id: "sess-1", state: "running", live: true, reason: "INTERNAL_LEAK" }],
	turns: [{ session_id: "sess-1", status: "active", turn_id: "turn-1", prompt: { text: "PROMPT_LEAK" } }],
};

const FORBIDDEN = ["SECRET_TAIL", "sk-LEAK", "TRANSCRIPT_LEAK", "PROMPT_LEAK", "/secret/abs/path"];

// Long, punctuation-heavy raw coordinator id that must survive unchanged through
// tokens/coordinator calls but never appear in callback_data or chat text.
const LONG_ID = `sess:gjc/feat-x&<unsafe>${"z".repeat(50)}`;

class SmokeCoordinator implements CoordinatorClient {
	startCalls = 0;
	reportCalls = 0;
	lastStartCwd = "";
	lastReportSessionId = "";
	constructor(private readonly status: CoordinationStatus) {}
	async getCoordinationStatus(): Promise<CoordinationStatus> {
		return this.status;
	}
	async watchEvents(input: WatchEventsInput): Promise<WatchEventsResult> {
		return { ok: true, events: [], latestSeq: input.afterSeq, timedOut: true };
	}
	async startSession(input: { cwd: string; prompt?: string }): Promise<StartSessionResult> {
		this.startCalls++;
		this.lastStartCwd = input.cwd;
		return { ok: true, sessionId: "sess-new" };
	}
	async reportStatus(input: { sessionId: string }): Promise<ReportStatusResult> {
		this.reportCalls++;
		this.lastReportSessionId = input.sessionId;
		return { ok: true };
	}
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`safety-smoke failed: ${message}`);
}

function asChat(reply: OutgoingReply): Extract<OutgoingReply, { kind: "chat" }> {
	assert(reply.kind === "chat", `expected chat reply, got ${reply.kind}`);
	return reply as Extract<OutgoingReply, { kind: "chat" }>;
}

function buttons(reply: OutgoingReply): TelegramInlineKeyboardButton[] {
	const chat = asChat(reply);
	return (chat.replyMarkup?.inline_keyboard ?? []).flat();
}

const msg = (userId: string, text: string): IncomingMessage => ({ kind: "message", userId, chatId: userId, text });
const cb = (userId: string, chatId: string, data: string): IncomingCallbackQuery => ({
	kind: "callback_query",
	userId,
	chatId,
	messageId: 1,
	callbackQueryId: "cb",
	data,
});

function richGateway(coordinator: CoordinatorClient): TelegramRemoteGateway {
	return new TelegramRemoteGateway(
		{
			allowedUserIds: new Set(["100"]),
			allowedChatIds: new Set(),
			presets: new Map([
				[
					"demo",
					{ id: "demo", workdir: "/home/bot/src/project", sessionCommand: "gjc --worktree", taskMaxLen: 50 },
				],
			]),
			enableStop: true,
			enableRichMessages: true,
		},
		{ coordinator },
	);
}

async function plainInvariants(): Promise<void> {
	const coordinator = new SmokeCoordinator(HOSTILE_STATUS);
	const gateway = richGateway(coordinator);

	// 1. Default deny: an intruder gets the identical boring refusal and no backend call.
	for (const text of ["/sessions", "/start-session demo x", "/stop sess-1 confirm"]) {
		assert((await gateway.handleMessage(msg("999", text))) === UNAUTHORIZED_REFUSAL, `intruder refused: ${text}`);
	}
	assert(coordinator.startCalls === 0 && coordinator.reportCalls === 0, "intruder triggered no mutation");

	// 2. Redaction: hostile coordinator fields never reach chat (plain or HTML).
	const listed = await gateway.handleMessage(msg("100", "/sessions"));
	const observed = await gateway.handleMessage(msg("100", "/observe sess-1"));
	for (const secret of FORBIDDEN) {
		assert(!listed.includes(secret), `list leaked ${secret}`);
		assert(!observed.includes(secret), `observe leaked ${secret}`);
	}

	// 3. Workdir injection: chat-supplied path never becomes the cwd.
	await gateway.handleMessage(msg("100", "/start-session demo /etc/shadow"));
	assert(coordinator.lastStartCwd === "/home/bot/src/project", "workdir bound to preset, not chat");

	// 4. Text /stop confirmation gating: arm does not mutate; only confirm does.
	await gateway.handleMessage(msg("100", "/stop sess-1"));
	assert(coordinator.reportCalls === 0, "arm did not mutate");
	await gateway.handleMessage(msg("100", "/stop sess-1 confirm"));
	assert(coordinator.reportCalls === 1, "confirm recorded exactly one cancel");
}

async function richCallbackInvariants(): Promise<void> {
	const status: CoordinationStatus = {
		ok: true,
		sessions: [{ session_id: LONG_ID, branch: "main", cwd: "/secret/abs/path" }],
		sessionStates: [{ session_id: LONG_ID, state: "running", live: true }],
		turns: [{ session_id: LONG_ID, status: "active", turn_id: "turn-x" }],
	};
	const coordinator = new SmokeCoordinator(status);
	const gateway = richGateway(coordinator);

	// 5. Rich /sessions: HTML + inline keyboard; callback_data is opaque and bounded.
	const sessions = asChat(await gateway.handleUpdate(msg("100", "/sessions")));
	assert(sessions.parseMode === "HTML", "rich /sessions is HTML");
	assert(!sessions.text.includes(LONG_ID), "raw id not in rendered text");
	const observeBtn = buttons(sessions).find(b => b.text.startsWith("Observe"));
	const stopBtn = buttons(sessions).find(b => b.text.startsWith("Stop"));
	assert(!!observeBtn && !!stopBtn, "observe + stop buttons present");
	for (const b of buttons(sessions)) {
		assert(Buffer.byteLength(b.callbackData, "utf8") <= 64, "callback_data <=64 bytes");
		assert(!b.callbackData.includes(LONG_ID), "callback_data never contains the raw id");
	}

	// 6. Observe callback: reuses read path, renders the exact-raw-id view, leaks nothing.
	const observed = asChat(
		await gateway.handleUpdate(cb("100", "100", (observeBtn as TelegramInlineKeyboardButton).callbackData)),
	);
	assert(observed.text.includes("status:"), "observe callback renders the view");
	for (const secret of FORBIDDEN) assert(!observed.text.includes(secret), `observe callback leaked ${secret}`);

	// 7. Stop arm -> confirm: exact raw id reaches the coordinator unchanged.
	const arm = asChat(
		await gateway.handleUpdate(cb("100", "100", (stopBtn as TelegramInlineKeyboardButton).callbackData)),
	);
	assert(coordinator.reportCalls === 0, "stop arm did not mutate");
	const confirmBtn = buttons(arm).find(b => b.text === "Confirm stop");
	assert(!!confirmBtn, "confirm button present");
	await gateway.handleUpdate(cb("100", "100", (confirmBtn as TelegramInlineKeyboardButton).callbackData));
	assert(coordinator.reportCalls === 1, "confirm recorded exactly one cancel");
	assert(coordinator.lastReportSessionId === LONG_ID, "coordinator received the EXACT raw id");

	// 8. Replay: a second confirm press is single-use and does not double-mutate.
	const replay = await gateway.handleUpdate(
		cb("100", "100", (confirmBtn as TelegramInlineKeyboardButton).callbackData),
	);
	assert(replay.kind === "callback_answer", "replayed confirm is answer-only");
	assert(coordinator.reportCalls === 1, "replay did not double-mutate");

	// 9. Unauthorized / forwarded callback: answer-only refusal, no backend call.
	const fresh = asChat(await gateway.handleUpdate(msg("100", "/sessions")));
	const freshObserve = buttons(fresh).find(b => b.text.startsWith("Observe")) as TelegramInlineKeyboardButton;
	const before = coordinator.reportCalls;
	const intruder = await gateway.handleUpdate(cb("999", "999", freshObserve.callbackData));
	assert(intruder.kind === "callback_answer", "unauthorized callback is answer-only");
	assert(
		intruder.kind === "callback_answer" && intruder.callbackAnswer.text === UNAUTHORIZED_REFUSAL,
		"boring refusal",
	);
	assert(coordinator.reportCalls === before, "unauthorized callback triggered no mutation");
}

async function pushNotifierInvariants(): Promise<void> {
	const store = await SubscriptionStore.load({ filePath: `/tmp/gtr-smoke-${process.pid}.json`, now: () => 1_000_000 });
	const status: CoordinationStatus = {
		ok: true,
		sessions: [{ session_id: "sess-1", branch: "safe", cwd: "/secret/abs/path", tail_preview: "SECRET_TAIL" }],
		sessionStates: [{ session_id: "sess-1", state: "blocked", live: true, reason: "blocked" }],
		turns: [{ session_id: "sess-1", status: "waiting_for_answer", prompt: "PROMPT_LEAK" }],
	};
	const coordinator = new SmokeCoordinator(status);
	const gateway = new TelegramRemoteGateway(
		{
			allowedUserIds: new Set(["100"]),
			allowedChatIds: new Set(),
			presets: new Map(),
			enableStop: true,
			enableRichMessages: true,
			enablePush: true,
		},
		{ coordinator, subscriptions: store },
	);
	const sessions = asChat(await gateway.handleUpdate(msg("100", "/sessions")));
	const follow = buttons(sessions).find(b => b.text.startsWith("Follow"));
	assert(!!follow, "follow button present when push enabled");
	await gateway.handleUpdate(cb("100", "100", (follow as TelegramInlineKeyboardButton).callbackData));
	assert((await store.followers("sess-1")).length === 1, "follow persisted");
	const denied = await gateway.handleUpdate(cb("999", "999", (follow as TelegramInlineKeyboardButton).callbackData));
	assert(denied.kind === "callback_answer", "unauthorized follow default-denied");

	const sends: Array<{ chatId: string; reply: ChatReply }> = [];
	const sleeps: number[] = [];
	let first = true;
	const notifier = new TelegramRemoteNotifier({
		coordinator: {
			getCoordinationStatus: () => coordinator.getCoordinationStatus(),
			watchEvents: async input => ({
				ok: true,
				events:
					input.afterSeq === 0 ? [{ seq: 1, kind: "session.state_changed", sessionId: "sess-1" } as never] : [],
				latestSeq: 999,
				timedOut: false,
			}),
			reportStatus: input => coordinator.reportStatus(input),
			startSession: input => coordinator.startSession(input),
		},
		outbound: {
			send: async message => {
				sends.push(message);
				if (first) {
					first = false;
					return { ok: false, retryAfterMs: 429 };
				}
				return { ok: true };
			},
		},
		subscriptions: store,
		renderCard: (raw, view, sub) =>
			gateway.renderNotificationCard(raw, view, { chatId: sub.chatId, userId: sub.userId }),
		sleep: async ms => {
			sleeps.push(ms);
		},
	});
	await (notifier as unknown as { pollDrain(timeoutMs: number): Promise<boolean> }).pollDrain(1);
	assert(store.getCursor() === 1, "watch_events backlog advanced through returned seq");
	assert(sleeps.includes(429), "429 retry_after slept before digest retry");
	const rendered = JSON.stringify(sends);
	for (const secret of FORBIDDEN) assert(!rendered.includes(secret), `push leaked ${secret}`);
	assert(!rendered.includes(LONG_ID), "raw id absent from push smoke output");
}

type RpcSend = { chatId: string; reply: ChatReply };
type WorkflowGate = Parameters<FakeRpcBackend["emitWorkflowGate"]>[0];

function rpcGateway(deps: {
	backend: FakeRpcBackend;
	store: RpcAttachmentStore;
	sends: RpcSend[];
	send?: (message: RpcSend) => Promise<{ ok: boolean; retryAfterMs?: number }>;
	now?: () => number;
}): TelegramRpcGateway {
	return new TelegramRpcGateway(
		{
			allowedUserIds: new Set(["100"]),
			allowedChatIds: new Set(),
			defaultSocketPath: "/tmp/whatever.sock",
			allowAttachSocketArg: false,
		},
		{
			backend: deps.backend,
			attachments: deps.store,
			outbound: {
				send:
					deps.send ??
					(async message => {
						deps.sends.push(message);
						return { ok: true };
					}),
			},
			now: deps.now ?? (() => 1_000_000),
		},
	);
}

function rpcStorePath(label: string): string {
	return `/tmp/gtr-rpc-smoke-${process.pid}-${label}.json`;
}

async function loadRpcStore(label: string): Promise<RpcAttachmentStore> {
	const filePath = rpcStorePath(label);
	await unlink(filePath).catch(() => undefined);
	return RpcAttachmentStore.load({ filePath });
}

function assertNoRpcMutation(backend: FakeRpcBackend, message: string): void {
	assert(backend.countOf("prompt") === 0 && backend.countOf("steer") === 0, message);
}

function assertNoForbiddenLeak(text: string, label: string): void {
	for (const secret of FORBIDDEN) assert(!text.includes(secret), `${label} leaked ${secret}`);
	assert(!text.includes("HOSTILE<&>ID"), `${label} leaked hostile id`);
}

async function flushRpc(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

function assistantMessage(message: Record<string, unknown>): AgentMessage {
	return message as unknown as AgentMessage;
}

async function rpcInvariants(): Promise<void> {
	const cleanupPaths: string[] = [];
	try {
		const store = await loadRpcStore("main");
		cleanupPaths.push(rpcStorePath("main"));
		const backend = new FakeRpcBackend();
		const sends: RpcSend[] = [];
		const gateway = rpcGateway({ backend, store, sends });

		for (const command of ["/sessions", "/observe x", "/presets", "/start-session demo x", "/stop x"]) {
			const reply = asChat(await gateway.handleUpdate(msg("100", command)));
			assert(
				reply.text === "Unknown command. Send /help for the command set.",
				`RPC rejected coordinator command: ${command}`,
			);
		}
		assertNoRpcMutation(backend, "RPC coordinator browsing did not prompt/steer");

		const intruderStore = await loadRpcStore("intruder");
		cleanupPaths.push(rpcStorePath("intruder"));
		const intruderBackend = new FakeRpcBackend();
		const intruderSends: RpcSend[] = [];
		const intruderGateway = rpcGateway({ backend: intruderBackend, store: intruderStore, sends: intruderSends });
		assert(
			asChat(await intruderGateway.handleUpdate(msg("999", "/attach"))).text === UNAUTHORIZED_REFUSAL,
			"intruder attach refused",
		);
		assert(
			asChat(await intruderGateway.handleUpdate(msg("999", "hello"))).text === UNAUTHORIZED_REFUSAL,
			"intruder text refused",
		);
		const intruderCallback = await intruderGateway.handleUpdate(cb("999", "999", "gtr:v1:opaque"));
		assert(intruderCallback.kind === "callback_answer", "intruder callback answer-only");
		assert(
			intruderCallback.kind === "callback_answer" && intruderCallback.callbackAnswer.text === UNAUTHORIZED_REFUSAL,
			"intruder callback boring refusal",
		);
		assert(intruderBackend.calls.length === 0, "intruder triggered zero backend operations");

		await gateway.handleUpdate(msg("100", "/attach"));
		const hostileGate: WorkflowGate = {
			type: "workflow_gate",
			gate_id: "HOSTILE<&>ID",
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string" },
			schema_hash: "hash",
			context: { title: "HOSTILE<&>ID", prompt: "Approve HOSTILE<&>ID?" },
			options: [{ label: "Approve HOSTILE<&>ID", value: "HOSTILE<&>ID" }],
			created_at: "2026-06-16T00:00:00Z",
			required: true,
		};
		backend.emitWorkflowGate(hostileGate);
		await flushRpc();
		const gateSend = sends.find(send => send.reply.replyMarkup?.inline_keyboard.flat().length);
		assert(!!gateSend, "workflow gate rendered a button");
		for (const button of gateSend!.reply.replyMarkup!.inline_keyboard.flat()) {
			assert(button.callbackData.startsWith("gtr:v1:"), "RPC callback_data is opaque token");
			assert(Buffer.byteLength(button.callbackData, "utf8") <= 64, "RPC callback_data <=64 bytes");
			assert(!button.callbackData.includes("HOSTILE<&>ID"), "RPC callback_data excludes hostile id");
		}

		const beforeFinal = sends.length;
		const finalText = `<script>&" ${"x".repeat(8200)}`;
		backend.messages = [
			assistantMessage({
				role: "assistant",
				content: finalText,
				index: 1,
				turnId: "turn-final",
				timestamp: "2026-06-16T00:00:00Z",
			}),
		];
		backend.emitEvent({ type: "turn_end" });
		await flushRpc();
		const finalSends = sends.slice(beforeFinal);
		assert(finalSends.length >= 2, "long final answer chunked");
		const renderedFinal = finalSends.map(send => send.reply.text).join("\n");
		assert(!renderedFinal.includes("<script>"), "final answer HTML escaped script tag");
		assert(
			renderedFinal.includes("&lt;script&gt;") && renderedFinal.includes("&amp;"),
			"final answer contains HTML entities",
		);
		for (const send of finalSends) {
			assert(Buffer.byteLength(send.reply.text, "utf8") <= 4096, "final chunk <=4096 bytes");
			assertNoForbiddenLeak(send.reply.text, "RPC final answer");
		}

		const failStore = await loadRpcStore("fail");
		cleanupPaths.push(rpcStorePath("fail"));
		const failBackend = new FakeRpcBackend();
		const failSends: RpcSend[] = [];
		let failFirst = true;
		const failGateway = rpcGateway({
			backend: failBackend,
			store: failStore,
			sends: failSends,
			send: async message => {
				failSends.push(message);
				if (failFirst) {
					failFirst = false;
					return { ok: false, retryAfterMs: 1000 };
				}
				return { ok: true };
			},
		});
		await failGateway.handleUpdate(msg("100", "/attach"));
		failBackend.messages = [assistantMessage({ role: "assistant", content: "failed chunk", index: 1 })];
		failBackend.emitEvent({ type: "turn_end" });
		await flushRpc();
		assert(
			failSends.some(send => send.reply.text.includes("Final answer delivery paused")),
			"failed chunk visible",
		);
		assert(!!failStore.get()?.chunkProgress?.failedAt, "failed chunk progress persisted");
		await failGateway.handleUpdate(msg("100", "/detach"));

		const beforeDetach = sends.length;
		await gateway.handleUpdate(msg("100", "/detach"));
		backend.messages = [assistantMessage({ role: "assistant", content: "after detach", index: 2 })];
		backend.emitEvent({ type: "turn_end" });
		await flushRpc();
		assert(sends.length === beforeDetach, "detach suppresses later delivery");

		const replayStore = await loadRpcStore("replay");
		cleanupPaths.push(rpcStorePath("replay"));
		const replayBackend = new FakeRpcBackend();
		const replaySends: RpcSend[] = [];
		replayBackend.pendingWorkflowGates = [hostileGate];
		// Seed a persisted non-stale attachment so restorePersistedAttachment exercises the real
		// startup restore path (allowlist re-check + reconnect + pending-gate replay), not /attach.
		await replayStore.set({
			chatId: "100",
			userId: "100",
			socketPath: "/tmp/whatever.sock",
			stale: false,
			pendingGateIds: [],
			deliveryIdentities: [],
			updatedAt: 1_000_000,
		});
		const replayGateway = rpcGateway({ backend: replayBackend, store: replayStore, sends: replaySends });
		await replayGateway.restorePersistedAttachment();
		await flushRpc();
		assert(replayBackend.countOf("connect") === 1, "restore reconnected to the persisted socket");
		assert(
			replaySends.some(send => send.reply.replyMarkup?.inline_keyboard.flat().length),
			"pending gate replay rendered button on restore",
		);
		await replayGateway.handleUpdate(msg("100", "/detach"));
		process.stdout.write("telegram-remote-rpc-safety-ok\n");
	} finally {
		await Promise.all(cleanupPaths.map(path => unlink(path).catch(() => undefined)));
	}
}

async function main(): Promise<void> {
	await plainInvariants();
	await richCallbackInvariants();
	await pushNotifierInvariants();
	await rpcInvariants();
	process.stdout.write("telegram-remote-safety-ok\n");
}

await main();
