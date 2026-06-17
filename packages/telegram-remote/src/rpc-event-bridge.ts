import { createHash } from "node:crypto";
import { chunkForDelivery, formatExitAlert, formatLivenessAlert, formatSendFailure } from "./projection";
import type { RpcAttachmentStore } from "./rpc-attachment-store";
import type { AttachmentRecord, ChatReply, RpcBackendPort, RpcChunkProgress, RpcDeliveryIdentity } from "./types";

type RpcEvent = { type: string; [key: string]: unknown };
type Outbound = {
	send(message: { chatId: string; reply: ChatReply }): Promise<{ ok: boolean; retryAfterMs?: number }>;
};
type Timer = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
type Clock = {
	setInterval?: (callback: () => void, ms: number) => Timer;
	clearInterval?: (timer: Timer) => void;
	setTimeout?: (callback: () => void, ms: number) => Timer;
	clearTimeout?: (timer: Timer) => void;
};

type MessageCandidate = { text: string; identity: RpcDeliveryIdentity; deliveryId: string };

const TURN_COMPLETE_EVENTS = new Set(["turn_end", "agent_end", "turn_cancelled", "agent_cancelled"]);
const EXIT_EVENTS = new Set(["session_exit", "agent_dead", "exit", "session_end"]);

export class RpcEventBridge {
	readonly #backend: RpcBackendPort;
	readonly #attachments: RpcAttachmentStore;
	readonly #binding: { chatId: string; userId: string | null };
	readonly #outbound?: Outbound;
	readonly #now: () => number;
	readonly #livenessMs: number;
	readonly #clock: Clock;
	#unsubscribeEvents: (() => void) | null = null;
	#unsubscribeTransportError: (() => void) | null = null;
	#timer: Timer | null = null;
	#exitAlerted = false;
	#delivering: Promise<void> | null = null;
	#lastSeenAt: number;
	#eventQueue: Promise<void> = Promise.resolve();

	constructor(deps: {
		backend: RpcBackendPort;
		attachments: RpcAttachmentStore;
		binding: { chatId: string; userId: string | null };
		outbound?: Outbound;
		now?: () => number;
		livenessMs?: number;
		clock?: Clock;
	}) {
		this.#backend = deps.backend;
		this.#attachments = deps.attachments;
		this.#binding = deps.binding;
		this.#outbound = deps.outbound;
		this.#now = deps.now ?? Date.now;
		this.#livenessMs = deps.livenessMs ?? 60_000;
		this.#clock = deps.clock ?? { setInterval, clearInterval, setTimeout, clearTimeout };
		this.#lastSeenAt = this.#now();
	}

