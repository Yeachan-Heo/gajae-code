import { type AcpSdkAdapter, AcpSdkAdapterError } from "../../sdk/acp/adapter";
import { SdkClientError } from "../../sdk/client";

type StagingAdapter = Pick<AcpSdkAdapter, "stagePromptImage" | "discardPromptImage">;
type PromptImage = { data: string; mimeType: string };

function isUncertainAfterSend(error: unknown): boolean {
	return (
		(error instanceof SdkClientError || error instanceof AcpSdkAdapterError) && error.code === "uncertain_after_send"
	);
}

/**
 * Owns one ACP prompt's staged image IDs from upload until a `turn.prompt` consumes them.
 *
 * Staged IDs are connection-owned and one-shot on the host. Every ID that is not handed to
 * a definitive `turn.prompt` is discarded: a cancelled, failed or superseded staging run,
 * a prompt the host definitively rejected, and any set still held when the prompt retires.
 */
export class AcpPromptImageStaging {
	readonly #images: readonly PromptImage[];
	readonly #batchId: string;
	readonly #isLive: () => boolean;
	#staged?: { adapter: StagingAdapter; ids: string[] };
	#retired = false;

	constructor(images: readonly PromptImage[], batchId: string, isLive: () => boolean) {
		this.#images = images;
		this.#batchId = batchId;
		this.#isLive = isLive;
	}

	/** Upload every image on `adapter`, replacing any set staged earlier. */
	async stage(adapter: StagingAdapter): Promise<void> {
		this.#discardStaged();
		const ids: string[] = [];
		try {
			for (const image of this.#images) {
				this.#assertLive();
				ids.push(await adapter.stagePromptImage(image, this.#batchId));
			}
			this.#assertLive();
		} catch (error) {
			await Promise.all(ids.map(id => adapter.discardPromptImage(id)));
			throw error;
		}
		this.#staged = { adapter, ids };
	}

	/**
	 * Hand the staged IDs to exactly one `turn.prompt` on `adapter`. A set staged on another
	 * adapter (session reattachment) or already handed out (busy retry) is staged afresh.
	 * A definitive rejection discards the handed-out IDs; an uncertain send leaves them to the
	 * host, which may still redeem them, and whose lease/disconnect cleanup reclaims them otherwise.
	 */
	async submit<T>(adapter: StagingAdapter, send: (stagedImages: Array<{ id: string }>) => Promise<T>): Promise<T> {
		if (this.#staged?.adapter !== adapter) await this.stage(adapter);
		const ids = this.#staged!.ids;
		this.#staged = undefined;
		try {
			return await send(ids.map(id => ({ id })));
		} catch (error) {
			if (!isUncertainAfterSend(error)) await Promise.all(ids.map(id => adapter.discardPromptImage(id)));
			throw error;
		}
	}

	/** Stop further staging and discard every ID not yet handed to `turn.prompt`. */
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
