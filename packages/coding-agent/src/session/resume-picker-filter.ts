import type { SessionMetadata } from "../sdk/session-readonly/metadata";
import { FileSessionReader, type SessionStorageReader } from "../sdk/session-readonly/storage";

/**
 * Largest transcript the `/resume` picker reads to decide that a session never
 * started a conversation (#8028). A startup-only transcript is a header plus a
 * few control records, far below this bound. A larger transcript stays listed
 * without being read in full.
 */
export const RESUME_PICKER_METADATA_SCAN_BYTES = 64 * 1024;

/**
 * Supported pre-conversation control records. They configure a session but
 * carry no conversation and no model context.
 *
 * Other records startup can write (`mcp_tool_selection`,
 * `discovered_builtin_tool_selection`, `mode_change`) are deliberately not
 * listed: a session that holds them stays in the picker.
 */
const PRE_CONVERSATION_CONTROL_TYPES: ReadonlySet<string> = new Set([
	"model_change",
	"thinking_level_change",
	"service_tier_change",
	"configured_model_chain",
]);

/**
 * Whether a complete transcript holds only its session header followed by at
 * least one pre-conversation control record.
 *
 * Every other record counts as content and keeps the session listed: a
 * `message`, a context-bearing `custom_message` such as a handoff, a `custom`
 * entry, a header patch, or a type this check does not know. A header-only
 * transcript is not metadata-only. A line that does not parse (for example a
 * record still being appended) also counts as content.
 */
export function isMetadataOnlyTranscript(content: string): boolean {
	let sawHeader = false;
	let controlRecords = 0;
	for (const line of content.split("\n")) {
		if (line.trim() === "") continue;
		let type: unknown;
		try {
			type = (JSON.parse(line) as { type?: unknown } | null)?.type;
		} catch {
			return false;
		}
		if (!sawHeader) {
			if (type !== "session") return false;
			sawHeader = true;
			continue;
		}
		if (typeof type !== "string" || !PRE_CONVERSATION_CONTROL_TYPES.has(type)) return false;
		controlRecords++;
	}
	return controlRecords > 0;
}

async function isMetadataOnlySession(session: SessionMetadata, storage: SessionStorageReader): Promise<boolean> {
	// Named, starred, or message-bearing sessions are always listed. These checks
	// use the listing's own metadata, so most sessions are never read again.
	if (session.title || session.starred || session.messageCount > 0) return false;
	if (session.size > RESUME_PICKER_METADATA_SCAN_BYTES) return false;
	try {
		const content = await storage.readTextPrefix(session.path, RESUME_PICKER_METADATA_SCAN_BYTES + 1);
		// The file grew past the bound after listing: keep it rather than judge a prefix.
		if (Buffer.byteLength(content, "utf8") > RESUME_PICKER_METADATA_SCAN_BYTES) return false;
		return isMetadataOnlyTranscript(content);
	} catch {
		return false;
	}
}

/**
 * Drops sessions that hold only startup metadata from a `/resume` picker list,
 * keeping the input order. Apply this only where the picker is built: generic
 * listing, explicit session-ID resolution, and recovery keep the full inventory.
 *
 * A session is dropped only when the whole transcript, read within
 * {@link RESUME_PICKER_METADATA_SCAN_BYTES}, is confirmed metadata-only. When a
 * session cannot be read or is over the bound, it stays listed.
 */
export async function excludeMetadataOnlySessions<T extends SessionMetadata>(
	sessions: readonly T[],
	storage: SessionStorageReader = new FileSessionReader(),
): Promise<T[]> {
	const kept: T[] = [];
	for (const session of sessions) {
		if (!(await isMetadataOnlySession(session, storage))) kept.push(session);
	}
	return kept;
}
