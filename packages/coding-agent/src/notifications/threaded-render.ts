/**
 * Pure rendering of threaded-session frames into Telegram send specs.
 *
 * The daemon receives the additive `ServerMessage` frames (identity_header,
 * context_update, turn_stream, image_attachment, config_update) over the session
 * WS and must turn each into a Bot API call scoped to the session's forum topic
 * (`message_thread_id`), throttled through the shared rate-limit pool. This
 * module is the pure frame→send mapping (including the priority lane and live-
 * edit coalesce key), so rendering is unit-testable without a live Bot API.
 */

import { truncate } from "./helpers";
import { bold, code, escapeHtml, finalizeTelegramHtml, italic, markdownToTelegramHtml, pre } from "./html-format";
import type { RateLimitLane } from "./rate-limit-pool";

/** A Telegram send derived from a threaded frame (topic id is applied by the daemon). */
export interface ThreadedSend {
	method: "sendMessage" | "sendPhoto" | "sendDocument";
	/** Rate-limit lane for prioritisation/fairness. */
	lane: RateLimitLane;
	/** Message text (sendMessage) or photo caption (sendPhoto). */
	text?: string;
	/** Base64 image bytes for sendPhoto. */
	photoBase64?: string;
	/** Base64 file bytes for sendDocument. */
	documentBase64?: string;
	/** Image MIME type for sendPhoto. */
	mime?: string;
	/** Suggested document filename. */
	fileName?: string;
	/** Coalesce key for live edits (same key collapses to the latest). */
	coalesceKey?: string;
	/** True for the one-time identity header (the daemon pins it once). */
	identity?: boolean;
	/**
	 * When true the daemon may deliver this as an in-place edit of the message
	 * previously sent under the same `(sessionId, coalesceKey)` instead of a new
	 * message. Set for streamed turn frames so live + finalized share one message.
	 */
	editable?: boolean;
	/** Rich message class metadata. Only finalized final-answer sends are ever
	 * rich-promoted; the daemon gate (`shouldPromoteRich`) requires exactly this. */
	richClass?: "final";
	/** Rich final-answer markdown (raw). Delivery marker derived ONLY from a frame's `finalAnswer` bit; never inferred from `phase`. */
	richMarkdown?: string;
	/** Live-turn raw markdown for opt-in draft streaming (set ONLY on non-finalized turn frames; never triggers rich-final promotion, which requires `lane === "finalized"`). */
	richDraftMarkdown?: string;
}

