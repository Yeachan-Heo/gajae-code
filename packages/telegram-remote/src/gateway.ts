/**
 * The Telegram Remote gateway core. Maps the fixed command vocabulary AND inline
 * keyboard callbacks onto the {@link CoordinatorClient} port under default-deny
 * authorization, redacted projection, fail-closed mutation handling, and explicit
 * `/stop` confirmation.
 *
 * Rich messaging is a presentation + alternate-entry layer: callbacks reuse the
 * same handlers/coordinator calls as text commands (no second control path), and
 * the transmitted-data allowlist is unchanged. {@link TelegramRemoteGateway.handleUpdate}
 * is the primary entry; {@link TelegramRemoteGateway.handleMessage} is a thin
 * text-only compatibility wrapper.
 */
import { parseCommand } from "./commands";
import { MESSAGES } from "./messages";
import { presetName, resolvePreset } from "./presets";
import {
	activeTurnId,
	escapeHtml,
	findSessionView,
	formatRelativeTime,
	isTerminalStatus,
	isWithinRetention,
	projectSessionRows,
	projectSessionSummaries,
	renderSessionsList,
	renderSessionsListHtml,
	renderSessionView,
	renderSessionViewHtml,
} from "./projection";
import type { SubscriptionStore } from "./subscriptions";
import {
	type CallbackTokenRecord,
	CallbackTokenStore,
	type ListCallbackAction,
	type PresetCallbackAction,
	type SessionCallbackAction,
} from "./tokens";
import type {
	CallbackAnswerOnlyReply,
	ChatReply,
	CoordinationStatus,
	CoordinatorClient,
	GatewayPreset,
	IncomingCallbackQuery,
	IncomingMessage,
	IncomingTextMessage,
	IncomingUpdate,
	OutgoingReply,
	SessionFilter,
	SessionStatus,
	SessionView,
	TelegramInlineKeyboardButton,
	TelegramInlineKeyboardMarkup,
} from "./types";

const DEFAULT_CONFIRM_TTL_MS = 120_000;
const PAGE_SIZE = 8;
const DEFAULT_RICH_TTL_MS = 600_000;
const BUTTON_NAME_MAX = 40;
const STOP_SUMMARY = "Operator requested graceful stop via Telegram remote.";
const MAX_PENDING_PRESET_TASKS = 200;

/** Authorization + preset + rich-UI policy the gateway enforces. */
export interface GatewayPolicy {
	allowedUserIds: ReadonlySet<string>;
	allowedChatIds: ReadonlySet<string>;
	presets: ReadonlyMap<string, GatewayPreset>;
	/** When false, `/stop` is refused as disabled (no `reports` mutation). */
	enableStop: boolean;
	/** How long a `/stop` arm (text or button) stays valid before re-confirmation. */
	confirmTtlMs?: number;
	/** Enable HTML formatting + inline keyboards. Default false (plain v0 baseline). */
	enableRichMessages?: boolean;
	/** TTL for observe/refresh/arm buttons. Default 600_000. */
	richCallbackTtlMs?: number;
	/** Max in-memory callback tokens. Default 500. */
	richCallbackMaxTokens?: number;
	/** Enable proactive Follow/Mute push controls. Default false. */
	enablePush?: boolean;
}

/** Runtime dependencies for the gateway. */
export interface GatewayDeps {
	coordinator: CoordinatorClient;
	/** Injectable clock for deterministic confirmation-expiry tests. */
	now?: () => number;
	subscriptions?: SubscriptionStore;
}

type CallbackContext = { chatId: string; userId: string | null };

/** Map a coordinator failure reason onto a boring, safe chat message. */
function mapReason(reason: string | undefined): string {
	if (!reason) return MESSAGES.genericFailure;
	if (reason.startsWith("coordinator_mutation_class_disabled")) return MESSAGES.sessionControlDisabled;
	if (reason.startsWith("coordinator_mutation_call_not_allowed")) return MESSAGES.sessionControlNotPermitted;
	if (reason === "unknown_session") return MESSAGES.unknownSession;
	if (reason === "active_turn_exists") return MESSAGES.activeTurnExists;
	if (reason === "coordinator_unreachable" || reason === "offline") return MESSAGES.backendOffline;
	return MESSAGES.genericFailure;
}

