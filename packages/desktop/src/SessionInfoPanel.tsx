import type {
	DesktopSessionInfo,
	DesktopSessionInfoContext,
	DesktopSessionInfoUnavailable,
	DesktopSessionInfoUsage,
} from "../../desktop-host/src/session-info-protocol";
import { Button, ErrorBanner } from "./components";

export interface SessionInfoPanelProps {
	info: DesktopSessionInfo | null;
	pending?: boolean;
	error?: string;
	onRefresh(): void;
}

const runLabels = {
	running: "작업 중",
	compacting: "문맥 압축 중",
	retrying: "재시도 중",
	settling: "후속 처리 중",
	idle: "현재 실행 중 아님",
};
const unavailableLabels = {
	disposed: "종료된 세션입니다.",
	transitioning: "세션 전환 중입니다. 전환 후 다시 조회하세요.",
	stale_session: "조회 대상 세션이 변경되었습니다. 현재 세션을 다시 조회하세요.",
	backend_failure: "세션 정보 조회에 실패했습니다.",
	redaction_failed: "민감 정보 가림 처리에 실패하여 정보를 표시하지 않습니다.",
	invalid_catalog_session: "유효한 앱 카탈로그 세션이 아닙니다.",
};
const usageLabels = {
	transcript_aggregate: "전체 기록·비활성 분기 포함 (transcript_aggregate)",
	active_messages: "활성 메시지 목록 (active_messages)",
	stream_partial: "진행 중 스트림 일부 · 잠정·미청구 (stream_partial)",
};
const contextLabels = {
	provider_anchor: "공급자 기준점 + 후속 휴리스틱 추정 (provider_anchor)",
	heuristic: "휴리스틱 추정 (heuristic)",
	unknown: "출처 알 수 없음 (unknown)",
};

