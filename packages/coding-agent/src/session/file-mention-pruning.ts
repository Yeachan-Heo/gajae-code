/**
 * Staleness pruning for auto-read file-mention entries.
 *
 * A `@path` mention is superseded once a newer read or mention of the same
 * resolved path appears later in the branch. Stale bodies are replaced with an
 * explicit digest notice (never silently deleted) so context shrinks without
 * losing the reference.
 */
import type { FileMentionMessage } from "./messages";
import type { SessionEntry, SessionMessageEntry } from "./session-manager";

export interface FileMentionPruneResult {
	changed: SessionMessageEntry[];
	bytesSaved: number;
}

/** Notice injected in place of a superseded file-mention body. */
export function stalefileMentionNotice(path: string): string {
	return `(pruned: a newer view of \`${path}\` appears later in the conversation; use the read tool to fetch it again)`;
}

export function pruneStaleFileMentions(
	entries: readonly SessionEntry[],
	resolveAbs: (path: string) => string,
): FileMentionPruneResult {
	// Latest branch index at which each absolute path was shown (read or mention).
	const latestShownIndex = new Map<string, number>();
	entries.forEach((entry, i) => {
		if (entry.type !== "message") return;
		const msg = entry.message;
		if (msg.role === "fileMention") {
			for (const file of msg.files) {
				if (file.duplicate || file.pruned) continue;
				latestShownIndex.set(resolveAbs(file.path), i);
			}
		} else if (msg.role === "toolResult") {
			const resolved = (msg.details as { resolvedPath?: unknown } | undefined)?.resolvedPath;
			if (typeof resolved === "string" && resolved) latestShownIndex.set(resolveAbs(resolved), i);
		}
	});

	const changed: SessionMessageEntry[] = [];
	let bytesSaved = 0;
	entries.forEach((entry, i) => {
		if (entry.type !== "message" || entry.message.role !== "fileMention") return;
		const msg = entry.message as FileMentionMessage;
		let mutated = false;
		for (const file of msg.files) {
			if (file.duplicate || file.pruned || !file.content) continue;
			const latest = latestShownIndex.get(resolveAbs(file.path));
			if (latest !== undefined && latest > i) {
				const notice = stalefileMentionNotice(file.path);
				bytesSaved += Math.max(0, Buffer.byteLength(file.content, "utf-8") - Buffer.byteLength(notice, "utf-8"));
				file.content = notice;
				file.pruned = true;
				file.image = undefined;
				file.lineCount = undefined;
				mutated = true;
			}
		}
		if (mutated) changed.push(entry as SessionMessageEntry);
	});
	return { changed, bytesSaved };
}
