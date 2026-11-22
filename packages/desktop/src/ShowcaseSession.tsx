import type { DesktopSession } from "@gajae-code/desktop-host/protocol";
import type { ReactNode } from "react";
import { Button, SessionRow } from "./components";
import { type MessageKey, t } from "./i18n";
import { RecoveryConversation } from "./RecoveryConversation";
import { DisconnectConfirmation, SessionConnectionNotice } from "./SessionConnection";
import { SessionConnectionBadge } from "./SessionConnectionMark";

function State({ caption, narrow, children }: { caption: MessageKey; narrow?: boolean; children: ReactNode }) {
	return (
		<div className={narrow ? "showcase-todo-state showcase-session-narrow" : "showcase-todo-state"}>
			<h3>{t(caption)}</h3>
			{children}
		</div>
	);
}

/** The App's recovery card markup around fixture records; its buttons do nothing here. */
function RecoveryCard({ orphan, restored, children }: { orphan?: boolean; restored?: boolean; children: ReactNode }) {
	return (
		<div className="notice" role="status">
			<p>{t("support.deliveryOutcomeUnknown")}</p>
			{children}
			{!orphan && <Button disabled={restored}>{t("shell.restoreDraft")}</Button>}
			<Button disabled={!orphan && !restored}>{t("shell.discardRestoredRecord")}</Button>
		</div>
	);
}

export function ShowcaseSessionNav() {
	return (
		<>
			<a href="#showcase-recovery-cards">{t("recovery.showcaseNav")}</a>
			<a href="#showcase-session-connection">{t("connection.showcaseNav")}</a>
		</>
	);
}

// Fixture rows only: nothing here is requested from the Host.
const row = (id: string, title: string, state: "connected" | "disconnected" | "elsewhere"): DesktopSession => ({
	id,
	projectId: "p",
	title,
	starred: false,
	status: "idle",
	imageInput: null,
	operatorRunning: false,
	controlGeneration: null,
	messages: [],
	connection: { state },
});

/** The composer area around a connection notice, as the App lays it out. */
function ComposerArea({ children }: { children: ReactNode }) {
	return <div className="composer-area">{children}</div>;
}

function ShowcaseConnection() {
	const none = () => {};
	return (
		<section id="showcase-session-connection">
			<h2>{t("connection.showcaseHeading")}</h2>
			<p className="muted">{t("connection.showcaseNote")}</p>
			<div className="showcase-todo-states">
				<State caption="connection.showcaseDisconnected">
					<ComposerArea>
						<SessionConnectionNotice state="disconnected" pending={false} onConnect={none} />
					</ComposerArea>
				</State>
				<State caption="connection.showcaseConnecting">
					<ComposerArea>
						<SessionConnectionNotice state="disconnected" pending onConnect={none} />
					</ComposerArea>
				</State>
				<State caption="connection.showcaseElsewhere">
					<ComposerArea>
						<SessionConnectionNotice state="elsewhere" pending={false} onConnect={none} />
					</ComposerArea>
				</State>
				<State caption="connection.showcaseChecking">
					<ComposerArea>
						<SessionConnectionNotice state="elsewhere" pending onConnect={none} />
					</ComposerArea>
				</State>
				<State caption="connection.showcaseBadges">
					<div className="toolbar-title">
						<h1>Fix the flaky test</h1>
						<SessionConnectionBadge session={row("b1", "", "disconnected")} />
					</div>
					<div className="toolbar-title">
						<h1>Release checklist</h1>
						<SessionConnectionBadge session={row("b2", "", "elsewhere")} />
					</div>
				</State>
				<State caption="connection.showcaseRows">
					<div className="showcase-session-rows">
						<SessionRow session={row("r1", "Connected conversation", "connected")} onSelect={none} />
						<SessionRow session={row("r2", "Fix the flaky test", "disconnected")} selected onSelect={none} />
						<SessionRow session={row("r3", "Release checklist", "elsewhere")} onSelect={none} />
					</div>
				</State>
				<State caption="connection.showcaseConfirm">
					<DisconnectConfirmation running queued={2} pending={false} onConfirm={none} onCancel={none} />
				</State>
				<State caption="connection.showcaseConfirmQueued">
					<DisconnectConfirmation running={false} queued={1} pending={false} onConfirm={none} onCancel={none} />
				</State>
				<State caption="connection.showcaseNarrow" narrow>
					<div className="showcase-session-rows">
						<SessionRow
							session={row("r4", "터미널에서 이어서 작업한 아주 긴 대화 제목", "disconnected")}
							onSelect={none}
						/>
					</div>
					<ComposerArea>
						<SessionConnectionNotice state="disconnected" pending={false} onConnect={none} />
					</ComposerArea>
				</State>
			</div>
		</section>
	);
}

/** Showcase sections for the session lane: recovery card labels and conversation connection states. */
export function ShowcaseSession() {
	return (
		<>
			<ShowcaseRecovery />
			<ShowcaseConnection />
		</>
	);
}

function ShowcaseRecovery() {
	const text = "Summarize the failing test output";
	return (
		<section id="showcase-recovery-cards">
			<h2>{t("recovery.showcaseHeading")}</h2>
			<p className="muted">{t("recovery.showcaseNote")}</p>
			<div className="showcase-todo-states">
				<State caption="recovery.showcaseListed">
					<RecoveryCard>
						<RecoveryConversation title="Fix the flaky test" current={false} text={text} onOpen={() => {}} />
					</RecoveryCard>
				</State>
				<State caption="recovery.showcaseCurrent">
					<RecoveryCard restored>
						<RecoveryConversation title="Fix the flaky test" current text={text} onOpen={() => {}} />
					</RecoveryCard>
				</State>
				<State caption="recovery.showcaseOrphan">
					<RecoveryCard orphan>
						<RecoveryConversation
							rememberedTitle="Release checklist"
							current={false}
							text={text}
							onOpen={() => {}}
						/>
					</RecoveryCard>
				</State>
				<State caption="recovery.showcaseOrphanUnnamed">
					<RecoveryCard orphan>
						<RecoveryConversation current={false} text={text} onOpen={() => {}} />
					</RecoveryCard>
				</State>
				<State caption="recovery.showcaseLong" narrow>
					<RecoveryCard>
						<RecoveryConversation
							title="터미널에서 이어서 작업한 아주 긴 대화 제목이 좁은 화면에서도 자연스럽게 줄바꿈되는지 확인합니다"
							current={false}
							text={text}
							onOpen={() => {}}
						/>
					</RecoveryCard>
				</State>
			</div>
		</section>
	);
}
