import {
	type NotificationVerbosity,
	type VisibleDeliveryClass,
	type VisibleDeliveryInput,
	classifyVisibleDelivery,
	mayCreateVisiblePayload,
} from "./notification-verbosity";
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
	/**
	 * Default verbosity applied to a session when {@link connectSession} is
	 * called without an explicit seed. Defaults to `"lean"`. Sessions with no
	 * registered policy at {@link NotificationPresentationEngine.fanout} time
	 * fail closed under `"quiet"`.
	 */
	defaultVerbosity?: NotificationVerbosity;
}

/**
 * Per-session notification policy. `policyGeneration` is monotonic: each
 * successful {@link NotificationPresentationEngine.setSessionVerbosity} call
 * increments it, so callers can reject stale config_update frames by comparing
 * generations.
 */
export interface SessionNotificationPolicy {
	verbosity: NotificationVerbosity;
	policyGeneration: number;
}

/** Fail-closed default for a session with no registered policy. */
const FAIL_CLOSED_VERBOSITY: NotificationVerbosity = "quiet";

function frameTypeOf(event: NotificationEvent): string | undefined {
	return event.type === "frame" && typeof event.frame.type === "string" ? event.frame.type : undefined;
}

function deliveryInputFor(event: NotificationEvent): VisibleDeliveryInput {
	if (event.type === "action_needed") return { frameType: "action_needed", actionKind: event.kind };
	if (event.type === "frame") {
		const frameType = frameTypeOf(event);
		return {
			frameType,
			userInitiated: frameType === "control_command_result",
			explicitAttachment: frameType === "file_attachment" || frameType === "image_attachment",
		};
	}
	return {};
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
	/**
	 * Per-session notification policy, keyed by sessionId (never process-global).
	 * A session with no entry at fanout time fails closed under quiet.
	 */
	private readonly policies = new Map<string, SessionNotificationPolicy>();
	/** Monotonic global counter seeding each session's policy generation. */
	private policyGenerationCounter = 0;

	constructor(
		adapters: readonly NotificationPresentationAdapter[],
		private readonly opts: NotificationEngineOptions,
	) {
		this.adapters = adapters;
	}

	connectSession(sessionId: string, sink: EngineSessionSink, seedVerbosity?: NotificationVerbosity): void {
		this.sessions.set(sessionId, sink);
		const verbosity = seedVerbosity ?? this.opts.defaultVerbosity ?? "lean";
		if (!this.policies.has(sessionId)) this.policies.set(sessionId, { verbosity, policyGeneration: ++this.policyGenerationCounter });
	}

	dropSession(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.policies.delete(sessionId);
		for (const [key, route] of this.pending) {
			if (route.sessionId === sessionId) this.pending.delete(key);
		}
	}

	/**
	 * Strictly update one session's verbosity. Returns the new monotonic policy
	 * generation, or `undefined` when the session is not connected. Stale
	 * callers compare the returned generation against a captured baseline to
	 * reject regressive updates.
	 */
	setSessionVerbosity(sessionId: string, verbosity: NotificationVerbosity): number | undefined {
		if (!this.sessions.has(sessionId)) return undefined;
		const next = ++this.policyGenerationCounter;
		this.policies.set(sessionId, { verbosity, policyGeneration: next });
		return next;
	}

	/** Read-only snapshot of a session's policy; undefined when not connected. */
	getSessionPolicy(sessionId: string): SessionNotificationPolicy | undefined {
		const policy = this.policies.get(sessionId);
		return policy ? { verbosity: policy.verbosity, policyGeneration: policy.policyGeneration } : undefined;
	}

	fanout(event: NotificationEvent): NotificationAdapterPayload[] {
		const safeEvent = this.redactEvent(event);
		if (safeEvent.type === "action_needed" && safeEvent.kind === "ask") {
			this.pending.set(safeEvent.id, { sessionId: safeEvent.sessionId, actionId: safeEvent.id });
		}
		if (safeEvent.type === "action_resolved") {
			this.pending.delete(safeEvent.id);
		}
		const policy = this.policies.get(safeEvent.sessionId);
		const verbosity = policy?.verbosity ?? FAIL_CLOSED_VERBOSITY;
		const deliveryClass: VisibleDeliveryClass = classifyVisibleDelivery(deliveryInputFor(safeEvent));
		if (!mayCreateVisiblePayload(verbosity, deliveryClass)) return [];
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