export class TelegramRemoteGateway {
	private readonly policy: GatewayPolicy;
	private readonly coordinator: CoordinatorClient;
	private readonly now: () => number;
	private readonly tokens: CallbackTokenStore;
	private readonly subscriptions?: SubscriptionStore;
	/** Pending text `/stop` confirmations keyed by `${chatId}:${sessionId}` → expiry ms. */
	private readonly pendingStops = new Map<string, number>();
	private readonly pendingPresetTasks = new Map<string, { presetId: string; expiresAt: number }>();

	constructor(policy: GatewayPolicy, deps: GatewayDeps) {
		this.policy = policy;
		this.coordinator = deps.coordinator;
		this.now = deps.now ?? Date.now;
		this.subscriptions = deps.subscriptions;
		this.tokens = new CallbackTokenStore({ now: this.now, maxTokens: policy.richCallbackMaxTokens });
	}

	/** Primary entry: handle a text message or an inline-keyboard callback. */
	async handleUpdate(update: IncomingUpdate): Promise<OutgoingReply> {
		if (update.kind === "callback_query") return this.handleCallback(update);
		if (!this.isAuthorized(update.userId, update.chatId)) return this.chat(MESSAGES.unauthorized);
		return this.dispatchText(update);
	}

	/** Text-only compatibility wrapper returning the reply text. */
	async handleMessage(message: IncomingMessage): Promise<string> {
		const reply = await this.handleUpdate(message);
		return reply.kind === "chat" ? reply.text : (reply.callbackAnswer.text ?? "");
	}

	private async dispatchText(message: IncomingTextMessage): Promise<ChatReply> {
		const ctx: CallbackContext = { chatId: message.chatId, userId: message.userId };
		if (!message.text.trim().startsWith("/")) {
			const pending = this.takePendingPresetTask(ctx);
			if (pending) return this.startPreset(pending.presetId, message.text);
		}
		const command = parseCommand(message.text);
		switch (command.kind) {
			case "help":
				return this.chat(MESSAGES.help);
			case "start":
				return this.chat(MESSAGES.start);
			case "sessions":
				return this.handleSessions(ctx, command.query);
			case "observe":
				return this.handleObserve(command.sessionId, ctx);
			case "presets":
				return this.handlePresets(ctx);
			case "start_session":
				return this.handleStartSession(command.presetId, command.task, ctx);
			case "stop":
				return this.handleStop(ctx, command.sessionId, command.confirm);
			default:
				return this.chat(MESSAGES.unknownCommand);
		}
	}

	private async handleSessions(ctx: CallbackContext, query: string | null): Promise<ChatReply> {
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.chat(MESSAGES.backendOffline);
		if (!this.rich) {
			// Plain v0 mode: simple list, but still honor the optional substring query.
			const queryLower = query?.trim().toLowerCase() || null;
			const summaries = projectSessionSummaries(status).filter(summary => {
				if (!queryLower) return true;
				return `${summary.name} ${summary.sessionId} ${summary.branch ?? ""}`.toLowerCase().includes(queryLower);
			});
			return this.chat(renderSessionsList(summaries));
		}
		return this.renderSessionsPage(status, { filter: "all", query, page: 0 }, ctx);
	}

	private async handleObserve(sessionId: string | null, ctx: CallbackContext): Promise<ChatReply> {
		if (!sessionId) return this.chat(MESSAGES.observeUsage);
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.chat(MESSAGES.backendOffline);
		const view = findSessionView(status, sessionId);
		if (!view) return this.chat(MESSAGES.unknownSession);
		return this.viewReply(view, sessionId, ctx);
	}

	private async handleStartSession(
		presetId: string | null,
		task: string | null,
		ctx: CallbackContext,
	): Promise<ChatReply> {
		if (!presetId) {
			// Arg-less: show preset buttons (rich) or a safe id/name list (plain). renderPresets handles both.
			if (this.policy.presets.size > 0) return this.renderPresets(ctx);
			return this.chat(MESSAGES.startUsage);
		}
		return this.startPreset(presetId, task);
	}

	private async handlePresets(ctx: CallbackContext): Promise<ChatReply> {
		return this.renderPresets(ctx);
	}

