/**
 * Shared, side-effect-free Telegram pairing helpers.
 *
 * This module owns Bot API validation and the single-poller setup policy. It
 * never writes settings or renders output: callers provide UI callbacks and
 * persist a successful result only after the returned result is complete.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "../../config/file-lock";

import { tokenFingerprint } from "./config";
import { sanitizeDiagnostic } from "./notification-service";

export const DEFAULT_TELEGRAM_SETUP_API_BASE = "https://api.telegram.org";
export const DEFAULT_TELEGRAM_SETUP_POLL_TIMEOUT_MS = 60_000;
export const DEFAULT_TELEGRAM_SETUP_POLL_INTERVAL_MS = 1_000;

export type TelegramThreadedModeState = "enabled" | "disabled" | "unknown";
export type TelegramThreadedModeLabel = "verified" | "unverified" | "unknown";
export type TelegramSetupPairingSource = "discovered" | "provided" | "reused";
export type TelegramSetupFailureStatus =
	| "error"
	| "cancelled"
	| "requires_explicit_chat"
	| "ownership_lost"
	| "aborted";

export interface TelegramSetupTimers {
	now(): number;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface TelegramSetupDeps {
	fetchImpl: typeof fetch;
	apiBase?: string;
	timers?: TelegramSetupTimers;
}

/** Current daemon ownership facts collected by the caller before setup starts. */
export interface TelegramSetupPreflight {
	storedChatId?: string;
	daemon?: {
		live: boolean;
		tokenFingerprint?: string;
		/** Required with a live daemon so reuse verifies the complete token/chat identity. */
		chatId?: string;
	};
}

export type TelegramSetupPollingPolicy =
	| { kind: "discover" }
	| { kind: "reuse_stored_chat"; chatId: string }
	| { kind: "validate_explicit_chat"; chatId: string }
	| { kind: "requires_explicit_chat" }
	| { kind: "cancel_foreign_or_unknown_owner"; identity: "foreign" | "unknown" };

export type TelegramSetupEvent =
	| { kind: "token_validated"; message: string }
	| { kind: "threaded_mode_guidance"; message: string }
	| { kind: "rejected_chat"; message: string };

export interface TelegramSetupSuccess {
	ok: true;
	chatId: string;
	tokenFingerprint: string;
	threadedMode: TelegramThreadedModeState;
	threadedLabel: TelegramThreadedModeLabel;
	pairingSource: TelegramSetupPairingSource;
}

export interface TelegramSetupFailure {
	ok: false;
	status: TelegramSetupFailureStatus;
	detail: string;
}

export type TelegramSetupResult = TelegramSetupSuccess | TelegramSetupFailure;

export interface TelegramBot {
	id: number;
	isBot?: boolean;
	firstName?: string;
	username?: string;
	hasTopicsEnabled?: boolean;
	allowsUsersToCreateTopics?: boolean;
}

export type TelegramTokenValidationResult =
	| {
			ok: true;
			bot: TelegramBot;
			threadedMode: TelegramThreadedModeState;
	  }
	| TelegramSetupFailure;

export type TelegramPrivateChatValidationResult =
	| {
			ok: true;
			chatId: string;
	  }
	| TelegramSetupFailure;

export interface RunTelegramSetupInput {
	token: string;
	preflight: TelegramSetupPreflight;
	/**
	 * Re-reads daemon ownership immediately before any `getUpdates` call. It is
	 * mandatory for discovery because an earlier preflight cannot own Telegram's
	 * single-poller slot.
	 */
	revalidatePreflight?: (signal?: AbortSignal) => Promise<TelegramSetupPreflight>;
	chatId?: string;
	interactive: boolean;
	threadedModePrompt?: (message: string) => Promise<string>;
	pollTimeoutMs?: number;
	pollIntervalMs?: number;
	signal?: AbortSignal;
	onEvent?: (event: TelegramSetupEvent) => void;
	deps: TelegramSetupDeps;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
}

interface TelegramApiUser {
	id?: unknown;
	is_bot?: unknown;
	first_name?: unknown;
	username?: unknown;
	has_topics_enabled?: unknown;
	allows_users_to_create_topics?: unknown;
}

