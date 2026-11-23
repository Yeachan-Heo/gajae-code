import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "./components";
import { type MessageKey, t } from "./i18n";
import { connectionIcons, type ReadOnlyConnection } from "./SessionConnectionMark";

/**
 * Replaces the composer while the app does not write the conversation: what happened, and the one
 * action that changes it. A released conversation offers Connect; one another process has open
 * offers a re-check; one the app cannot open at all (`unavailable`) offers only removal from the
 * list. The draft stays in the app's draft store and returns with the composer.
 */
export function SessionConnectionNotice({
	state,
	holder,
	reason,
	pending,
	onConnect,
	onRemove,
}: {
	state: ReadOnlyConnection;
	/** With `elsewhere`: an earlier app session's background process holds it, not a terminal. */
	holder?: "earlier-app";
	/** With `unavailable`: why it cannot open, once a listing has said. */
	reason?: "outside" | "missing";
	pending: boolean;
	onConnect: () => void;
	/** With `unavailable`: remove it from the list (through the Delete confirmation). */
	onRemove?: () => void;
}) {
	const Icon = connectionIcons[state];
	const disconnected = state === "disconnected";
	const unavailable = state === "unavailable";
	const idle = unavailable ? t("connection.remove") : t(disconnected ? "connection.connect" : "connection.retry");
	const busy = t(disconnected ? "connection.connecting" : "connection.checking");
	const label = pending && !unavailable ? busy : idle;
	// Every label the Connect and Check again states can show reserves the button's width, so those
	// states' buttons, and so their layouts, match at any width and in any language.
	const reserve = unavailable
		? ""
		: [t("connection.connect"), t("connection.connecting"), t("connection.retry"), t("connection.checking")]
				.filter(text => text !== label)
				.join("\n");
	const bodyId = useId();
	const [expanded, setExpanded] = useState(false);
	const details = expanded ? t("connection.hideDetails") : t("connection.showDetails");
	const leftover = state === "elsewhere" && holder === "earlier-app";
	const [title, body]: [MessageKey, MessageKey] = disconnected
		? ["connection.disconnectedTitle", "connection.disconnectedBody"]
		: unavailable
			? reason === "outside"
				? ["connection.outsideTitle", "connection.outsideBody"]
				: reason === "missing"
					? ["connection.missingTitle", "connection.missingBody"]
					: ["connection.unavailableTitle", "connection.unavailableBody"]
			: leftover
				? ["connection.leftoverTitle", "connection.leftoverBody"]
				: ["connection.elsewhereTitle", "connection.elsewhereBody"];
	return (
		<div
			className="connection-notice"
			role="status"
			data-state={state}
			data-reason={reason}
			data-expanded={expanded || undefined}
		>
			{/* Icon and text wrap as one unit, so the icon never lands on a line of its own. */}
			<div className="connection-notice-main">
				<Icon className="connection-notice-icon" aria-hidden="true" />
				<div className="connection-notice-text">
					<strong>{t(title)}</strong>
					<span id={bodyId}>{t(body)}</span>
				</div>
				{/* Shown only in short windows, where the explanation is folded away to keep the action in view. */}
				<Button
					className="connection-notice-more"
					aria-expanded={expanded}
					aria-controls={bodyId}
					aria-label={details}
					title={details}
					onClick={() => setExpanded(value => !value)}
				>
					<ChevronDown aria-hidden="true" />
				</Button>
			</div>
			{/* While pending it stays focusable and legible (aria-disabled, not disabled) and ignores clicks. */}
			<Button
				className="primary connection-notice-action"
				aria-disabled={pending || undefined}
				aria-busy={(pending && !unavailable) || undefined}
				onClick={() => {
					if (pending) return;
					if (unavailable) onRemove?.();
					else onConnect();
				}}
			>
				{/* The other labels reserve their width (as generated content, outside the accessible name). */}
				<span className="connection-notice-label" data-reserve={reserve || undefined}>
					{label}
				</span>
			</Button>
		</div>
	);
}

/**
 * The Disconnect confirmation's dialog title. A running turn or background work is stopped
 * (`working`); with only queued messages nothing is working, and those messages simply go back
 * to the message box.
 */
export function disconnectConfirmTitle(working: boolean): string {
	return working ? t("connection.confirmTitle") : t("connection.confirmTitleQueued");
}

/** What a confirmed Disconnect stops; the conversation itself is always kept. */
export function DisconnectConfirmation({
	running,
	queued,
	background = 0,
	pending,
	onConfirm,
	onCancel,
}: {
	running: boolean;
	queued: number;
	/** Background jobs or tasks the conversation is still running; a confirmed Disconnect ends them. */
	background?: number;
	pending: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	// Stopping a turn or ending background work is the destructive case; queued messages just come back.
	const working = running || background > 0;
	return (
		<div className="disconnect-confirmation">
			{running && <p>{t("connection.confirmRunning")}</p>}
			{background > 0 && (
				<p>
					{background === 1
						? t("connection.confirmBackgroundOne")
						: t("connection.confirmBackground", { count: background })}
				</p>
			)}
			{queued > 0 && (
				<p>{queued === 1 ? t("connection.confirmQueuedOne") : t("connection.confirmQueued", { count: queued })}</p>
			)}
			<p className="muted">{t("connection.confirmKept")}</p>
			<div className="actions">
				<Button onClick={onCancel}>{t("support.cancel")}</Button>
				<Button
					className={working ? "danger" : "primary"}
					disabled={pending}
					aria-busy={pending}
					onClick={onConfirm}
				>
					{working ? t("connection.confirmAction") : t("connection.confirmActionQueued")}
				</Button>
			</div>
		</div>
	);
}