	private async startPreset(presetId: string, task: string | null): Promise<ChatReply> {
		const resolution = resolvePreset(this.policy.presets, presetId, task);
		if (!resolution.ok) {
			return this.chat(resolution.reason === "unknown_preset" ? MESSAGES.unknownPreset : MESSAGES.taskTooLong);
		}
		const result = await this.coordinator.startSession({ cwd: resolution.preset.workdir, prompt: resolution.prompt });
		if (!result.ok) return this.chat(mapReason(result.reason));
		return this.chat(`Started ${result.sessionId ?? "session"} from preset ${resolution.preset.id}.`);
	}

	private async handleStop(ctx: CallbackContext, sessionId: string | null, confirm: boolean): Promise<ChatReply> {
		if (!sessionId) return this.chat(MESSAGES.stopUsage);
		if (!this.policy.enableStop) return this.chat(MESSAGES.sessionControlDisabled);

		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.chat(MESSAGES.backendOffline);
		const view = findSessionView(status, sessionId);
		if (!view) return this.chat(MESSAGES.unknownSession);
		// Fail closed: never record control for a dead/non-live session (it may have a different owner).
		if (view.status === "dead") return this.chat(MESSAGES.backendOffline);

		const key = `${ctx.chatId}:${sessionId}`;
		const now = this.now();
		if (confirm && this.isArmed(key, now)) {
			this.pendingStops.delete(key);
			return this.executeStop(sessionId, status, view);
		}

		this.pendingStops.set(key, now + this.confirmTtl);
		if (this.rich) {
			// Rich: show the capped/escaped display id and a Confirm button; the exact raw id stays
			// in the token + coordinator call, never echoed uncapped in chat.
			return {
				kind: "chat",
				text: `Confirm stop of <code>${escapeHtml(view.sessionId)}</code>?`,
				parseMode: "HTML",
				replyMarkup: this.stopConfirmKeyboard(sessionId, ctx),
			};
		}
		// Plain: the operator must type `/stop <id> confirm`, so echo the id they supplied.
		return { kind: "chat", text: `Confirm stop of ${sessionId}: send /stop ${sessionId} confirm` };
	}

	// --- Callback (inline-keyboard) handling ---

	private async handleCallback(update: IncomingCallbackQuery): Promise<OutgoingReply> {
		if (update.chatId === null) return this.answerOnly(MESSAGES.callbackInvalid);
		if (!this.isAuthorized(update.userId, update.chatId)) return this.answerOnly(MESSAGES.unauthorized, true);
		const resolution = this.tokens.resolve(update.data, { chatId: update.chatId, userId: update.userId });
		if (!resolution.ok) {
			return this.answerOnly(resolution.reason === "expired" ? MESSAGES.callbackExpired : MESSAGES.callbackInvalid);
		}
		const ctx: CallbackContext = { chatId: update.chatId, userId: update.userId };
		const { token, record } = resolution;
		switch (record.action) {
			case "observe":
			// Observe from a list row edits the originating list message in place (no sticky focus).
			case "refresh_observe":
				return this.callbackObserve(record, ctx, update.messageId);
			case "follow":
				return this.callbackFollow(record, ctx);
			case "mute":
				return this.callbackMute(record, ctx);
			case "stop_arm":
				return this.callbackStopArm(record, ctx);
			case "stop_confirm":
				return this.callbackStopConfirm(token, record);
			case "cancel":
				this.tokens.delete(token);
				// Revoke the paired confirmation so Cancel-then-Confirm cannot still mutate.
				this.tokens.revokeMatching("stop_confirm", record.chatId, record.sessionId);
				return this.answerOnly(MESSAGES.callbackCancelled);
			case "sessions_page":
			case "sessions_filter":
				return this.callbackSessionsList(record, ctx, update.messageId);
			case "preset_start":
				return this.callbackPresetStart(token, record, ctx);
			case "ui_select":
			case "ui_confirm":
			case "gate_answer":
			case "steer_held":
			case "cancel_steer":
			case "abort":
				return this.answerOnly(MESSAGES.callbackInvalid);
		}
	}