interface ThreadedFrame {
	type?: unknown;
	sessionId?: unknown;
	// identity_header
	repo?: unknown;
	branch?: unknown;
	machine?: unknown;
	title?: unknown;
	// context_update
	lastMessage?: unknown;
	task?: unknown;
	goal?: unknown;
	tokenUsage?: unknown;
	model?: unknown;
	diff?: unknown;
	cwd?: unknown;
	// turn_stream
	phase?: unknown;
	finalAnswer?: boolean;
	text?: unknown;
	messageRef?: unknown;
	// image_attachment / file_attachment
	source?: unknown;
	data?: unknown;
	mime?: unknown;
	caption?: unknown;
	name?: unknown;
	// config_update
	verbosity?: unknown;
	redact?: unknown;
	// control_command_result
	status?: unknown;
	message?: unknown;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function isDotOnlyText(value: string): boolean {
	return /^[.\s]+$/.test(value);
}

/** Format the one-time identity header as pinned bullets. */
export function formatIdentityHeader(frame: {
	repo?: unknown;
	branch?: unknown;
	machine?: unknown;
	sessionId?: unknown;
	title?: unknown;
}): string {
	const title = str(frame.title) ?? "GJC session";
	const bullets = [
		`• repo: ${code(str(frame.repo) ?? "?")}`,
		`• branch: ${code(str(frame.branch) ?? "?")}`,
		`• machine: ${code(str(frame.machine) ?? "?")}`,
		`• session: ${code(str(frame.sessionId) ?? "?")}`,
	];
	return `${bold(title)}\n${bullets.join("\n")}`;
}

/** Format a streamed context update into a compact block (omitting empty fields). */
export function formatContextUpdate(frame: ThreadedFrame): string | undefined {
	const lines: string[] = [];
	const session = str(frame.sessionId);
	const cwd = str(frame.cwd);
	const last = str(frame.lastMessage);
	const task = str(frame.task);
	const goal = str(frame.goal);
	const usage = str(frame.tokenUsage);
	const model = str(frame.model);
	const diff = str(frame.diff);
	if (!cwd && !last && !task && !goal && !usage && !model && !diff) return undefined;
	const meta = [session ? `session: ${code(session)}` : undefined, cwd ? `cwd: ${code(cwd)}` : undefined].filter(
		Boolean,
	);
	if (meta.length > 0) lines.push(meta.join(" · "));
	if (last) lines.push(escapeHtml(truncate(last, 600)));
	if (task) lines.push(`${italic("task:")} ${escapeHtml(task)}`);
	if (goal) lines.push(`${italic("goal:")} ${escapeHtml(goal)}`);
	if (usage || model) lines.push(`ctx: ${code([usage, model].filter(Boolean).join(" · "))}`);
	if (diff) lines.push(`diff:\n${pre(truncate(diff, 1200))}`);
	return lines.join("\n");
}

/**
 * Map a threaded frame to a Telegram send spec, or `undefined` when there is
 * nothing to send (e.g. an empty context update or an unknown frame type).
 */
export function renderThreadedFrame(frame: ThreadedFrame): ThreadedSend | undefined {
	switch (frame.type) {
		case "identity_header":
			return {
				method: "sendMessage",
				lane: "finalized",
				text: finalizeTelegramHtml(formatIdentityHeader(frame)),
				identity: true,
			};
		case "context_update": {
			const text = finalizeTelegramHtml(formatContextUpdate(frame));
			return text
				? { method: "sendMessage", lane: "live", text, coalesceKey: `ctx:${str(frame.sessionId) ?? ""}` }
				: undefined;
		}
		case "turn_stream": {
			const raw = str(frame.text);
			if (!raw) return undefined;
			if (frame.phase === "finalized" && isDotOnlyText(raw)) return undefined;
			const text = markdownToTelegramHtml(raw);
			const finalized = frame.phase === "finalized";
			// A per-turn ref ties the streamed live edits and the finalized text to
			// ONE message. Without a ref (streaming off), finalized keeps its legacy
			// keyless behaviour: a fresh message per turn.
			const ref = str(frame.messageRef);
			const coalesceKey = finalized
				? ref
					? `turn:${ref}`
					: undefined
				: `turn:${ref ?? str(frame.sessionId) ?? ""}`;
			return {
				method: "sendMessage",
				lane: finalized ? "finalized" : "live",
				text,
				coalesceKey,
				editable: coalesceKey !== undefined,
				// Rich-final markers are set ONLY on a non-editable finalized final
				// (no messageRef / coalesceKey). A streamed (editable) final owns a live
				// message edited in place, so it is never rich-promoted and carries no
				// rich marker to leak into split continuations.
				richClass: frame.finalAnswer === true && coalesceKey === undefined ? "final" : undefined,
				richMarkdown: frame.finalAnswer === true && coalesceKey === undefined ? raw : undefined,
				// Live-only draft marker: carries the RAW markdown on non-finalized turn
				// frames so the opt-in draft gate has the source. It never arms rich-final
				// promotion (shouldPromoteRich requires lane === "finalized").
				richDraftMarkdown: finalized ? undefined : raw,
			};
		}
		case "image_attachment": {
			const data = str(frame.data);
			if (!data) return undefined;
			const caption = str(frame.caption);
			return {
				method: "sendPhoto",
				lane: "finalized",
				photoBase64: data,
				mime: str(frame.mime),
				text: finalizeTelegramHtml(caption === undefined ? undefined : escapeHtml(caption)),
			};
		}
		case "file_attachment": {
			const data = str(frame.data);
			if (!data) return undefined;
			const caption = str(frame.caption);
			return {
				method: "sendDocument",
				lane: "finalized",
				documentBase64: data,
				mime: str(frame.mime),
				fileName: str(frame.name),
				text: finalizeTelegramHtml(caption === undefined ? undefined : escapeHtml(caption)),
			};
		}
		case "config_update": {
			const verbosity = str(frame.verbosity);
			const redact = typeof frame.redact === "boolean" ? `redact ${frame.redact ? "on" : "off"}` : undefined;
			const parts = [verbosity ? `verbosity ${verbosity}` : undefined, redact].filter(Boolean);
			return parts.length
				? {
						method: "sendMessage",
						lane: "idle",
						text: finalizeTelegramHtml(`⚙ ${escapeHtml(parts.join(", "))}`),
					}
				: undefined;
		}
		case "control_command_result": {
			const message = str(frame.message);
			if (!message) return undefined;
			const status = str(frame.status);
			const prefix = status === "ok" ? "✅" : status === "unavailable" ? "⚠️" : "❌";
			return {
				method: "sendMessage",
				lane: "idle",
				text: finalizeTelegramHtml(`${prefix} ${escapeHtml(truncate(message, 1200))}`),
			};
		}
		default:
			return undefined;
	}
}
