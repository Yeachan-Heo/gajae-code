import type { ReactNode } from "react";
import { Button } from "./components";
import { type MessageKey, t } from "./i18n";
import { RecoveryConversation } from "./RecoveryConversation";

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
	return <a href="#showcase-recovery-cards">{t("recovery.showcaseNav")}</a>;
}

/** Showcase sections for the session lane: recovery card labels. */
export function ShowcaseSession() {
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
