/**
 * Notifications extension.
 *
 * Hosts a per-session loopback WebSocket notification server (the Rust core via
 * N-API) and bridges GJC session events + the `ask` tool to it so a remote client
 * (e.g. a Telegram bot) can both see action-needed signals and ANSWER them —
 * without requiring RPC/unattended mode:
 *
 * - `ask` (interactive): registers an {@link AskAnswerSource}; the ask tool races
 *   the local UI against a remote reply. First valid answer wins; a local answer
 *   aborts the remote wait (and broadcasts `action_resolved` resolvedBy=local).
 * - `ask` (unattended/RPC): observes emitted workflow gates and resolves the real
 *   gate on a remote reply via `ctx.workflowGate`.
 * - `turn_end` -> `action_needed` (kind `idle`, deduped per turn).
 * - `session_shutdown` -> stop the server + deregister the answer source.
 *
 * Enable with Settings notifications config, `GJC_NOTIFICATIONS=1` (a token is
 * generated), or `GJC_NOTIFICATIONS_TOKEN`.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import { NotificationServer } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import { Settings } from "../config/settings";
import type { ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { registerAskAnswerSource } from "../tools/ask-answer-registry";
import {
	getNotificationConfig,
	isGloballyConfigured,
	isSessionNotificationsEnabled,
	type NotificationConfig,
	sessionTag,
} from "./config";
import { idleDedupeKey, notificationActionPayload, summaryFromMessage } from "./helpers";
import { ensureTelegramDaemonRunning } from "./telegram-daemon";

interface PendingInteractiveAsk {
	resolve: (label: string | undefined) => void;
	options: string[];
}

interface SessionRuntime {
	server: NotificationServer;
	notifiedIdleTurns: Set<string>;
	/** Interactive asks awaiting a remote answer, by action id. */
	pendingInteractive: Map<string, PendingInteractiveAsk>;
	/** Deregisters this session's ask answer source. */
	disposeAnswerSource: () => void;
	redact: boolean;
	sessionTag: string;
}

interface ResolvedSettings {
	settings: Settings | undefined;
	cfg: NotificationConfig;
	settingsAvailable: boolean;
}

const defaultConfig: NotificationConfig = {
	enabled: false,
	redact: false,
	idleTimeoutMs: 60_000,
};

export function notificationsEnabled(): boolean {
	return process.env.GJC_NOTIFICATIONS === "1" || Boolean(process.env.GJC_NOTIFICATIONS_TOKEN);
}

function resolveSettings(): ResolvedSettings {
	try {
		const settings = Settings.instance;
		return { settings, cfg: getNotificationConfig(settings), settingsAvailable: true };
	} catch {
		return { settings: undefined, cfg: defaultConfig, settingsAvailable: false };
	}
}

function resolveToken(): string {
	return process.env.GJC_NOTIFICATIONS_TOKEN ?? crypto.randomBytes(24).toString("base64url");
}

function parseAnswer(answerJson: string): unknown {
	try {
		return JSON.parse(answerJson);
	} catch {
		return answerJson;
	}
}

/** Map a client answer to the option LABEL the local UI would return (or free text). */
function mapAnswerToLabel(answerJson: string, options: string[]): string | undefined {
	const answer = parseAnswer(answerJson);
	if (typeof answer === "number") return options[answer];
	if (typeof answer === "string") return answer;
	if (answer && typeof answer === "object") {
		const sel = (answer as { selected?: unknown; custom?: unknown }).selected;
		if (Array.isArray(sel) && sel.length > 0) {
			const first = sel[0];
			return typeof first === "number" ? options[first] : String(first);
		}
		const custom = (answer as { custom?: unknown }).custom;
		if (typeof custom === "string") return custom;
	}
	return undefined;
}

/** Map a client answer to the workflow-gate answer shape (unattended mode). */
function mapAnswerToGate(
	answerJson: string,
	options: string[],
): { selected: string[]; other?: boolean; custom?: string } {
	const answer = parseAnswer(answerJson);
	if (typeof answer === "number") {
		const label = options[answer];
		return label === undefined ? { selected: [], other: true, custom: String(answer) } : { selected: [label] };
	}
	if (typeof answer === "string") {
		return options.includes(answer) ? { selected: [answer] } : { selected: [], other: true, custom: answer };
	}
	if (answer && typeof answer === "object") {
		const obj = answer as { selected?: unknown; custom?: unknown };
		const selected = Array.isArray(obj.selected)
			? obj.selected.map(s => (typeof s === "number" ? (options[s] ?? String(s)) : String(s)))
			: [];
		const custom = typeof obj.custom === "string" ? obj.custom : undefined;
		return { selected, other: custom !== undefined, custom };
	}
	return { selected: [] };
}

