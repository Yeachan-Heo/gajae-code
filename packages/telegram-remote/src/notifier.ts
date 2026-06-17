import { findSessionView } from "./projection";
import type { Subscription, SubscriptionStore } from "./subscriptions";
import type { ChatReply, CoordinatorClient, CoordinatorRoutingEvent, SessionStatus, SessionView } from "./types";

export interface NotifierDeps {
	coordinator: CoordinatorClient;
	outbound: { send(message: { chatId: string; reply: ChatReply }): Promise<{ ok: boolean; retryAfterMs?: number }> };
	subscriptions: SubscriptionStore;
	renderCard(rawSessionId: string, view: SessionView, sub: { chatId: string; userId: string | null }): ChatReply;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	longPollMs?: number;
	digestThreshold?: number;
	logger?: (event: string, fields?: Record<string, number | string>) => void;
}

type PendingNotification = {
	seq: number;
	sessionId: string;
	status: NotifyState;
	view: SessionView;
	followers: Subscription[];
};

type NotifyState = Extract<SessionStatus, "blocked" | "waiting_for_input" | "failed" | "done">;

const NOTIFY_KINDS = [
	"session.state_changed",
	"turn.waiting_for_answer",
	"turn.completed",
	"turn.failed",
	"turn.cancelled",
] as const;
const LIMIT = 100;
const DEFAULT_LONG_POLL_MS = 25_000;
const DEFAULT_DIGEST_THRESHOLD = 5;
const BACKOFF_MS = 1_000;

export class TelegramRemoteNotifier {
	private readonly coordinator: CoordinatorClient;
	private readonly outbound: NotifierDeps["outbound"];
	private readonly subscriptions: SubscriptionStore;
	private readonly renderCard: NotifierDeps["renderCard"];
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly longPollMs: number;
	private readonly digestThreshold: number;
	private readonly logger?: NotifierDeps["logger"];
	private stopping = false;
	private running: Promise<void> | null = null;

	constructor(deps: NotifierDeps) {
		this.coordinator = deps.coordinator;
		this.outbound = deps.outbound;
		this.subscriptions = deps.subscriptions;
		this.renderCard = deps.renderCard;
		this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
		this.longPollMs = deps.longPollMs ?? DEFAULT_LONG_POLL_MS;
		this.digestThreshold = deps.digestThreshold ?? DEFAULT_DIGEST_THRESHOLD;
		this.logger = deps.logger;
	}

	start(): Promise<void> {
		if (!this.running) {
			this.stopping = false;
			this.running = this.loop().finally(() => {
				this.running = null;
			});
		}
		return this.running;
	}

	stop(): void {
		this.stopping = true;
	}

	private async loop(): Promise<void> {
		while (!this.stopping) {
			const progressed = await this.pollDrain(this.longPollMs);
			if (!progressed && !this.stopping) await this.sleep(0);
		}
	}

	private async pollDrain(timeoutMs: number): Promise<boolean> {
		let cursor = this.subscriptions.getCursor();
		let drainTimeout = timeoutMs;
		const processed = new Set<string>();
		let progressed = false;
		while (!this.stopping) {
			const result = await this.coordinator.watchEvents?.({
				afterSeq: cursor,
				eventTypes: [...NOTIFY_KINDS],
				timeoutMs: drainTimeout,
				limit: LIMIT,
			});
			if (!result?.ok) {
				this.logger?.("watch_failed", { reason: result?.reason ?? "unavailable" });
				await this.sleep(BACKOFF_MS);
				return progressed;
			}
			if (result.events.length === 0) return progressed;
			const page = [...result.events].sort((a, b) => a.seq - b.seq);
			const advanced = await this.processPage(page, processed);
			if (advanced > cursor) {
				await this.subscriptions.setCursor(advanced);
				cursor = advanced;
				progressed = true;
			}
			if (page.length < LIMIT || advanced < page[page.length - 1]!.seq) return progressed;
			drainTimeout = 0;
		}
		return progressed;
	}