/** Host-redacted text remains inert and defensively bounded in the renderer. */
function InfoText({ text, limit = 1024 }: { text: string | null; limit?: number }) {
	if (text === null) return <>알 수 없음</>;
	const truncated = text.length > limit;
	let end = limit;
	if (truncated && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
	return <span className="session-info-text">{truncated ? text.slice(0, end) : text}{truncated && <small className="truncation-notice">… (긴 내용 생략)</small>}</span>;
}

function counter(value: number | null): string {
	return value !== null && Number.isSafeInteger(value) && value >= 0 ? String(value) : "알 수 없음";
}

function costAmount(value: number | null): string {
	return value !== null && Number.isFinite(value) && value >= 0 ? String(value) : "알 수 없음";
}

function UsageSection({ title, usage }: {
	title: string;
	usage: DesktopSessionInfoUsage | DesktopSessionInfoUnavailable;
}) {
	return (
		<section className="session-info-usage" aria-label={title} data-source={usage.available ? usage.source : undefined}>
			<h4>{title}</h4>
			{usage.available ? <>
				<p className="session-info-note">출처: {usageLabels[usage.source]}</p>
				<p className="session-info-note"><InfoText text={usage.note} /></p>
				<dl className="session-info-grid">
					<dt>입력 토큰</dt><dd>{counter(usage.tokens.input)}</dd>
					<dt>출력 토큰</dt><dd>{counter(usage.tokens.output)}</dd>
					<dt>캐시 읽기 토큰</dt><dd>{counter(usage.tokens.cacheRead)}</dd>
					<dt>캐시 쓰기 토큰</dt><dd>{counter(usage.tokens.cacheWrite)}</dd>
					<dt>SDK 제공 총 토큰</dt><dd>{counter(usage.tokens.total)}</dd>
					<dt>프리미엄 요청</dt><dd>{counter(usage.premiumRequests)}</dd>
					<dt>{usage.cost.source === "live_partial_cost" ? "SDK 잠정 비용 · 미청구" : "SDK 기록 비용"}</dt>
					<dd>{costAmount(usage.cost.amount)}</dd>
				</dl>
				<p className="session-info-note">비용 출처: {usage.cost.source} · <InfoText text={usage.cost.reason} /></p>
			</> : <p className="session-info-note">사용량을 제공할 수 없습니다. <InfoText text={usage.reason} /></p>}
		</section>
	);
}

function ContextSection({ context }: { context: DesktopSessionInfoContext }) {
	const known = context.source !== "unknown" && context.percent !== null && Number.isFinite(context.percent) && context.percent >= 0;
	const percent = known && context.percent !== null ? Math.round(Math.min(100, context.percent)) : null;
	const percentLabel = percent === null ? "알 수 없음" : `약 ${percent}%${context.percent !== null && context.percent > 100 ? " 이상" : ""}`;
	return (
		<section className="session-info-context" aria-label="문맥 추정">
			<h4>문맥 추정</h4>
			<p className="session-info-note">출처: {contextLabels[context.source]}</p>
			<dl className="session-info-grid">
				<dt>문맥 토큰 추정</dt><dd>{counter(context.tokens)}</dd>
				<dt>문맥 한도</dt><dd>{counter(context.contextWindow)}</dd>
				<dt>추정 사용률</dt><dd>{percentLabel}</dd>
			</dl>
			{percent !== null && <meter className="session-info-meter" aria-label="추정 문맥 사용률" aria-valuetext={percentLabel} min={0} max={100} value={percent}>{percentLabel}</meter>}
			<p className="session-info-note"><InfoText text={context.note} /> 문맥 추정은 청구 사용량이 아닙니다.</p>
		</section>
	);
}

export function SessionInfoPanel({ info, pending = false, error, onRefresh }: SessionInfoPanelProps) {
	return (
		<section className="session-info-panel" aria-label="세션 정보" aria-busy={pending}>
			<header className="session-info-heading">
				<h3>세션 정보</h3>
				<Button disabled={pending} onClick={onRefresh}>세션 정보 새로고침</Button>
			</header>
			<p className="session-info-note">읽기 전용 조회 · 작업 중에도 새로고침할 수 있습니다. 자동 갱신되지 않습니다.</p>
			{pending && <p className="session-info-note" role="status">세션 정보 조회 또는 연결을 기다리는 중…</p>}
			{error && <ErrorBanner><InfoText text={error} /></ErrorBanner>}
			{info?.available && (pending || error) && <p className="session-info-note">아래는 마지막으로 받은 정보입니다. 현재 상태와 다를 수 있습니다.</p>}
			{info === null ? <p className="session-info-note">아직 받은 세션 정보가 없습니다. 알 수 없는 값은 0을 뜻하지 않습니다.</p> : !info.available ? (
				<ErrorBanner><p>{unavailableLabels[info.code]} ({info.code})</p><p><InfoText text={info.reason} /></p></ErrorBanner>
			) : <>
				<section className="session-info-metadata" aria-label="세션 메타데이터">
					<h4>세션</h4>
					<dl className="session-info-grid">
						<dt>이름</dt><dd><InfoText text={info.metadata.name} limit={240} /></dd>
						<dt>앱 카탈로그 ID</dt><dd><InfoText text={info.metadata.catalogSessionId} /></dd>
						<dt>기록 파일 · 가림 처리된 표시 전용</dt><dd><InfoText text={info.metadata.sessionFileDisplay} /></dd>
						<dt>작업 디렉터리 · 표시 전용</dt><dd><InfoText text={info.metadata.cwd} /></dd>
						<dt>생성 시각 · 제공된 값</dt><dd><InfoText text={info.metadata.createdAt} /></dd>
						<dt>기록 저장 설정</dt><dd>{info.metadata.persisted ? "켜짐 · 디스크 쓰기 완료를 보장하지 않음" : "꺼짐"}</dd>
					</dl>
					<p className="session-info-note">경로 표시는 파일 열기 권한이 아닙니다.</p>
				</section>
				<section className="session-info-model" aria-label="실제 모델 정보">
					<h4>실제 모델</h4>
					{info.model ? <dl className="session-info-grid">
						<dt>모델</dt><dd><InfoText text={info.model.name} limit={240} /></dd>
						<dt>공급자</dt><dd><InfoText text={info.model.provider} limit={240} /></dd>
						<dt>모델 ID</dt><dd><InfoText text={info.model.id} /></dd>
					</dl> : <p className="session-info-note">실제 모델을 알 수 없습니다.</p>}
					<dl className="session-info-grid"><dt>사고 수준</dt><dd><InfoText text={info.thinkingLevel} limit={240} /></dd></dl>
				</section>
				<section className="session-info-run" aria-label="실행과 도구 상태">
					<h4>실행과 도구</h4>
					<p className="session-info-note">조회 시점: {runLabels[info.run.state]} ({info.run.state})</p>
					<dl className="session-info-grid">
						<dt>스트리밍</dt><dd>{info.run.streaming ? "진행 중" : "아님"}</dd>
						<dt>셸 직접 실행</dt><dd>{info.run.bashRunning ? "진행 중" : "아님"}</dd>
						<dt>Python 직접 실행</dt><dd>{info.run.pythonRunning ? "진행 중" : "아님"}</dd>
						<dt>문맥 압축</dt><dd>{info.run.compacting ? "진행 중" : "아님"}</dd>
						<dt>재시도</dt><dd>{info.run.retrying ? "진행 중" : "아님"}</dd>
						<dt>프롬프트 후속 작업</dt><dd>{info.run.postPromptWork ? "진행 중" : "아님"}</dd>
						<dt>대기 메시지</dt><dd>{counter(info.run.queuedMessages)}</dd>
						<dt>사용 가능한 도구</dt><dd>{counter(info.tools.available)}</dd>
						<dt>대기 중인 도구</dt><dd>{counter(info.tools.pending)}</dd>
						<dt>활성 메시지의 도구 호출</dt><dd>{counter(info.tools.calls)}</dd>
						<dt>활성 메시지의 도구 결과</dt><dd>{counter(info.tools.results)}</dd>
					</dl>
				</section>
				<div className="session-info-usage-groups">
					<p className="session-info-note">전체 기록·활성 메시지·스트림 일부는 겹치는 집계입니다. 서로 더하지 않습니다. 토큰 항목도 표시된 총계에 다시 더하지 않습니다.</p>
					<UsageSection title="전체 기록 사용량 · 모든 분기" usage={info.recordedTotals} />
					<p className="session-info-note">전체 기록은 비활성 분기의 assistant/task 사용량도 포함하며, 디스크 저장 완료를 뜻하지 않습니다.</p>
					<UsageSection title="활성 메시지 사용량 · 스트림 일부 제외" usage={info.activeTotals} />
					<UsageSection title="실시간 진행 · 잠정·미청구 스트림 일부" usage={info.liveProgress} />
					<p className="session-info-note">비용은 SDK 기록 또는 잠정 값이며 실제 청구액·계정 잔액·할당량이 아닙니다. 통화는 제공되지 않아 가정하지 않습니다. 알 수 없는 값은 0이 아닙니다.</p>
				</div>
				<ContextSection context={info.context} />
				<section className="session-info-unavailable" aria-label="제공되지 않는 계정 정보">
					<h4>계정 정보 · 제공되지 않음</h4>
					<dl className="session-info-grid">
						<dt>계정 할당량</dt><dd>알 수 없음 · <InfoText text={info.accountQuota.reason} /></dd>
						<dt>실제 청구액</dt><dd>알 수 없음 · <InfoText text={info.actualBilledCost.reason} /></dd>
					</dl>
				</section>
			</>}
		</section>
	);
}
