import type {
	DesktopSessionInfo,
	DesktopSessionInfoContext,
	DesktopSessionInfoUnavailable,
	DesktopSessionInfoUsage,
} from "../../desktop-host/src/session-info-protocol";
import { Button, ErrorBanner } from "./components";
import { t } from "./i18n";

export interface SessionInfoPanelProps {
	info: DesktopSessionInfo | null;
	pending?: boolean;
	error?: string;
	onRefresh(): void;
}

const runLabels = {
	running: () => t("panels.runWorking"),
	compacting: () => t("panels.runCompacting"),
	retrying: () => t("panels.runRetrying"),
	settling: () => t("panels.runSettling"),
	idle: () => t("panels.runIdle"),
};
const unavailableLabels = {
	disposed: () => t("panels.sessionDisposed"),
	transitioning: () => t("panels.sessionTransitioning"),
	stale_session: () => t("panels.sessionStale"),
	backend_failure: () => t("panels.sessionBackendFailure"),
	redaction_failed: () => t("panels.sessionRedactionFailed"),
	invalid_catalog_session: () => t("panels.sessionInvalidCatalog"),
};
const usageLabels = {
	transcript_aggregate: () => t("panels.usageTranscriptAggregate"),
	active_messages: () => t("panels.usageActiveMessages"),
	stream_partial: () => t("panels.usageStreamPartial"),
};
const contextLabels = {
	provider_anchor: () => t("panels.contextProviderAnchor"),
	heuristic: () => t("panels.contextHeuristic"),
	unknown: () => t("panels.contextUnknownSource"),
};
const costSourceLabels = {
	sdk_recorded_cost: () => t("panels.costSourceRecorded"),
	live_partial_cost: () => t("panels.costSourceProvisional"),
};

