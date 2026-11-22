import type { DesktopAttachmentDraft } from "./AttachmentPicker";

/**
 * A rejected dispatch never delivered its payload, so the composer gets it back.
 * Text typed while the request was in flight stays below the restored text:
 * dropping either side would lose input the user cannot recover. A turn that ran
 * and then failed also restores its text; re-arming the composer is the safer
 * error here, because `session.retry` is the recovery path and losing typed input
 * is worse than a possible duplicate.
 */
export const restoreDraft = (current: string, submitted: string) => [submitted, current].filter(Boolean).join("\n\n");

/**
 * Restores one of several handed-back texts (Stop can return every queued message at once) so
 * they read in the order they were sent. `earlier` holds the texts already restored into this
 * draft that were sent before `submitted`, oldest first. While the draft still begins with them,
 * `submitted` goes after them instead of on top; anything the user typed stays below. A restored
 * text the user has since edited is skipped. Nothing in the draft is replaced or removed.
 */
export const restoreDraftInOrder = (current: string, submitted: string, earlier: readonly string[]) => {
	let end = 0;
	for (const text of earlier) {
		if (!text) continue;
		const start = end === 0 ? 0 : end + 2;
		if (end !== 0 && !current.startsWith("\n\n", end)) break;
		const after = start + text.length;
		if (!current.startsWith(text, start) || (after < current.length && !current.startsWith("\n\n", after))) continue;
		end = after;
	}
	if (end === 0) return restoreDraft(current, submitted);
	return [current.slice(0, end), submitted, current.slice(end + 2)].filter(Boolean).join("\n\n");
};

/** Re-add only the attachments that were sent and are no longer selected. */
export const restoreAttachments = (current: DesktopAttachmentDraft[], submitted: DesktopAttachmentDraft[]) => {
	const present = new Set(current.map(draft => draft.id));
	const missing = submitted.filter(draft => !present.has(draft.id));
	return missing.length ? [...current, ...missing] : current;
};
