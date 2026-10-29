import type {
	DesktopMcpAction,
	DesktopMcpRef,
	DesktopMcpServer,
	DesktopMcpSnapshot,
} from "../../desktop-host/src/mcp-protocol";
import { Button, ErrorBanner } from "./components";

export interface McpPanelProps {
	snapshot: DesktopMcpSnapshot | null;
	pending?: boolean;
	busy?: boolean;
	error?: string;
	onRefresh: () => void;
	onOperate: (ref: DesktopMcpRef, action: DesktopMcpAction) => void;
}

const actionLabels: Record<DesktopMcpAction, string> = {
	suspend: "연결 일시 중지",
	resume: "연결 재개",
	reconnect: "다시 연결",
};
const stateLabels: Record<DesktopMcpServer["state"], string> = {
	connected: "관리자 연결됨",
	connecting: "관리자 연결 중",
	disconnected: "관리자 연결 끊김",
	suspended: "관리자 연결 일시 중지됨",
	unknown: "알 수 없음",
};
const sharingLabels: Record<DesktopMcpServer["sharing"], string> = {
	shared: "공유",
	"per-session": "세션별",
	unknown: "알 수 없음",
};
const serverLimit = 100;
const labelLimit = 128;

/** Display bounds never change the opaque control reference passed to the host. */
function McpText({ text, limit = labelLimit }: { text: string; limit?: number }) {
	const truncated = text.length > limit;
	let end = limit;
	if (truncated && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
	return <span>{truncated ? text.slice(0, end) : text}{truncated && <small className="truncation-notice">… (긴 내용 생략)</small>}</span>;
}

export function McpPanel({ snapshot, pending = false, busy = false, error, onRefresh, onOperate }: McpPanelProps) {
	const servers = snapshot?.available ? snapshot.servers.slice(0, serverLimit) : [];
	const locked = pending || busy || !snapshot?.available;
	const truncated = snapshot?.truncated || (snapshot?.available && snapshot.servers.length > serverLimit);
	return (
		<section className="mcp-panel" aria-label="MCP 관리자" aria-busy={pending}>
			<header className="mcp-heading">
				<h3>MCP 관리자</h3>
				<Button disabled={pending} onClick={() => {
					if (!pending) onRefresh();
				}}>상태 새로고침</Button>
			</header>
			<p className="mcp-help">
				제어 대상은 세션 생성 시 캡처한 팩터리 관리자이며, 다른 세션과 공유될 수 있습니다.
				 서버별 공유 표시와 관계없이 다른 세션에 영향을 줄 수 있습니다.
			</p>
			<p className="mcp-help">
				연결됨(connected)·재개(resumed)·재연결(reconnected)은 관리자 연결·도구 카탈로그만 뜻합니다.
				 원격 세션 종료, 자원 정산·정리, 세션 도구 레지스트리 동기화를 보증하지 않습니다.
				 정리 보증 없음 (cleanup: not_certified).
			</p>
			{pending && <p className="mcp-meta" role="status">
				연결 또는 요청 처리를 기다리는 중…{snapshot && " 아래는 마지막으로 받은 관리자 정보이며 현재 상태를 보증하지 않습니다."}
			</p>}
			{busy && <p className="mcp-meta">세션 작업 중에는 연결 변경을 제한합니다. 상태 조회는 별도이며, 연결 또는 요청 대기 중이 아니면 새로고침할 수 있습니다.</p>}
			{error && <ErrorBanner><McpText text={error} limit={1024} />{snapshot && <p>아래는 마지막으로 받은 관리자 정보입니다.</p>}<p>변경 효과가 확인되지 않았습니다. 재시도 전에 상태를 새로고침하세요.</p></ErrorBanner>}
			{snapshot?.error && <ErrorBanner>
				{snapshot.error.code}: <McpText text={snapshot.error.message} limit={1024} />
				{(snapshot.error.code === "unknown_effect" || snapshot.error.code === "backend_failure") && <p>변경 효과가 확인되지 않았습니다. 재시도 전에 상태를 새로고침하세요.</p>}
			</ErrorBanner>}
			{!snapshot ? (
				<p className="mcp-empty">MCP 관리자 정보를 받지 못했습니다. 연결과 조회 상태를 확인하세요. 연결된 서버가 없다는 뜻은 아닙니다.</p>
			) : !snapshot.available ? (
				<p className="mcp-empty">캡처한 MCP 관리자 조회·제어를 사용할 수 없습니다. 서버가 없거나 연결이 종료되었다는 뜻은 아닙니다.</p>
			) : (
				<>
					<p className="mcp-meta">관리자 정보 제공됨 · 표시된 서버 {servers.length}개 · 호스트가 제공한 제한된 표시 정보입니다. 원본 설정·주소·인증 정보는 표시하지 않습니다.</p>
					{servers.length === 0 ? <p className="mcp-empty">받은 관리자 목록에 표시된 서버가 없습니다.</p> : (
						<ul className="mcp-server-list" aria-label="받은 MCP 서버 목록">
							{servers.map(server => (
								<li className="mcp-server" key={server.ref.key} data-state={server.state}>
									<div className="mcp-server-main">
										<h4 className="mcp-server-label"><McpText text={server.label} /></h4>
										<dl className="mcp-meta">
											<dt>관리자 상태</dt><dd>{stateLabels[server.state]} ({server.state})</dd>
											<dt>전송</dt><dd>{server.transport === "unknown" ? "알 수 없음 (unknown)" : server.transport}</dd>
											<dt>공유</dt><dd>{sharingLabels[server.sharing]} ({server.sharing})</dd>
											<dt>관리자 도구 수</dt><dd>{server.toolCount}</dd>
										</dl>
									</div>
									<div className="mcp-actions actions" role="group" aria-label="서버 관리자 연결 제어">
										{server.controls.map(action => (
											<Button key={action} disabled={locked} onClick={() => {
												if (!locked) onOperate(server.ref, action);
											}}>{actionLabels[action]}</Button>
										))}
										{server.controls.length === 0 && <small className="mcp-meta">제공된 제어 없음 · 읽기 전용</small>}
									</div>
								</li>
							))}
						</ul>
					)}
					{truncated && <p className="truncation-notice">표시 한도로 일부 서버가 생략되었습니다. 표시된 수는 전체 서버 수가 아닙니다.</p>}
				</>
			)}
		</section>
	);
}
