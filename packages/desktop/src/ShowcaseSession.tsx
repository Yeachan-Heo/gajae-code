import type { DesktopSession, DesktopSessionConnection } from "@gajae-code/desktop-host/protocol";
import { type ReactNode, useState } from "react";
import { Button, Modal, SessionRow } from "./components";
import { type DeliveryRecovery, recoveryNotice } from "./delivery-recovery";
import { type MessageKey, t } from "./i18n";
import { DeleteConversationConfirmation, RecoveryCard, recoveryDiscardLabel } from "./RecoveryConversation";
import { DisconnectConfirmation, disconnectConfirmTitle, SessionConnectionNotice } from "./SessionConnection";
import { SessionConnectionBadge } from "./SessionConnectionMark";

function State({ caption, narrow, children }: { caption: MessageKey; narrow?: boolean; children: ReactNode }) {
	return (
		<div className={narrow ? "showcase-todo-state showcase-session-narrow" : "showcase-todo-state"}>
			<h3>{t(caption)}</h3>
			{children}
		</div>
	);
}

// Fixture records; nothing here is read from or written to the store.
const record: DeliveryRecovery = {
	id: "showcase-recovery",
	sessionId: "showcase",
	text: "Summarize the failing test output",
	attachments: [],
	disposition: "unknown",
};
const longText = Array.from(
	{ length: 8 },
	(_, index) => `Step ${index + 1}: rerun the failing test with verbose output and keep the log.`,
).join("\n");

/** The App's recovery card around a fixture record, with the App's rules; its buttons do nothing here. */
function FixtureCard({
	orphan = false,
	restored = false,
	disposition = "unknown",
	title,
	rememberedTitle,
	current = false,
	text = record.text,
}: {
	orphan?: boolean;
	restored?: boolean;
	disposition?: DeliveryRecovery["disposition"];
	title?: string;
	rememberedTitle?: string;
	current?: boolean;
	text?: string;
}) {
	const none = () => {};
	const unknown = disposition === "unknown";
	return (
		<RecoveryCard
			notice={recoveryNotice({ ...record, disposition }, false, orphan) ?? ""}
			orphan={orphan}
			title={title}
			rememberedTitle={rememberedTitle}
			current={current}
			text={text}
			onOpen={none}
			restore={orphan ? undefined : { label: t("shell.restoreDraft"), disabled: restored, onClick: none }}
			discard={{
				label: recoveryDiscardLabel(orphan, disposition),
				disabled: !orphan && unknown && !restored,
				reason: !orphan && unknown && !restored ? t("recovery.restoreFirst") : undefined,
				onClick: none,
			}}
		/>
	);
}

export function ShowcaseSessionNav() {
	return (
		<>
			<a href="#showcase-recovery-cards">{t("recovery.showcaseNav")}</a>
			<a href="#showcase-delete-confirmation">{t("recovery.showcaseDeleteNav")}</a>
			<a href="#showcase-session-connection">{t("connection.showcaseNav")}</a>
		</>
	);
}

// Fixture rows only: nothing here is requested from the Host.
const row = (id: string, title: string, state: DesktopSessionConnection["state"]): DesktopSession => ({
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

/** The Disconnect confirmation in the App's native dialog, opened from the showcase; it does nothing. */
function ConfirmationDialog({
	running,
	queued,
	background = 0,
}: {
	running: boolean;
	queued: number;
	background?: number;
}) {
	const [open, setOpen] = useState(false);
	const close = () => setOpen(false);
	return (
		<>
			<div className="actions">
				<Button className="disconnect-dialog-opener" onClick={() => setOpen(true)}>
					{t("connection.showcaseOpenDialog")}
				</Button>
			</div>
			{open && (
				<Modal title={disconnectConfirmTitle(running || background > 0)} onClose={close}>
					<DisconnectConfirmation
						running={running}
						queued={queued}
						background={background}
						pending={false}
						onConfirm={close}
						onCancel={close}
					/>
				</Modal>
			)}
		</>
	);
}

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
				<State caption="connection.showcaseLeftover">
					<ComposerArea>
						<SessionConnectionNotice state="elsewhere" holder="earlier-app" pending={false} onConnect={none} />
					</ComposerArea>
				</State>
				<State caption="connection.showcaseChecking">
					<ComposerArea>
						<SessionConnectionNotice state="elsewhere" pending onConnect={none} />
					</ComposerArea>
				</State>
				<State caption="connection.showcaseOutside">
					<ComposerArea>
						<SessionConnectionNotice
							state="unavailable"
							reason="outside"
							pending={false}
							onConnect={none}
							onRemove={none}
						/>
					</ComposerArea>
				</State>
				<State caption="connection.showcaseMissing">
					<ComposerArea>
						<SessionConnectionNotice
							state="unavailable"
							reason="missing"
							pending={false}
							onConnect={none}
							onRemove={none}
						/>
					</ComposerArea>
				</State>
				<State caption="connection.showcaseUnavailable">
					<ComposerArea>
						<SessionConnectionNotice state="unavailable" pending={false} onConnect={none} onRemove={none} />
					</ComposerArea>
				</State>
				<State caption="connection.showcaseRemove">
					<DeleteDialog texts={[]} removeOnly />
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
					<div className="toolbar-title">
						<h1>Workflow subagent run</h1>
						<SessionConnectionBadge session={row("b3", "", "unavailable")} />
					</div>
				</State>
				<State caption="connection.showcaseRows">
					<div className="showcase-session-rows">
						<SessionRow session={row("r1", "Connected conversation", "connected")} onSelect={none} />
						<SessionRow session={row("r2", "Fix the flaky test", "disconnected")} selected onSelect={none} />
						<SessionRow session={row("r3", "Release checklist", "elsewhere")} onSelect={none} />
						<SessionRow session={row("r5", "Workflow subagent run", "unavailable")} onSelect={none} />
					</div>
				</State>
				<State caption="connection.showcaseConfirm">
					<ConfirmationDialog running queued={2} />
				</State>
				<State caption="connection.showcaseConfirmQueued">
					<ConfirmationDialog running={false} queued={1} />
				</State>
				<State caption="connection.showcaseConfirmBackground">
					<ConfirmationDialog running={false} queued={0} background={2} />
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
			<ShowcaseDeleteConfirmation />
			<ShowcaseConnection />
		</>
	);
}

