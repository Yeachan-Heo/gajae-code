import { useState } from "react";
import { Button } from "./components";
import { t } from "./i18n";

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

/**
 * Names the conversation a delivery-recovery card belongs to. A listed conversation can be
 * opened from the card; an orphan (not in the list: deleted, or its workspace closed) offers
 * its text instead, because restoring a draft into it would write into a conversation the
 * user cannot see.
 */
export function RecoveryConversation({
	orphan,
	title,
	rememberedTitle,
	current,
	text,
	onOpen,
}: RecoveryConversationProps) {
	const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
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
			{!orphan && !current && <Button onClick={onOpen}>{t("recovery.openConversation")}</Button>}
			{orphan && (
				<Button
					onClick={() => {
						// Registered inside the click so WebKit keeps the user gesture for the write.
						const write = async () =>
							navigator.clipboard.write([
								new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) }),
							]);
						write().then(
							() => setCopy("copied"),
							() => setCopy("failed"),
						);
					}}
				>
					{t("recovery.copyText")}
				</Button>
			)}
			{copy === "copied" && (
				<span className="sr-only" role="status">
					{t("recovery.copied")}
				</span>
			)}
			{copy === "failed" && <span role="alert">{t("recovery.copyFailed")}</span>}
		</div>
	);
}

/** One of a recovery card's actions; App owns every condition and handler. */
export interface RecoveryAction {
	label: string;
	disabled?: boolean;
	onClick?: () => void;
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
 * A delivery-recovery card: what happened, which conversation it belongs to, and its actions.
 * Presentational only, so the App and the showcase render the same card; the App decides what
 * each action does and when it is available.
 */
export function RecoveryCard({ notice, error, retry, restore, discard, ...conversation }: RecoveryCardProps) {
	return (
		<div className="notice" role="status">
			<p>{notice}</p>
			{error && <p>{error}</p>}
			<RecoveryConversation {...conversation} />
			{retry && (
				<Button disabled={retry.disabled} onClick={retry.onClick}>
					{retry.label}
				</Button>
			)}
			{restore && (
				<Button disabled={restore.disabled} onClick={restore.onClick}>
					{restore.label}
				</Button>
			)}
			<Button disabled={discard.disabled} onClick={discard.onClick}>
				{discard.label}
			</Button>
		</div>
	);
}
