import type { DesktopDeliveryReceipt } from "@gajae-code/desktop-host/protocol";
import { Check, ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "./components";
import { t } from "./i18n";

/**
 * The card's discard action. A listed conversation's unknown outcome is discarded once restored;
 * an orphan's record was never restored and cannot be, so it is just a record.
 */
export function recoveryDiscardLabel(orphan: boolean, disposition: DesktopDeliveryReceipt["disposition"]): string {
	if (orphan) return t("recovery.discardOrphan");
	return disposition === "unknown" ? t("shell.discardRestoredRecord") : t("shell.discardRecoveryRecord");
}

export interface RecoveryConversationProps {
	/** The conversation is not in the app's list (deleted, or its workspace closed). */
	orphan: boolean;
	/** The conversation's current title while it is in the app's list. */
	title?: string;
	/** Title remembered when the prompt was sent; names an orphan when present. */
	rememberedTitle?: string;
	/** The card sits under its own open conversation, so opening it again would do nothing. */
	current: boolean;
	/** The prompt text the record keeps; an orphan offers it on the clipboard. */
	text: string;
	onOpen: () => void;
}

/** Past this length or line count the orphan's text starts collapsed behind a disclosure. */
const LONG_TEXT_CHARACTERS = 280;
const LONG_TEXT_LINES = 4;

/**
 * An orphan's unsent text, readable and selectable on the card: it may be the last copy, so it
 * must survive a clipboard that refuses the write. Long text starts collapsed.
 */
function RecoveryText({ text, open, onToggle }: { text: string; open: boolean; onToggle(open: boolean): void }) {
	const body = (
		// Focusable so the keyboard can scroll a long text in WebKit too.
		<pre className="recovery-text" tabIndex={0} aria-label={t("recovery.textLabel")}>
			{text}
		</pre>
	);
	if (text.length <= LONG_TEXT_CHARACTERS && text.split("\n").length <= LONG_TEXT_LINES) return body;
	return (
		<details className="recovery-text-disclosure" open={open} onToggle={event => onToggle(event.currentTarget.open)}>
			<summary>
				<ChevronRight className="disclosure-chevron" aria-hidden="true" />
				{t("recovery.showText")}
			</summary>
			{body}
		</details>
	);
}

type CopyState = "idle" | "copied" | "failed";

/**
 * Copies unsent text on the user's click and remembers how it went. `copy` must run inside the
 * click handler, so WebKit keeps the user gesture for the clipboard write.
 */
/** Writes plain text to the system clipboard; fixtures pass their own to show a refused write. */
export type ClipboardWriter = (text: string) => Promise<void>;

const writeClipboard: ClipboardWriter = async text =>
	navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) })]);

function useCopyText(
	text: string,
	onFailure: () => void,
	writer: ClipboardWriter = writeClipboard,
): [CopyState, () => void] {
	const [state, setState] = useState<CopyState>("idle");
	const copy = () => {
		writer(text).then(
			() => setState("copied"),
			() => {
				setState("failed");
				onFailure();
			},
		);
	};
	return [state, copy];
}

/** Visible copy feedback: a green check when copied, an error-ink alert when the write is refused. */
function CopyFeedback({ state }: { state: CopyState }) {
	if (state === "copied")
		return (
			<p className="recovery-copy-status" role="status">
				<Check aria-hidden="true" />
				{t("recovery.copied")}
			</p>
		);
	if (state === "failed")
		return (
			<p className="recovery-copy-error" role="alert">
				<CircleAlert aria-hidden="true" />
				{t("recovery.copyFailed")}
			</p>
		);
	return null;
}

/**
 * Names the conversation a delivery-recovery card belongs to. An orphan (not in the list:
 * deleted, or its workspace closed) also shows its text, because restoring a draft into it would
 * write into a conversation the user cannot see, so the text may be the last copy.
 */
function RecoveryConversation({
	orphan,
	title,
	rememberedTitle,
	text,
	textOpen,
	onTextToggle,
}: Pick<RecoveryConversationProps, "orphan" | "title" | "rememberedTitle" | "text"> & {
	textOpen: boolean;
	onTextToggle(open: boolean): void;
}) {
	const name = title ?? rememberedTitle;
	return (
		<div className="recovery-conversation">
			<p className="recovery-conversation-name">
				{orphan
					? rememberedTitle
						? t("recovery.orphanNamed", { title: rememberedTitle })
						: t("recovery.orphanUnnamed")
					: name !== undefined && t("recovery.conversation", { title: name })}
			</p>
			{orphan && <p className="recovery-conversation-hint">{t("recovery.orphanHint")}</p>}
			{orphan && <RecoveryText text={text} open={textOpen} onToggle={onTextToggle} />}
		</div>
	);
}

