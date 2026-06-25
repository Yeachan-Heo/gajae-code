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

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ImageContent, TextContent } from "@gajae-code/ai";
import { NotificationServer } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import { Settings } from "../config/settings";
import type { ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { registerAskAnswerSource } from "../tools/ask-answer-registry";
import { registerTelegramFileSink } from "./attachment-registry";
import {
	getNotificationConfig,
	isGloballyConfigured,
	isSessionNotificationsEnabled,
	type NotificationConfig,
	sessionTag,
} from "./config";
import { imageAttachmentsFromMessage, notificationActionPayload, summaryFromMessage } from "./helpers";
import { ensureTelegramDaemonRunning } from "./telegram-daemon";

/** Resolve the git dir for `cwd`, handling worktrees where `.git` is a file. */
function gitDir(cwd: string): string | undefined {
	const dot = path.join(cwd, ".git");
	try {
		if (fs.statSync(dot).isDirectory()) return dot;
		const m = fs
			.readFileSync(dot, "utf8")
			.trim()
			.match(/^gitdir:\s*(.+)$/);
		if (m) return path.resolve(cwd, m[1]);
	} catch {}
	return undefined;
}

/** Best-effort current branch from `.git/HEAD` (no git spawn). */
function readGitBranch(cwd: string): string | undefined {
	const gd = gitDir(cwd);
	if (!gd) return undefined;
	try {
		const head = fs.readFileSync(path.join(gd, "HEAD"), "utf8").trim();
		const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
		return m ? m[1] : head.slice(0, 12);
	} catch {
		return undefined;
	}
}

/** Resolve the shared git dir (the main repo's `.git`) for a possibly-linked worktree. */
function gitCommonDir(gd: string): string {
	try {
		const raw = fs.readFileSync(path.join(gd, "commondir"), "utf8").trim();
		if (raw) return path.resolve(gd, raw);
	} catch {}
	return gd;
}

/**
 * Best-effort real repository name (no git spawn): resolves the main worktree
 * root directory so linked worktrees report the repo (e.g. `gajae-code`)
 * instead of the worktree directory (e.g. `feat-foo-01047f11`).
 */
export function readGitRepoName(cwd: string): string | undefined {
	const gd = gitDir(cwd);
	if (!gd) return undefined;
	const commonDir = gitCommonDir(gd);
	// Strip the trailing `.git` to land on the main worktree root directory.
	const repoRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
	const name = path.basename(repoRoot);
	return name && name !== ".git" ? name : undefined;
}

/** Build the one-time identity header fields for a session thread. */
function buildIdentity(
	cwd: string,
	sessionName?: string,
): {
	repo: string;
	branch: string;
	machine: string;
	title?: string;
} {
	const repo = readGitRepoName(cwd) ?? (path.basename(cwd) || cwd);
	const branch = readGitBranch(cwd) ?? "(detached)";
	// Send repo/branch and the raw session title separately; the consumer
	// composes the topic name ("{repo}/{branch}" before the session title is
	// auto-generated, then "{repo}/{branch} - {session title}" once it exists).
	return { repo, branch, machine: os.hostname(), title: sessionName };
}

const execFileAsync = promisify(execFile);

/** Best-effort working-tree diff stat for the context update (no throw). */
async function readGitDiffStat(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, "diff", "--stat", "--no-color"], {
			timeout: 3000,
			maxBuffer: 256 * 1024,
		});
		const trimmed = stdout.trim();
		return trimmed ? trimmed.slice(0, 1500) : undefined;
	} catch {
		return undefined;
	}
}

interface PendingInteractiveAsk {
	resolve: (label: string | undefined) => void;
	options: string[];
}

