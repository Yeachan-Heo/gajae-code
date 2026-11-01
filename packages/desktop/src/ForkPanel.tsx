import { useId } from "react";
import type { DesktopHistory } from "../../desktop-host/src/protocol";
import { Button } from "./components";
import { t } from "./i18n";
import { Select } from "./Select";

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
			<div className="select-field">
				<label id={`${id}-entry`}>{t("settings.forkEntryLabel")}</label>
				<Select
					value={selectedMessage ? selectedEntryId : ""}
					options={[
						{ value: "", label: t("settings.forkEntryPlaceholder") },
						...entries.flatMap((message, index) =>
							message.entryId
								? [
										{
											value: message.entryId,
											label: `${index + 1}. ${message.text.slice(0, 100) || t("settings.forkNoText")}`,
										},
									]
								: [],
						),
					]}
					ariaLabel={t("settings.forkEntryLabel")}
					ariaLabelledby={`${id}-entry`}
					disabled={locked || entries.length === 0}
					onChange={entryId => {
						if (!locked && (entryId === "" || entries.some(message => message.entryId === entryId))) {
							onSelect(entryId);
						}
					}}
				/>
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
