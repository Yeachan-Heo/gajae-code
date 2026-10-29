import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	DesktopActivityRef,
	DesktopActivitySessionState,
	DesktopActivitySnapshot,
} from "../../desktop-host/src/activity-protocol";
import { ActivityPanel, type ActivityPanelProps } from "../src/ActivityPanel";

const scope = { sessionGeneration: "session-fixture", connectionGeneration: "connection-fixture" };
const ref = (key: string): DesktopActivityRef => ({ ...scope, key });
const callbacks: Omit<ActivityPanelProps, "snapshot"> = {
	onRefresh: () => {},
	onOperate: () => {},
	onAcknowledge: () => {},
	onInspect: () => {},
	onOpenGate: () => {},
};

function snapshot(): DesktopActivitySnapshot & { available: true } {
	return {
		...scope,
		available: true,
		jobs: [],
		tasks: [],
		crons: [],
		truncated: { jobs: false, tasks: false, crons: false },
		activeMonitorCount: 0,
		activeCronCount: 0,
		worstState: "none",
		failedUnacknowledged: false,
	};
}

function sessionState(): DesktopActivitySessionState {
	return {
		goal: { enabled: true, status: "paused", tokensUsed: 123, timeUsedSeconds: 42 },
		workflow: { skill: "ralplan" },
		gates: {
			available: true,
			pending: [
				{ ref: ref("gate-question"), kind: "question", stage: "설계 검토", createdAt: "2026-10-28T18:00:00Z", answerable: true },
				{ ref: ref("gate-approval"), kind: "approval", stage: "ralplan", createdAt: "2026-10-28T18:01:00Z", answerable: false, reason: "원격 응답을 지원하지 않는 생산자" },
			],
			truncated: false,
		},
	};
}

function render(value: DesktopActivitySnapshot | null, props: Partial<ActivityPanelProps> = {}): string {
	return renderToStaticMarkup(<ActivityPanel {...callbacks} snapshot={value} {...props} />);
}

function button(html: string, label: string): string {
	const found = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)].find(match => match[0].endsWith(`${label}</button>`));
	if (!found) throw new Error(`Missing rendered button: ${label}`);
	return found[0];
}