export const createNotificationsExtension: ExtensionFactory = api => {
	const runtimes = new Map<string, SessionRuntime>();
	const disabledSessions = new Set<string>();
	const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();

	function stopSession(id: string): boolean {
		const rt = runtimes.get(id);
		if (!rt) return false;
		runtimes.delete(id);
		try {
			rt.disposeAnswerSource();
		} catch {}
		// Resolve any still-pending interactive asks so the ask tool is not left hanging.
		for (const pending of rt.pendingInteractive.values()) pending.resolve(undefined);
		rt.pendingInteractive.clear();
		try {
			rt.server.stop();
		} catch (e) {
			logger.warn(`notifications: stop failed: ${String(e)}`);
		}
		return true;
	}

	function isEnabledForSession(id: string, cfg: NotificationConfig): boolean {
		return isSessionNotificationsEnabled({ cfg, env: process.env, sessionDisabled: disabledSessions.has(id) });
	}

	async function startSession(ctx: ExtensionContext): Promise<"started" | "already" | "disabled" | "failed"> {
		const id = sessionId(ctx);
		const { settings, cfg, settingsAvailable } = resolveSettings();
		if (!isEnabledForSession(id, cfg)) return "disabled";
		if (runtimes.has(id)) return "already";

		const stateRoot = path.join(ctx.cwd, ".gjc", "state");
		const gate = ctx.workflowGate;
		const unattended =
			gate?.isUnattended?.() === true &&
			typeof gate.onGateEmitted === "function" &&
			typeof gate.resolveGate === "function";
		const gateOptions = new Map<string, string[]>();
		const pendingInteractive = new Map<string, PendingInteractiveAsk>();
		const tag = sessionTag(id);
		const redact = cfg.redact;

		// The SDK can always answer now (interactive via the answer source, or the
		// unattended gate), so the endpoint advertises a resolver.
		const server = new NotificationServer(id, resolveToken(), stateRoot, true);

		server.onReply((err, reply) => {
			if (err || !reply) return;
			// 1) Interactive ask awaiting a remote answer.
			const pending = pendingInteractive.get(reply.id);
			if (pending) {
				pendingInteractive.delete(reply.id);
				const label = mapAnswerToLabel(reply.answerJson, pending.options);
				try {
					server.resolveClient(reply.id, reply.answerJson, reply.idempotencyKey ?? undefined);
				} catch (e) {
					logger.warn(`notifications: resolveClient failed: ${String(e)}`);
				}
				pending.resolve(label);
				return;
			}
			// 2) Unattended workflow gate: resolve the real gate, then confirm.
			if (unattended && gate?.resolveGate) {
				const answer = mapAnswerToGate(reply.answerJson, gateOptions.get(reply.id) ?? []);
				gate
					.resolveGate({ gate_id: reply.id, answer, idempotency_key: reply.idempotencyKey ?? undefined })
					.then(() => server.resolveClient(reply.id, reply.answerJson, reply.idempotencyKey ?? undefined))
					.catch(e => {
						logger.warn(`notifications: resolveGate failed: ${String(e)}`);
						try {
							server.reject(reply.id, "invalid_answer");
						} catch {}
					});
				return;
			}
			// 3) No matching pending ask.
			try {
				server.reject(reply.id, "unknown_action");
			} catch (e) {
				logger.warn(`notifications: reject failed: ${String(e)}`);
			}
		});

		try {
			const endpoint = await server.start();

			// Interactive answer source: the ask tool races the local UI against this.
			const disposeAnswerSource = registerAskAnswerSource(id, {
				awaitAnswer(question, options, signal) {
					if (signal?.aborted) return Promise.resolve(undefined);
					const askId = `ask:${crypto.randomUUID()}`;
					try {
						server.registerAsk(
							JSON.stringify(
								notificationActionPayload(
									{ id: askId, kind: "ask", sessionId: id, question, options },
									{ redact, sessionTag: tag },
								),
							),
							true,
						);
					} catch (e) {
						logger.warn(`notifications: registerAsk failed: ${String(e)}`);
						return Promise.resolve(undefined);
					}
					return new Promise<string | undefined>(resolve => {
						pendingInteractive.set(askId, { resolve, options });
						signal?.addEventListener("abort", () => {
							if (!pendingInteractive.delete(askId)) return;
							// Local UI answered: mark the remote action resolved-locally.
							try {
								server.resolveLocal(askId, undefined);
							} catch {}
							resolve(undefined);
						});
					});
				},
			});

			runtimes.set(id, {
				server,
				notifiedIdleTurns: new Set(),
				pendingInteractive,
				disposeAnswerSource,
				redact,
				sessionTag: tag,
			});
			logger.info(`notifications: serving session ${id} at ${endpoint.url} (unattended=${unattended})`);

			if (settingsAvailable && settings && isGloballyConfigured(cfg)) {
				try {
					await ensureTelegramDaemonRunning({ settings, cwd: ctx.cwd, sessionId: id });
				} catch (e) {
					logger.warn(`notifications: failed to ensure Telegram daemon: ${String(e)}`);
				}
			}

			// Unattended: a real ask emits a workflow gate; register it repliable by gate_id.
			if (unattended && gate?.onGateEmitted) {
				gate.onGateEmitted(g => {
					const options = (g.options ?? []).map(o => String((o as { label?: unknown }).label ?? ""));
					gateOptions.set(g.gate_id, options);
					const promptCtx = g.context as { prompt?: unknown; title?: unknown } | undefined;
					const question =
						(typeof promptCtx?.prompt === "string" && promptCtx.prompt) ||
						(typeof promptCtx?.title === "string" && promptCtx.title) ||
						"Question";
					try {
						server.registerAsk(
							JSON.stringify(
								notificationActionPayload(
									{ id: g.gate_id, kind: "ask", sessionId: id, question, options },
									{ redact, sessionTag: tag },
								),
							),
							true,
						);
					} catch (e) {
						logger.warn(`notifications: registerAsk (gate) failed: ${String(e)}`);
					}
				});
			}
			return "started";
		} catch (e) {
			logger.warn(`notifications: failed to start server: ${String(e)}`);
			return "failed";
		}
	}

	api.registerCommand("notify", {
		description: "Control notifications for this session (on, off, status).",
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const id = sessionId(ctx);
			const command = args.trim().split(/\s+/, 1)[0]?.toLowerCase() || "status";
			const resolved = resolveSettings();
			const enabledWithoutLocalOff = isSessionNotificationsEnabled({
				cfg: resolved.cfg,
				env: process.env,
				sessionDisabled: false,
			});

			if (command === "off") {
				disabledSessions.add(id);
				const stopped = stopSession(id);
				ctx.ui.notify(
					stopped
						? "Notifications disabled for this session."
						: "Notifications already disabled for this session.",
					"info",
				);
				return;
			}

			if (command === "on") {
				if (process.env.GJC_NOTIFICATIONS === "0") {
					ctx.ui.notify(
						"Notifications remain disabled: GJC_NOTIFICATIONS=0 is an authoritative opt-out.",
						"warning",
					);
					return;
				}
				if (!enabledWithoutLocalOff) {
					ctx.ui.notify(
						"Notifications are not configured. Run `gjc notify setup` or set GJC_NOTIFICATIONS=1.",
						"warning",
					);
					return;
				}
				disabledSessions.delete(id);
				const result = await startSession(ctx);
				ctx.ui.notify(
					result === "started"
						? "Notifications enabled for this session."
						: result === "already"
							? "Notifications already enabled for this session."
							: result === "failed"
								? "Notifications failed to start for this session."
								: "Notifications are not configured. Run `gjc notify setup` or set GJC_NOTIFICATIONS=1.",
					result === "failed" ? "error" : result === "disabled" ? "warning" : "info",
				);
				return;
			}

			if (command !== "status") {
				ctx.ui.notify("Usage: /notify status | /notify on | /notify off", "warning");
				return;
			}

			const running = runtimes.has(id);
			const locallyDisabled = disabledSessions.has(id);
			const enabled = isEnabledForSession(id, resolved.cfg);
			ctx.ui.notify(
				`Notifications ${running ? "running" : enabled ? "enabled" : "disabled"} for this session; redaction ${resolved.cfg.redact ? "on" : "off"}${locallyDisabled ? "; locally off" : ""}.`,
				"info",
			);
		},
	});

	api.on("session_start", async (_event, ctx) => {
		await startSession(ctx);
	});

	api.on("turn_end", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
		const key = idleDedupeKey(id, event.turnIndex);
		if (rt.notifiedIdleTurns.has(key)) return;
		rt.notifiedIdleTurns.add(key);
		try {
			rt.server.noteIdle(
				JSON.stringify(
					notificationActionPayload(
						{
							id: `idle:${key}`,
							kind: "idle",
							sessionId: id,
							summary: summaryFromMessage(event.message),
						},
						{ redact: rt.redact, sessionTag: rt.sessionTag },
					),
				),
			);
		} catch (e) {
			logger.warn(`notifications: noteIdle failed: ${String(e)}`);
		}
	});

	api.on("session_shutdown", (_event, ctx) => {
		stopSession(sessionId(ctx));
	});
};