interface SessionRuntime {
	server: NotificationServer;
	idleSeq: number;
	/** Interactive asks awaiting a remote answer, by action id. */
	pendingInteractive: Map<string, PendingInteractiveAsk>;
	/** Deregisters this session's ask answer source. */
	disposeAnswerSource: () => void;
	/** Deregisters this session's Telegram file sink. */
	disposeFileSink: () => void;
	redact: boolean;
	verbosity: "lean" | "verbose";
	sessionTag: string;
	/** Whether the agent loop is currently running (drives the typing indicator). */
	busy: boolean;
	/** Inbound Telegram update ids injected but not yet consumed by a turn. */
	pendingInbound: Set<number>;
	/** Latest assistant text of the in-flight turn (from message_update). */
	currentTurnText?: string;
	/** Assistant text already flushed before an ask this turn (turn-scoped dedupe
	 * so turn_end does not re-emit the pre-ask lead-in). Reset each turn. */
	preAskFlushedText?: string;
}

interface ResolvedSettings {
	settings: Settings | undefined;
	cfg: NotificationConfig;
	settingsAvailable: boolean;
}

const defaultConfig: NotificationConfig = {
	enabled: false,
	botToken: undefined,
	chatId: undefined,
	discord: {
		botToken: undefined,
		channelId: undefined,
	},
	slack: {
		botToken: undefined,
		channelId: undefined,
	},
	redact: false,
	verbosity: "lean",
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

/** Register the interactive `ask` answer source for a session (the ask tool
 * races the local UI against a remote reply). Returns the deregister disposer. */
function registerInteractiveAnswerSource(
	id: string,
	server: NotificationServer,
	pendingInteractive: Map<string, PendingInteractiveAsk>,
	getRedact: () => boolean,
	tag: string,
): () => void {
	return registerAskAnswerSource(id, {
		awaitAnswer(question, options, signal) {
			if (signal?.aborted) return Promise.resolve(undefined);
			const askId = `ask:${crypto.randomUUID()}`;
			try {
				server.registerAsk(
					JSON.stringify(
						notificationActionPayload(
							{ id: askId, kind: "ask", sessionId: id, question, options },
							{ redact: getRedact(), sessionTag: tag },
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
}

/** Extract the session id from a `<timestamp>_<uuid>.jsonl` session file path. */
function sessionIdFromFile(file: string | undefined): string | undefined {
	if (!file) return undefined;
	const base = path.basename(file).replace(/\.jsonl$/, "");
	const underscore = base.indexOf("_");
	return underscore >= 0 ? base.slice(underscore + 1) : undefined;
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
			rt.disposeFileSink();
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
		const verbosity = cfg.verbosity;
		let runtime: SessionRuntime | undefined;

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

		// Inbound free-text injection / in-thread config command from a session
		// thread (forwarded by the daemon over the WS, fail-closed at the daemon).
		server.onInbound((err, inbound) => {
			if (err || !inbound) return;
			if (inbound.kind === "user_message") {
				// Inject as a user turn (steers/continues the agent; the resulting
				// turn streams back via the turn_end handler even when not idle).
				// Record the update id so it can be acked as "consumed" on the next
				// turn_start, and steer (vs start a fresh turn) when already busy.
				const text = inbound.text ?? "";
				const images = inbound.images ?? [];
				if (!text && images.length === 0) return;
				if (runtime && typeof inbound.updateId === "number") runtime.pendingInbound.add(inbound.updateId);
				const content: string | (TextContent | ImageContent)[] =
					images.length > 0
						? [
								...(text ? [{ type: "text", text } as TextContent] : []),
								...images.map(
									img =>
										({ type: "image", data: img.data, mimeType: img.mime ?? "image/jpeg" }) as ImageContent,
								),
							]
						: text;
				try {
					api.sendUserMessage(content, runtime?.busy ? { deliverAs: "steer" } : undefined);
				} catch (e) {
					logger.warn(`notifications: sendUserMessage failed: ${String(e)}`);
				}
				return;
			}
			if (inbound.kind === "config_command") {
				if (!runtime) return;
				const update: {
					type: "config_update";
					sessionId: string;
					verbosity?: "lean" | "verbose";
					redact?: boolean;
				} = {
					type: "config_update",
					sessionId: id,
				};
				if (inbound.verbosity === "lean" || inbound.verbosity === "verbose") {
					runtime.verbosity = inbound.verbosity;
					update.verbosity = inbound.verbosity;
				}
				if (typeof inbound.redact === "boolean") {
					runtime.redact = inbound.redact;
					update.redact = inbound.redact;
				}
				if (update.verbosity !== undefined || update.redact !== undefined) {
					try {
						runtime.server.pushFrame(JSON.stringify(update));
					} catch (e) {
						logger.warn(`notifications: config_update failed: ${String(e)}`);
					}
				}
			}
		});

		try {
			const endpoint = await server.start();

			// Interactive answer source: the ask tool races the local UI against this.
			const disposeAnswerSource = registerInteractiveAnswerSource(
				id,
				server,
				pendingInteractive,
				() => runtime?.redact ?? redact,
				tag,
			);
			const disposeFileSink = registerTelegramFileSink(id, async file => {
				try {
					const data = await fs.promises.readFile(file.path);
					server.pushFrame(
						JSON.stringify({
							type: "file_attachment",
							sessionId: id,
							name: path.basename(file.path),
							data: data.toString("base64"),
							caption: file.caption,
						}),
					);
					return { ok: true };
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			});

			runtime = {
				server,
				idleSeq: 0,
				pendingInteractive,
				disposeAnswerSource,
				disposeFileSink,
				redact,
				verbosity,
				sessionTag: tag,
				busy: false,
				pendingInbound: new Set<number>(),
			};
			runtimes.set(id, runtime);
			logger.info(`notifications: serving session ${id} at ${endpoint.url} (unattended=${unattended})`);

			if (settingsAvailable && settings && isGloballyConfigured(cfg)) {
				try {
					await ensureTelegramDaemonRunning({ settings, cwd: ctx.cwd, sessionId: id });
				} catch (e) {
					logger.warn(`notifications: failed to ensure Telegram daemon: ${String(e)}`);
				}
			}

			// One-time identity header (repo/branch/machine/session) pinned at the top
			// of the session thread by the daemon.
			try {
				server.pushFrame(
					JSON.stringify({
						type: "identity_header",
						sessionId: id,
						...buildIdentity(ctx.cwd, ctx.sessionManager.getSessionName()),
					}),
				);
			} catch (e) {
				logger.warn(`notifications: identity_header failed: ${String(e)}`);
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
			const runtime = runtimes.get(id);
			ctx.ui.notify(
				`Notifications ${running ? "running" : enabled ? "enabled" : "disabled"} for this session; redaction ${(runtime?.redact ?? resolved.cfg.redact) ? "on" : "off"}; verbosity ${runtime?.verbosity ?? resolved.cfg.verbosity}${locallyDisabled ? "; locally off" : ""}.`,
				"info",
			);
		},
	});

	api.on("session_start", async (_event, ctx) => {
		await startSession(ctx);
	});

	// A session id change within the same process needs reason-aware handling.
	// `/new` and fork CONTINUE the same terminal thread (e.g. plan "approve and
	// execute" clears into a fresh session), so re-key the existing runtime
	// old→new WITHOUT recreating the NotificationServer: the server, its endpoint
	// discovery file, and the daemon's forum topic are all keyed by the original
	// session id and the daemon routes by socket, so the existing topic is reused
	// and the next identity frame renames it in place instead of spawning a new
	// thread. `resume`, by contrast, loads a DIFFERENT, already-persisted session
	// that owns its own topic — tear the previous runtime down and start fresh
	// under the resumed id so the daemon attaches to (or recreates) that
	// session's own discovery + topic rather than hijacking this terminal's.
	api.on("session_switch", async (event, ctx) => {
		const newId = sessionId(ctx);
		const prevId = sessionIdFromFile(event.previousSessionFile);
		if (!prevId || prevId === newId) return;

		if (event.reason === "resume") {
			stopSession(prevId);
			await startSession(ctx);
			return;
		}

		// `/new` / fork: re-key in place and rename the existing topic.
		if (disabledSessions.delete(prevId)) disabledSessions.add(newId);
		const rt = runtimes.get(prevId);
		if (!rt || runtimes.has(newId)) return;
		runtimes.delete(prevId);
		runtimes.set(newId, rt);
		// Re-bind the interactive ask answer source: the ask tool resolves the
		// source by the current session id, which just changed.
		try {
			rt.disposeAnswerSource();
			rt.disposeFileSink();
		} catch {}
		rt.disposeAnswerSource = registerInteractiveAnswerSource(
			newId,
			rt.server,
			rt.pendingInteractive,
			() => rt.redact,
			rt.sessionTag,
		);
		rt.disposeFileSink = registerTelegramFileSink(newId, async file => {
			try {
				const data = await fs.promises.readFile(file.path);
				rt.server.pushFrame(
					JSON.stringify({
						type: "file_attachment",
						sessionId: newId,
						name: path.basename(file.path),
						data: data.toString("base64"),
						caption: file.caption,
					}),
				);
				return { ok: true };
			} catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
		});
		// Rename the existing topic now when the new session already has a name; a
		// fresh unnamed session is renamed on its next agent_end re-assert, which
		// avoids a transient rename to bare "repo/branch".
		if (ctx.sessionManager.getSessionName()) {
			try {
				rt.server.pushFrame(
					JSON.stringify({
						type: "identity_header",
						sessionId: newId,
						...buildIdentity(ctx.cwd, ctx.sessionManager.getSessionName()),
					}),
				);
			} catch (e) {
				logger.warn(`notifications: identity_header (switch) failed: ${String(e)}`);
			}
		}
	});

	// Drive the live typing indicator: mark busy when the agent loop starts so
	// the daemon shows "typing…" in the thread while the agent is thinking,
	// before any turn output exists. Cleared on `agent_end` below.
	api.on("agent_start", (_event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
		rt.busy = true;
		try {
			rt.server.pushFrame(JSON.stringify({ type: "activity", sessionId: id, state: "busy" }));
		} catch (e) {
			logger.warn(`notifications: activity (busy) failed: ${String(e)}`);
		}
	});

	// Each turn that starts has absorbed any messages injected from the thread,
	// so ack them as "consumed": the daemon flips the queued reaction on the
	// originating Telegram message to the consumed (double-check) reaction.
	api.on("turn_start", (_event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt || rt.pendingInbound.size === 0) return;
		for (const updateId of rt.pendingInbound) {
			try {
				rt.server.pushFrame(JSON.stringify({ type: "inbound_ack", sessionId: id, updateId, state: "consumed" }));
			} catch (e) {
				logger.warn(`notifications: inbound_ack failed: ${String(e)}`);
			}
		}
		rt.pendingInbound.clear();
	});

	// Idle fires on `agent_end` (the agent loop settling to await the user), NOT
	// per `turn_end`. turn_end fires once per turn iteration, so a single
	// user-visible idle previously produced many idle pings (the flood); agent_end
	// fires exactly once per settle, yielding exactly one idle notification.
	api.on("agent_end", (_event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
		const seq = rt.idleSeq++;
		// Clear the typing indicator: the agent loop has settled.
		rt.busy = false;
		try {
			rt.server.pushFrame(JSON.stringify({ type: "activity", sessionId: id, state: "idle" }));
		} catch (e) {
			logger.warn(`notifications: activity (idle) failed: ${String(e)}`);
		}
		// Re-assert the identity header so the daemon renames the topic once the
		// session title has been auto-generated ("{repo}/{branch} - {title}"). The
		// daemon only renames when the title actually changed.
		try {
			rt.server.pushFrame(
				JSON.stringify({
					type: "identity_header",
					sessionId: id,
					...buildIdentity(ctx.cwd, ctx.sessionManager.getSessionName()),
				}),
			);
		} catch {}
		try {
			rt.server.noteIdle(
				JSON.stringify(
					notificationActionPayload(
						{
							id: `idle:${id}#${seq}`,
							kind: "idle",
							sessionId: id,
							summary: undefined,
						},
						{ redact: rt.redact, sessionTag: rt.sessionTag },
					),
				),
			);
		} catch (e) {
			logger.warn(`notifications: noteIdle failed: ${String(e)}`);
		}

		// On idle, stream a context update with metadata (token/model usage +
		// working-tree diff) unless redaction is on. The agent's last message is
		// NOT repeated here — it is already streamed once via `turn_stream`.
		if (!rt.redact && rt.verbosity === "verbose") {
			const usage = (
				ctx as { getContextUsage?: () => { tokens: number | null; contextWindow: number } | undefined }
			).getContextUsage?.();
			const model = (ctx as { getModel?: () => { id?: string } | undefined }).getModel?.();
			const tokenUsage = usage && usage.tokens != null ? `${usage.tokens}/${usage.contextWindow}` : undefined;
			const modelId = model?.id;
			void readGitDiffStat(ctx.cwd).then(diff => {
				if (!diff && !tokenUsage && !modelId) return;
				try {
					rt.server.pushFrame(
						JSON.stringify({
							type: "context_update",
							sessionId: id,
							tokenUsage,
							model: modelId,
							diff,
						}),
					);
				} catch (e) {
					logger.warn(`notifications: context_update failed: ${String(e)}`);
				}
			});
		}
	});

	// Stream viable agent output per turn (the live thread mirror). Unlike idle,
	// turn output is expected to be multiple messages — one per turn that
	// produced assistant text. Tool-only turns yield no text and are skipped.
	// Redaction suppresses streamed content (only the one-time identity header
	// survives redaction). The daemon coalesces/throttles these via its shared
	// rate-limit pool before sending to Telegram.
	// Push the in-flight turn's assistant text as a finalized turn_stream, deduped
	// against what was already flushed for this turn (the pre-ask lead-in).
	const flushTurnText = (rt: SessionRuntime, id: string, text: string | undefined): void => {
		if (!text || text === rt.preAskFlushedText) return;
		rt.preAskFlushedText = text;
		try {
			rt.server.pushFrame(JSON.stringify({ type: "turn_stream", sessionId: id, phase: "finalized", text }));
		} catch (e) {
			logger.warn(`notifications: pushFrame (turn) failed: ${String(e)}`);
		}
	};

	// Emit the assistant text that precedes an ask BEFORE the ask's action_needed
	// is broadcast, so the remote (e.g. Telegram) shows the lead-in first instead
	// of only after the ask resolves at turn_end. The text is captured on
	// message_end (which, like tool_execution_start, is on the awaited extension
	// path and ordered before it — unlike message_update, which is queued async),
	// then flushed here before the ask tool's execute calls registerAsk.
	api.on("tool_execution_start", (event, ctx) => {
		if (event.toolName !== "ask") return;
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt || rt.redact) return;
		flushTurnText(rt, id, rt.currentTurnText);
	});

	api.on("turn_end", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
		const text = rt.redact ? undefined : summaryFromMessage(event.message, 3500);
		if (text) flushTurnText(rt, id, text);
		// Reset per-turn streaming state so the next turn starts fresh and a later
		// turn with identical text is not falsely deduped.
		rt.currentTurnText = undefined;
		rt.preAskFlushedText = undefined;
	});

	// Stream agent-produced images (computer/browser/tool screenshots) as
	// image_attachment frames; suppressed when redaction is on.
	api.on("message_end", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt || rt.redact) return;
		// Capture the in-flight ASSISTANT text here (message_end is on the awaited
		// extension path and ordered before tool_execution_start) so the pre-ask
		// flush can emit it before the ask prompt. Role-scoped: message_end also
		// fires for the user prompt, which must never be mirrored back as turn output.
		if ((event.message as { role?: unknown }).role === "assistant") {
			const turnText = summaryFromMessage(event.message, 3500);
			if (turnText) rt.currentTurnText = turnText;
		}
		for (const img of imageAttachmentsFromMessage(event.message)) {
			try {
				rt.server.pushFrame(
					JSON.stringify({
						type: "image_attachment",
						sessionId: id,
						source: img.source,
						mime: img.mime,
						data: img.data,
					}),
				);
			} catch (e) {
				logger.warn(`notifications: image_attachment failed: ${String(e)}`);
			}
		}
	});

	api.on("session_shutdown", (_event, ctx) => {
		stopSession(sessionId(ctx));
	});
};
