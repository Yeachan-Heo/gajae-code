import { useId } from "react";
import type { DesktopBtwConversation, DesktopBtwTurn } from "../../desktop-host/src/btw-protocol";
import { Button, ErrorBanner } from "./components";
import { t } from "./i18n";

export interface BtwPanelProps {
	conversation: DesktopBtwConversation | null;
	draft: string;
	disabled: boolean;
	pending: boolean;
	onDraftChange: (value: string) => void;
	onSend: (question: string) => void;
	onCancel: (turnId: string) => void;
}

const statusLabels: Record<DesktopBtwTurn["status"], () => string> = {
	running: () => t("support.btwStatusRunning"),
	cancel_requested: () => t("support.btwStatusCancelling"),
	completed: () => t("support.btwStatusCompleted"),
	cancelled: () => t("support.btwStatusCancelled"),
	failed: () => t("support.btwStatusFailed"),
};

export function BtwPanel({ conversation, draft, disabled, pending, onDraftChange, onSend, onCancel }: BtwPanelProps) {
	const id = useId();
	const turns = conversation?.turns ?? [];
	const active = turns.find(turn => turn.status === "running" || turn.status === "cancel_requested");
	const canSend = !disabled && !pending && !active && Boolean(draft.trim());
	const canCancel = !disabled && !pending && active?.status === "running";
	return (
		<section className="btw-panel" aria-label={t("support.btwLabel")} aria-busy={pending}>
			<p id={`${id}-scope`} className="btw-help">
				{t("support.btwScopeHelp")}
			</p>
			{turns.length ? (
				<div className="btw-history" role="region" aria-label={t("support.btwHistory")} tabIndex={0}>
					<ol className="btw-turn-list">
						{turns.map((turn, index) => (
							<li key={turn.turnId}>
								<article
									className="btw-turn"
									data-status={turn.status}
									aria-label={t("support.btwTurnLabel", { index: index + 1 })}
								>
									<strong className="role-label">{t("support.roleUser")}</strong>
									<div className="btw-text" aria-label={t("support.btwQuestion")}>
										{turn.question}
									</div>
									<strong className="role-label">{t("support.btwRole")}</strong>
									<p className="btw-status" role="status">
										{statusLabels[turn.status]()}
									</p>
									{turn.answer ? (
										<div className="btw-text" aria-label={t("support.btwAnswer")}>
											{turn.answer}
										</div>
									) : (
										<p className="btw-help">{t("support.btwNoAnswer")}</p>
									)}
									{turn.answerTruncated && <p className="truncation-notice">{t("support.btwTruncated")}</p>}
									{turn.error && (
										<ErrorBanner>
											{turn.error.code}: {turn.error.message}
										</ErrorBanner>
									)}
								</article>
							</li>
						))}
					</ol>
				</div>
			) : (
				<div className="btw-empty">
					<h3>{t("support.btwEmptyTitle")}</h3>
					<p>{t("support.btwEmptyBody")}</p>
				</div>
			)}
			{disabled && (
				<p className="btw-help" role="status">
					{t("support.btwUnavailable")}
				</p>
			)}
			{pending && (
				<p className="btw-help" role="status">
					{t("support.btwPending")}
				</p>
			)}
			<form
				className="composer btw-composer"
				onSubmit={event => {
					event.preventDefault();
					if (canSend) onSend(draft);
				}}
			>
				<label htmlFor={`${id}-draft`}>{t("support.btwQuestion")}</label>
				<textarea
					id={`${id}-draft`}
					aria-describedby={`${id}-scope ${id}-hint`}
					rows={3}
					value={draft}
					placeholder={t("support.btwPlaceholder")}
					onChange={event => onDraftChange(event.target.value)}
					onKeyDown={event => {
						if (
							event.key === "Enter" &&
							(event.metaKey || event.ctrlKey) &&
							!event.nativeEvent.isComposing &&
							canSend
						) {
							event.preventDefault();
							onSend(draft);
						}
					}}
				/>
				<div className="btw-actions">
					<small id={`${id}-hint`} className="composer-hint">
						{t("support.btwHint")}
					</small>
					<div className="btw-buttons">
						{active && (
							<Button
								disabled={!canCancel}
								aria-describedby={`${id}-stop-help`}
								onClick={() => {
									if (canCancel) onCancel(active.turnId);
								}}
							>
								{t("support.btwStopRequest")}
							</Button>
						)}
						<Button type="submit" className="primary" disabled={!canSend}>
							{t("support.btwSend")}
						</Button>
					</div>
				</div>
			</form>
			{active && (
				<p id={`${id}-stop-help`} className="btw-help">
					{t("support.btwStopHelp")}
				</p>
			)}
		</section>
	);
}