interface TelegramApiChat {
	id?: unknown;
	type?: unknown;
}

interface TelegramUpdate {
	update_id?: unknown;
	message?: {
		chat?: {
			id?: unknown;
			type?: unknown;
		};
	};
}

const THREADED_ENABLED_SUCCESS =
	"Telegram Threaded Mode capability verified for this bot. GJC will request a private-chat topic per session; if Telegram ever refuses topic creation, notifications fall back to this flat chat with inline ask buttons only and a one-time Threaded Mode nudge.\n";
const THREADED_MISSING_WARNING =
	"Warning: Telegram getMe did not include has_topics_enabled, so GJC cannot verify private-chat Threaded Mode capability for this bot. Setup will continue; flat private-chat fallback supports outbound notifications and inline ask buttons only. Free-text replies and session commands require Threaded Mode/topic routing.\n";
const THREADED_NONINTERACTIVE_WARNING =
	"Warning: Telegram Threaded Mode capability is OFF for this bot. Setup will be saved because this run is non-interactive. Flat private-chat fallback supports outbound notifications and inline ask buttons only; free-text replies and session commands require enabling Threaded Mode in @BotFather > Bot Settings > Threads Settings.\n";
const THREADED_DISABLED_GUIDANCE =
	"Telegram Threaded Mode is OFF for this bot. GJC needs Telegram private-chat topics so each session can use its own thread.\n" +
	"GJC cannot enable this through the Bot API. Open @BotFather > Bot Settings > Threads Settings for this bot, enable Threaded Mode / forum topics for private chats, then return here.\n" +
	"Without Threaded Mode, flat private-chat fallback supports outbound notifications and inline ask buttons only; free-text replies and session commands require topic routing.\n";
const THREADED_DISABLED_PROMPT =
	"Press Enter after enabling Threaded Mode, or type skip to finish setup with a warning: ";
const THREADED_STILL_OFF = "Telegram still reports Threaded Mode OFF for this bot.\n";
const THREADED_RETRY_PROMPT = "Press Enter to check again, or type skip to finish setup with a warning: ";
const THREADED_SKIP_WARNING =
	"Warning: continuing without verified Telegram Threaded Mode capability. Setup will be saved. Flat private-chat fallback supports outbound notifications and inline ask buttons only; free-text replies and session commands require enabling Threaded Mode in BotFather.\n";
const THREADED_INVALID_INPUT = "Type Enter to retry or skip to continue with a warning.\n";
const THREADED_RETRY_INPUTS = new Set(["", "y", "yes", "r", "retry"]);
const THREADED_SKIP_INPUTS = new Set(["s", "skip", "n", "no"]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		cleanup();
		resolve();
	}, ms);
	const onAbort = () => {
		clearTimeout(timer);
		cleanup();
		reject(abortError());
	};
	const cleanup = () => signal?.removeEventListener("abort", onAbort);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	return promise;
}

const defaultTimers: TelegramSetupTimers = {
	now: () => Date.now(),
	sleep: defaultSleep,
};

function abortError(): Error {
	const error = new Error("Telegram setup cancelled.");
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /\baborted\b|\bcancelled\b/i.test(error.message));
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError();
}

function failure(token: string, status: TelegramSetupFailureStatus, detail: string): TelegramSetupFailure {
	return { ok: false, status, detail: sanitizeDiagnostic(detail, token) };
}

function apiBase(deps: TelegramSetupDeps): string {
	return (deps.apiBase ?? DEFAULT_TELEGRAM_SETUP_API_BASE).replace(/\/$/, "");
}

function timers(deps: TelegramSetupDeps): TelegramSetupTimers {
	return deps.timers ?? defaultTimers;
}

