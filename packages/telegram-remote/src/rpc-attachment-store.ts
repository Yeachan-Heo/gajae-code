import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStateDir } from "./subscriptions";
import type {
	AttachmentRecord,
	RpcChunkProgress,
	RpcControlState,
	RpcDeliveryIdentity,
	RpcLivenessState,
} from "./types";

export const RPC_ATTACHMENT_FILE_NAME = "telegram-remote-rpc-attachment.json";

export interface RpcAttachmentStoreState {
	version: 1;
	attachment: AttachmentRecord | null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isControlState(value: unknown): value is RpcControlState {
	return (
		value === "detached" ||
		value === "connecting" ||
		value === "attached_idle" ||
		value === "attached_turn_active" ||
		value === "waiting_for_ui" ||
		value === "control_pending_abort_and_prompt" ||
		value === "reconnecting" ||
		value === "stale"
	);
}

function isLiveness(value: unknown): value is RpcLivenessState {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.lastSeenAt === "number" &&
		Number.isFinite(record.lastSeenAt) &&
		typeof record.timeoutMs === "number" &&
		Number.isFinite(record.timeoutMs)
	);
}

function isDeliveryIdentity(value: unknown): value is RpcDeliveryIdentity {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return record.role === "assistant" && typeof record.contentHash === "string";
}

function isChunkProgress(value: unknown): value is RpcChunkProgress {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.deliveryId === "string" &&
		typeof record.nextChunkIndex === "number" &&
		Number.isFinite(record.nextChunkIndex) &&
		typeof record.chunkCount === "number" &&
		Number.isFinite(record.chunkCount)
	);
}

function isAttachment(value: unknown): value is AttachmentRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.chatId === "string" &&
		(typeof record.userId === "string" || record.userId === null) &&
		typeof record.socketPath === "string" &&
		typeof record.stale === "boolean" &&
		(record.controllerState === undefined || isControlState(record.controllerState)) &&
		(record.liveness === undefined || isLiveness(record.liveness)) &&
		isStringArray(record.pendingGateIds) &&
		Array.isArray(record.deliveryIdentities) &&
		record.deliveryIdentities.every(isDeliveryIdentity) &&
		(record.chunkProgress === undefined || isChunkProgress(record.chunkProgress)) &&
		typeof record.updatedAt === "number" &&
		Number.isFinite(record.updatedAt)
	);
}

function normalizeAttachment(attachment: AttachmentRecord): AttachmentRecord {
	return {
		chatId: attachment.chatId,
		userId: attachment.userId,
		socketPath: attachment.socketPath,
		stale: attachment.stale,
		...(attachment.controllerState ? { controllerState: attachment.controllerState } : {}),
		...(attachment.liveness
			? { liveness: { lastSeenAt: attachment.liveness.lastSeenAt, timeoutMs: attachment.liveness.timeoutMs } }
			: {}),
		pendingGateIds: [...attachment.pendingGateIds],
		deliveryIdentities: attachment.deliveryIdentities.map(identity => ({ ...identity })),
		...(attachment.chunkProgress ? { chunkProgress: { ...attachment.chunkProgress } } : {}),
		updatedAt: attachment.updatedAt,
	};
}

function emptyState(): RpcAttachmentStoreState {
	return { version: 1, attachment: null };
}

function parseState(text: string): RpcAttachmentStoreState {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) throw new Error("invalid_state");
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1) throw new Error("invalid_state");
	if (record.attachment !== null && !isAttachment(record.attachment)) throw new Error("invalid_state");
	return { version: 1, attachment: record.attachment === null ? null : normalizeAttachment(record.attachment) };
}

export class RpcAttachmentStore {
	readonly #filePath: string;
	#state: RpcAttachmentStoreState;

	private constructor(filePath: string, state: RpcAttachmentStoreState) {
		this.#filePath = filePath;
		this.#state = state;
	}

	static async load(options: { filePath: string }): Promise<RpcAttachmentStore> {
		let state = emptyState();
		try {
			state = parseState(await readFile(options.filePath, "utf8"));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) state = emptyState();
		}
		return new RpcAttachmentStore(options.filePath, state);
	}

	static async open(options: { stateDir: string }): Promise<RpcAttachmentStore> {
		const dir = resolveStateDir(options.stateDir);
		return RpcAttachmentStore.load({ filePath: join(dir, RPC_ATTACHMENT_FILE_NAME) });
	}

	get(): AttachmentRecord | null {
		return this.#state.attachment ? normalizeAttachment(this.#state.attachment) : null;
	}

	async set(attachment: AttachmentRecord): Promise<void> {
		this.#state = { version: 1, attachment: normalizeAttachment(attachment) };
		await this.persist();
	}

	async markStale(now = Date.now()): Promise<void> {
		if (!this.#state.attachment) return;
		this.#state.attachment = { ...this.#state.attachment, stale: true, controllerState: "stale", updatedAt: now };
		await this.persist();
	}

	async clear(): Promise<void> {
		this.#state = emptyState();
		await this.persist();
	}

	snapshotState(): RpcAttachmentStoreState {
		return { version: 1, attachment: this.get() };
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.#filePath), { recursive: true });
		const tmpPath = `${this.#filePath}.tmp`;
		await writeFile(tmpPath, `${JSON.stringify(this.snapshotState())}\n`, "utf8");
		await rename(tmpPath, this.#filePath);
	}
}
