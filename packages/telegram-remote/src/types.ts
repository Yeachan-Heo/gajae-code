/**
 * Shared domain types for the Telegram Remote gateway.
 *
 * Tracks docs/telegram-remote.md. The gateway is a thin command + bounded-read
 * surface over the Coordinator MCP. Nothing here imports coding-agent internals;
 * the only contract with the coordinator is the {@link CoordinatorClient} port.
 *
 * Rich messaging (inline keyboards, callback queries, HTML formatting) is a
 * presentation + alternate-entry layer only: it widens the transport/reply
 * contract but never the action surface or the transmitted-data allowlist.
 */

/** Opaque coordinator record. The gateway never trusts or forwards raw fields. */
export type RawRecord = Record<string, unknown>;

/**
 * A named, server-side session preset. Never assembled from chat input.
 * `workdir` and `sessionCommand` are fixed bindings; the only chat-supplied
 * value is a single length-capped task string injected into `taskTemplate`.
 */
export interface GatewayPreset {
	/** The only preset reference a chat user may name. */
	id: string;
	/** Optional display name; chat-safe when trimmed, falls back to id. */
	name?: string;
	/** Fixed workdir; must be inside the coordinator workdir allowlist. */
	workdir: string;
	/** Fixed session command (e.g. `gjc --worktree`). Enforced coordinator-side. */
	sessionCommand: string;
	/** Optional fixed template with exactly one `{{task}}` slot. */
	taskTemplate?: string;
	/** Hard length cap on the chat-supplied task string. */
	taskMaxLen: number;
}

/** Bounded session status enum that may leave the PC into chat. */
export type SessionStatus = "working" | "waiting_for_input" | "blocked" | "done" | "failed" | "cancelled" | "dead";
export type SessionFilter = "live" | "blocked" | "done" | "all";

/** Bounded turn-lifecycle enum that may leave the PC into chat. */
export type TurnActivity = "none" | "queued" | "active" | "waiting_for_answer" | "terminal";

/** Allowlisted session-list projection. Only these fields may reach chat. */
export interface SessionSummary {
	sessionId: string;
	name: string;
	status: SessionStatus;
	branch: string | null;
	lastActivityAt: string | null;
}

/** Allowlisted open-session projection. Only these fields may reach chat. */
export interface SessionView extends SessionSummary {
	activeTurn: TurnActivity;
	/** Short sanitized reason when blocked; null when not blocked or withheld. */
	blockerSummary: string | null;
}

/** Parsed command vocabulary. Everything outside this set is `unknown`. */
export type ParsedCommand =
	| { kind: "help" }
	| { kind: "start" }
	| { kind: "sessions"; query: string | null }
	| { kind: "observe"; sessionId: string | null }
	| { kind: "presets" }
	| { kind: "start_session"; presetId: string | null; task: string | null }
	| { kind: "stop"; sessionId: string | null; confirm: boolean }
	| { kind: "attach"; socketPath: string | null }
	| { kind: "detach" }
	| { kind: "status" }
	| { kind: "abort" }
	| { kind: "unknown" };

// --- RPC backend skeleton contract ---

export type TelegramRemoteBackend = "coordinator" | "rpc";

export interface RpcBackendConfig {
	socketPath: string;
	stateDir: string;
	livenessMs: number;
	allowAttachSocketArg: boolean;
}

export type RpcControlState =
	| "detached"
	| "connecting"
	| "attached_idle"
	| "attached_turn_active"
	| "waiting_for_ui"
	| "control_pending_abort_and_prompt"
	| "reconnecting"
	| "stale";

export interface RpcDeliveryIdentity {
	turnId?: string;
	messageIndex?: number;
	timestamp?: string;
	role: "assistant";
	contentHash: string;
	fallback?: boolean;
}

export interface RpcChunkProgress {
	deliveryId: string;
	nextChunkIndex: number;
	chunkCount: number;
	failedAt?: number;
}

export interface RpcLivenessState {
	lastSeenAt: number;
	timeoutMs: number;
}

export interface AttachmentRecord {
	chatId: string;
	userId: string | null;
	socketPath: string;
	stale: boolean;
	controllerState?: RpcControlState;
	liveness?: RpcLivenessState;
	pendingGateIds: string[];
	deliveryIdentities: RpcDeliveryIdentity[];
	chunkProgress?: RpcChunkProgress;
	updatedAt: number;
}

export interface RpcBackendState {
	connected: boolean;
	socketPath: string;
	session?: unknown;
}

