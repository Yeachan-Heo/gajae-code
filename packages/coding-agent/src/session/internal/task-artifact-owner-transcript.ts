import { parseFirstJsonlLine } from "../session-transcript-header";
import { parseTaskArtifactOwnerLocator, type TaskArtifactOwnerLocator } from "../task-artifact-owner-codec";

const transcriptDecoder = new TextDecoder("utf-8", { fatal: true });

/** Resolve the path-free owner locator using transcript replay's header-patch semantics. */
export function taskArtifactOwnerLocatorFromTranscriptBytes(
	bytes: Uint8Array,
	expectedSessionId: string,
): TaskArtifactOwnerLocator | undefined {
	const header = parseFirstJsonlLine(bytes);
	if (header?.type !== "session" || header.id !== expectedSessionId)
		throw new Error("task_artifact_owner_transcript_header_invalid");
	let locator = parseTaskArtifactOwnerLocator(header.taskArtifactOwner);
	if (typeof header.version !== "number" || header.version < 4) return locator;
	const firstEnd = bytes.indexOf(0x0a);
	let start = firstEnd < 0 ? bytes.byteLength : firstEnd + 1;
	while (start < bytes.byteLength) {
		const newline = bytes.indexOf(0x0a, start);
		const end = newline < 0 ? bytes.byteLength : newline;
		const line = bytes.subarray(start, end);
		let record: Record<string, unknown> | undefined;
		try {
			if (line.byteLength > 0) {
				const parsed: unknown = JSON.parse(transcriptDecoder.decode(line));
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
					record = parsed as Record<string, unknown>;
			}
		} catch {
			const text = Buffer.from(line).toString("utf8");
			if (text.includes("header_patch") && text.includes("taskArtifactOwner"))
				throw new Error("task_artifact_owner_patch_invalid");
		}
		if (
			record?.type === "header_patch" &&
			typeof record.patch === "object" &&
			record.patch !== null &&
			!Array.isArray(record.patch) &&
			Object.hasOwn(record.patch, "taskArtifactOwner")
		) {
			const patch = record.patch as Record<string, unknown>;
			if (
				!Object.keys(record).every(key => key === "type" || key === "patch") ||
				!Object.keys(patch).every(
					key =>
						key === "cwd" ||
						key === "title" ||
						key === "titleSource" ||
						key === "starred" ||
						key === "taskArtifactOwner",
				) ||
				(patch.cwd !== undefined && typeof patch.cwd !== "string") ||
				(patch.title !== undefined && typeof patch.title !== "string") ||
				(patch.titleSource !== undefined && patch.titleSource !== "auto" && patch.titleSource !== "user") ||
				(patch.starred !== undefined && typeof patch.starred !== "boolean")
			)
				throw new Error("task_artifact_owner_patch_invalid");
			try {
				locator = parseTaskArtifactOwnerLocator(patch.taskArtifactOwner);
			} catch {
				throw new Error("task_artifact_owner_patch_invalid");
			}
		}
		if (newline < 0) break;
		start = newline + 1;
	}
	return locator;
}
