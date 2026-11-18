import { type AcpSdkAdapter, AcpSdkAdapterError } from "../../sdk/acp/adapter";
import { SdkClientError } from "../../sdk/client";

type StagingAdapter = Pick<AcpSdkAdapter, "stagePromptImage" | "discardPromptImage" | "currentAttachment">;
type PromptImage = { data: string; mimeType: string };
type ConnectionIdentity = { connectionId: string; generation: number };

function connectionIdentity(adapter: StagingAdapter): ConnectionIdentity {
	const attachment = adapter.currentAttachment();
	if (!attachment?.connectionId)
		throw new AcpSdkAdapterError("connection_closed", "Prompt image staging requires a live connection.");
	return { connectionId: attachment.connectionId, generation: attachment.generation };
}

function sameConnection(a: ConnectionIdentity, b: ConnectionIdentity): boolean {
	return a.connectionId === b.connectionId && a.generation === b.generation;
}

function isUncertainAfterSend(error: unknown): boolean {
	return (
		(error instanceof SdkClientError || error instanceof AcpSdkAdapterError) && error.code === "uncertain_after_send"
	);
}

/** Owns connection-bound, one-shot image IDs until turn.prompt consumes them. */
export class AcpPromptImageStaging {
	readonly #images: readonly PromptImage[];
	readonly #batchId: string;
	readonly #isLive: () => boolean;
	#staged?: { adapter: StagingAdapter; ids: string[]; owner: ConnectionIdentity };
	#retired = false;

	constructor(images: readonly PromptImage[], batchId: string, isLive: () => boolean) {
		this.#images = images;
		this.#batchId = batchId;
		this.#isLive = isLive;
	}

	async stage(adapter: StagingAdapter): Promise<void> {
		this.#discardStaged();
		const ids: string[] = [];
		// Capture values, not a getter: the upload owner must not change on reconnect.
		const owner = connectionIdentity(adapter);
		try {
			for (const image of this.#images) {
				this.#assertLive();
				ids.push(await adapter.stagePromptImage(image, this.#batchId));
				if (!sameConnection(owner, connectionIdentity(adapter)))
					throw new AcpSdkAdapterError("connection_closed", "Connection changed during image staging.");
			}
			this.#assertLive();
		} catch (error) {
			await Promise.all(ids.map(id => adapter.discardPromptImage(id)));
			throw error;
		}
		this.#staged = { adapter, ids, owner };
	}

	async submit<T>(adapter: StagingAdapter, send: (stagedImages: Array<{ id: string }>) => Promise<T>): Promise<T> {
		this.#assertLive();
		if (
			!this.#staged ||
			this.#staged.adapter !== adapter ||
			!sameConnection(this.#staged.owner, connectionIdentity(adapter))
		)
			await this.stage(adapter);
		this.#assertLive();
		const staged = this.#staged!;
		if (!sameConnection(staged.owner, connectionIdentity(adapter))) {
			this.#discardStaged();
			throw new AcpSdkAdapterError("connection_closed", "Connection changed before image submission.");
		}
		this.#staged = undefined;
		try {
			// The caller dispatches immediately; Router pins the request to its attachment.
			return await send(staged.ids.map(id => ({ id })));
		} catch (error) {
			if (!isUncertainAfterSend(error)) await Promise.all(staged.ids.map(id => adapter.discardPromptImage(id)));
			throw error;
		}
	}

	retire(): void {
		this.#retired = true;
		this.#discardStaged();
	}

	#discardStaged(): void {
		const staged = this.#staged;
		this.#staged = undefined;
		if (staged) for (const id of staged.ids) void staged.adapter.discardPromptImage(id);
	}

	#assertLive(): void {
		if (this.#retired || !this.#isLive())
			throw new AcpSdkAdapterError("cancelled", "ACP prompt image staging was cancelled.");
	}
}
