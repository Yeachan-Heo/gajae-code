import { ChevronRight, RefreshCw } from "lucide-react";
import { useId } from "react";
import type {
	DesktopActivityCron,
	DesktopActivityJob,
	DesktopActivityOperation,
	DesktopActivityRef,
	DesktopActivityScope,
	DesktopActivitySnapshot,
	DesktopActivityStatus,
	DesktopActivityTask,
} from "../../desktop-host/src/activity-protocol";
import { Button, ErrorBanner } from "./components";
import { t } from "./i18n";

export interface ActivityPanelProps {
	snapshot: DesktopActivitySnapshot | null;
	pending?: boolean;
	error?: string;
	onRefresh: () => void;
	onOperate: (ref: DesktopActivityRef, operation: DesktopActivityOperation) => void;
	onAcknowledge: (scope: DesktopActivityScope) => void;
	onInspect: (ref: DesktopActivityRef) => void;
	onOpenGate: (ref: DesktopActivityRef) => void;
}

const operationLabels: Record<DesktopActivityOperation, () => string> = {
	cancel: () => t("panels.operationCancel"),
	delete: () => t("panels.operationDelete"),
	stop: () => t("panels.operationStop"),
	pause: () => t("panels.operationPause"),
	resume: () => t("panels.operationResume"),
};
const statusLabels: Record<DesktopActivityStatus, () => string> = {
	running: () => t("panels.statusRunning"),
	paused: () => t("panels.statusPaused"),
	queued: () => t("panels.statusQueued"),
	completed: () => t("panels.statusCompleted"),
	failed: () => t("panels.statusFailed"),
	cancelled: () => t("panels.statusCancelled"),
};
const deliveryLabels = {
	pending: () => t("panels.deliveryPending"),
	delivered: () => t("panels.deliveryDelivered"),
	"failed-visible": () => t("panels.deliveryFailedVisible"),
};
const gateLabels = {
	question: () => t("panels.gateQuestion"),
	approval: () => t("panels.gateApproval"),
	execution: () => t("panels.gateExecution"),
};
const goalLabels = {
	active: () => t("panels.goalActive"),
	paused: () => t("panels.statusPaused"),
	complete: () => t("panels.statusCompleted"),
	dropped: () => t("panels.goalDropped"),
};

type ActivityEntry = DesktopActivityJob | DesktopActivityTask | DesktopActivityCron;

