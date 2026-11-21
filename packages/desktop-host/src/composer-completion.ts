import type { SdkComposerCompletionResult, SdkComposerObservation } from "@gajae-code/coding-agent/sdk";
import { type DesktopCompletionResult, MAX_FRAME_BYTES } from "./protocol";

const TEXT_LIMIT = 32_000;
const STALE = "Session changed while completing the draft. Select the conversation again.";

export interface DesktopCompletionInput {
	text: string;
	cursor: number;
	sessionGeneration: number;
}

export function readDesktopCompletionInput(params: Record<string, unknown>): DesktopCompletionInput {
	if (Object.keys(params).some(key => !["sessionId", "sessionGeneration", "text", "cursor"].includes(key)))
		throw new Error("Invalid completion parameters");
	const { text, cursor, sessionGeneration } = params;
	if (typeof text !== "string" || text.length > TEXT_LIMIT || text.includes("\0"))
		throw new Error("Invalid completion text");
	if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length)
		throw new Error("Invalid completion cursor");
	if (
		cursor > 0 &&
		cursor < text.length &&
		/[\uD800-\uDBFF]/.test(text[cursor - 1]!) &&
		/[\uDC00-\uDFFF]/.test(text[cursor]!)
	)
		throw new Error("Invalid completion cursor");
	if (typeof sessionGeneration !== "number" || !Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0)
		throw new Error("Invalid completion session generation");
	return { text, cursor, sessionGeneration };
}

function assertCurrent(isCurrent: () => boolean): void {
	if (!isCurrent()) throw new Error(STALE);
}

/** Maps a trusted SDK owner response; the caller fences ownership around a remote query. */
export function projectDesktopCompletion(suggestions: SdkComposerCompletionResult): DesktopCompletionResult {
	const result: DesktopCompletionResult = { items: [] };
	let bytes = 1024; // Reserve the desktop response envelope and JSON framing.
	for (const item of suggestions.items) {
		// Never reconstruct or truncate an executable value or whole-draft replacement.
		if (item.text.length > TEXT_LIMIT || item.value.length > TEXT_LIMIT) continue;
		const completion = {
			value: item.value,
			label: item.label,
			...(item.description !== undefined ? { description: item.description } : {}),
			text: item.text,
			cursor: item.cursor,
		};
		const size = new TextEncoder().encode(JSON.stringify(completion)).byteLength + 1;
		if (result.items.length === 100 || bytes + size > MAX_FRAME_BYTES) break;
		bytes += size;
		result.items.push(completion);
	}
	return result;
}

/** The SDK owns discovery, visibility, token interpretation and frozen replacements. */
export class DesktopComposerCompletion {
	constructor(
		readonly observation: Pick<SdkComposerObservation, "complete">,
		readonly isCurrent: () => boolean,
	) {}

	async complete(text: string, cursor: number): Promise<DesktopCompletionResult> {
		assertCurrent(this.isCurrent);
		try {
			const suggestions = await this.observation.complete({ text, cursor });
			assertCurrent(this.isCurrent);
			const result = projectDesktopCompletion(suggestions);
			assertCurrent(this.isCurrent);
			return result;
		} catch (error) {
			// A retired app identity takes precedence over an asynchronous provider failure.
			assertCurrent(this.isCurrent);
			throw error;
		}
	}
}