function toBot(value: unknown): TelegramBot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const user = value as TelegramApiUser;
	if (typeof user.id !== "number" || !Number.isSafeInteger(user.id)) return undefined;
	return {
		id: user.id,
		isBot: typeof user.is_bot === "boolean" ? user.is_bot : undefined,
		firstName: typeof user.first_name === "string" ? user.first_name : undefined,
		username: typeof user.username === "string" ? user.username : undefined,
		hasTopicsEnabled: typeof user.has_topics_enabled === "boolean" ? user.has_topics_enabled : undefined,
		allowsUsersToCreateTopics:
			typeof user.allows_users_to_create_topics === "boolean" ? user.allows_users_to_create_topics : undefined,
	};
}

export async function withTelegramSetupLease<T>(token: string, operation: () => Promise<T>): Promise<T> {
	const dir = path.join(os.tmpdir(), "gjc-telegram-setup");
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	return await withFileLock(path.join(dir, tokenFingerprint(token.trim())), operation);
}

function threadedMode(bot: TelegramBot): TelegramThreadedModeState {
	if (bot.hasTopicsEnabled === true) return "enabled";
	if (bot.hasTopicsEnabled === false) return "disabled";
	return "unknown";
}

function threadedLabel(state: TelegramThreadedModeState): TelegramThreadedModeLabel {
	if (state === "enabled") return "verified";
	if (state === "disabled") return "unverified";
	return "unknown";
}