	private async callbackObserve(
		record: Extract<CallbackTokenRecord, { action: SessionCallbackAction }>,
		ctx: CallbackContext,
		editMessageId: string | number | null,
	): Promise<OutgoingReply> {
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.answerOnly(MESSAGES.backendOffline);
		const view = findSessionView(status, record.sessionId);
		if (!view) return this.answerOnly(MESSAGES.unknownSession);
		const reply = this.viewReply(view, record.sessionId, ctx);
		reply.callbackAnswer = { text: MESSAGES.callbackDone };
		if (editMessageId !== null) reply.edit = { messageId: editMessageId };
		return reply;
	}

	private async callbackSessionsList(
		record: Extract<CallbackTokenRecord, { action: ListCallbackAction }>,
		ctx: CallbackContext,
		editMessageId: string | number | null,
	): Promise<OutgoingReply> {
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.answerOnly(MESSAGES.backendOffline);
		const reply = this.renderSessionsPage(
			status,
			{ filter: record.filter, query: record.query, page: record.page },
			ctx,
			editMessageId ?? undefined,
		);
		reply.callbackAnswer = { text: MESSAGES.callbackDone };
		return reply;
	}

	private async callbackPresetStart(
		token: string,
		record: Extract<CallbackTokenRecord, { action: PresetCallbackAction }>,
		ctx: CallbackContext,
	): Promise<OutgoingReply> {
		const preset = this.policy.presets.get(record.presetId);
		if (!preset) return this.answerOnly(MESSAGES.unknownPreset);
		// Single-use: consume the button before any start / pending mutation so a replayed
		// preset button cannot start a duplicate session or re-arm a task prompt.
		this.tokens.markUsed(token);
		if (preset.taskTemplate) {
			this.setPendingPresetTask(ctx, preset.id);
			return { ...this.chat(MESSAGES.presetNeedsTask), callbackAnswer: { text: MESSAGES.callbackDone } };
		}
		const reply = await this.startPreset(preset.id, null);
		reply.callbackAnswer = { text: MESSAGES.callbackDone };
		return reply;
	}

	private async callbackFollow(
		record: Extract<CallbackTokenRecord, { action: SessionCallbackAction }>,
		ctx: CallbackContext,
	): Promise<OutgoingReply> {
		if (!this.pushEnabled || !this.subscriptions) return this.answerOnly(MESSAGES.callbackInvalid);
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.answerOnly(MESSAGES.backendOffline);
		const view = findSessionView(status, record.sessionId);
		if (!view) return this.answerOnly(MESSAGES.unknownSession);
		await this.subscriptions.follow({ sessionId: record.sessionId, chatId: ctx.chatId, userId: ctx.userId });
		return this.answerOnly(MESSAGES.following);
	}

	private async callbackMute(
		record: Extract<CallbackTokenRecord, { action: SessionCallbackAction }>,
		ctx: CallbackContext,
	): Promise<OutgoingReply> {
		if (!this.pushEnabled || !this.subscriptions) return this.answerOnly(MESSAGES.callbackInvalid);
		await this.subscriptions.mute({ sessionId: record.sessionId, chatId: ctx.chatId });
		return this.answerOnly(MESSAGES.muted);
	}

	private async callbackStopArm(
		record: Extract<CallbackTokenRecord, { action: SessionCallbackAction }>,
		ctx: CallbackContext,
	): Promise<OutgoingReply> {
		if (!this.policy.enableStop) return this.answerOnly(MESSAGES.sessionControlDisabled);
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.answerOnly(MESSAGES.backendOffline);
		const view = findSessionView(status, record.sessionId);
		if (!view) return this.answerOnly(MESSAGES.unknownSession);
		if (view.status === "dead") return this.answerOnly(MESSAGES.backendOffline);
		const display = this.rich ? `<code>${escapeHtml(view.sessionId)}</code>` : view.sessionId;
		const reply: ChatReply = {
			kind: "chat",
			text: `Confirm stop of ${display}?`,
			replyMarkup: this.stopConfirmKeyboard(record.sessionId, ctx),
			callbackAnswer: { text: "Confirm?" },
		};
		if (this.rich) reply.parseMode = "HTML";
		return reply;
	}

