import { useId } from "react";
import type { DesktopOperatorOperation, DesktopOperatorStatus } from "../../desktop-host/src/operator-protocol";
import { Button, ErrorBanner } from "./components";
import { t } from "./i18n";

export interface OperatorPanelProps {
	value: string;
	operation: DesktopOperatorOperation | null;
	pending?: boolean;
	disabled?: boolean;
	busy?: boolean;
	error?: string;
	onChange: (value: string) => void;
	onExecute: (text: string) => void;
	onAbort: (operationId: string) => void;
	onFold: () => void;
	onRefresh: (operationId: string) => void;
}

const statusLabels: Record<DesktopOperatorStatus, () => string> = {
	running: () => t("panels.operatorStatusRunning"),
	cancel_requested: () => t("panels.operatorStatusCancelRequested"),
	completed: () => t("panels.operatorStatusCompleted"),
	cancelled: () => t("panels.operatorStatusCancelled"),
	failed: () => t("panels.operatorStatusFailed"),
};
const outputLimit = 16_384;

export function OperatorPanel({
	value,
	operation,
	pending = false,
	disabled = false,
	busy = false,
	error,
	onChange,
	onExecute,
	onAbort,
	onFold,
	onRefresh,
}: OperatorPanelProps) {
	const id = useId();
	const locked = pending || disabled;
	const active = operation?.status === "running" || operation?.status === "cancel_requested";
	const canExecute = !locked && !busy && !active && Boolean(value.trim());
	const canAbort = !locked && operation?.status === "running";
	const failed =
		operation &&
		(operation.status === "failed" ||
			operation.error !== undefined ||
			(operation.status !== "cancelled" &&
				((operation.exitCode !== undefined && operation.exitCode !== 0) || Boolean(operation.signal))));
	const withheld = active && operation?.liveOutput === "withheld";
	// DTO output is already redacted and bounded by the host. Keep a defensive display bound, too.
	const output = withheld ? "" : (operation?.output ?? "").slice(-outputLimit);
	const truncated = operation && (operation.outputTruncated || (!withheld && operation.output.length > outputLimit));
	return (
		<section className="operator-panel" aria-labelledby={`${id}-title`} aria-busy={pending}>
			<header className="operator-heading">
				<h3 id={`${id}-title`}>{t("panels.directRun")}</h3>
			</header>
			<form
				className="operator-form"
				onSubmit={event => {
					event.preventDefault();
					if (canExecute) onExecute(value);
				}}
			>
				<label htmlFor={`${id}-input`}>{t("panels.operatorInputLabel")}</label>
				<textarea
					id={`${id}-input`}
					aria-describedby={`${id}-help`}
					rows={3}
					value={value}
					disabled={locked}
					spellCheck={false}
					onChange={event => {
						if (!locked) onChange(event.target.value);
					}}
				/>
				<p id={`${id}-help`} className="operator-help">
					<code>!</code> {t("panels.operatorShell")} · <code>!!</code> {t("panels.operatorShellExcluded")} ·{" "}
					<code>$</code> Python · <code>$$</code> Python ({t("panels.operatorExcluded")}).{" "}
					{t("panels.operatorHelp")}
				</p>
				<div className="actions">
					<Button type="submit" className="primary" disabled={!canExecute}>
						{t("panels.run")}
					</Button>
				</div>
			</form>
			{busy && !active && <p className="operator-meta">{t("panels.operatorBusy")}</p>}
			{pending && (
				<p className="operator-meta" role="status">
					{t("panels.operatorPending")}
				</p>
			)}
			{disabled && <p className="operator-meta">{t("panels.operatorLocked")}</p>}
			{error && <ErrorBanner>{error}</ErrorBanner>}
			{operation ? (
				<article className="operator-result" data-status={operation.status} data-failed={failed || undefined}>
					<p className="operator-meta" role="status">
						{operation.kind === "bash" ? t("panels.operatorKindShell") : t("panels.operatorKindPython")} ·{" "}
						{statusLabels[operation.status]()} ({operation.status})
						{failed && operation.status !== "failed" && <> · {t("panels.operatorStatusFailed")}</>}
					</p>
					<p className="operator-meta">
						{operation.excludeFromContext
							? t("panels.excludedFromModelContext")
							: t("panels.includedInModelContext")}
					</p>
					<dl className="operator-meta">
						<dt>{t("panels.exitCode")}</dt>
						<dd>{operation.exitCode ?? t("panels.notProvided")}</dd>
						<dt>{t("panels.exitSignal")}</dt>
						<dd>{operation.signal ?? t("panels.notProvided")}</dd>
					</dl>
					{operation.error && (
						<ErrorBanner>
							{operation.error.code}: {operation.error.message}
						</ErrorBanner>
					)}
					<p className="operator-meta">
						{operation.liveOutput === "withheld"
							? withheld
								? t("panels.liveOutputWithheldActive")
								: t("panels.liveOutputWithheldFinal")
							: t("panels.outputRedacted")}
					</p>
					{output ? (
						<pre className="bounded-output operator-output" aria-label={t("panels.actualRunOutput")}>
							{output}
						</pre>
					) : (
						<p className="operator-meta">{withheld ? t("panels.noOutputShown") : t("panels.noOutputProvided")}</p>
					)}
					{truncated && <p className="truncation-notice">{t("panels.outputTruncated")}</p>}
					<details className="operator-details">
						<summary>{t("panels.runIdentity")}</summary>
						<dl className="operator-meta">
							<dt>{t("panels.runId")}</dt>
							<dd>{operation.operationId}</dd>
						</dl>
					</details>
					<div className="actions" role="group" aria-label={t("panels.directRunControls")}>
						<Button
							disabled={!canAbort}
							onClick={() => {
								if (canAbort) onAbort(operation.operationId);
							}}
						>
							{t("panels.requestCancellation")}
						</Button>
						<Button
							disabled={locked}
							onClick={() => {
								if (!locked) onRefresh(operation.operationId);
							}}
						>
							{t("panels.refreshRunDetails")}
						</Button>
					</div>
				</article>
			) : (
				<p className="operator-meta">{t("panels.noRunInfo")}</p>
			)}
			<div className="operator-fold">
				<Button
					disabled={locked}
					onClick={() => {
						if (!locked) onFold();
					}}
				>
					{t("panels.foldForegroundTool")}
				</Button>
				<p className="operator-help">{t("panels.foldHelp")}</p>
			</div>
		</section>
	);
}
