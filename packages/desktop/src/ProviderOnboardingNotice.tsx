import type { DesktopModel, DesktopSession } from "@gajae-code/desktop-host/protocol";
import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { Button } from "./components";
import { t } from "./i18n";
import {
	type ConversationCatalog,
	type ConversationCatalogAnswer,
	settledCatalogAnswer,
	shouldShowProviderOnboarding,
} from "./provider-status";

/**
 * The zero-model guide docked at the bottom of the window. It is not dismissible: it hides
 * itself as soon as a model is available, so its owner decides only whether it renders.
 */
export function ProviderOnboardingNotice({ onConnect }: { onConnect(): void }) {
	const titleId = useId();
	return (
		<div className="provider-notice" role="status" aria-labelledby={titleId}>
			<TriangleAlert className="provider-notice-icon" aria-hidden="true" />
			<div className="provider-notice-text">
				<strong id={titleId}>{t("providers.noticeTitle")}</strong>
				<span>{t("providers.noticeBody")}</span>
			</div>
			<Button className="primary provider-notice-action" onClick={onConnect}>
				{t("providers.noticeAction")}
			</Button>
		</div>
	);
}

/**
 * Whether the onboarding notice shows (see `shouldShowProviderOnboarding`). The conversation's
 * catalog resets to loading on every snapshot, so the last answer it settled on for the same
 * conversation and control generation is kept until it settles again.
 */
export function useProviderOnboarding({
	connected,
	models,
	session,
	catalog,
}: {
	connected: boolean;
	models: readonly DesktopModel[] | undefined;
	session: Pick<DesktopSession, "id" | "controlGeneration"> | undefined;
	catalog: ConversationCatalog;
}): boolean {
	const owner = session && session.controlGeneration !== null ? `${session.id}:${session.controlGeneration}` : null;
	const settled = session ? settledCatalogAnswer(catalog, session) : undefined;
	const remembered = useRef<{ owner: string; answer: ConversationCatalogAnswer } | null>(null);
	useEffect(() => {
		if (owner && settled) remembered.current = { owner, answer: settled };
	}, [owner, settled]);
	const answer = settled ?? (owner && remembered.current?.owner === owner ? remembered.current.answer : undefined);
	return shouldShowProviderOnboarding({ connected, models, conversation: session ? { answer } : null });
}