	private async callbackStopConfirm(
		token: string,
		record: Extract<CallbackTokenRecord, { action: SessionCallbackAction }>,
	): Promise<OutgoingReply> {
		if (!this.policy.enableStop) return this.answerOnly(MESSAGES.sessionControlDisabled);
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.answerOnly(MESSAGES.backendOffline);
		const view = findSessionView(status, record.sessionId);
		if (!view) return this.answerOnly(MESSAGES.unknownSession);
		if (view.status === "dead") return this.answerOnly(MESSAGES.backendOffline);
		// Single-use: consume before the call so a replay cannot double-mutate.
		this.tokens.markUsed(token);
		const result = await this.executeStop(record.sessionId, status, view);
		return { ...result, callbackAnswer: { text: MESSAGES.callbackDone } };
	}

	/** Shared terminal-stop call used by text confirm and button confirm. */
	private async executeStop(sessionId: string, status: CoordinationStatus, view: SessionView): Promise<ChatReply> {
		const turnId = activeTurnId(status, sessionId) ?? undefined;
		const result = await this.coordinator.reportStatus({
			sessionId,
			turnId,
			status: "cancelled",
			summary: STOP_SUMMARY,
		});
		if (!result.ok) return this.chat(mapReason(result.reason));
		if (this.rich) {
			return {
				kind: "chat",
				text: `Stop requested for <code>${escapeHtml(view.sessionId)}</code>.`,
				parseMode: "HTML",
			};
		}
		return this.chat(`Stop requested for ${sessionId}.`);
	}

	// --- Rendering + keyboards ---

	public renderNotificationCard(rawSessionId: string, view: SessionView, ctx: CallbackContext): ChatReply {
		const activity = view.lastActivityAt
			? ` Last activity ${formatRelativeTime(view.lastActivityAt, this.now())}.`
			: "";
		return {
			kind: "chat",
			text: `Session <b>${escapeHtml(view.name)}</b> is <b>${view.status}</b>.${activity}`,
			parseMode: "HTML",
			replyMarkup: this.notificationKeyboard(rawSessionId, ctx),
		};
	}

	private viewReply(view: SessionView, rawSessionId: string, ctx: CallbackContext): ChatReply {
		if (!this.rich) return this.chat(renderSessionView(view, this.now()));
		return {
			kind: "chat",
			text: renderSessionViewHtml(view, this.now()),
			parseMode: "HTML",
			replyMarkup: this.observeKeyboard(rawSessionId, ctx),
		};
	}

	private renderSessionsPage(
		status: CoordinationStatus,
		state: { filter: SessionFilter; query: string | null; page: number },
		ctx: CallbackContext,
		editMessageId?: string | number,
	): ChatReply {
		const query = state.query?.trim() || null;
		const queryLower = query?.toLowerCase() ?? null;
		const filtered = projectSessionRows(status)
			.filter(row => isWithinRetention(row.summary.status, row.summary.lastActivityAt, this.now()))
			.filter(row => this.matchesFilter(row.summary.status, state.filter))
			.filter(row => {
				if (!queryLower) return true;
				const haystack =
					`${row.summary.name} ${row.summary.sessionId} ${row.summary.branch ?? ""} ${row.rawSessionId}`.toLowerCase();
				return haystack.includes(queryLower);
			})
			.map((row, index) => ({ ...row, index }))
			.sort((a, b) => {
				const liveDelta = Number(isTerminalStatus(a.summary.status)) - Number(isTerminalStatus(b.summary.status));
				if (liveDelta !== 0) return liveDelta;
				const timeDelta = this.timeValue(b.summary.lastActivityAt) - this.timeValue(a.summary.lastActivityAt);
				return timeDelta !== 0 ? timeDelta : a.index - b.index;
			});
		const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
		const page = Math.min(Math.max(0, state.page), totalPages - 1);
		const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
		const header = `Filter: ${state.filter} · page ${page + 1}/${totalPages} · ${filtered.length} sessions`;
		const reply: ChatReply = {
			kind: "chat",
			text: `${renderSessionsListHtml(pageRows.map(row => row.summary))}\n${header}`,
			parseMode: "HTML",
			replyMarkup: this.sessionsKeyboard(pageRows, { filter: state.filter, query, page }, ctx, totalPages),
		};
		if (editMessageId !== undefined) reply.edit = { messageId: editMessageId };
		return reply;
	}

