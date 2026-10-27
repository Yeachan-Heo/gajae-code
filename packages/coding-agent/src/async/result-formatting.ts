import { logger } from "@gajae-code/utils";
import type { SessionManager } from "../session/session-manager";
import { DEFAULT_ARTIFACT_MAX_BYTES, truncateHeadBytes } from "../session/streaming-output";

const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
const ASYNC_PREVIEW_MAX_CHARS = 4_000;

export async function formatAsyncResultForFollowUp(
	sessionManager: SessionManager,
	result: string,
	allowArtifact = true,
): Promise<string> {
	if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) return result;
	const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
	// Denied owned deliveries must not leave unreferenced output artifacts.
	if (!allowArtifact) return preview;
	try {
		const artifactId = await sessionManager.saveArtifact(result, "async");
		if (artifactId) {
			const bytes = Buffer.byteLength(result, "utf8");
			const omittedBytes =
				bytes > DEFAULT_ARTIFACT_MAX_BYTES
					? bytes - truncateHeadBytes(result, DEFAULT_ARTIFACT_MAX_BYTES).bytes
					: 0;
			const notice = omittedBytes
				? `Saved completion output is incomplete; omitted ${omittedBytes} UTF-8 bytes`
				: "Saved completion output";
			return `${preview}\n${notice}: artifact://${artifactId}`;
		}
	} catch (error) {
		try {
			logger.warn("Failed to persist async follow-up artifact", {
				error: error instanceof Error ? error.message : String(error),
			});
		} catch {
			// Diagnostics must not discard a completed job's preview.
		}
	}
	return `${preview}\n[Completion output storage unavailable; only the preview is available here.]`;
}