// Presentation-only tests. No callback here is evidence of a host or SDK mutation.
describe("desktop activity panel", () => {
	test("renders only declared controls, even when status alone would suggest a different action", () => {
		const value = snapshot();
		value.jobs = [
			{ type: "job", ref: ref("job-readonly"), id: "job-1", kind: "shell", label: "실행 중이지만 읽기 전용", status: "running", controls: [], backgrounded: true, deliveryState: "pending", outputAvailable: false, reason: "공개 제어를 제공하지 않음" },
			{ type: "job", ref: ref("job-cancel"), id: "job-2", kind: "shell", label: "취소 가능한 작업", status: "queued", controls: ["cancel"], backgrounded: false, deliveryState: "delivered", outputAvailable: true },
		];
		value.tasks = [{ type: "task", ref: ref("task-resume"), id: "task-1", status: "paused", controls: ["resume"], requestedModel: "requested/model", effectiveModel: "effective/model" }];
		value.crons = [{ type: "cron", ref: ref("cron-delete"), id: "cron-1", schedule: "0 * * * *", controls: ["delete"], recurring: true, firing: false }];
		const html = render(value);
		expect(button(html, "취소")).not.toContain('disabled=""');
		expect(button(html, "재개")).not.toContain('disabled=""');
		expect(button(html, "삭제")).not.toContain('disabled=""');
		expect(html).not.toContain(">중지</button>");
		expect(html).not.toContain(">일시 정지</button>");
		expect(html).toContain("제공된 제어 없음 · 읽기 전용");
		expect(html).toContain("공개 제어를 제공하지 않음");
		expect(html).toContain("effective/model");
		expect(html).toContain("출력 확인 가능");
		expect(html).toContain("제공된 출력 없음");
		expect(html).not.toContain("작업 취소 완료");
	});

	test("uses distinct stop and pause labels and disables every operation while pending", () => {
		const value = snapshot();
		value.jobs = [{ type: "job", ref: ref("stop-job"), id: "job", kind: "shell", label: "중지 제어", status: "running", controls: ["stop"], backgrounded: false, deliveryState: "failed-visible", outputAvailable: false }];
		value.tasks = [{ type: "task", ref: ref("pause-task"), id: "task", status: "running", controls: ["pause", "cancel"], reason: "SDK가 선언한 제어" }];
		value.failedUnacknowledged = true;
		value.sessionState = sessionState();
		const html = render(value, { pending: true });
		for (const label of ["새로고침", "상세 보기", "중지", "일시 정지", "취소", "실패 알림 확인", "요청 내용 보기"]) {
			expect(button(html, label)).toContain('disabled=""');
		}
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("전달 실패 표시됨");
		expect(html).toContain("아래는 마지막으로 받은 정보입니다.");
		expect(html).not.toContain("응답을 보냈습니다");
	});

	test("separates disconnected, pending, error and unavailable from observed empty lists", () => {
		const disconnected = render(null);
		expect(disconnected).toContain("활동 정보가 연결되지 않았습니다.");
		expect(disconnected).not.toContain("표시할 항목이 없습니다.");
		const pending = render(null, { pending: true });
		expect(pending).toContain("활동 조회·처리 또는 연결을 기다리는 중…");
		expect(pending).not.toContain("표시할 항목이 없습니다.");
		const failed = render(null, { error: "연결 실패" });
		expect(failed).toContain('role="alert"');
		expect(failed).toContain("연결 실패");
		expect(failed).not.toContain("표시할 항목이 없습니다.");
		const unavailable = render({ ...scope, available: false, reason: "관찰 기능 미지원" });
		expect(unavailable).toContain("작업 관찰을 사용할 수 없습니다");
		expect(unavailable).toContain("관찰 기능 미지원");
		expect(unavailable).not.toContain("실행 중 모니터 0개");
		expect(unavailable).not.toContain("표시할 항목이 없습니다.");
		const empty = render(snapshot());
		expect(empty.match(/표시할 항목이 없습니다\./gu)).toHaveLength(3);
		expect(empty).not.toContain("작업 관찰을 사용할 수 없습니다");
		const stale = render(snapshot(), { error: "새로고침 실패" });
		expect(stale).toContain("마지막 조회에 표시된 항목이 없습니다.");
		expect(stale).not.toContain("표시할 항목이 없습니다.");
		expect(stale).toContain("변경 성공을 뜻하지 않습니다.");
	});

	test("keeps canonical monitor and cron counts separate from overlapping visible rows", () => {
		const value = snapshot();
		value.activeMonitorCount = 7;
		value.activeCronCount = 3;
		value.worstState = "failed";
		value.failedUnacknowledged = true;
		value.jobs = [{ type: "job", ref: ref("job"), id: "same-work", label: "관찰된 실패", kind: "task", status: "failed", controls: [], backgrounded: true, deliveryState: "delivered", outputAvailable: false, error: "실제 오류 요약" }];
		value.tasks = [{ type: "task", ref: ref("task"), id: "same-work", status: "failed", controls: [] }];
		value.truncated.jobs = true;
		const html = render(value);
		expect(html).toContain("실행 중 모니터 7개 · 활성 예약 3개");
		expect(html).toContain("관찰 상태: 실패");
		expect(html.match(/표시된 항목 1개/gu)).toHaveLength(2);
		expect(html).toContain("합산하지 않습니다.");
		expect(html).toContain("위 숫자는 전체 개수가 아닙니다.");
		expect(html).toContain("실제 오류 요약");
		expect(button(html, "실패 알림 확인")).not.toContain('disabled=""');
		expect(render({ ...value, failedUnacknowledged: false })).not.toContain("실패 알림 확인");
	});

	test("shows goal, workflow and gates even when job observation is unavailable", () => {
		const html = render({ ...scope, available: false, reason: "No public job observation", sessionState: sessionState() });
		expect(html).toContain("목표 모드 켜짐 · 일시 정지됨 · 사용 토큰 123 · 사용 시간 42초");
		expect(html).toContain("ralplan");
		expect(html).toContain("표시된 요청 2개");
		expect(html).toContain("질문 ·");
		expect(html).toContain("승인 요청 ·");
		expect(html.match(/요청 내용 보기<\/button>/gu)).toHaveLength(2);
		expect(button(html, "요청 내용 보기")).not.toContain('disabled=""');
		expect(html).toContain("원격 응답은 지원되지 않습니다.");
		expect(html).toContain("내용을 열어 확인한 뒤 응답할 수 있습니다.");
		expect(html).not.toContain("승인</button>");
		expect(html).not.toContain("gate-approval");
		expect(html).not.toContain("session-fixture");
		expect(html).not.toContain("실패 알림 확인");
	});

	test("does not confuse unavailable or absent gate summaries with no pending gates", () => {
		const value = snapshot();
		expect(render(value)).toContain("응답 요청 정보를 제공받지 못했습니다.");
		value.sessionState = { goal: null, workflow: null, gates: { available: false, reason: "Gate emitter unavailable" } };
		const unavailable = render(value);
		expect(unavailable).toContain("응답 요청 조회 불가");
		expect(unavailable).toContain("Gate emitter unavailable");
		expect(unavailable).not.toContain("대기 중인 응답 요청이 없습니다.");
		value.sessionState.gates = { available: true, pending: [], truncated: true };
		const empty = render(value);
		expect(empty).toContain("대기 중인 응답 요청이 없습니다.");
		expect(empty).toContain("일부 응답 요청이 생략되었습니다.");
		expect(render(value, { pending: true })).toContain("마지막 조회에 응답 요청이 없습니다.");
	});

	test("bounds long Korean/CJK and unbroken fields and escapes producer HTML as text", () => {
		const value = snapshot();
		const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
		value.jobs = [{ type: "job", ref: ref("long-job"), id: "x".repeat(5000), label: `긴 한국어 日本語 中文 ${"가".repeat(5000)}`, kind: hostile, status: "failed", controls: [], backgrounded: false, deliveryState: "failed-visible", outputAvailable: false, reason: `${hostile}${"r".repeat(5000)}`, error: hostile }];
		value.sessionState = sessionState();
		value.sessionState.workflow = { skill: "w".repeat(5000) };
		if (value.sessionState.gates.available) value.sessionState.gates.pending[0]!.reason = "artifact:///private/plan.html";
		const html = render(value, { error: `${hostile}${"e".repeat(5000)}` });
		expect(html).toContain("긴 한국어 日本語 中文");
		expect(html).toContain("긴 내용 생략");
		expect(html).not.toContain("가".repeat(241));
		expect(html).not.toContain("x".repeat(1025));
		expect(html).not.toContain("r".repeat(1025));
		expect(html).not.toContain("w".repeat(241));
		expect(html).not.toContain("e".repeat(1025));
		expect(html).toContain("&lt;img");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("href=");
		expect(html).toContain("artifact:///private/plan.html");
		expect(html).toContain("<details");
		expect(html).toContain("<summary");
		expect(html).toContain('class="activity-entry-main"');
	});
});