	private renderPresets(ctx: CallbackContext): ChatReply {
		if (this.policy.presets.size === 0) return this.chat(MESSAGES.noPresets);
		const lines = [
			"Presets:",
			...[...this.policy.presets.values()].map(preset => `- ${presetName(preset)} (${preset.id})`),
		];
		const reply: ChatReply = { kind: "chat", text: lines.join("\n") };
		if (this.rich) reply.replyMarkup = this.presetsKeyboard(ctx);
		return reply;
	}

	private presetsKeyboard(ctx: CallbackContext): TelegramInlineKeyboardMarkup {
		return {
			inline_keyboard: [...this.policy.presets.values()].map(preset => [
				{ text: presetName(preset), callbackData: this.issuePreset(preset.id, ctx) },
			]),
		};
	}

	private sessionsKeyboard(
		rows: Array<{ rawSessionId: string; summary: { name: string } }>,
		state: { filter: SessionFilter; query: string | null; page: number },
		ctx: CallbackContext,
		totalPages: number,
	): TelegramInlineKeyboardMarkup {
		const keyboard = rows.map(({ rawSessionId, summary }) => {
			const name = summary.name.slice(0, BUTTON_NAME_MAX);
			const row: TelegramInlineKeyboardButton[] = [
				{ text: `Observe ${name}`, callbackData: this.issue("observe", rawSessionId, ctx, this.richTtl) },
			];
			if (this.pushEnabled) {
				row.push({ text: `Follow ${name}`, callbackData: this.issue("follow", rawSessionId, ctx, this.richTtl) });
				row.push({ text: `Mute ${name}`, callbackData: this.issue("mute", rawSessionId, ctx, this.richTtl) });
			}
			if (this.policy.enableStop) {
				row.push({ text: `Stop ${name}`, callbackData: this.issue("stop_arm", rawSessionId, ctx, this.richTtl) });
			}
			return row;
		});
		keyboard.push(
			(["live", "blocked", "done", "all"] as const).map(filter => ({
				text: filter === state.filter ? `[${filter}]` : filter,
				callbackData: this.issueList(
					{ action: "sessions_filter", filter, query: state.query, page: 0 },
					ctx,
					this.richTtl,
				),
			})),
		);
		const nav: TelegramInlineKeyboardButton[] = [];
		if (state.page > 0) {
			nav.push({
				text: "Prev",
				callbackData: this.issueList(
					{ action: "sessions_page", filter: state.filter, query: state.query, page: state.page - 1 },
					ctx,
					this.richTtl,
				),
			});
		}
		if (state.page < totalPages - 1) {
			nav.push({
				text: "Next",
				callbackData: this.issueList(
					{ action: "sessions_page", filter: state.filter, query: state.query, page: state.page + 1 },
					ctx,
					this.richTtl,
				),
			});
		}
		if (nav.length > 0) keyboard.push(nav);
		return { inline_keyboard: keyboard };
	}

	private observeKeyboard(rawSessionId: string, ctx: CallbackContext): TelegramInlineKeyboardMarkup {
		const row: TelegramInlineKeyboardButton[] = [
			{ text: "Refresh", callbackData: this.issue("refresh_observe", rawSessionId, ctx, this.richTtl) },
		];
		if (this.pushEnabled) {
			row.push({ text: "Follow", callbackData: this.issue("follow", rawSessionId, ctx, this.richTtl) });
			row.push({ text: "Mute", callbackData: this.issue("mute", rawSessionId, ctx, this.richTtl) });
		}
		if (this.policy.enableStop) {
			row.push({ text: "Stop", callbackData: this.issue("stop_arm", rawSessionId, ctx, this.richTtl) });
		}
		return { inline_keyboard: [row] };
	}

	private notificationKeyboard(rawSessionId: string, ctx: CallbackContext): TelegramInlineKeyboardMarkup {
		const row: TelegramInlineKeyboardButton[] = [
			{ text: "Observe", callbackData: this.issue("observe", rawSessionId, ctx, this.richTtl) },
			{ text: "Mute", callbackData: this.issue("mute", rawSessionId, ctx, this.richTtl) },
		];
		if (this.policy.enableStop) {
			row.push({ text: "Stop", callbackData: this.issue("stop_arm", rawSessionId, ctx, this.richTtl) });
		}
		return { inline_keyboard: [row] };
	}

