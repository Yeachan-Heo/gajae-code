import type { DesktopSession } from "@gajae-code/desktop-host/protocol";
import { X } from "lucide-react";
import { useId } from "react";
import { ActivityPanel, type ActivityPanelProps } from "./ActivityPanel";
import { Button, ErrorBanner, GoalStrip, TodoPanel } from "./components";
import { t } from "./i18n";

export type DesktopGoalOperation = "resume" | "pause" | "complete" | "drop";

export interface SessionWorkPanelProps {
	session: DesktopSession;
	activity: ActivityPanelProps;
	goalPending?: boolean;
	goalError?: string;
	onOperateGoal: (op: DesktopGoalOperation) => void;
	onClose: () => void;
}

export function SessionWorkPanel({
	session,
	activity,
	goalPending,
	goalError,
	onOperateGoal,
	onClose,
}: SessionWorkPanelProps) {
	const titleId = useId();
	const hasTasks = session.todos?.some(phase => phase.tasks.length > 0);
	return (
		<section className="session-work-panel" aria-labelledby={titleId}>
			<header className="session-work-header">
				<h2 id={titleId}>{t("panels.sessionWorkTitle")}</h2>
				<Button
					className="icon"
					aria-label={t("panels.closeSessionWork")}
					title={t("panels.closeSessionWork")}
					onClick={onClose}
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="session-work-body">
				<section className="session-work-todos" aria-label={t("panels.sessionWorkTodos")}>
					<h3>{t("panels.sessionWorkTodos")}</h3>
					{hasTasks ? (
						<TodoPanel phases={session.todos ?? []} />
					) : (
						<p className="activity-empty">{t("panels.sessionWorkNoTasks")}</p>
					)}
				</section>
				<section className="session-work-goal" aria-label={t("support.goalLabel")}>
					<h3>{t("support.goalLabel")}</h3>
					{session.goal ? (
						<GoalStrip
							goal={session.goal}
							pending={goalPending}
							busy={session.status === "running" || session.status === "waiting"}
							onOperate={onOperateGoal}
						/>
					) : (
						<p className="activity-empty">{t("panels.noGoal")}</p>
					)}
					{goalError && <ErrorBanner>{goalError}</ErrorBanner>}
				</section>
				<ActivityPanel {...activity} embedded />
			</div>
		</section>
	);
}
