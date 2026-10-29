import { useId } from "react";
import type { DesktopOperatorOperation, DesktopOperatorStatus } from "../../desktop-host/src/operator-protocol";
import { Button, ErrorBanner } from "./components";

export interface OperatorPanelProps {
	value: string;
	operation: DesktopOperatorOperation | null;
	pending?: boolean;
	disabled?: boolean;
	busy?: boolean;
	error?: string;
	onChange: (value: string) => void;
	onExecute: (text: string) => void;
	onAbort: (operationId: string) => void;
	onFold: () => void;
	onRefresh: (operationId: string) => void;
}

const statusLabels: Record<DesktopOperatorStatus, string> = {
	running: "실행 중",
	cancel_requested: "취소 요청됨 · 실행 종료 미확인",
	completed: "실행 종료",
	cancelled: "취소됨",
	failed: "실패",
};
const outputLimit = 16_384;

export function OperatorPanel({
	value,
	operation,
	pending = false,
	disabled = false,
	busy = false,
	error,
	onChange,
	onExecute,
	onAbort,
	onFold,
	onRefresh,
}: OperatorPanelProps) {
	const id = useId();
	const locked = pending || disabled;
	const active = operation?.status === "running" || operation?.status === "cancel_requested";
	const canExecute = !locked && !busy && !active && Boolean(value.trim());
	const canAbort = !locked && operation?.status === "running";
	const failed = operation && (operation.status === "failed" || operation.error !== undefined ||
		(operation.status !== "cancelled" && ((operation.exitCode !== undefined && operation.exitCode !== 0) || Boolean(operation.signal))));
	const withheld = active && operation?.liveOutput === "withheld";
	// DTO output is already redacted and bounded by the host. Keep a defensive display bound, too.
	const output = withheld ? "" : (operation?.output ?? "").slice(-outputLimit);
	const truncated = operation && (operation.outputTruncated || (!withheld && operation.output.length > outputLimit));
	return (
		<section className="operator-panel" aria-labelledby={`${id}-title`} aria-busy={pending}>
			<header className="operator-heading">
				<h3 id={`${id}-title`}>직접 실행</h3>
			</header>
			<form
				className="operator-form"
				onSubmit={event => {
					event.preventDefault();
					if (canExecute) onExecute(value);
				}}
			>
				<label htmlFor={`${id}-input`}>셸 명령 / Python 코드</label>
				<textarea
					id={`${id}-input`}
					aria-describedby={`${id}-help`}
					rows={3}
					value={value}
					disabled={locked}
					spellCheck={false}
					onChange={event => {
						if (!locked) onChange(event.target.value);
					}}
				/>
				<p id={`${id}-help`} className="operator-help">
					<code>!</code> 셸 · <code>!!</code> 셸 (모델 문맥에서 제외) ·{" "}
					<code>$</code> Python · <code>$$</code> Python (모델 문맥에서 제외).{" "}
					접두사를 포함해 입력하세요. Enter는 줄바꿈이며, 실행 버튼으로만 제출합니다. 모델에게 보내는 메시지가 아닙니다.
				</p>
				<div className="actions">
					<Button type="submit" className="primary" disabled={!canExecute}>실행</Button>
				</div>
			</form>
			{busy && !active && <p className="operator-meta">다른 세션 작업이 실행 중이거나 응답을 기다리고 있어 새 직접 실행을 시작할 수 없습니다. 도구 접기와 실행 상세 조회는 별도 제어입니다.</p>}
			{pending && <p className="operator-meta" role="status">연결 또는 요청 처리를 기다리는 중… 실행 완료를 뜻하지 않습니다.</p>}
			{disabled && <p className="operator-meta">현재 연결 또는 세션에서는 제어할 수 없습니다.</p>}
			{error && <ErrorBanner>{error}</ErrorBanner>}
			{operation ? (
				<article className="operator-result" data-status={operation.status} data-failed={failed || undefined}>
					<p className="operator-meta" role="status">
						{operation.kind === "bash" ? "셸" : "Python"} · {statusLabels[operation.status]} ({operation.status})
						{failed && operation.status !== "failed" && " · 실패"}
					</p>
					<p className="operator-meta">{operation.excludeFromContext ? "모델 문맥에서 제외" : "모델 문맥에 포함"}</p>
					<dl className="operator-meta">
						<dt>종료 코드</dt><dd>{operation.exitCode ?? "제공되지 않음"}</dd>
						<dt>종료 신호</dt><dd>{operation.signal ?? "제공되지 않음"}</dd>
					</dl>
					{operation.error && <ErrorBanner>{operation.error.code}: {operation.error.message}</ErrorBanner>}
					<p className="operator-meta">
						{operation.liveOutput === "withheld"
							? withheld
								? "실시간 출력 보류 · 상태만 수신 중입니다. 종료 출력은 결과를 받은 뒤에만 표시합니다."
								: "실시간 출력은 보류되었습니다. 제공된 종료 출력만 표시합니다."
							: "민감 정보 가림 처리된 출력입니다. 일부 내용이 가려질 수 있습니다."}
					</p>
					{output ? (
						<pre className="bounded-output operator-output" aria-label="실제 실행 출력">{output}</pre>
					) : <p className="operator-meta">{withheld ? "현재 출력 내용은 표시하지 않습니다." : "제공된 출력이 없습니다. 상태 정보는 출력이 아닙니다."}</p>}
					{truncated && <p className="truncation-notice">출력 한도로 일부 내용이 생략되었습니다. 표시된 출력은 전체가 아닙니다.</p>}
					<details className="operator-details">
						<summary>실행 식별 정보</summary>
						<dl className="operator-meta"><dt>실행 ID</dt><dd>{operation.operationId}</dd></dl>
					</details>
					<div className="actions" role="group" aria-label="직접 실행 제어">
						<Button disabled={!canAbort} onClick={() => {
							if (canAbort) onAbort(operation.operationId);
						}}>취소 요청</Button>
						<Button disabled={locked} onClick={() => {
							if (!locked) onRefresh(operation.operationId);
						}}>실행 상세 새로고침</Button>
					</div>
				</article>
			) : <p className="operator-meta">아직 받은 실행 정보가 없습니다.</p>}
			<div className="operator-fold">
				<Button disabled={locked} onClick={() => {
					if (!locked) onFold();
				}}>현재 포그라운드 도구 접기</Button>
				<p className="operator-help">현재 포그라운드 도구(current foreground tool)가 대상입니다. 직접 실행한 ! / !! 셸 명령을 접는 기능이 아닙니다. 지원 여부와 결과는 호스트가 확인합니다.</p>
			</div>
		</section>
	);
}
