import { useState } from "react";
import { Button } from "./components";
import { t } from "./i18n";

export interface RecoveryConversationProps {
	/** The conversation's current title while it is in the app's list; absent for an orphan. */
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
export function RecoveryConversation({ title, rememberedTitle, current, text, onOpen }: RecoveryConversationProps) {
	const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
	const orphan = title === undefined;
	return (
		<div className="recovery-conversation">
			<p className="recovery-conversation-name">
				{orphan
					? rememberedTitle
						? t("recovery.orphanNamed", { title: rememberedTitle })
						: t("recovery.orphanUnnamed")
					: t("recovery.conversation", { title })}
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
