import { buildRedactedAction, type RedactableAction } from "./config";

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
	sessionTag: (sessionId: string) => string;
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
		if (event.type !== "action_needed") return event;
		return {
			...buildRedactedAction(event, {
				redact: this.opts.redact,
				sessionTag: this.opts.sessionTag(event.sessionId),
			}),
			type: "action_needed",
		};
	}
}