async function callTelegram<T>(input: {
	deps: TelegramSetupDeps;
	token: string;
	method: string;
	body: Record<string, unknown>;
	signal?: AbortSignal;
}): Promise<T> {
	assertNotAborted(input.signal);
	const response = await input.deps.fetchImpl(`${apiBase(input.deps)}/bot${input.token}/${input.method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input.body),
		signal: input.signal,
	});
	let payload: TelegramApiResponse<T>;
	try {
		payload = (await response.json()) as TelegramApiResponse<T>;
	} catch {
		throw new Error(`Telegram ${input.method} returned invalid JSON.`);
	}
	if (!payload || typeof payload !== "object") {
		throw new Error(`Telegram ${input.method} returned invalid JSON.`);
	}
	if (!response.ok || payload.ok !== true) {
		throw new Error(`Telegram ${input.method} failed: ${payload.description ?? response.statusText}`);
	}
	return payload.result as T;
}

/** Validate a token with getMe without exposing it in diagnostics or results. */
export async function validateTelegramBotToken(input: {
	token: string;
	deps: TelegramSetupDeps;
	signal?: AbortSignal;
}): Promise<TelegramTokenValidationResult> {
	const token = input.token.trim();
	if (!token) return failure(input.token, "error", "Telegram bot token is required.");
	try {
		const bot = toBot(await callTelegram<unknown>({ ...input, token, method: "getMe", body: {} }));
		if (!bot) {
			return failure(
				token,
				"error",
				"Telegram getMe returned invalid Telegram response: missing valid User result.",
			);
		}
		return { ok: true, bot, threadedMode: threadedMode(bot) };
	} catch (error) {
		if (isAbortError(error)) return failure(token, "aborted", "Telegram setup cancelled.");
		return failure(token, "error", error instanceof Error ? error.message : "Telegram getMe failed.");
	}
}

/** Validate that a supplied or stored chat is an actual Telegram private chat. */
export async function validateTelegramPrivateChat(input: {
	token: string;
	chatId: string;
	deps: TelegramSetupDeps;
	signal?: AbortSignal;
}): Promise<TelegramPrivateChatValidationResult> {
	const token = input.token.trim();
	const requestedChatId = input.chatId.trim();
	if (!requestedChatId) return failure(token, "error", "Telegram private chat id is required.");
	try {
		const chat = (await callTelegram<unknown>({
			deps: input.deps,
			token,
			method: "getChat",
			body: { chat_id: requestedChatId },
			signal: input.signal,
		})) as TelegramApiChat;
		if (!chat || typeof chat !== "object" || (typeof chat.id !== "number" && typeof chat.id !== "string")) {
			return failure(
				token,
				"error",
				"Telegram getChat returned invalid Telegram response: missing valid Chat result.",
			);
		}
		if (chat.type !== "private") {
			const type = typeof chat.type === "string" && chat.type ? chat.type : "unknown";
			return failure(
				token,
				"error",
				`Provided chat id ${requestedChatId} is a ${type} chat; pairing requires a private Telegram chat.`,
			);
		}
		return { ok: true, chatId: String(chat.id) };
	} catch (error) {
		if (isAbortError(error)) return failure(token, "aborted", "Telegram setup cancelled.");
		return failure(token, "error", error instanceof Error ? error.message : "Telegram getChat failed.");
	}
}

/**
 * Decide whether setup may call getUpdates. Any live daemon is a hard polling
 * boundary: only a verified complete token/chat identity may reuse the stored
 * chat; setup never polls while any live owner exists.
 */
export function resolveTelegramSetupPollingPolicy(input: {
	token: string;
	preflight: TelegramSetupPreflight;
	chatId?: string;
}): TelegramSetupPollingPolicy {
	const explicitChatId = input.chatId?.trim();
	const storedChatId = input.preflight.storedChatId?.trim();
	const daemon = input.preflight.daemon;
	if (!daemon?.live) {
		return explicitChatId ? { kind: "validate_explicit_chat", chatId: explicitChatId } : { kind: "discover" };
	}

	const fingerprint = daemon.tokenFingerprint?.trim();
	const daemonChatId = daemon.chatId?.trim();
	if (!fingerprint || !daemonChatId) return { kind: "cancel_foreign_or_unknown_owner", identity: "unknown" };
	if (fingerprint !== tokenFingerprint(input.token.trim())) {
		return { kind: "cancel_foreign_or_unknown_owner", identity: "foreign" };
	}
	if (storedChatId && daemonChatId !== storedChatId) {
		return { kind: "cancel_foreign_or_unknown_owner", identity: "foreign" };
	}
	if (storedChatId && (!explicitChatId || explicitChatId === storedChatId)) {
		return { kind: "reuse_stored_chat", chatId: storedChatId };
	}
	if (explicitChatId) return { kind: "validate_explicit_chat", chatId: explicitChatId };
	return { kind: "requires_explicit_chat" };
}

function nextOffset(updates: TelegramUpdate[], fallback?: number): number | undefined {
	let max = fallback === undefined ? undefined : fallback - 1;
	for (const update of updates) {
		if (typeof update.update_id === "number" && Number.isSafeInteger(update.update_id)) {
			if (max === undefined || update.update_id > max) max = update.update_id;
		}
	}
	return max === undefined ? fallback : max + 1;
}

async function getUpdates(input: {
	token: string;
	deps: TelegramSetupDeps;
	offset?: number;
	signal?: AbortSignal;
}): Promise<TelegramUpdate[]> {
	const result = await callTelegram<unknown>({
		deps: input.deps,
		token: input.token,
		method: "getUpdates",
		body: { offset: input.offset, timeout: 0, allowed_updates: ["message"] },
		signal: input.signal,
	});
	if (!Array.isArray(result)) throw new Error("Telegram getUpdates returned invalid Telegram response.");
	return result as TelegramUpdate[];
}

async function discoverPrivateTelegramChat(input: {
	token: string;
	deps: TelegramSetupDeps;
	pollTimeoutMs: number;
	pollIntervalMs: number;
	signal?: AbortSignal;
	onRejectedChat?: (type: string) => void;
}): Promise<TelegramPrivateChatValidationResult> {
	const token = input.token.trim();
	try {
		assertNotAborted(input.signal);
		const stale = await getUpdates({ token, deps: input.deps, signal: input.signal });
		let offset = nextOffset(stale);
		const timeoutMs = Math.max(0, input.pollTimeoutMs);
		const intervalMs = Math.max(0, input.pollIntervalMs);
		const clock = timers(input.deps);
		const deadline = clock.now() + timeoutMs;
		const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(intervalMs, 1)) + 1);
		let sawRejectedChatType: string | undefined;

		for (let attempt = 0; attempt < maxAttempts && clock.now() <= deadline; attempt++) {
			assertNotAborted(input.signal);
			const updates = await getUpdates({ token, deps: input.deps, offset, signal: input.signal });
			offset = nextOffset(updates, offset);
			for (const update of updates) {
				const chat = update.message?.chat;
				if (!chat) continue;
				if (chat.type === "private" && (typeof chat.id === "number" || typeof chat.id === "string")) {
					return { ok: true, chatId: String(chat.id) };
				}
				if (chat.type === "group" || chat.type === "supergroup" || chat.type === "channel") {
					sawRejectedChatType = chat.type;
					input.onRejectedChat?.(chat.type);
				}
			}
			if (attempt + 1 >= maxAttempts) break;
			const remaining = deadline - clock.now();
			if (remaining <= 0) break;
			await clock.sleep(Math.min(intervalMs, remaining), input.signal);
		}
		if (sawRejectedChatType) {
			return failure(
				token,
				"error",
				`Pairing rejected ${sawRejectedChatType} chat; message the bot from a private chat.`,
			);
		}
		return failure(token, "error", "Timed out waiting for a private Telegram message to pair notifications.");
	} catch (error) {
		if (isAbortError(error)) return failure(token, "aborted", "Telegram setup cancelled.");
		if (error instanceof Error && /\b409\b|\bconflict\b/i.test(error.message)) {
			return failure(
				token,
				"ownership_lost",
				"Telegram setup stopped because another poller owns this bot. No configuration was saved.",
			);
		}
		return failure(token, "error", error instanceof Error ? error.message : "Telegram getUpdates failed.");
	}
}

async function verifyThreadedMode(input: {
	token: string;
	bot: TelegramBot;
	interactive: boolean;
	prompt?: (message: string) => Promise<string>;
	deps: TelegramSetupDeps;
	signal?: AbortSignal;
	onEvent?: (event: TelegramSetupEvent) => void;
}): Promise<TelegramThreadedModeState | TelegramSetupFailure> {
	const emit = (message: string) => input.onEvent?.({ kind: "threaded_mode_guidance", message });
	let state = threadedMode(input.bot);
	if (state === "enabled") {
		emit(THREADED_ENABLED_SUCCESS);
		return state;
	}
	if (state === "unknown") {
		emit(THREADED_MISSING_WARNING);
		return state;
	}
	if (!input.interactive || !input.prompt) {
		emit(THREADED_NONINTERACTIVE_WARNING);
		return state;
	}

	emit(THREADED_DISABLED_GUIDANCE);
	let firstPrompt = true;
	try {
		for (;;) {
			assertNotAborted(input.signal);
			const answer = (await input.prompt(firstPrompt ? THREADED_DISABLED_PROMPT : THREADED_RETRY_PROMPT))
				.trim()
				.toLowerCase();
			firstPrompt = false;
			if (THREADED_SKIP_INPUTS.has(answer)) {
				emit(THREADED_SKIP_WARNING);
				return "disabled";
			}
			if (!THREADED_RETRY_INPUTS.has(answer)) {
				emit(THREADED_INVALID_INPUT);
				continue;
			}
			const validation = await validateTelegramBotToken({
				token: input.token,
				deps: input.deps,
				signal: input.signal,
			});
			if (!validation.ok) return validation;
			state = validation.threadedMode;
			if (state === "enabled") {
				emit(THREADED_ENABLED_SUCCESS);
				return state;
			}
			if (state === "unknown") {
				emit(THREADED_MISSING_WARNING);
				return state;
			}
			emit(THREADED_STILL_OFF);
		}
	} catch (error) {
		if (isAbortError(error)) return failure(input.token, "aborted", "Telegram setup cancelled.");
		return failure(
			input.token,
			"error",
			error instanceof Error ? error.message : "Telegram Threaded Mode verification failed.",
		);
	}
}

/**
 * Validate a token, assess Threaded Mode, and obtain a private chat according
 * to the daemon poller-contention policy. No settings are written here.
 */
export async function runTelegramSetup(input: RunTelegramSetupInput): Promise<TelegramSetupResult> {
	const token = input.token.trim();
	const tokenValidation = await validateTelegramBotToken({ token, deps: input.deps, signal: input.signal });
	if (!tokenValidation.ok) return tokenValidation;
	input.onEvent?.({
		kind: "token_validated",
		message: "Token validated. Message your bot now from the private Telegram chat to pair notifications.\n",
	});

	const threadedMode = await verifyThreadedMode({
		token,
		bot: tokenValidation.bot,
		interactive: input.interactive,
		prompt: input.threadedModePrompt,
		deps: input.deps,
		signal: input.signal,
		onEvent: input.onEvent,
	});
	if (typeof threadedMode !== "string") return threadedMode;

	let policy = resolveTelegramSetupPollingPolicy({ token, preflight: input.preflight, chatId: input.chatId });
	if (policy.kind === "discover") {
		if (!input.revalidatePreflight) {
			return failure(
				token,
				"ownership_lost",
				"Telegram setup cannot safely start pairing because daemon ownership was not revalidated. No configuration was saved.",
			);
		}
		try {
			assertNotAborted(input.signal);
			const preflight = await input.revalidatePreflight(input.signal);
			policy = resolveTelegramSetupPollingPolicy({ token, preflight, chatId: input.chatId });
		} catch (error) {
			if (isAbortError(error)) return failure(token, "aborted", "Telegram setup cancelled.");
			return failure(
				token,
				"ownership_lost",
				"Telegram setup could not revalidate daemon ownership before pairing. No configuration was saved.",
			);
		}
	}
	if (policy.kind === "cancel_foreign_or_unknown_owner") {
		return failure(
			token,
			"cancelled",
			`Telegram setup cancelled: a live daemon has a ${policy.identity} identity. Stop or reconfigure that daemon before pairing this bot.`,
		);
	}
	if (policy.kind === "requires_explicit_chat") {
		return failure(
			token,
			"requires_explicit_chat",
			"A live daemon already owns this bot token. Supply an explicit private --chat-id to reconfigure without polling.",
		);
	}

	if (policy.kind === "discover") {
		const revalidate = input.revalidatePreflight;
		if (!revalidate)
			return failure(
				token,
				"ownership_lost",
				"Telegram setup cannot safely start pairing because daemon ownership was not revalidated. No configuration was saved.",
			);
		const chat = await withTelegramSetupLease(token, async () => {
			try {
				const preflight = await revalidate(input.signal);
				if (resolveTelegramSetupPollingPolicy({ token, preflight, chatId: input.chatId }).kind !== "discover")
					return failure(
						token,
						"ownership_lost",
						"Telegram setup stopped because daemon ownership changed before pairing. No configuration was saved.",
					);
				return await discoverPrivateTelegramChat({
					token,
					deps: input.deps,
					pollTimeoutMs: input.pollTimeoutMs ?? DEFAULT_TELEGRAM_SETUP_POLL_TIMEOUT_MS,
					pollIntervalMs: input.pollIntervalMs ?? DEFAULT_TELEGRAM_SETUP_POLL_INTERVAL_MS,
					signal: input.signal,
					onRejectedChat: type =>
						input.onEvent?.({
							kind: "rejected_chat",
							message: `Rejected ${type} chat. Pairing requires a private Telegram chat with the bot.\n`,
						}),
				});
			} catch (error) {
				return isAbortError(error)
					? failure(token, "aborted", "Telegram setup cancelled.")
					: failure(
							token,
							"ownership_lost",
							"Telegram setup could not revalidate daemon ownership before pairing. No configuration was saved.",
						);
			}
		});
		if (!chat.ok) return chat;
		return {
			ok: true,
			chatId: chat.chatId,
			tokenFingerprint: tokenFingerprint(token),
			threadedMode,
			threadedLabel: threadedLabel(threadedMode),
			pairingSource: "discovered",
		};
	}
	const chat = await validateTelegramPrivateChat({
		token,
		chatId: policy.chatId,
		deps: input.deps,
		signal: input.signal,
	});
	if (!chat.ok) return chat;
	return {
		ok: true,
		chatId: chat.chatId,
		tokenFingerprint: tokenFingerprint(token),
		threadedMode,
		threadedLabel: threadedLabel(threadedMode),
		pairingSource: policy.kind === "reuse_stored_chat" ? "reused" : "provided",
	};
}