/** Bound display text only. The original reference always goes back to the host unchanged. */
function ActivityText({ text, limit = 1024 }: { text: string; limit?: number }) {
	const truncated = text.length > limit;
	let end = limit;
	// Do not cut a UTF-16 surrogate pair at the display boundary.
	if (truncated && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
	return (
		<span>
			{truncated ? text.slice(0, end) : text}
			{truncated && <small className="truncation-notice">{t("panels.truncated")}</small>}
		</span>
	);
}

function ActivityEntryCard({
	entry,
	pending,
	onOperate,
	onInspect,
}: {
	entry: ActivityEntry;
	pending?: boolean;
	onOperate: ActivityPanelProps["onOperate"];
	onInspect: ActivityPanelProps["onInspect"];
}) {
	const title = entry.type === "job" ? entry.label : entry.type === "task" ? entry.id : entry.schedule;
	return (
		<article className="activity-entry" data-kind={entry.type}>
			<div className="activity-entry-main">
				<h4>
					<ActivityText text={title} limit={240} />
				</h4>
				<p className="activity-meta">
					{entry.type === "cron" ? (
						<>
							{entry.recurring ? t("panels.scheduleRecurring") : t("panels.scheduleOneOff")} ·{" "}
							{entry.firing ? t("panels.scheduleFiring") : t("panels.scheduleNotFiring")}
						</>
					) : (
						statusLabels[entry.status]()
					)}
					{entry.type === "job" && (
						<>
							{" "}
							· {entry.backgrounded ? t("panels.jobBackground") : t("panels.jobForeground")} ·{" "}
							{deliveryLabels[entry.deliveryState]()}
						</>
					)}
				</p>
				{entry.type === "job" && (
					<p className="activity-meta">
						{entry.outputAvailable ? t("panels.outputAvailable") : t("panels.outputUnavailable")}
					</p>
				)}
				{entry.reason && (
					<p className="activity-meta">
						<ActivityText text={entry.reason} />
					</p>
				)}
				{entry.type === "job" && entry.error && (
					<ErrorBanner>
						<ActivityText text={entry.error} />
					</ErrorBanner>
				)}
				<details className="activity-details">
					<summary>
						<ChevronRight className="disclosure-chevron" size={16} aria-hidden="true" />
						{t("panels.identity")}
					</summary>
					<dl className="activity-meta">
						<dt>ID</dt>
						<dd>
							<ActivityText text={entry.id} />
						</dd>
						{entry.type === "job" && (
							<>
								<dt>{t("panels.kindLabel")}</dt>
								<dd>
									<ActivityText text={entry.kind} />
								</dd>
							</>
						)}
						{entry.type !== "cron" && (
							<>
								<dt>{t("panels.statusLabel")}</dt>
								<dd>{statusLabels[entry.status]()}</dd>
							</>
						)}
						{entry.type === "task" && (
							<>
								<dt>{t("panels.requestedModel")}</dt>
								<dd>
									{entry.requestedModel ? (
										<ActivityText text={entry.requestedModel} />
									) : (
										t("panels.notProvided")
									)}
								</dd>
								<dt>{t("panels.actualModel")}</dt>
								<dd>
									{entry.effectiveModel ? (
										<ActivityText text={entry.effectiveModel} />
									) : (
										t("panels.notProvided")
									)}
								</dd>
							</>
						)}
						{entry.type === "cron" && (
							<>
								<dt>{t("panels.scheduleLabel")}</dt>
								<dd>
									<ActivityText text={entry.schedule} />
								</dd>
								<dt>{t("panels.nextRun")}</dt>
								<dd>{entry.nextFireAt ?? t("panels.notProvided")}</dd>
							</>
						)}
					</dl>
				</details>
			</div>
			<div className="activity-actions" role="group" aria-label={t("panels.activityControls")}>
				<Button disabled={pending} onClick={() => onInspect(entry.ref)}>
					{t("panels.viewDetails")}
				</Button>
				{entry.controls.map(operation => (
					<Button
						key={operation}
						className={operation === "delete" || operation === "cancel" || operation === "stop" ? "danger" : ""}
						disabled={pending}
						onClick={() => onOperate(entry.ref, operation)}
					>
						{operationLabels[operation]()}
					</Button>
				))}
				{entry.controls.length === 0 && <small>{t("panels.noControls")}</small>}
			</div>
		</article>
	);
}

function ActivityGroup({
	title,
	entries,
	truncated,
	stale,
	pending,
	onOperate,
	onInspect,
}: {
	title: string;
	entries: ActivityEntry[];
	truncated: boolean;
	stale: boolean;
	pending?: boolean;
	onOperate: ActivityPanelProps["onOperate"];
	onInspect: ActivityPanelProps["onInspect"];
}) {
	const titleId = useId();
	return (
		<section className="activity-group" aria-labelledby={titleId}>
			<h3 id={titleId}>
				{title} <small>{t("panels.showingCount", { count: entries.length })}</small>
			</h3>
			{entries.length === 0 ? (
				<p className="activity-empty">{stale ? t("panels.activityStaleEmpty") : t("panels.activityEmpty")}</p>
			) : (
				entries.map(entry => (
					<ActivityEntryCard
						key={entry.ref.key}
						entry={entry}
						pending={pending}
						onOperate={onOperate}
						onInspect={onInspect}
					/>
				))
			)}
			{truncated && <p className="truncation-notice">{t("panels.activityGroupTruncated")}</p>}
		</section>
	);
}

export function ActivityPanel({
	snapshot,
	pending,
	error,
	onRefresh,
	onOperate,
	onAcknowledge,
	onInspect,
	onOpenGate,
}: ActivityPanelProps) {
	const titleId = useId();
	const state = snapshot?.sessionState;
	return (
		<section className="activity-panel" aria-labelledby={titleId} aria-busy={pending}>
			<header className="activity-toolbar">
				<div>
					<h2 id={titleId}>{t("panels.activityTitle")}</h2>
					<p className="activity-meta">{t("panels.activitySubtitle")}</p>
				</div>
				<Button disabled={pending} onClick={onRefresh}>
					<RefreshCw size={16} aria-hidden="true" />
					{t("panels.refresh")}
				</Button>
			</header>
			{pending && (
				<p className="notice" role="status">
					{t("panels.activityPending")}
					{snapshot && ` ${t("panels.activityLastReceived")}`}
				</p>
			)}
			{error && (
				<ErrorBanner>
					<ActivityText text={error} />
					{snapshot && <p>{t("panels.activityErrorLastReceived")}</p>}
				</ErrorBanner>
			)}
			{!snapshot ? (
				!pending && (
					<p className="activity-empty">
						{error ? t("panels.activityReadFailed") : t("panels.activityDisconnected")}
					</p>
				)
			) : !snapshot.available ? (
				<div className="activity-empty">
					<h3>{t("panels.activityUnavailable")}</h3>
					<ActivityText text={snapshot.reason} />
				</div>
			) : (
				<>
					<div className="activity-meta" aria-label={t("panels.activitySummaryLabel")}>
						<p>
							{t("panels.activityCounts", {
								monitors: snapshot.activeMonitorCount,
								schedules: snapshot.activeCronCount,
							})}
						</p>
						<p>
							{t("panels.activityObservedState", {
								state:
									snapshot.worstState === "failed"
										? t("panels.statusFailed")
										: snapshot.worstState === "running"
											? t("panels.statusRunning")
											: t("panels.observedNone"),
							})}
						</p>
						<p>{t("panels.activityCountsOverlap")}</p>
					</div>
					{snapshot.failedUnacknowledged && (
						<div className="activity-actions">
							<p>{t("panels.failuresUnacknowledged")}</p>
							<Button
								disabled={pending}
								onClick={() =>
									onAcknowledge({
										sessionGeneration: snapshot.sessionGeneration,
										connectionGeneration: snapshot.connectionGeneration,
									})
								}
							>
								{t("panels.acknowledgeFailures")}
							</Button>
						</div>
					)}
					<ActivityGroup
						title={t("panels.groupJobs")}
						entries={snapshot.jobs}
						truncated={snapshot.truncated.jobs}
						stale={Boolean(pending || error)}
						pending={pending}
						onOperate={onOperate}
						onInspect={onInspect}
					/>
					<ActivityGroup
						title={t("panels.groupTasks")}
						entries={snapshot.tasks}
						truncated={snapshot.truncated.tasks}
						stale={Boolean(pending || error)}
						pending={pending}
						onOperate={onOperate}
						onInspect={onInspect}
					/>
					<ActivityGroup
						title={t("panels.groupSchedules")}
						entries={snapshot.crons}
						truncated={snapshot.truncated.crons}
						stale={Boolean(pending || error)}
						pending={pending}
						onOperate={onOperate}
						onInspect={onInspect}
					/>
				</>
			)}
			<section className="activity-group" aria-label={t("panels.goalSectionLabel")}>
				<h3>
					{t("panels.goalSectionTitle")} <small>{t("panels.readOnly")}</small>
				</h3>
				{!state ? (
					<p className="activity-empty">{t("panels.noSessionSummary")}</p>
				) : (
					<div className="activity-meta">
						<p>
							{state.goal
								? t("panels.goalSummary", {
										state: state.goal.enabled ? t("panels.goalModeOn") : t("panels.goalModeOff"),
										status: goalLabels[state.goal.status](),
										tokens: state.goal.tokensUsed,
										seconds: state.goal.timeUsedSeconds,
									})
								: t("panels.noGoal")}
						</p>
						<p>
							{t("panels.workflowLabel")}{" "}
							{state.workflow ? (
								<ActivityText text={state.workflow.skill} limit={240} />
							) : (
								t("panels.noWorkflow")
							)}
						</p>
					</div>
				)}
			</section>
			<section className="activity-group" aria-label={t("panels.gatesLabel")}>
				<h3>
					{t("panels.gatesLabel")}{" "}
					{state?.gates.available && (
						<small>{t("panels.showingCount", { count: state.gates.pending.length })}</small>
					)}
				</h3>
				{!state ? (
					<p className="activity-empty">{t("panels.noGateInfo")}</p>
				) : !state.gates.available ? (
					<p className="activity-empty">
						{t("panels.gatesUnavailable")} <ActivityText text={state.gates.reason} />
					</p>
				) : (
					<>
						{state.gates.pending.length === 0 && (
							<p className="activity-empty">
								{pending || error ? t("panels.gatesStaleEmpty") : t("panels.gatesEmpty")}
							</p>
						)}
						{state.gates.pending.map(gate => (
							<article className="activity-entry" key={gate.ref.key}>
								<div className="activity-entry-main">
									<h4>
										{gateLabels[gate.kind]()} · <ActivityText text={gate.stage} limit={240} />
									</h4>
									<p className="activity-meta">
										{t("panels.createdLabel")} <ActivityText text={gate.createdAt} limit={120} />
									</p>
									<p className="activity-meta">
										{gate.answerable ? t("panels.gateAnswerable") : t("panels.gateNotAnswerable")}
									</p>
									{gate.reason && (
										<p className="activity-meta">
											<ActivityText text={gate.reason} />
										</p>
									)}
								</div>
								<div className="activity-actions">
									<Button disabled={pending} onClick={() => onOpenGate(gate.ref)}>
										{t("panels.viewRequest")}
									</Button>
								</div>
							</article>
						))}
						{state.gates.truncated && <p className="truncation-notice">{t("panels.gatesTruncated")}</p>}
					</>
				)}
			</section>
		</section>
	);
}