	start(): void {
		this.stop();
		this.#unsubscribeEvents =
			this.#backend.onEvents?.(event => {
				this.#eventQueue = this.#eventQueue
					.then(() => this.handleEvent(event))
					.catch(error => {
						console.error("gtr_rpc_event_bridge_event_failed", {
							message: error instanceof Error ? error.message.slice(0, 80) : "unknown",
						});
					});
			}) ?? null;
		this.#unsubscribeTransportError =
			this.#backend.onTransportError?.(() => {
				void this.alertExitOnce("exit");
			}) ?? null;
		const tick = () => void this.checkLiveness();
		this.#timer =
			this.#clock.setInterval?.(tick, this.#livenessMs) ?? this.#clock.setTimeout?.(tick, this.#livenessMs) ?? null;
	}

	stop(): void {
		this.#unsubscribeEvents?.();
		this.#unsubscribeTransportError?.();
		this.#unsubscribeEvents = null;
		this.#unsubscribeTransportError = null;
		if (this.#timer) {
			this.#clock.clearInterval?.(this.#timer);
			this.#clock.clearTimeout?.(this.#timer);
			this.#timer = null;
		}
	}

	async deliverFinalAnswer(): Promise<void> {
		if (this.#delivering) return this.#delivering;
		this.#delivering = this.deliverFinalAnswerOnce().finally(() => {
			this.#delivering = null;
		});
		return this.#delivering;
	}

	async resync(): Promise<number> {
		const attachment = this.#attachments.get();
		if (!this.isDeliverableAttachment(attachment)) return 0;
		await this.#backend.getState().catch(() => undefined);
		const messages = await this.#backend.getMessages?.().catch(() => undefined);
		await this.#backend.getLastAssistantText?.().catch(() => undefined);
		const gates = await this.#backend.getPendingWorkflowGates?.().catch(() => []);
		console.warn("gtr_rpc_event_bridge_resync", { gates: Array.isArray(gates) ? gates.length : 0 });
		const latest = this.#attachments.get();
		if (this.isDeliverableAttachment(latest) && latest.chunkProgress) {
			await this.resumeChunkProgress(latest, Array.isArray(messages) ? messages : undefined);
			const resumed = this.#attachments.get();
			if (this.isDeliverableAttachment(resumed) && !resumed.chunkProgress) await this.deliverFinalAnswer();
		} else {
			await this.deliverFinalAnswer();
		}
		return Array.isArray(gates) ? gates.length : 0;
	}

	async alertExitOnce(variant: "exit" | "liveness"): Promise<void> {
		if (this.#exitAlerted) return;
		const attachment = this.#attachments.get();
		if (!this.isDeliverableAttachment(attachment)) return;
		this.#exitAlerted = true;
		console.warn("gtr_rpc_event_bridge_alert", { variant });
		await this.#outbound?.send({
			chatId: attachment.chatId,
			reply: { kind: "chat", text: variant === "exit" ? formatExitAlert() : formatLivenessAlert() },
		});
		await this.#attachments.markStale(this.#now());
	}

	private async handleEvent(event: RpcEvent): Promise<void> {
		await this.updateLiveness();
		if (TURN_COMPLETE_EVENTS.has(event.type)) await this.deliverFinalAnswer();
		if (EXIT_EVENTS.has(event.type)) await this.alertExitOnce("exit");
	}

	private async checkLiveness(): Promise<void> {
		const attachment = this.#attachments.get();
		if (!this.isDeliverableAttachment(attachment)) return;
		const liveness = attachment.liveness ?? { lastSeenAt: this.#lastSeenAt, timeoutMs: this.#livenessMs };
		if (this.#now() - liveness.lastSeenAt > liveness.timeoutMs) await this.alertExitOnce("liveness");
	}

	private async updateLiveness(): Promise<void> {
		this.#lastSeenAt = this.#now();
		const attachment = this.#attachments.get();
		if (!this.isDeliverableAttachment(attachment)) return;
		await this.#attachments.set({
			...attachment,
			liveness: { lastSeenAt: this.#lastSeenAt, timeoutMs: this.#livenessMs },
			updatedAt: this.#now(),
		});
	}

	private async deliverFinalAnswerOnce(): Promise<void> {
		const attachment = this.#attachments.get();
		if (!this.isDeliverableAttachment(attachment)) return;
		if (attachment.chunkProgress) {
			await this.resumeChunkProgress(attachment);
			return;
		}
		const candidate = await this.selectCandidate();
		if (!candidate) return;
		console.warn("gtr_rpc_event_bridge_identity", {
			fallback: candidate.identity.fallback === true,
			messageIndex: candidate.identity.messageIndex,
			turnId: candidate.identity.turnId ? "present" : "absent",
		});
		const latest = this.#attachments.get();
		if (!this.isDeliverableAttachment(latest)) return;
		if (latest.deliveryIdentities.some(identity => identitiesMatch(identity, candidate.identity))) return;
		const chunks = chunkForDelivery(candidate.text);
		if (chunks.length === 0) return;
		await this.persistChunkProgress(latest, {
			deliveryId: candidate.deliveryId,
			nextChunkIndex: 0,
			chunkCount: chunks.length,
		});
		await this.deliverChunks(candidate, chunks, 0);
	}

	private async resumeChunkProgress(attachment: AttachmentRecord, prefetchedMessages?: unknown[]): Promise<void> {
		const progress = attachment.chunkProgress;
		if (!progress) return;
		const candidate = await this.selectCandidate(prefetchedMessages, progress.deliveryId);
		if (!candidate) {
			await this.#attachments.set({ ...attachment, chunkProgress: undefined, updatedAt: this.#now() });
			console.warn("gtr_rpc_event_bridge_chunk_clear", { reason: "missing_identity" });
			return;
		}
		const chunks = chunkForDelivery(candidate.text);
		if (chunks.length === 0 || chunks.length !== progress.chunkCount) {
			await this.#attachments.set({ ...attachment, chunkProgress: undefined, updatedAt: this.#now() });
			console.warn("gtr_rpc_event_bridge_chunk_clear", { reason: "chunk_mismatch" });
			return;
		}
		console.warn("gtr_rpc_event_bridge_chunk_resume", { next: progress.nextChunkIndex, count: progress.chunkCount });
		await this.deliverChunks(candidate, chunks, progress.nextChunkIndex);
	}

	private async deliverChunks(candidate: MessageCandidate, chunks: string[], startIndex: number): Promise<void> {
		for (let index = startIndex; index < chunks.length; index += 1) {
			try {
				const result = await this.#outbound?.send({
					chatId: this.#binding.chatId,
					reply: { kind: "chat", text: chunks[index] },
				});
				if (!result || result.ok === false) {
					await this.persistFailedProgress(candidate.deliveryId, index, chunks.length, result?.retryAfterMs);
					return;
				}
				await this.persistChunkAdvance(candidate.deliveryId, index + 1, chunks.length);
			} catch {
				await this.persistFailedProgress(candidate.deliveryId, index, chunks.length);
				return;
			}
		}
		const attachment = this.#attachments.get();
		if (!this.isDeliverableAttachment(attachment)) return;
		await this.#attachments.set({
			...attachment,
			deliveryIdentities: [...attachment.deliveryIdentities, candidate.identity].slice(-100),
			chunkProgress: undefined,
			updatedAt: this.#now(),
		});
	}

	private async persistChunkProgress(attachment: AttachmentRecord, chunkProgress: RpcChunkProgress): Promise<void> {
		await this.#attachments.set({ ...attachment, chunkProgress, updatedAt: this.#now() });
	}

	private async persistChunkAdvance(deliveryId: string, nextChunkIndex: number, chunkCount: number): Promise<void> {
		const attachment = this.#attachments.get();
		if (!this.isDeliverableAttachment(attachment)) return;
		await this.#attachments.set({
			...attachment,
			chunkProgress: { deliveryId, nextChunkIndex, chunkCount },
			updatedAt: this.#now(),
		});
	}

	private async persistFailedProgress(
		deliveryId: string,
		nextChunkIndex: number,
		chunkCount: number,
		retryAfterMs?: number,
	): Promise<void> {
		const attachment = this.#attachments.get();
		if (this.isDeliverableAttachment(attachment)) {
			await this.#attachments.set({
				...attachment,
				chunkProgress: { deliveryId, nextChunkIndex, chunkCount, failedAt: this.#now() },
				updatedAt: this.#now(),
			});
		}
		console.warn("gtr_rpc_event_bridge_chunk_failed", { next: nextChunkIndex, retryAfterMs: retryAfterMs ?? null });
		await this.#outbound?.send({
			chatId: this.#binding.chatId,
			reply: { kind: "chat", text: formatSendFailure(retryAfterMs) },
		});
	}

	private async selectCandidate(
		prefetchedMessages?: unknown[],
		deliveryId?: string,
	): Promise<MessageCandidate | null> {
		const messages = prefetchedMessages ?? (await this.#backend.getMessages?.().catch(() => undefined));
		const candidates = Array.isArray(messages)
			? messages.map(messageToCandidate).filter((item): item is MessageCandidate => item !== null)
			: [];
		if (deliveryId) return candidates.find(candidate => candidate.deliveryId === deliveryId) ?? null;
		const latest = candidates.at(-1);
		if (latest) return latest;
		const fallbackText = await this.#backend.getLastAssistantText?.().catch(() => null);
		if (typeof fallbackText !== "string" || fallbackText.trim().length === 0) return null;
		const contentHash = hashText(fallbackText);
		return {
			text: fallbackText,
			identity: { role: "assistant", contentHash, fallback: true },
			deliveryId: `fallback:${contentHash}`,
		};
	}

	private isDeliverableAttachment(attachment: AttachmentRecord | null): attachment is AttachmentRecord {
		return (
			attachment !== null &&
			!attachment.stale &&
			attachment.chatId === this.#binding.chatId &&
			attachment.userId === this.#binding.userId
		);
	}
}