export interface RpcBackendPort {
	connect(socketPath?: string): Promise<void>;
	close(): Promise<void>;
	getState(): Promise<RpcBackendState>;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
	abortAndPrompt(message: string): Promise<void>;
	respondExtensionUi?(response: unknown): void;
	respondGate?(gateId: string, answer: unknown, idempotencyKey?: string): Promise<unknown>;
	getPendingWorkflowGates?(): Promise<unknown[]>;
	getMessages?(): Promise<unknown[]>;
	getLastAssistantText?(): Promise<string | null>;
	onExtensionUiRequest?(listener: (request: unknown) => void): () => void;
	onWorkflowGate?(listener: (gate: unknown) => void): () => void;
	onEvents?(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
	onTransportError?(listener: (error: Error) => void): () => void;
	onCommandIgnored?(listener: (error: Error) => void): () => void;
}

// --- Rich messaging contract (presentation layer only) ---

/** Only HTML parse mode is supported; escaping is simpler and safer than MarkdownV2. */
export type TelegramParseMode = "HTML";

/** One inline-keyboard button. `callbackData` is always an opaque `gtr:v1:<token>`. */
export interface TelegramInlineKeyboardButton {
	text: string;
	callbackData: string;
}

/** Inline keyboard markup (rows of buttons). */
export interface TelegramInlineKeyboardMarkup {
	inline_keyboard: TelegramInlineKeyboardButton[][];
}

/** The toast/alert shown on a callback button press. Never leaks internal reasons. */
export interface CallbackAnswer {
	text?: string;
	showAlert?: boolean;
}

/** A reply that sends (or edits) a chat message; may also answer a callback. */
export interface ChatReply {
	kind: "chat";
	text: string;
	parseMode?: TelegramParseMode;
	replyMarkup?: TelegramInlineKeyboardMarkup;
	edit?: { messageId: string | number };
	callbackAnswer?: CallbackAnswer;
}

/**
 * A callback-only reply: answer the callback, send no chat message. The guardrail
 * for unauthorized/expired/malformed/missing-chat/used/cancel callbacks.
 */
export interface CallbackAnswerOnlyReply {
	kind: "callback_answer";
	callbackAnswer: CallbackAnswer;
	sendMessage: false;
}

export type OutgoingReply = ChatReply | CallbackAnswerOnlyReply;

/** A normalized inbound text message. */
export interface IncomingTextMessage {
	kind: "message";
	/** Telegram user id; null when not present (e.g. channel posts). */
	userId: string | null;
	/** Telegram chat id the reply must be sent to. */
	chatId: string;
	/** Raw message text. */
	text: string;
}

/** A normalized inbound callback-query (inline-keyboard button press). */
export interface IncomingCallbackQuery {
	kind: "callback_query";
	userId: string | null;
	/** Chat id of the message the button belongs to; null when unavailable. */
	chatId: string | null;
	messageId: string | number | null;
	callbackQueryId: string;
	/** Opaque callback payload, validated as a string <=64 bytes by the transport. */
	data: string;
}

export type IncomingUpdate = IncomingTextMessage | IncomingCallbackQuery;

/** Back-compat alias: the text-message shape used by older call sites/tests. */
export type IncomingMessage = IncomingTextMessage;

/** Result of reading bounded coordination state. */
export interface CoordinationStatus {
	ok: boolean;
	/** Failure reason when `ok` is false (e.g. `coordinator_unreachable`). */
	reason?: string;
	sessions: RawRecord[];
	sessionStates: RawRecord[];
	turns: RawRecord[];
}

/** Result of a preset-bound session start. */
export interface StartSessionResult {
	ok: boolean;
	reason?: string;
	sessionId?: string;
}

/** Result of recording a coordinator report (used for `/stop`). */
export interface ReportStatusResult {
	ok: boolean;
	reason?: string;
}

/** Hostile coordinator event reduced to routing-only fields. */
export interface CoordinatorRoutingEvent {
	seq: number;
	kind: string;
	sessionId: string | null;
}

export interface WatchEventsInput {
	afterSeq: number;
	sessionId?: string;
	eventTypes?: string[];
	timeoutMs?: number;
	limit?: number;
}

export interface WatchEventsResult {
	ok: boolean;
	reason?: string;
	events: CoordinatorRoutingEvent[];
	latestSeq: number;
	timedOut: boolean;
}

/**
 * The only contract the gateway has with the session backend. Both text commands
 * and inline-keyboard callbacks map onto these same bounded operations; the MCP
 * stdio client and test fakes both implement this port. No callback-specific
 * control path or coordinator tool is introduced.
 */
export interface CoordinatorClient {
	/** Bounded, redaction-friendly cross-session read. Never raw tail/scrollback. */
	getCoordinationStatus(): Promise<CoordinationStatus>;
	/** Preset-bound creation. Only `cwd` (+ optional templated prompt) crosses. */
	startSession(input: { cwd: string; prompt?: string }): Promise<StartSessionResult>;
	/** Records a terminal coordinator status (used for graceful `/stop`). */
	reportStatus(input: {
		sessionId: string;
		turnId?: string;
		status: "cancelled";
		summary?: string;
	}): Promise<ReportStatusResult>;
	/** Watches hostile raw coordinator events, exposing only routing fields. */
	watchEvents?(input: WatchEventsInput): Promise<WatchEventsResult>;
	/** Release any underlying process. Optional for in-memory implementations. */
	close?(): Promise<void>;
}

/** Telegram transport port. The real adapter long-polls the Bot API. */
export interface TelegramTransport {
	/** Run the receive loop, replying with the handler's returned reply. */
	run(onUpdate: (update: IncomingUpdate) => Promise<OutgoingReply | string>): Promise<void>;
	/** Stop the receive loop. */
	stop(): void;
	/** Optional outbound send port for notifier-driven messages. */
	send?(message: { chatId: string; reply: ChatReply }): Promise<{ ok: boolean; retryAfterMs?: number }>;
}
