import { useId } from "react";
import type { DesktopHistory } from "../../desktop-host/src/protocol";
import { Button } from "./components";
import { t } from "./i18n";

export interface ForkPanelProps {
	history: DesktopHistory | null;
	selectedEntryId: string;
	pending: boolean;
	disabled: boolean;
	onSelect: (entryId: string) => void;
	onFork: (entryId?: string) => void;
	onLoadMore: () => void;
}

export function ForkPanel({
	history,
	selectedEntryId,
	pending,
	disabled,
	onSelect,
	onFork,
	onLoadMore,
}: ForkPanelProps) {
	const id = useId();
	const entries = history?.messages.filter(message => message.role === "user" && message.entryId) ?? [];
	const selectedMessage = entries.find(message => message.entryId === selectedEntryId);
	const locked = pending || disabled;
	return (
		<div className="fork-panel">
			<p>{t("settings.forkIntro")}</p>
			<Button
				disabled={locked}
				onClick={() => {
					if (!locked) onFork();
				}}
			>
				{t("settings.forkWhole")}
			</Button>
			<div>
				<label htmlFor={`${id}-entry`}>{t("settings.forkEntryLabel")}</label>
				<select
					id={`${id}-entry`}
					value={selectedMessage ? selectedEntryId : ""}
					disabled={locked || entries.length === 0}
					onChange={event => {
						const entryId = event.target.value;
						if (!locked && (entryId === "" || entries.some(message => message.entryId === entryId))) {
							onSelect(entryId);
						}
					}}
				>
					<option value="">{t("settings.forkEntryPlaceholder")}</option>
					{entries.map((message, index) => (
						<option key={message.entryId} value={message.entryId}>
							{index + 1}. {message.text.slice(0, 100) || t("settings.forkNoText")}
						</option>
					))}
				</select>
			</div>
			<div>
				<label htmlFor={`${id}-preview`}>{t("settings.forkPreviewLabel")}</label>
				<textarea
					id={`${id}-preview`}
					readOnly
					rows={6}
					value={selectedMessage?.text ?? ""}
					aria-describedby={selectedMessage?.truncated ? `${id}-truncation` : undefined}
				/>
				{selectedMessage?.truncated && (
					<p id={`${id}-truncation`} className="truncation-notice">
						{t("settings.forkPreviewTruncated")}
					</p>
				)}
			</div>
			<Button
				disabled={locked || !selectedMessage}
				onClick={() => {
					if (!locked && selectedMessage?.entryId) onFork(selectedMessage.entryId);
				}}
			>
				{t("settings.forkSelected")}
			</Button>
			{history && entries.length === 0 && <p>{t("settings.forkEmpty")}</p>}
			{history?.truncated && (
				<Button
					disabled={locked}
					onClick={() => {
						if (!locked) onLoadMore();
					}}
				>
					{t("settings.forkLoadMore")}
				</Button>
			)}
		</div>
	);
}
