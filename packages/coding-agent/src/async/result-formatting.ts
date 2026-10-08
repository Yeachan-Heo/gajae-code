import type { SessionManager } from "../session/session-manager";
import { DEFAULT_ARTIFACT_MAX_BYTES, truncateHeadBytes } from "../session/streaming-output";

const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
const ASYNC_PREVIEW_MAX_CHARS = 4_000;

export function summarizeAgentBashArtifactSave(artifactId: string, originalText: string) {
	const originalBytes = Buffer.byteLength(originalText, "utf8");
	if (originalBytes <= DEFAULT_ARTIFACT_MAX_BYTES) {
		return { status: "saved" as const, artifactId, complete: true as const };
	}
	const retainedBytes = truncateHeadBytes(originalText, DEFAULT_ARTIFACT_MAX_BYTES).bytes;
	return {
		status: "saved" as const,
		artifactId,
		complete: false as const,
		omittedBytes: originalBytes - retainedBytes,
	};
}

export async function formatAsyncResultForFollowUp(
	sessionManager: SessionManager,
	result: string,
	allowArtifact = true,
): Promise<string> {
	if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) return result;

	const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
	if (!allowArtifact) return preview;

	const artifactId = await sessionManager.saveArtifact(result, "async");
	if (artifactId === undefined) throw new Error("Artifact storage unavailable for async follow-up output.");

	const saved = summarizeAgentBashArtifactSave(artifactId, result);
	const completeness = saved.complete
		? "Saved completion output"
		: `Saved output artifact (truncated; omitted ${saved.omittedBytes} UTF-8 bytes)`;
	return `${preview}\n${completeness}: artifact://${saved.artifactId}`;
}
