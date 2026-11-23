/** Which conversation a delivery-recovery card belongs to (`recovery.*`). */
export const recovery = {
	"recovery.conversation": "Conversation: {title}",
	"recovery.orphanNamed": "“{title}” is no longer in the conversation list.",
	"recovery.orphanUnnamed": "This conversation is no longer in the conversation list.",
	"recovery.orphanHint":
		"It may have been deleted, or its workspace closed. Copy the text if you still need it, then discard the record.",
	"recovery.orphanOutcomeUnknown":
		"Delivery recovery: the outcome is unknown. It may already have run; the app will not send it again.",
	"recovery.orphanFailed": "Delivery recovery: delivery failed. Some work may already have run.",
	"recovery.discardOrphan": "Discard record",
	"recovery.restoreFirst":
		"Restore the draft first. The outcome is unknown, so this record keeps the text until it is back in the message box.",
	"recovery.openConversation": "Open conversation",
	"recovery.copyText": "Copy text",
	"recovery.copied": "Text copied.",
	"recovery.copyFailed": "The text could not be copied. Select it above and copy it yourself.",
	"recovery.textLabel": "Unsent text",
	"recovery.showText": "Show the unsent text",
	"recovery.showcaseNav": "Recovery cards",
	"recovery.showcaseHeading": "Delivery recovery cards · which conversation they belong to",
	"recovery.showcaseNote":
		"Design example · Fixture records only. A listed conversation can be opened from its card; an orphan offers its text and can be discarded without restoring. Nothing is sent.",
	"recovery.showcaseListed": "Empty screen · listed conversation",
	"recovery.showcaseCurrent": "Under its own open conversation",
	"recovery.showcaseOrphan": "Orphan · remembered title",
	"recovery.showcaseOrphanUnnamed": "Orphan · record saved before titles were kept",
	"recovery.showcaseLong": "Long and Korean title · narrow width",
	"recovery.showcaseOrphanLong": "Orphan · long text behind a disclosure",
	"recovery.showcaseStacked": "Three cards stacked in the conversation column",
} as const;
