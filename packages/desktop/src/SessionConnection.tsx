import { Button } from "./components";
import { t } from "./i18n";
import { connectionIcons, type ReadOnlyConnection } from "./SessionConnectionMark";

/**
 * Replaces the composer while the app does not write the conversation: what happened, and the one
 * action that changes it. A released conversation offers Connect; one another process has open
 * offers a re-check. The draft stays in the app's draft store and returns with the composer.
 */
export function SessionConnectionNotice({
	state,
	pending,
	onConnect,
}: {
	state: ReadOnlyConnection;
	pending: boolean;
	onConnect: () => void;
}) {
	const Icon = connectionIcons[state];
	const disconnected = state === "disconnected";
	return (
		<div className="connection-notice" role="status" data-state={state}>
			<Icon className="connection-notice-icon" aria-hidden="true" />
			<div className="connection-notice-text">
				<strong>{t(disconnected ? "connection.disconnectedTitle" : "connection.elsewhereTitle")}</strong>
				<span>{t(disconnected ? "connection.disconnectedBody" : "connection.elsewhereBody")}</span>
			</div>
			<Button
				className="primary connection-notice-action"
				disabled={pending}
				aria-busy={pending}
				onClick={onConnect}
			>
				{pending
					? t(disconnected ? "connection.connecting" : "connection.checking")
					: t(disconnected ? "connection.connect" : "connection.retry")}
			</Button>
		</div>
	);
}

/** What a confirmed Disconnect stops; the conversation itself is always kept. */
export function DisconnectConfirmation({
	running,
	queued,
	pending,
	onConfirm,
	onCancel,
}: {
	running: boolean;
	queued: number;
	pending: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="disconnect-confirmation">
			{running && <p>{t("connection.confirmRunning")}</p>}
			{queued > 0 && (
				<p>{queued === 1 ? t("connection.confirmQueuedOne") : t("connection.confirmQueued", { count: queued })}</p>
			)}
			<p className="muted">{t("connection.confirmKept")}</p>
			<div className="actions">
				<Button onClick={onCancel}>{t("support.cancel")}</Button>
				<Button className="danger" disabled={pending} aria-busy={pending} onClick={onConfirm}>
					{t("connection.confirmAction")}
				</Button>
			</div>
		</div>
	);
}