function messageToCandidate(message: unknown, fallbackIndex: number): MessageCandidate | null {
	if (typeof message !== "object" || message === null) return null;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant") return null;
	const text = messageText(record.content);
	if (text === null || text.trim().length === 0) return null;
	const contentHash = hashText(text);
	const identity: RpcDeliveryIdentity = { role: "assistant", contentHash };
	const messageIndex = readNumber(record.index) ?? readNumber(record.messageIndex) ?? fallbackIndex;
	identity.messageIndex = messageIndex;
	const metadata =
		typeof record.metadata === "object" && record.metadata !== null
			? (record.metadata as Record<string, unknown>)
			: undefined;
	const timestamp =
		readTimestamp(record.timestamp) ??
		readTimestamp(record.createdAt) ??
		readTimestamp(record.created_at) ??
		readTimestamp(metadata?.timestamp) ??
		readTimestamp(metadata?.createdAt) ??
		readTimestamp(metadata?.created_at);
	if (timestamp) identity.timestamp = timestamp;
	const turnId =
		readString(record.turnId) ??
		readString(record.turn_id) ??
		readString(metadata?.turnId) ??
		readString(metadata?.turn_id);
	if (turnId) identity.turnId = turnId;
	return { text, identity, deliveryId: deliveryIdFor(identity) };
}

function messageText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts = content
		.map(part => {
			if (typeof part === "string") return part;
			if (typeof part !== "object" || part === null) return "";
			const record = part as Record<string, unknown>;
			return typeof record.text === "string" ? record.text : "";
		})
		.join("");
	return parts.length > 0 ? parts : null;
}

function identitiesMatch(existing: RpcDeliveryIdentity, next: RpcDeliveryIdentity): boolean {
	if (existing.role !== next.role || existing.contentHash !== next.contentHash) return false;
	if (existing.fallback || next.fallback) return existing.fallback === true && next.fallback === true;
	if (existing.turnId && next.turnId) return existing.turnId === next.turnId;
	if (existing.timestamp && next.timestamp) return existing.timestamp === next.timestamp;
	if (existing.messageIndex !== undefined && next.messageIndex !== undefined)
		return existing.messageIndex === next.messageIndex;
	return true;
}

function deliveryIdFor(identity: RpcDeliveryIdentity): string {
	return [
		identity.fallback ? "fallback" : "message",
		identity.messageIndex ?? "",
		identity.turnId ?? "",
		identity.timestamp ?? "",
		identity.contentHash,
	].join(":");
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readTimestamp(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