/** Host-redacted text remains inert and defensively bounded in the renderer. */
function InfoText({ text, limit = 1024 }: { text: string | null; limit?: number }) {
	if (text === null) return <>{t("panels.unknown")}</>;
	const truncated = text.length > limit;
	let end = limit;
	if (truncated && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
	return (
		<span className="session-info-text">
			{truncated ? text.slice(0, end) : text}
			{truncated && <small className="truncation-notice">{t("panels.truncated")}</small>}
		</span>
	);
}

function counter(value: number | null): string {
	return value !== null && Number.isSafeInteger(value) && value >= 0 ? String(value) : t("panels.unknown");
}

function costAmount(value: number | null): string {
	return value !== null && Number.isFinite(value) && value >= 0 ? String(value) : t("panels.unknown");
}

function UsageSection({
	title,
	usage,
}: {
	title: string;
	usage: DesktopSessionInfoUsage | DesktopSessionInfoUnavailable;
}) {
	return (
		<section
			className="session-info-usage"
			aria-label={title}
			data-source={usage.available ? usage.source : undefined}
		>
			<h4>{title}</h4>
			{usage.available ? (
				<>
					<p className="session-info-note">
						{t("panels.sourceLabel")} {usageLabels[usage.source]()}
					</p>
					<p className="session-info-note">
						<InfoText text={usage.note} />
					</p>
					<dl className="session-info-grid">
						<dt>{t("panels.inputTokens")}</dt>
						<dd>{counter(usage.tokens.input)}</dd>
						<dt>{t("panels.outputTokens")}</dt>
						<dd>{counter(usage.tokens.output)}</dd>
						<dt>{t("panels.cacheReadTokens")}</dt>
						<dd>{counter(usage.tokens.cacheRead)}</dd>
						<dt>{t("panels.cacheWriteTokens")}</dt>
						<dd>{counter(usage.tokens.cacheWrite)}</dd>
						<dt>{t("panels.sdkTotalTokens")}</dt>
						<dd>{counter(usage.tokens.total)}</dd>
						<dt>{t("panels.premiumRequests")}</dt>
						<dd>{counter(usage.premiumRequests)}</dd>
						<dt>
							{usage.cost.source === "live_partial_cost"
								? t("panels.costProvisional")
								: t("panels.costRecorded")}
						</dt>
						<dd>{costAmount(usage.cost.amount)}</dd>
					</dl>
					<p className="session-info-note">
						{t("panels.costSourceLabel")} {costSourceLabels[usage.cost.source]()} ·{" "}
						<InfoText text={usage.cost.reason} />
					</p>
				</>
			) : (
				<p className="session-info-note">
					{t("panels.usageUnavailable")} <InfoText text={usage.reason} />
				</p>
			)}
		</section>
	);
}

function ContextSection({ context }: { context: DesktopSessionInfoContext }) {
	const known =
		context.source !== "unknown" &&
		context.percent !== null &&
		Number.isFinite(context.percent) &&
		context.percent >= 0;
	const percent = known && context.percent !== null ? Math.round(Math.min(100, context.percent)) : null;
	const percentLabel =
		percent === null
			? t("panels.unknown")
			: context.percent !== null && context.percent > 100
				? t("panels.contextPercentAtLeast", { percent })
				: t("panels.contextPercentApprox", { percent });
	return (
		<section className="session-info-context" aria-label={t("panels.contextEstimate")}>
			<h4>{t("panels.contextEstimate")}</h4>
			<p className="session-info-note">
				{t("panels.sourceLabel")} {contextLabels[context.source]()}
			</p>
			<dl className="session-info-grid">
				<dt>{t("panels.estimatedContextTokens")}</dt>
				<dd>{counter(context.tokens)}</dd>
				<dt>{t("panels.contextWindow")}</dt>
				<dd>{counter(context.contextWindow)}</dd>
				<dt>{t("panels.estimatedUsage")}</dt>
				<dd>{percentLabel}</dd>
			</dl>
			{percent !== null && (
				<meter
					className="session-info-meter"
					aria-label={t("panels.estimatedContextUsage")}
					aria-valuetext={percentLabel}
					min={0}
					max={100}
					value={percent}
				>
					{percentLabel}
				</meter>
			)}
			<p className="session-info-note">
				<InfoText text={context.note} /> {t("panels.contextNotBilled")}
			</p>
		</section>
	);
}

export function SessionInfoPanel({ info, pending = false, error, onRefresh }: SessionInfoPanelProps) {
	return (
		<section className="session-info-panel" aria-label={t("panels.sessionInfo")} aria-busy={pending}>
			<header className="session-info-heading">
				<h3>{t("panels.sessionInfo")}</h3>
				<Button disabled={pending} onClick={onRefresh}>
					{t("panels.refreshSessionInfo")}
				</Button>
			</header>
			<p className="session-info-note">{t("panels.sessionInfoNote")}</p>
			{pending && (
				<p className="session-info-note" role="status">
					{t("panels.sessionInfoPending")}
				</p>
			)}
			{error && (
				<ErrorBanner>
					<InfoText text={error} />
				</ErrorBanner>
			)}
			{info?.available && (pending || error) && (
				<p className="session-info-note">{t("panels.sessionInfoStaleNote")}</p>
			)}
			{info === null ? (
				<p className="session-info-note">{t("panels.sessionInfoNone")}</p>
			) : !info.available ? (
				<ErrorBanner>
					<p>{unavailableLabels[info.code]()}</p>
					<p>
						<InfoText text={info.reason} />
					</p>
				</ErrorBanner>
			) : (
				<>
					<section className="session-info-metadata" aria-label={t("panels.sessionMetadata")}>
						<h4>{t("panels.sessionHeading")}</h4>
						<dl className="session-info-grid">
							<dt>{t("panels.nameLabel")}</dt>
							<dd>
								<InfoText text={info.metadata.name} limit={240} />
							</dd>
							<dt>{t("panels.appCatalogId")}</dt>
							<dd>
								<InfoText text={info.metadata.catalogSessionId} />
							</dd>
							<dt>{t("panels.transcriptFile")}</dt>
							<dd>
								<InfoText text={info.metadata.sessionFileDisplay} />
							</dd>
							<dt>{t("panels.workingDirectory")}</dt>
							<dd>
								<InfoText text={info.metadata.cwd} />
							</dd>
							<dt>{t("panels.createdProvided")}</dt>
							<dd>
								<InfoText text={info.metadata.createdAt} />
							</dd>
							<dt>{t("panels.transcriptPersistence")}</dt>
							<dd>{info.metadata.persisted ? t("panels.persistenceOn") : t("panels.persistenceOff")}</dd>
						</dl>
						<p className="session-info-note">{t("panels.pathNotPermission")}</p>
					</section>
					<section className="session-info-model" aria-label={t("panels.actualModelSection")}>
						<h4>{t("panels.actualModelHeading")}</h4>
						{info.model ? (
							<dl className="session-info-grid">
								<dt>{t("panels.modelLabel")}</dt>
								<dd>
									<InfoText text={info.model.name} limit={240} />
								</dd>
								<dt>{t("panels.providerLabel")}</dt>
								<dd>
									<InfoText text={info.model.provider} limit={240} />
								</dd>
								<dt>{t("panels.modelIdLabel")}</dt>
								<dd>
									<InfoText text={info.model.id} />
								</dd>
							</dl>
						) : (
							<p className="session-info-note">{t("panels.modelUnknown")}</p>
						)}
						<dl className="session-info-grid">
							<dt>{t("panels.reasoningLevel")}</dt>
							<dd>
								<InfoText text={info.thinkingLevel} limit={240} />
							</dd>
						</dl>
					</section>
					<section className="session-info-run" aria-label={t("panels.runAndToolsSection")}>
						<h4>{t("panels.runAndToolsHeading")}</h4>
						<p className="session-info-note">{t("panels.stateAtRead", { label: runLabels[info.run.state]() })}</p>
						<dl className="session-info-grid">
							<dt>{t("panels.streaming")}</dt>
							<dd>{info.run.streaming ? t("panels.inProgress") : t("panels.noFlag")}</dd>
							<dt>{t("panels.directShellRun")}</dt>
							<dd>{info.run.bashRunning ? t("panels.inProgress") : t("panels.noFlag")}</dd>
							<dt>{t("panels.directPythonRun")}</dt>
							<dd>{info.run.pythonRunning ? t("panels.inProgress") : t("panels.noFlag")}</dd>
							<dt>{t("panels.contextCompaction")}</dt>
							<dd>{info.run.compacting ? t("panels.inProgress") : t("panels.noFlag")}</dd>
							<dt>{t("panels.retry")}</dt>
							<dd>{info.run.retrying ? t("panels.inProgress") : t("panels.noFlag")}</dd>
							<dt>{t("panels.postPromptWork")}</dt>
							<dd>{info.run.postPromptWork ? t("panels.inProgress") : t("panels.noFlag")}</dd>
							<dt>{t("panels.queuedMessages")}</dt>
							<dd>{counter(info.run.queuedMessages)}</dd>
							<dt>{t("panels.availableTools")}</dt>
							<dd>{counter(info.tools.available)}</dd>
							<dt>{t("panels.pendingTools")}</dt>
							<dd>{counter(info.tools.pending)}</dd>
							<dt>{t("panels.toolCalls")}</dt>
							<dd>{counter(info.tools.calls)}</dd>
							<dt>{t("panels.toolResults")}</dt>
							<dd>{counter(info.tools.results)}</dd>
						</dl>
					</section>
					<div className="session-info-usage-groups">
						<p className="session-info-note">{t("panels.usageOverlapNote")}</p>
						<UsageSection title={t("panels.usageRecordedTitle")} usage={info.recordedTotals} />
						<p className="session-info-note">{t("panels.usageRecordedNote")}</p>
						<UsageSection title={t("panels.usageActiveTitle")} usage={info.activeTotals} />
						<UsageSection title={t("panels.usageLiveTitle")} usage={info.liveProgress} />
						<p className="session-info-note">{t("panels.costDisclaimer")}</p>
					</div>
					<ContextSection context={info.context} />
					<section className="session-info-unavailable" aria-label={t("panels.accountSection")}>
						<h4>{t("panels.accountHeading")}</h4>
						<dl className="session-info-grid">
							<dt>{t("panels.accountQuota")}</dt>
							<dd>
								{t("panels.unknownWithReason")} <InfoText text={info.accountQuota.reason} />
							</dd>
							<dt>{t("panels.actualBilledCost")}</dt>
							<dd>
								{t("panels.unknownWithReason")} <InfoText text={info.actualBilledCost.reason} />
							</dd>
						</dl>
					</section>
				</>
			)}
		</section>
	);
}
