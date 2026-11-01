import type {
	DesktopMcpAction,
	DesktopMcpRef,
	DesktopMcpServer,
	DesktopMcpSnapshot,
} from "../../desktop-host/src/mcp-protocol";
import { Button, ErrorBanner } from "./components";
import { t } from "./i18n";

export interface McpPanelProps {
	snapshot: DesktopMcpSnapshot | null;
	pending?: boolean;
	busy?: boolean;
	error?: string;
	onRefresh: () => void;
	onOperate: (ref: DesktopMcpRef, action: DesktopMcpAction) => void;
}

const actionLabels: Record<DesktopMcpAction, () => string> = {
	suspend: () => t("settings.mcpActionSuspend"),
	resume: () => t("settings.mcpActionResume"),
	reconnect: () => t("settings.mcpActionReconnect"),
};
const stateLabels: Record<DesktopMcpServer["state"], () => string> = {
	connected: () => t("settings.mcpStateConnected"),
	connecting: () => t("settings.mcpStateConnecting"),
	disconnected: () => t("settings.mcpStateDisconnected"),
	suspended: () => t("settings.mcpStateSuspended"),
	unknown: () => t("settings.mcpStateUnknown"),
};
const sharingLabels: Record<DesktopMcpServer["sharing"], () => string> = {
	shared: () => t("settings.mcpSharingShared"),
	"per-session": () => t("settings.mcpSharingPerSession"),
	unknown: () => t("settings.mcpSharingUnknown"),
};
const serverLimit = 100;
const labelLimit = 128;

/** Display bounds never change the opaque control reference passed to the host. */
function McpText({ text, limit = labelLimit }: { text: string; limit?: number }) {
	const truncated = text.length > limit;
	let end = limit;
	if (truncated && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
	return (
		<span>
			{truncated ? text.slice(0, end) : text}
			{truncated && <small className="truncation-notice">{t("settings.mcpContentTruncated")}</small>}
		</span>
	);
}

export function McpPanel({ snapshot, pending = false, busy = false, error, onRefresh, onOperate }: McpPanelProps) {
	const servers = snapshot?.available ? snapshot.servers.slice(0, serverLimit) : [];
	const locked = pending || busy || !snapshot?.available;
	const truncated = snapshot?.truncated || (snapshot?.available && snapshot.servers.length > serverLimit);
	return (
		<section className="mcp-panel" aria-label={t("settings.mcpTitle")} aria-busy={pending}>
			<header className="mcp-heading">
				<h3>{t("settings.mcpTitle")}</h3>
				<Button
					disabled={pending}
					onClick={() => {
						if (!pending) onRefresh();
					}}
				>
					{t("settings.mcpRefresh")}
				</Button>
			</header>
			<p className="mcp-help">{t("settings.mcpHelpScope")}</p>
			<p className="mcp-help">{t("settings.mcpHelpLimits")}</p>
			{pending && (
				<p className="mcp-meta" role="status">
					{t("settings.mcpPending")}
					{snapshot && ` ${t("settings.mcpPendingRetained")}`}
				</p>
			)}
			{busy && <p className="mcp-meta">{t("settings.mcpBusy")}</p>}
			{error && (
				<ErrorBanner>
					<McpText text={error} limit={1024} />
					{snapshot && <p>{t("settings.mcpErrorRetained")}</p>}
					<p>{t("settings.mcpEffectUnknown")}</p>
				</ErrorBanner>
			)}
			{snapshot?.error && (
				<ErrorBanner>
					{snapshot.error.code}: <McpText text={snapshot.error.message} limit={1024} />
					{(snapshot.error.code === "unknown_effect" || snapshot.error.code === "backend_failure") && (
						<p>{t("settings.mcpEffectUnknown")}</p>
					)}
				</ErrorBanner>
			)}
			{!snapshot ? (
				<p className="mcp-empty">{t("settings.mcpMissing")}</p>
			) : !snapshot.available ? (
				<p className="mcp-empty">{t("settings.mcpUnavailable")}</p>
			) : (
				<>
					<p className="mcp-meta">{t("settings.mcpMeta", { count: servers.length })}</p>
					{servers.length === 0 ? (
						<p className="mcp-empty">{t("settings.mcpEmpty")}</p>
					) : (
						<ul className="mcp-server-list" aria-label={t("settings.mcpServerList")}>
							{servers.map(server => (
								<li className="mcp-server" key={server.ref.key} data-state={server.state}>
									<div className="mcp-server-main">
										<h4 className="mcp-server-label">
											<McpText text={server.label} />
										</h4>
										<dl className="mcp-meta">
											<dt>{t("settings.mcpStateLabel")}</dt>
											<dd>{stateLabels[server.state]()}</dd>
											<dt>{t("settings.mcpTransportLabel")}</dt>
											<dd>
												{server.transport === "unknown"
													? t("settings.mcpTransportUnknown")
													: server.transport}
											</dd>
											<dt>{t("settings.mcpSharingLabel")}</dt>
											<dd>{sharingLabels[server.sharing]()}</dd>
											<dt>{t("settings.mcpToolCountLabel")}</dt>
											<dd>{server.toolCount}</dd>
										</dl>
									</div>
									<div
										className="mcp-actions actions"
										role="group"
										aria-label={t("settings.mcpControlsLabel")}
									>
										{server.controls.map(action => (
											<Button
												key={action}
												disabled={locked}
												onClick={() => {
													if (!locked) onOperate(server.ref, action);
												}}
											>
												{actionLabels[action]()}
											</Button>
										))}
										{server.controls.length === 0 && (
											<small className="mcp-meta">{t("settings.mcpNoControls")}</small>
										)}
									</div>
								</li>
							))}
						</ul>
					)}
					{truncated && <p className="truncation-notice">{t("settings.mcpTruncated")}</p>}
				</>
			)}
		</section>
	);
}
