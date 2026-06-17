import type {
	CoordinationStatus,
	CoordinatorClient,
	GatewayPreset,
	IncomingCallbackQuery,
	IncomingMessage,
	IncomingUpdate,
	OutgoingReply,
	ReportStatusResult,
	StartSessionResult,
	TelegramTransport,
	WatchEventsInput,
	WatchEventsResult,
} from "../src/types";

export interface RecordedCall {
	method: "getCoordinationStatus" | "startSession" | "reportStatus" | "watchEvents";
	args: unknown;
}

/** In-memory CoordinatorClient that records calls and returns scripted results. */
export class FakeCoordinatorClient implements CoordinatorClient {
	status: CoordinationStatus = { ok: true, sessions: [], sessionStates: [], turns: [] };
	startResult: StartSessionResult = { ok: true, sessionId: "sess-1" };
	reportResult: ReportStatusResult = { ok: true };
	watchScript: WatchEventsResult[] = [];
	calls: RecordedCall[] = [];

	async getCoordinationStatus(): Promise<CoordinationStatus> {
		this.calls.push({ method: "getCoordinationStatus", args: {} });
		return this.status;
	}

	async startSession(input: { cwd: string; prompt?: string }): Promise<StartSessionResult> {
		this.calls.push({ method: "startSession", args: input });
		return this.startResult;
	}

	async reportStatus(input: {
		sessionId: string;
		turnId?: string;
		status: "cancelled";
		summary?: string;
	}): Promise<ReportStatusResult> {
		this.calls.push({ method: "reportStatus", args: input });
		return this.reportResult;
	}

	async watchEvents(input: WatchEventsInput): Promise<WatchEventsResult> {
		this.calls.push({ method: "watchEvents", args: input });
		return this.watchScript.shift() ?? { ok: true, events: [], latestSeq: input.afterSeq, timedOut: false };
	}

	countOf(method: RecordedCall["method"]): number {
		return this.calls.filter(call => call.method === method).length;
	}
}

/** Resolve any reply shape to its observable chat/callback text. */
export function replyText(reply: OutgoingReply | string): string {
	if (typeof reply === "string") return reply;
	if (reply.kind === "chat") return reply.text;
	return reply.callbackAnswer.text ?? "";
}

/** Drives a scripted list of inbound updates through the gateway and records replies. */
export class FakeTransport implements TelegramTransport {
	sent: Array<{ chatId: string | null; reply: OutgoingReply | string; text: string }> = [];
	outbound: Array<{ chatId: string; reply: import("../src/types").ChatReply }> = [];
	sendScript: Array<{ ok: boolean; retryAfterMs?: number }> = [];
	constructor(private readonly inbox: IncomingUpdate[]) {}

	async run(onUpdate: (update: IncomingUpdate) => Promise<OutgoingReply | string>): Promise<void> {
		for (const update of this.inbox) {
			const reply = await onUpdate(update);
			this.sent.push({ chatId: update.chatId, reply, text: replyText(reply) });
		}
	}

	async send(message: {
		chatId: string;
		reply: import("../src/types").ChatReply;
	}): Promise<{ ok: boolean; retryAfterMs?: number }> {
		this.outbound.push(message);
		return this.sendScript.shift() ?? { ok: true };
	}

	stop(): void {}
}

export function preset(overrides: Partial<GatewayPreset> = {}): GatewayPreset {
	return {
		id: "demo",
		workdir: "/home/bot/src/project",
		sessionCommand: "gjc --worktree",
		taskTemplate: "Work on this task: {{task}}",
		taskMaxLen: 100,
		...overrides,
	};
}

export function presetMap(...presets: GatewayPreset[]): Map<string, GatewayPreset> {
	return new Map(presets.map(item => [item.id, item]));
}

export function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return { userId: "100", chatId: "100", text: "/help", ...overrides, kind: "message" };
}

export function callback(overrides: Partial<IncomingCallbackQuery> = {}): IncomingCallbackQuery {
	return {
		userId: "100",
		chatId: "100",
		messageId: 1,
		callbackQueryId: "cb-1",
		data: "gtr:v1:placeholder",
		...overrides,
		kind: "callback_query",
	};
}