	private stopConfirmKeyboard(rawSessionId: string, ctx: CallbackContext): TelegramInlineKeyboardMarkup {
		return {
			inline_keyboard: [
				[
					{ text: "Confirm stop", callbackData: this.issue("stop_confirm", rawSessionId, ctx, this.confirmTtl) },
					{ text: "Cancel", callbackData: this.issue("cancel", rawSessionId, ctx, this.confirmTtl) },
				],
			],
		};
	}

	private issue(action: SessionCallbackAction, sessionId: string, ctx: CallbackContext, ttlMs: number): string {
		return this.tokens.issue({ action, sessionId, chatId: ctx.chatId, userId: ctx.userId, ttlMs });
	}

	private issueList(
		payload: { action: ListCallbackAction; filter: SessionFilter; query: string | null; page: number },
		ctx: CallbackContext,
		ttlMs: number,
	): string {
		return this.tokens.issue({ ...payload, chatId: ctx.chatId, userId: ctx.userId, ttlMs });
	}

	private issuePreset(presetId: string, ctx: CallbackContext): string {
		return this.tokens.issue({
			action: "preset_start",
			presetId,
			chatId: ctx.chatId,
			userId: ctx.userId,
			ttlMs: this.richTtl,
		});
	}

	// --- Helpers ---

	private get rich(): boolean {
		return this.policy.enableRichMessages ?? false;
	}

	private get pushEnabled(): boolean {
		return (this.policy.enablePush ?? false) && this.subscriptions !== undefined;
	}

	private get confirmTtl(): number {
		return this.policy.confirmTtlMs ?? DEFAULT_CONFIRM_TTL_MS;
	}

	private get richTtl(): number {
		return this.policy.richCallbackTtlMs ?? DEFAULT_RICH_TTL_MS;
	}

	private chat(text: string): ChatReply {
		return { kind: "chat", text };
	}

	private answerOnly(text: string, showAlert?: boolean): CallbackAnswerOnlyReply {
		return {
			kind: "callback_answer",
			callbackAnswer: showAlert ? { text, showAlert: true } : { text },
			sendMessage: false,
		};
	}

	private matchesFilter(status: SessionStatus, filter: SessionFilter): boolean {
		switch (filter) {
			case "live":
				return !isTerminalStatus(status);
			case "blocked":
				return status === "blocked" || status === "waiting_for_input";
			case "done":
				return status === "done";
			case "all":
				return true;
		}
	}

	private timeValue(iso: string | null): number {
		if (!iso) return 0;
		const value = Date.parse(iso);
		return Number.isFinite(value) ? value : 0;
	}
	private isAuthorized(userId: string | null, chatId: string): boolean {
		if (userId !== null && this.policy.allowedUserIds.has(userId)) return true;
		return this.policy.allowedChatIds.has(chatId);
	}

	private isArmed(key: string, now: number): boolean {
		const expiry = this.pendingStops.get(key);
		return expiry !== undefined && expiry > now;
	}

	private pendingPresetKey(ctx: CallbackContext): string {
		return `${ctx.chatId}:${ctx.userId ?? ""}`;
	}

	private takePendingPresetTask(ctx: CallbackContext): { presetId: string } | null {
		this.prunePendingPresetTasks();
		const key = this.pendingPresetKey(ctx);
		const pending = this.pendingPresetTasks.get(key);
		if (!pending) return null;
		this.pendingPresetTasks.delete(key);
		if (pending.expiresAt <= this.now()) return null;
		return { presetId: pending.presetId };
	}

	private setPendingPresetTask(ctx: CallbackContext, presetId: string): void {
		this.prunePendingPresetTasks();
		this.pendingPresetTasks.set(this.pendingPresetKey(ctx), { presetId, expiresAt: this.now() + this.confirmTtl });
		while (this.pendingPresetTasks.size > MAX_PENDING_PRESET_TASKS) {
			const oldest = this.pendingPresetTasks.keys().next().value;
			if (oldest === undefined) break;
			this.pendingPresetTasks.delete(oldest);
		}
	}

	private prunePendingPresetTasks(): void {
		const now = this.now();
		for (const [key, pending] of this.pendingPresetTasks) {
			if (pending.expiresAt <= now) this.pendingPresetTasks.delete(key);
		}
	}
}
