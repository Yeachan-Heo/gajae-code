import type { DesktopActivitySnapshot } from "@gajae-code/desktop-host/activity-protocol";
import type { DesktopSession } from "@gajae-code/desktop-host/protocol";
import { useId } from "react";
import { ActivityPanel, type ActivityPanelProps } from "./ActivityPanel";
import { ErrorBanner, GoalStrip, TodoPanel } from "./components";
import { t } from "./i18n";

export type DesktopGoalOperation = "resume" | "pause" | "complete" | "drop";

export interface SessionWorkPanelProps {
	session: DesktopSession;
	activity: ActivityPanelProps;
	goalPending?: boolean;
	goalError?: string;
	onOperateGoal: (op: DesktopGoalOperation) => void;
}

export function hasSessionWorkContent(session: DesktopSession, snapshot: DesktopActivitySnapshot | null): boolean {
	const state = snapshot?.sessionState;
	return Boolean(
		session.todos?.some(phase => phase.tasks.length > 0) ||
			session.goal ||
			state?.goal ||
			state?.workflow ||
			(state?.gates.available && (state.gates.pending.length > 0 || state.gates.truncated)) ||
			(snapshot?.available &&
				(snapshot.jobs.length > 0 ||
					snapshot.tasks.length > 0 ||
					snapshot.crons.length > 0 ||
					snapshot.activeMonitorCount > 0 ||
					snapshot.activeCronCount > 0 ||
					snapshot.failedUnacknowledged ||
					Object.values(snapshot.truncated).some(Boolean))),
	);
}

export function SessionWorkPanel({ session, activity, goalPending, goalError, onOperateGoal }: SessionWorkPanelProps) {
	const titleId = useId();
	const hasTasks = session.todos?.some(phase => phase.tasks.length > 0);
	const tokens = session.goal?.tokensUsed;
	const seconds = session.goal?.timeUsedSeconds;
	const empty =
		!hasSessionWorkContent(session, activity.snapshot) &&
		activity.snapshot?.available &&
		activity.snapshot.sessionState?.gates.available !== false &&
		!activity.pending &&
		!activity.error &&
		!goalError;
	return (
		<section className="session-work-panel" aria-labelledby={titleId}>
			<header className="session-work-header">
				<h2 id={titleId}>{t("panels.sessionWorkTitle")}</h2>
			</header>
			<div className="session-work-body">
				{empty && <p className="activity-empty">{t("panels.sessionWorkEmpty")}</p>}
				{hasTasks && (
					<section className="session-work-todos" aria-label={t("panels.sessionWorkTodos")}>
						<h3>{t("panels.sessionWorkTodos")}</h3>
						<TodoPanel phases={session.todos?.filter(phase => phase.tasks.length > 0) ?? []} />
					</section>
				)}
				{session.goal && (
					<section className="session-work-goal" aria-label={t("support.goalLabel")}>
						<h3>{t("support.goalLabel")}</h3>
						{session.goal && (
							<GoalStrip
								goal={session.goal}
								pending={goalPending}
								busy={session.status === "running" || session.status === "waiting"}
								onOperate={onOperateGoal}
							/>
						)}
						{tokens !== undefined && Number.isFinite(tokens) && tokens >= 0 && (
							<p className="activity-meta">{t("panels.goalTokens", { tokens })}</p>
						)}
						{seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 && (
							<p className="activity-meta">{t("panels.goalTime", { seconds })}</p>
						)}
					</section>
				)}
				{goalError && <ErrorBanner>{goalError}</ErrorBanner>}
				{!empty && <ActivityPanel {...activity} embedded hideGoal={Boolean(session.goal)} />}
			</div>
		</section>
	);
}