	private async processPage(events: CoordinatorRoutingEvent[], processed: Set<string>): Promise<number> {
		const eligible = new Set<number>();
		const pending: PendingNotification[] = [];
		const status = await this.coordinator.getCoordinationStatus();
		for (const event of events) {
			if (!event.sessionId) {
				eligible.add(event.seq);
				continue;
			}
			const followers = await this.subscriptions.followers(event.sessionId);
			if (followers.length === 0) {
				eligible.add(event.seq);
				continue;
			}
			if (!status.ok) break;
			const view = findSessionView(status, event.sessionId);
			if (!view) {
				eligible.add(event.seq);
				continue;
			}
			const notifyState = toNotifyState(view.status);
			if (!notifyState) {
				eligible.add(event.seq);
				continue;
			}
			const key = `${event.sessionId}::${notifyState}`;
			if (processed.has(key)) {
				eligible.add(event.seq);
				continue;
			}
			processed.add(key);
			pending.push({ seq: event.seq, sessionId: event.sessionId, status: notifyState, view, followers });
		}

		const delivered = await this.deliverPending(pending);
		for (const seq of delivered) eligible.add(seq);
		let cursor = this.subscriptions.getCursor();
		for (const event of events) {
			if (!eligible.has(event.seq)) break;
			cursor = event.seq;
		}
		return cursor;
	}

	private async deliverPending(pending: PendingNotification[]): Promise<Set<number>> {
		const byChat = new Map<string, Array<{ item: PendingNotification; sub: Subscription }>>();
		// Required follower chats per event seq: a seq is only deliverable once EVERY chat that
		// follows it has been delivered/coalesced. This prevents the cursor advancing past an event
		// when one of several follower chats failed (multi-chat partial-delivery).
		const requiredChats = new Map<number, Set<string>>();
		for (const item of pending) {
			const chats = requiredChats.get(item.seq) ?? new Set<string>();
			for (const sub of item.followers) {
				chats.add(sub.chatId);
				const list = byChat.get(sub.chatId) ?? [];
				list.push({ item, sub });
				byChat.set(sub.chatId, list);
			}
			requiredChats.set(item.seq, chats);
		}
		const succeededChats = new Map<number, Set<string>>();
		for (const [chatId, items] of byChat) {
			const deliveredSeqs = await this.sendChat(chatId, items);
			for (const seq of deliveredSeqs) {
				const chats = succeededChats.get(seq) ?? new Set<string>();
				chats.add(chatId);
				succeededChats.set(seq, chats);
			}
		}
		const delivered = new Set<number>();
		for (const [seq, required] of requiredChats) {
			const got = succeededChats.get(seq) ?? new Set<string>();
			if ([...required].every(chatId => got.has(chatId))) delivered.add(seq);
		}
		return delivered;
	}

	/**
	 * Deliver one chat's batch (individual cards, or a digest under burst/429). Returns the set of
	 * event seqs successfully delivered to THIS chat (preserves per-seq granularity so an earlier
	 * success still counts when a later send in the same chat fails).
	 */
	private async sendChat(
		chatId: string,
		items: Array<{ item: PendingNotification; sub: Subscription }>,
	): Promise<Set<number>> {
		const allSeqs = new Set(items.map(entry => entry.item.seq));
		if (items.length > this.digestThreshold) {
			return (await this.sendDigest(chatId, items)) ? allSeqs : new Set<number>();
		}
		const delivered = new Set<number>();
		for (const entry of items) {
			const result = await this.outbound.send({
				chatId,
				reply: this.renderCard(entry.item.sessionId, entry.item.view, entry.sub),
			});
			if (!result.ok && result.retryAfterMs !== undefined) {
				await this.sleep(result.retryAfterMs);
				return (await this.sendDigest(chatId, items)) ? allSeqs : delivered;
			}
			if (!result.ok) return delivered;
			delivered.add(entry.item.seq);
		}
		return delivered;
	}

	private async sendDigest(
		chatId: string,
		items: Array<{ item: PendingNotification; sub: Subscription }>,
	): Promise<boolean> {
		const unique = new Map<number, PendingNotification>();
		for (const entry of items) unique.set(entry.item.seq, entry.item);
		const lines = [...unique.values()].map(item => `- ${item.view.name}: ${item.status}`);
		const reply: ChatReply = { kind: "chat", text: ["Session updates:", ...lines].join("\n") };
		const result = await this.outbound.send({ chatId, reply });
		if (!result.ok && result.retryAfterMs !== undefined) {
			await this.sleep(result.retryAfterMs);
			return (await this.outbound.send({ chatId, reply })).ok;
		}
		return result.ok;
	}
}

function toNotifyState(status: SessionStatus): NotifyState | null {
	if (status === "blocked" || status === "waiting_for_input" || status === "failed" || status === "done")
		return status;
	return null;
}
