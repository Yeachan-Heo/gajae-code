import { redactCrashSecrets, replaceAbsolutePaths } from "@gajae-code/utils";
import { buildRedactedAction, type RedactableAction } from "./config";

/**
 * Outbound crash scrub (`redactCrashSecrets`, then `replaceAbsolutePaths`).
 * One scanner holds each http(s) URL from scheme:// up to whitespace, a
 * closing quote or backtick, or chat markup (`>` or a Slack `|`).
 * Balanced `()` and `[]` stay inside that span, and nothing inside the span
 * is path-masked. Text after that markup is still path-masked.
 * Each span is copied once. The surrounding text is path-masked on its own,
 * so a path glued to a link cannot consume the link.
 * Ask question and options stay unchanged so distinct choices remain readable.
 * Runs before adapter truncation.
 */
function redactEgressText(value: string): string {
	const scrubbed = redactCrashSecrets(value);
	let out = "";
	let cursor = 0;
	for (const match of scrubbed.matchAll(/https?:\/\//gi)) {
		const start = match.index ?? 0;
		if (start < cursor) continue;
		const prev = start > 0 ? scrubbed.charAt(start - 1) : "";
		if (prev !== "" && /[A-Za-z0-9+.-]/.test(prev)) continue;
		const end = httpUrlEnd(scrubbed, start);
		out += replaceAbsolutePaths(scrubbed.slice(cursor, start));
		out += scrubbed.slice(start, end);
		cursor = end;
	}
	out += replaceAbsolutePaths(scrubbed.slice(cursor));
	return out;
}

/** End of one URL span. An unmatched `)` or `]` ends the span before that character. Chat markup `>` and Slack `|` end it too. */
function httpUrlEnd(value: string, start: number): number {
	const stack: string[] = [];
	let index = start;
	while (index < value.length) {
		const ch = value.charAt(index);
		if (/\s/u.test(ch) || ch === '"' || ch === "'" || ch === "`" || ch === ">" || ch === "|") break;
		if (ch === "(" || ch === "[") {
			stack.push(ch);
			index += 1;
			continue;
		}
		if (ch === ")" || ch === "]") {
			const open = ch === ")" ? "(" : "[";
			if (stack.length > 0 && stack[stack.length - 1] === open) {
				stack.pop();
				index += 1;
				continue;
			}
			break;
		}
		index += 1;
	}
	return index;
}

/** Own data fields only. `__proto__` assignment must not publish inherited text. */
function copyOwnFrameFields(frame: Record<string, unknown>, redact: boolean): Record<string, unknown> {
	const out = Object.create(null) as Record<string, unknown>;
	for (const key of Object.getOwnPropertyNames(frame)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		const desc = Object.getOwnPropertyDescriptor(frame, key);
		if (!desc || !Object.hasOwn(desc, "value")) continue;
		const value = redact && typeof desc.value === "string" ? redactEgressText(desc.value) : desc.value;
		Object.defineProperty(out, key, {
			value,
			enumerable: desc.enumerable === true,
			writable: true,
			configurable: true,
		});
	}
	return out;
}

/**
 * Stored Discord/Slack provider text on the way to the provider.
 * A proven ask, or an explicit redact opt-out, stays literal. Scrubbing the same text again does not change it.
 * A frame body that is not a string never reaches this function; the daemon
 * refuses that dispatch instead of sending it.
 */
export function scrubReplayedProviderText(effectId: string, value: string, trustedAsk = false): string {
	if (trustedAsk || effectId.startsWith("action:") || effectId.startsWith("action-publication:")) return value;
	return redactEgressText(value);
}

export type NotificationEvent =
	| ({ type: "action_needed" } & RedactableAction)
	| { type: "action_resolved"; id: string; sessionId: string; resolvedBy?: string }
	| { type: "frame"; sessionId: string; frame: Record<string, unknown> };

export interface NotificationReplyRoute {
	sessionId: string;
	actionId: string;
	answer: number | string | { selected?: Array<number | string>; custom?: string };
}

export interface NotificationAdapterPayload {
	adapter: string;
	channelKey?: string;
	body: unknown;
	route?: Omit<NotificationReplyRoute, "answer">;
}

export interface NotificationPresentationAdapter {
	readonly kind: "telegram" | "discord" | "slack";
	render(event: NotificationEvent): NotificationAdapterPayload[];
	mapInbound(input: unknown): NotificationReplyRoute | undefined;
}

export interface EngineSessionSink {
	sendReply(route: NotificationReplyRoute): void;
}

export interface NotificationEngineOptions {
	redact: boolean;
}

/**
 * Shared presentation engine for managed notification clients.
 *
 * It owns fanout, redaction boundaries, pending-action routing, and reply
 * delivery into session sinks. Transport adapters stay pure: render an internal
 * event into a public-safe payload and map an inbound transport interaction
 * back into a session/action answer.
 */
export class NotificationPresentationEngine {
	readonly adapters: readonly NotificationPresentationAdapter[];
	private readonly sessions = new Map<string, EngineSessionSink>();
	private readonly pending = new Map<string, { sessionId: string; actionId: string }>();

	constructor(
		adapters: readonly NotificationPresentationAdapter[],
		private readonly opts: NotificationEngineOptions,
	) {
		this.adapters = adapters;
	}

	connectSession(sessionId: string, sink: EngineSessionSink): void {
		this.sessions.set(sessionId, sink);
	}

	dropSession(sessionId: string): void {
		this.sessions.delete(sessionId);
		for (const [key, route] of this.pending) {
			if (route.sessionId === sessionId) this.pending.delete(key);
		}
	}

	fanout(event: NotificationEvent): NotificationAdapterPayload[] {
		const safeEvent = this.redactEvent(event);
		if (safeEvent.type === "action_needed" && safeEvent.kind === "ask") {
			this.pending.set(safeEvent.id, { sessionId: safeEvent.sessionId, actionId: safeEvent.id });
		}
		if (safeEvent.type === "action_resolved") {
			this.pending.delete(safeEvent.id);
		}
		return this.adapters.flatMap(adapter => adapter.render(safeEvent));
	}

	routeInbound(adapterKind: NotificationPresentationAdapter["kind"], input: unknown): boolean {
		const adapter = this.adapters.find(candidate => candidate.kind === adapterKind);
		const route = adapter?.mapInbound(input);
		if (!route) return false;
		const pending = this.pending.get(route.actionId);
		if (!pending || pending.sessionId !== route.sessionId) return false;
		const sink = this.sessions.get(route.sessionId);
		if (!sink) return false;
		sink.sendReply(route);
		return true;
	}

	private redactEvent(event: NotificationEvent): NotificationEvent {
		if (event.type === "frame") {
			return { ...event, frame: copyOwnFrameFields(event.frame, this.opts.redact) };
		}
		if (event.type !== "action_needed") return event;
		// Asks stay fully readable. buildRedactedAction already returns them unchanged.
		return {
			...buildRedactedAction(event, { redact: this.opts.redact }),
			type: "action_needed",
		};
	}
}