// Fixture texts only; nothing here is read from or written to the recovery store.
const deleteFixtures: Array<{ caption: MessageKey; texts: string[]; refuse?: boolean }> = [
	{ caption: "recovery.showcaseDeleteNone", texts: [] },
	{ caption: "recovery.showcaseDeleteOne", texts: ["Summarize the failing test output"] },
	{
		caption: "recovery.showcaseDeleteSeveral",
		texts: [
			"Rerun the failing test.\n\nThen summarize what changed since yesterday.",
			"Open the release checklist",
			"Draft the changelog entry",
		],
	},
	{ caption: "recovery.showcaseDeleteLong", texts: [longText, "A second, short message"] },
	{
		caption: "recovery.showcaseDeleteKorean",
		texts: ["실패한 테스트 출력을 요약하고, 어제 이후 바뀐 내용을 정리해 주세요."],
	},
	{ caption: "recovery.showcaseDeleteRefused", texts: ["Summarize the failing test output"], refuse: true },
];
const refuseCopy = () => Promise.reject(new Error("Design example: the clipboard refused the write."));

/** The Delete conversation dialog, opened in the App's native dialog from fixture texts; it deletes nothing. */
function DeleteDialog({ texts, refuse, removeOnly }: { texts: string[]; refuse?: boolean; removeOnly?: boolean }) {
	const [open, setOpen] = useState(false);
	const close = () => setOpen(false);
	return (
		<>
			<div className="actions">
				<Button className="delete-dialog-opener" onClick={() => setOpen(true)}>
					{t("connection.showcaseOpenDialog")}
				</Button>
			</div>
			{open && (
				<Modal title={t(removeOnly ? "shell.dialogRemove" : "shell.dialogDelete")} onClose={close}>
					<DeleteConversationConfirmation
						title={removeOnly ? "Workflow subagent run" : "Fix the flaky test"}
						removeOnly={removeOnly}
						texts={texts}
						disabled={false}
						onDelete={close}
						writer={refuse ? refuseCopy : undefined}
					/>
				</Modal>
			)}
		</>
	);
}

function ShowcaseDeleteConfirmation() {
	return (
		<section id="showcase-delete-confirmation">
			<h2>{t("recovery.showcaseDeleteHeading")}</h2>
			<p className="muted">{t("recovery.showcaseDeleteNote")}</p>
			<div className="showcase-todo-states">
				{deleteFixtures.map(fixture => (
					<State key={fixture.caption} caption={fixture.caption}>
						<DeleteDialog texts={fixture.texts} refuse={fixture.refuse} />
					</State>
				))}
			</div>
		</section>
	);
}

function ShowcaseRecovery() {
	return (
		<section id="showcase-recovery-cards">
			<h2>{t("recovery.showcaseHeading")}</h2>
			<p className="muted">{t("recovery.showcaseNote")}</p>
			<div className="showcase-todo-states">
				<State caption="recovery.showcaseListed">
					<FixtureCard title="Fix the flaky test" />
				</State>
				<State caption="recovery.showcaseCurrent">
					<FixtureCard title="Fix the flaky test" current restored />
				</State>
				<State caption="recovery.showcaseOrphan">
					<FixtureCard orphan rememberedTitle="Release checklist" />
				</State>
				<State caption="recovery.showcaseOrphanUnnamed">
					<FixtureCard orphan />
				</State>
				<State caption="recovery.showcaseLong" narrow>
					<FixtureCard title="터미널에서 이어서 작업한 아주 긴 대화 제목이 좁은 화면에서도 자연스럽게 줄바꿈되는지 확인합니다" />
				</State>
				<State caption="recovery.showcaseOrphanLong">
					<FixtureCard orphan rememberedTitle="Release checklist" text={longText} />
				</State>
			</div>
			<h3>{t("recovery.showcaseStacked")}</h3>
			<div className="conversation-column showcase-recovery-column">
				<FixtureCard title="Fix the flaky test" />
				<FixtureCard title="Release checklist" disposition="failed" />
				<FixtureCard orphan rememberedTitle="Old planning notes" />
			</div>
		</section>
	);
}
