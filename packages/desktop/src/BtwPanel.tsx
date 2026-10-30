import { useId } from "react";
import type { DesktopBtwConversation, DesktopBtwTurn } from "../../desktop-host/src/btw-protocol";
import { Button, ErrorBanner } from "./components";

export interface BtwPanelProps {
	conversation: DesktopBtwConversation | null;
	draft: string;
	disabled: boolean;
	pending: boolean;
	onDraftChange: (value: string) => void;
	onSend: (question: string) => void;
	onCancel: (turnId: string) => void;
}

const statusLabels: Record<DesktopBtwTurn["status"], string> = {
	running: "응답 중",
	cancel_requested: "중지 요청됨 · 종료 확인 대기",
	completed: "응답 완료",
	cancelled: "취소됨 · 받은 답변 보존",
	failed: "응답 실패",
};

export function BtwPanel({ conversation, draft, disabled, pending, onDraftChange, onSend, onCancel }: BtwPanelProps) {
	const id = useId();
	const turns = conversation?.turns ?? [];
	const active = turns.find(turn => turn.status === "running" || turn.status === "cancel_requested");
	const canSend = !disabled && !pending && !active && Boolean(draft.trim());
	const canCancel = !disabled && !pending && active?.status === "running";
	return (
		<section className="btw-panel" aria-label="BTW 곁대화" aria-busy={pending}>
			<p id={`${id}-scope`} className="btw-help">
				시작할 때 고정한 문맥(frozen context)으로 이어 가는 텍스트 전용 곁대화입니다. 도구를 사용하지 않으며, 질문과
				답변은 주 대화 기록에 쓰이지 않습니다. 주 작업과 입력창은 별개입니다.
			</p>
			{turns.length ? (
				<div className="btw-history" role="region" aria-label="곁대화 질문과 답변" tabIndex={0}>
					<ol className="btw-turn-list">
						{turns.map((turn, index) => (
							<li key={turn.turnId}>
								<article
									className="btw-turn"
									data-status={turn.status}
									aria-label={`곁대화 ${index + 1}번째 질문과 답변`}
								>
									<strong className="role-label">나</strong>
									<div className="btw-text" aria-label="곁대화 질문">
										{turn.question}
									</div>
									<strong className="role-label">gajae · 곁대화</strong>
									<p className="btw-status" role="status">
										{statusLabels[turn.status]}
									</p>
									{turn.answer ? (
										<div className="btw-text" aria-label="곁대화 답변">
											{turn.answer}
										</div>
									) : (
										<p className="btw-help">아직 받은 답변이 없습니다.</p>
									)}
									{turn.answerTruncated && (
										<p className="truncation-notice">
											답변 한도로 일부 내용이 생략되었습니다. 표시된 답변은 전체가 아닙니다.
										</p>
									)}
									{turn.error && (
										<ErrorBanner>
											{turn.error.code}: {turn.error.message}
										</ErrorBanner>
									)}
								</article>
							</li>
						))}
					</ol>
				</div>
			) : (
				<div className="btw-empty">
					<h3>주 작업과 별개로 물어보세요</h3>
					<p>아직 곁대화가 없습니다.</p>
				</div>
			)}
			{disabled && (
				<p className="btw-help" role="status">
					연결 또는 세션을 사용할 수 없습니다.
				</p>
			)}
			{pending && (
				<p className="btw-help" role="status">
					응답을 기다리는 중…
				</p>
			)}
			<form
				className="composer btw-composer"
				onSubmit={event => {
					event.preventDefault();
					if (canSend) onSend(draft);
				}}
			>
				<label htmlFor={`${id}-draft`}>곁대화 질문</label>
				<textarea
					id={`${id}-draft`}
					aria-describedby={`${id}-scope ${id}-hint`}
					rows={3}
					value={draft}
					placeholder="주 작업과 별개로 궁금한 점을 적어 주세요"
					onChange={event => onDraftChange(event.target.value)}
					onKeyDown={event => {
						if (
							event.key === "Enter" &&
							(event.metaKey || event.ctrlKey) &&
							!event.nativeEvent.isComposing &&
							canSend
						) {
							event.preventDefault();
							onSend(draft);
						}
					}}
				/>
				<div className="composer-actions">
					<small id={`${id}-hint`} className="composer-hint">
						Enter는 줄바꿈 · ⌘ / Ctrl + Enter로 보내기
					</small>
					<div className="composer-buttons">
						{active && (
							<Button
								disabled={!canCancel}
								aria-describedby={`${id}-stop-help`}
								onClick={() => {
									if (canCancel) onCancel(active.turnId);
								}}
							>
								곁대화 중지 요청
							</Button>
						)}
						<Button type="submit" className="primary" disabled={!canSend}>
							곁대화 보내기
						</Button>
					</div>
				</div>
			</form>
			{active && (
				<p id={`${id}-stop-help`} className="btw-help">
					중지 요청은 이 곁대화 응답만 대상으로 하며, 즉시 종료를 보장하지 않습니다. 받은 부분 답변은 유지됩니다.
				</p>
			)}
		</section>
	);
}
