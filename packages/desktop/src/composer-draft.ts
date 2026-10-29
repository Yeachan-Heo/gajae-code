import type { DesktopAttachmentDraft } from "./AttachmentPicker";

/**
 * A rejected dispatch never delivered its payload, so the composer gets it back.
 * Text typed while the request was in flight stays below the restored text:
 * dropping either side would lose input the user cannot recover.
 */
export const restoreDraft = (current: string, submitted: string) => (current ? `${submitted}\n\n${current}` : submitted);

/** Re-add only the attachments that were sent and are no longer selected. */
export const restoreAttachments = (current: DesktopAttachmentDraft[], submitted: DesktopAttachmentDraft[]) => {
	const present = new Set(current.map(draft => draft.id));
	const missing = submitted.filter(draft => !present.has(draft.id));
	return missing.length ? [...current, ...missing] : current;
};