/** One of a recovery card's actions; App owns every condition and handler. */
export interface RecoveryAction {
	label: string;
	disabled?: boolean;
	onClick?: () => void;
	/** Shown under the actions while the action is disabled, and linked to it as its description. */
	reason?: string;
}

export interface RecoveryCardProps extends RecoveryConversationProps {
	/** What happened to the delivery, as `recoveryNotice` words it. */
	notice: string;
	error?: string;
	/** Retry a storage repair or a failed restore; absent when there is nothing to retry. */
	retry?: RecoveryAction;
	/** Restore the draft into its conversation; absent for an orphan. */
	restore?: RecoveryAction;
	discard: RecoveryAction;
}

/**
 * A delivery-recovery card: what happened, which conversation it belongs to, and one row of
 * actions (retry, open, restore or copy, then discard last). Presentational only, so the App and
 * the showcase render the same card; the App decides what each action does and when it is
 * available. A failed copy opens an orphan's text so it can be selected by hand.
 */
export function RecoveryCard({
	notice,
	error,
	retry,
	restore,
	discard,
	current,
	onOpen,
	...conversation
}: RecoveryCardProps) {
	const [textOpen, setTextOpen] = useState(false);
	const reasonId = useId();
	const { orphan, text } = conversation;
	const [copy, copyText] = useCopyText(text, () => setTextOpen(true));
	const reason = discard.disabled ? discard.reason : undefined;
	return (
		<section className="recovery-card">
			{/* Only what happened is announced; the conversation, its text and copy feedback are not. */}
			<div className="recovery-card-message" role="status">
				<p>{notice}</p>
				{error && <p>{error}</p>}
			</div>
			<RecoveryConversation {...conversation} textOpen={textOpen} onTextToggle={setTextOpen} />
			<div className="recovery-card-actions">
				{retry && (
					<Button disabled={retry.disabled} onClick={retry.onClick}>
						{retry.label}
					</Button>
				)}
				{!orphan && !current && <Button onClick={onOpen}>{t("recovery.openConversation")}</Button>}
				{restore && (
					<Button disabled={restore.disabled} onClick={restore.onClick}>
						{restore.label}
					</Button>
				)}
				{orphan && <Button onClick={copyText}>{t("recovery.copyText")}</Button>}
				<Button
					disabled={discard.disabled}
					aria-describedby={reason ? reasonId : undefined}
					onClick={discard.onClick}
				>
					{discard.label}
				</Button>
			</div>
			{reason && (
				<p className="recovery-card-reason" id={reasonId}>
					{reason}
				</p>
			)}
			<CopyFeedback state={copy} />
		</section>
	);
}

/**
 * Inside the Delete conversation confirmation: deleting also discards the conversation's
 * unrestored recovery records, so it says how many unsent messages go with it and offers their
 * text first, as an orphan card does. Renders nothing when there are none.
 */
export function DeleteRecoveryWarning({ texts, writer }: { texts: readonly string[]; writer?: ClipboardWriter }) {
	const [textOpen, setTextOpen] = useState(false);
	const joined = texts.join("\n\n");
	const [copy, copyText] = useCopyText(joined, () => setTextOpen(true), writer);
	if (texts.length === 0) return null;
	const one = texts.length === 1;
	return (
		<div className="delete-recoveries">
			<p>{one ? t("recovery.deleteDiscardsOne") : t("recovery.deleteDiscards", { count: texts.length })}</p>
			<RecoveryText text={joined} open={textOpen} onToggle={setTextOpen} />
			<div className="recovery-card-actions">
				<Button onClick={copyText}>{one ? t("recovery.copyText") : t("recovery.copyAllText")}</Button>
			</div>
			<CopyFeedback state={copy} />
		</div>
	);
}

/**
 * The Delete conversation dialog's body: the question, that it cannot be undone, the unsent texts
 * it discards (if any) and the Delete action. Presentational, so the App and the showcase render
 * the same dialog; the App decides when Delete is available and what it does.
 */
export function DeleteConversationConfirmation({
	title,
	texts,
	disabled,
	onDelete,
	writer,
}: {
	title: string;
	/** The conversation's unrestored recovery texts, in the order they were sent. */
	texts: readonly string[];
	disabled: boolean;
	onDelete: () => void;
	writer?: ClipboardWriter;
}) {
	return (
		<>
			<div className="delete-confirmation">
				<p>{t("shell.deleteConversationConfirm", { title })}</p>
				<p className="delete-warning">
					<TriangleAlert aria-hidden="true" />
					<strong>{t("shell.deleteConversationIrreversible")}</strong>
				</p>
			</div>
			<DeleteRecoveryWarning texts={texts} writer={writer} />
			<Button className="danger" disabled={disabled} onClick={onDelete}>
				{t("shell.dialogDelete")}
			</Button>
		</>
	);
}
