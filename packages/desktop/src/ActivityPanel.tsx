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

const operationLabels: Record<DesktopActivityOperation, string> = {
	cancel: "취소",
	delete: "삭제",
	stop: "중지",
	pause: "일시 정지",
	resume: "재개",
};
const statusLabels: Record<DesktopActivityStatus, string> = {
	running: "실행 중",
	paused: "일시 정지됨",
	queued: "대기열",
	completed: "완료",
	failed: "실패",
	cancelled: "취소됨",
};
const deliveryLabels = { pending: "전달 대기", delivered: "전달됨", "failed-visible": "전달 실패 표시됨" };
const gateLabels = { question: "질문", approval: "승인 요청", execution: "실행 요청" };
const goalLabels = { active: "활성", paused: "일시 정지됨", complete: "완료", dropped: "해제됨" };

type ActivityEntry = DesktopActivityJob | DesktopActivityTask | DesktopActivityCron;

/** Bound display text only. The original reference always goes back to the host unchanged. */
function ActivityText({ text, limit = 1024 }: { text: string; limit?: number }) {
	const truncated = text.length > limit;
	let end = limit;
	// Do not cut a UTF-16 surrogate pair at the display boundary.
	if (truncated && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
	return <span>{truncated ? text.slice(0, end) : text}{truncated && <small className="truncation-notice">… (긴 내용 생략)</small>}</span>;
}

function ActivityEntryCard({ entry, pending, onOperate, onInspect }: {
	entry: ActivityEntry;
	pending?: boolean;
	onOperate: ActivityPanelProps["onOperate"];
	onInspect: ActivityPanelProps["onInspect"];
}) {
	const title = entry.type === "job" ? entry.label : entry.type === "task" ? entry.id : entry.schedule;
	return (
		<article className="activity-entry" data-kind={entry.type}>
			<div className="activity-entry-main">
				<h4><ActivityText text={title} limit={240} /></h4>
				<p className="activity-meta">
					{entry.type === "cron" ? <>{entry.recurring ? "반복 예약" : "일회 예약"} · {entry.firing ? "실행 중" : "현재 실행 중 아님"}</> : statusLabels[entry.status]}
					{entry.type === "job" && <> · {entry.backgrounded ? "백그라운드" : "포그라운드"} · {deliveryLabels[entry.deliveryState]}</>}
				</p>
				{entry.type === "job" && <p className="activity-meta">{entry.outputAvailable ? "출력 확인 가능" : "제공된 출력 없음"}</p>}
				{entry.reason && <p className="activity-meta"><ActivityText text={entry.reason} /></p>}
				{entry.type === "job" && entry.error && <ErrorBanner><ActivityText text={entry.error} /></ErrorBanner>}
				<details className="activity-details">
					<summary><ChevronRight className="disclosure-chevron" size={16} aria-hidden="true" />식별 정보</summary>
					<dl className="activity-meta">
						<dt>ID</dt><dd><ActivityText text={entry.id} /></dd>
						{entry.type === "job" && <><dt>종류</dt><dd><ActivityText text={entry.kind} /></dd></>}
						{entry.type !== "cron" && <><dt>상태</dt><dd>{entry.status}</dd></>}
						{entry.type === "task" && <>
							<dt>요청 모델</dt><dd>{entry.requestedModel ? <ActivityText text={entry.requestedModel} /> : "제공되지 않음"}</dd>
							<dt>실제 모델</dt><dd>{entry.effectiveModel ? <ActivityText text={entry.effectiveModel} /> : "제공되지 않음"}</dd>
						</>}
						{entry.type === "cron" && <>
							<dt>일정</dt><dd><ActivityText text={entry.schedule} /></dd>
							<dt>다음 실행 (Unix ms)</dt><dd>{entry.nextFireAt ?? "제공되지 않음"}</dd>
						</>}
					</dl>
				</details>
			</div>
			<div className="activity-actions" role="group" aria-label="활동 제어">
				<Button disabled={pending} onClick={() => onInspect(entry.ref)}>상세 보기</Button>
				{entry.controls.map(operation => (
					<Button
						key={operation}
						className={operation === "delete" || operation === "cancel" || operation === "stop" ? "danger" : ""}
						disabled={pending}
						onClick={() => onOperate(entry.ref, operation)}
					>{operationLabels[operation]}</Button>
				))}
				{entry.controls.length === 0 && <small>제공된 제어 없음 · 읽기 전용</small>}
			</div>
		</article>
	);
}

function ActivityGroup({ title, entries, truncated, stale, pending, onOperate, onInspect }: {
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
			<h3 id={titleId}>{title} <small>표시된 항목 {entries.length}개</small></h3>
			{entries.length === 0 ? (
				<p className="activity-empty">{stale ? "마지막 조회에 표시된 항목이 없습니다." : "표시할 항목이 없습니다."}</p>
			) : entries.map(entry => <ActivityEntryCard key={entry.ref.key} entry={entry} pending={pending} onOperate={onOperate} onInspect={onInspect} />)}
			{truncated && <p className="truncation-notice">표시 한도를 넘어 일부 항목이 생략되었습니다. 위 숫자는 전체 개수가 아닙니다.</p>}
		</section>
	);
}

export function ActivityPanel({ snapshot, pending, error, onRefresh, onOperate, onAcknowledge, onInspect, onOpenGate }: ActivityPanelProps) {
	const titleId = useId();
	const state = snapshot?.sessionState;
	return (
		<section className="activity-panel" aria-labelledby={titleId} aria-busy={pending}>
			<header className="activity-toolbar">
				<div><h2 id={titleId}>활동</h2><p className="activity-meta">이 대화의 작업, 예약과 응답 요청</p></div>
				<Button disabled={pending} onClick={onRefresh}><RefreshCw size={16} aria-hidden="true" />새로고침</Button>
			</header>
			{pending && <p className="notice" role="status">활동 조회·처리 또는 연결을 기다리는 중…{snapshot && " 아래는 마지막으로 받은 정보입니다."}</p>}
			{error && <ErrorBanner><ActivityText text={error} />{snapshot && <p>아래는 마지막으로 받은 정보입니다. 변경 성공을 뜻하지 않습니다.</p>}</ErrorBanner>}
			{!snapshot ? (
				!pending && <p className="activity-empty">{error ? "활동 정보를 확인하지 못했습니다. 오류를 확인한 뒤 다시 조회하세요." : "활동 정보가 연결되지 않았습니다. 연결 후 새로고침하세요."}</p>
			) : !snapshot.available ? (
				<div className="activity-empty"><h3>작업 관찰을 사용할 수 없습니다</h3><ActivityText text={snapshot.reason} /></div>
			) : (
				<>
					<div className="activity-meta" aria-label="SDK 활동 요약">
						<p>실행 중 모니터 {snapshot.activeMonitorCount}개 · 활성 예약 {snapshot.activeCronCount}개</p>
						<p>관찰 상태: {snapshot.worstState === "failed" ? "실패" : snapshot.worstState === "running" ? "실행 중" : "관찰된 실행·실패 없음"}</p>
						<p>작업·태스크·예약 목록은 서로 겹칠 수 있어 합산하지 않습니다.</p>
					</div>
					{snapshot.failedUnacknowledged && <div className="activity-actions">
						<p>아직 확인하지 않은 실패가 있습니다.</p>
						<Button disabled={pending} onClick={() => onAcknowledge({ sessionGeneration: snapshot.sessionGeneration, connectionGeneration: snapshot.connectionGeneration })}>실패 알림 확인</Button>
					</div>}
					<ActivityGroup title="작업" entries={snapshot.jobs} truncated={snapshot.truncated.jobs} stale={Boolean(pending || error)} pending={pending} onOperate={onOperate} onInspect={onInspect} />
					<ActivityGroup title="태스크" entries={snapshot.tasks} truncated={snapshot.truncated.tasks} stale={Boolean(pending || error)} pending={pending} onOperate={onOperate} onInspect={onInspect} />
					<ActivityGroup title="예약" entries={snapshot.crons} truncated={snapshot.truncated.crons} stale={Boolean(pending || error)} pending={pending} onOperate={onOperate} onInspect={onInspect} />
				</>
			)}
			<section className="activity-group" aria-label="목표와 워크플로 요약">
				<h3>목표와 워크플로 <small>읽기 전용</small></h3>
				{!state ? <p className="activity-empty">세션 요약이 제공되지 않았습니다.</p> : <div className="activity-meta">
					<p>{state.goal ? <>목표 모드 {state.goal.enabled ? "켜짐" : "꺼짐"} · {goalLabels[state.goal.status]} · 사용 토큰 {state.goal.tokensUsed} · 사용 시간 {state.goal.timeUsedSeconds}초</> : "설정된 목표 없음"}</p>
					<p>워크플로: {state.workflow ? <ActivityText text={state.workflow.skill} limit={240} /> : "설정된 워크플로 없음"}</p>
				</div>}
			</section>
			<section className="activity-group" aria-label="응답 요청">
				<h3>응답 요청 {state?.gates.available && <small>표시된 요청 {state.gates.pending.length}개</small>}</h3>
				{!state ? <p className="activity-empty">응답 요청 정보를 제공받지 못했습니다.</p> : !state.gates.available ? (
					<p className="activity-empty">응답 요청 조회 불가 · <ActivityText text={state.gates.reason} /></p>
				) : <>
					{state.gates.pending.length === 0 && <p className="activity-empty">{pending || error ? "마지막 조회에 응답 요청이 없습니다." : "대기 중인 응답 요청이 없습니다."}</p>}
					{state.gates.pending.map(gate => <article className="activity-entry" key={gate.ref.key}>
						<div className="activity-entry-main">
							<h4>{gateLabels[gate.kind]} · <ActivityText text={gate.stage} limit={240} /></h4>
							<p className="activity-meta">생성: <ActivityText text={gate.createdAt} limit={120} /></p>
							<p className="activity-meta">{gate.answerable ? "내용을 열어 확인한 뒤 응답할 수 있습니다." : "원격 응답은 지원되지 않습니다. 내용만 확인할 수 있습니다."}</p>
							{gate.reason && <p className="activity-meta"><ActivityText text={gate.reason} /></p>}
						</div>
						<div className="activity-actions"><Button disabled={pending} onClick={() => onOpenGate(gate.ref)}>요청 내용 보기</Button></div>
					</article>)}
					{state.gates.truncated && <p className="truncation-notice">표시 한도를 넘어 일부 응답 요청이 생략되었습니다.</p>}
				</>}
			</section>
		</section>
	);
}
