import { useEffect, useRef, useState } from "react";
import type { DesktopBtwConversation } from "../../desktop-host/src/btw-protocol";
import { BtwPanel } from "./BtwPanel";
import { request, subscribe } from "./bridge";
import { ErrorBanner, Modal } from "./components";

interface BtwDialogOwner {
	active: boolean;
	sessionId: string;
	sessionGeneration: number;
	conversation: DesktopBtwConversation | null;
	events: number;
	inFlight: boolean;
}

export interface BtwDialogProps {
	sessionId: string;
	sessionGeneration: number;
	connected: boolean;
	initialQuestion?: string;
	onAdmitted(): void;
	onClose(): void;
}

/** This mounted surface owns one in-memory side conversation, not the main turn. */
export function BtwDialog(props: BtwDialogProps) {
	const [conversation, setConversation] = useState<DesktopBtwConversation | null>(null);
	const [draft, setDraft] = useState(props.initialQuestion ?? "");
	const [ready, setReady] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const ownerRef = useRef<BtwDialogOwner | null>(null);
	const latest = useRef(props);
	latest.current = props;
	const current = (owner: BtwDialogOwner) => owner.active && ownerRef.current === owner;
	const scope = (owner: BtwDialogOwner) => ({
		sessionId: owner.sessionId,
		sessionGeneration: owner.sessionGeneration,
	});
	const remember = (owner: BtwDialogOwner, value: DesktopBtwConversation) => {
		if (!current(owner) || value.sessionGeneration !== owner.sessionGeneration) return;
		if (owner.conversation?.conversationId === value.conversationId && owner.conversation.revision >= value.revision)
			return;
		owner.conversation = value;
		setConversation(value);
	};
	const retire = (owner: BtwDialogOwner, value: DesktopBtwConversation) =>
		request("btw.close", { ...scope(owner), conversationId: value.conversationId });
	const send = async (owner: BtwDialogOwner, question: string) => {
		if (!current(owner) || owner.inFlight || !latest.current.connected || !question.trim()) return;
		owner.inFlight = true;
		setPending(true);
		setError("");
		try {
			const previous = owner.conversation;
			const value = await request<DesktopBtwConversation>(previous ? "btw.submit" : "btw.open", {
				...scope(owner),
				question,
				...(previous ? { conversationId: previous.conversationId } : {}),
			});
			if (!current(owner)) {
				// Closing during admission must not leave the newly admitted side turn orphaned.
				await retire(owner, value);
				return;
			}
			remember(owner, value);
			setDraft(value => (value === question ? "" : value));
			latest.current.onAdmitted();
		} catch (failure) {
			if (current(owner)) setError(failure instanceof Error ? failure.message : "별도 대화 요청에 실패했습니다.");
		} finally {
			owner.inFlight = false;
			if (current(owner)) setPending(false);
		}
	};

	useEffect(() => {
		const owner: BtwDialogOwner = {
			active: true,
			sessionId: props.sessionId,
			sessionGeneration: props.sessionGeneration,
			conversation: null,
			events: 0,
			inFlight: false,
		};
		ownerRef.current = owner;
		setReady(false);
		setConversation(null);
		let unsubscribe: (() => void) | undefined;
		void (async () => {
			try {
				unsubscribe = await subscribe(frame => {
					if (!current(owner)) return;
					if (
						frame.type === "session" &&
						frame.session.id === owner.sessionId &&
						frame.session.controlGeneration !== owner.sessionGeneration
					) {
						latest.current.onClose();
						return;
					}
					if (
						frame.type === "snapshot" &&
						!frame.snapshot.sessions.some(
							session => session.id === owner.sessionId && session.controlGeneration === owner.sessionGeneration,
						)
					) {
						latest.current.onClose();
						return;
					}
					if (
						frame.type === "btw" &&
						frame.sessionId === owner.sessionId &&
						frame.sessionGeneration === owner.sessionGeneration
					) {
						owner.events++;
						if (frame.event.conversation) remember(owner, frame.event.conversation);
						else {
							owner.conversation = null;
							latest.current.onClose();
						}
					}
				});
				if (!current(owner)) {
					unsubscribe();
					return;
				}
				const events = owner.events;
				const value = await request<DesktopBtwConversation | null>("btw.get", scope(owner));
				if (!current(owner)) return;
				if (events === owner.events && value) remember(owner, value);
				setReady(true);
				const question = latest.current.initialQuestion;
				if (question?.trim() && !owner.conversation) await send(owner, question);
			} catch (failure) {
				if (current(owner))
					setError(failure instanceof Error ? failure.message : "별도 대화를 불러오지 못했습니다.");
			}
		})();
		return () => {
			owner.active = false;
			unsubscribe?.();
			const value = owner.conversation;
			owner.conversation = null;
			if (value) void retire(owner, value).catch(() => {});
		};
	}, [props.sessionId, props.sessionGeneration]);

	const close = async () => {
		const owner = ownerRef.current;
		if (!owner || !current(owner)) return;
		const value = owner.conversation;
		if (!value) {
			latest.current.onClose();
			return;
		}
		setPending(true);
		try {
			await retire(owner, value);
			if (current(owner)) {
				owner.conversation = null;
				latest.current.onClose();
			}
		} catch (failure) {
			if (current(owner))
				setError(failure instanceof Error ? failure.message : "별도 대화 닫기 요청에 실패했습니다.");
		} finally {
			if (current(owner)) setPending(false);
		}
	};
	const cancel = async (turnId: string) => {
		const owner = ownerRef.current;
		if (!owner || !current(owner) || !owner.conversation || owner.inFlight) return;
		owner.inFlight = true;
		setPending(true);
		setError("");
		try {
			remember(
				owner,
				await request<DesktopBtwConversation>("btw.cancel", {
					...scope(owner),
					conversationId: owner.conversation.conversationId,
					turnId,
				}),
			);
		} catch (failure) {
			if (current(owner))
				setError(failure instanceof Error ? failure.message : "별도 대화 중지 요청에 실패했습니다.");
		} finally {
			owner.inFlight = false;
			if (current(owner)) setPending(false);
		}
	};
	return (
		<Modal title="별도 대화 · /btw" onClose={() => void close()}>
			{error && <ErrorBanner>{error}</ErrorBanner>}
			{!ready && !error && <p role="status">별도 대화 정보를 불러오는 중…</p>}
			<BtwPanel
				conversation={conversation}
				draft={draft}
				disabled={!props.connected || !ready}
				pending={pending}
				onDraftChange={setDraft}
				onSend={question => {
					const owner = ownerRef.current;
					if (owner && ready) void send(owner, question);
				}}
				onCancel={turnId => void cancel(turnId)}
			/>
		</Modal>
	);
}
