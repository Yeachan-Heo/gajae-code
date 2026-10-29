import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	DesktopSessionInfo,
	DesktopSessionInfoUsage,
} from "../../desktop-host/src/session-info-protocol";
import { SessionInfoPanel, type SessionInfoPanelProps } from "../src/SessionInfoPanel";

type AvailableInfo = Extract<DesktopSessionInfo, { available: true }>;

function usage(source: DesktopSessionInfoUsage["source"], total: number | null): DesktopSessionInfoUsage {
	return {
		available: true,
		source,
		note: `${source} 실제 호스트 집계 설명`,
		tokens: { input: null, output: 0, cacheRead: null, cacheWrite: 0, total },
		premiumRequests: null,
		cost: {
			amount: null,
			source: source === "stream_partial" ? "live_partial_cost" : "sdk_recorded_cost",
			reason: "가격 근거가 없어 비용을 알 수 없음",
		},
	};
}

function info(): AvailableInfo {
	return {
		available: true,
		metadata: {
			catalogSessionId: "app-catalog-session-17",
			name: "세션 정보 검토",
			sessionFileDisplay: "[가림]/project/session.jsonl",
			cwd: "[가림]/project",
			createdAt: "2026-10-28T18:00:00Z",
			persisted: true,
		},
		model: { provider: "actual-provider", id: "actual-model-id", name: "실제 모델 이름" },
		thinkingLevel: "medium",
		run: { state: "running", streaming: true, bashRunning: false, pythonRunning: false, compacting: false, retrying: false, postPromptWork: false, queuedMessages: 0 },
		tools: { available: 8, pending: null, calls: 12, results: 11 },
		recordedTotals: usage("transcript_aggregate", 1001),
		activeTotals: usage("active_messages", 204),
		liveProgress: usage("stream_partial", 7),
		context: { tokens: 1234, contextWindow: 16000, percent: 7.7125, source: "provider_anchor", note: "공급자 기준점 이후 메시지는 추정" },
		accountQuota: { available: false, reason: "공개 SDK에 계정 할당량 없음" },
		actualBilledCost: { available: false, reason: "실제 청구액은 제공되지 않음" },
	};
}

function render(value: DesktopSessionInfo | null = info(), props: Partial<SessionInfoPanelProps> = {}): string {
	return renderToStaticMarkup(<SessionInfoPanel info={value} onRefresh={() => { throw new Error("SSR must not request a refresh"); }} {...props} />);
}

function section(html: string, label: string): string {
	const start = html.indexOf(`aria-label="${label}"`);
	if (start < 0) throw new Error(`Missing section: ${label}`);
	return html.slice(start, html.indexOf("</section>", start));
}

function refreshButton(html: string): string {
	const match = html.match(/<button\b[^>]*>세션 정보 새로고침<\/button>/u);
	if (!match) throw new Error("Missing refresh button");
	return match[0];
}

// SSR proves presentation only, not DOM interactions, refresh transport or SDK effects.
describe("desktop session information presentation", () => {
	test("keeps recorded branches, active messages and provisional stream counters separate and non-additive", () => {
		const html = render();
		const recorded = section(html, "전체 기록 사용량 · 모든 분기");
		const active = section(html, "활성 메시지 사용량 · 스트림 일부 제외");
		const live = section(html, "실시간 진행 · 잠정·미청구 스트림 일부");
		expect(recorded).toContain('data-source="transcript_aggregate"');
		expect(recorded).toContain("전체 기록·비활성 분기 포함 (transcript_aggregate)");
		expect(recorded).toContain("<dt>SDK 제공 총 토큰</dt><dd>1001</dd>");
		expect(active).toContain('data-source="active_messages"');
		expect(active).toContain("<dt>SDK 제공 총 토큰</dt><dd>204</dd>");
		expect(live).toContain('data-source="stream_partial"');
		expect(live).toContain("<dt>SDK 제공 총 토큰</dt><dd>7</dd>");
		expect(live).toContain("진행 중 스트림 일부 · 잠정·미청구 (stream_partial)");
		expect(html).toContain("서로 더하지 않습니다.");
		expect(html).toContain("토큰 항목도 표시된 총계에 다시 더하지 않습니다.");
		expect(html).toContain("비활성 분기의 assistant/task 사용량도 포함");
		expect(html).not.toContain(">1212<");
		expect(html).not.toContain(">1205<");
	});

	test("distinguishes unknown counters and costs from genuine zero without deriving totals", () => {
		const value = info();
		value.recordedTotals = usage("transcript_aggregate", null);
		value.activeTotals = { ...usage("active_messages", 0), premiumRequests: 0, cost: { amount: 0, source: "sdk_recorded_cost", reason: "SDK가 제공한 가격 근거 있는 0" } };
		const html = render(value);
		const recorded = section(html, "전체 기록 사용량 · 모든 분기");
		const active = section(html, "활성 메시지 사용량 · 스트림 일부 제외");
		expect(recorded).toContain("<dt>입력 토큰</dt><dd>알 수 없음</dd>");
		expect(recorded).toContain("<dt>출력 토큰</dt><dd>0</dd>");
		expect(recorded).toContain("<dt>SDK 제공 총 토큰</dt><dd>알 수 없음</dd>");
		expect(recorded).toContain("<dt>프리미엄 요청</dt><dd>알 수 없음</dd>");
		expect(recorded).toContain("<dt>SDK 기록 비용</dt><dd>알 수 없음</dd>");
		expect(active).toContain("<dt>SDK 제공 총 토큰</dt><dd>0</dd>");
		expect(active).toContain("<dt>프리미엄 요청</dt><dd>0</dd>");
		expect(active).toContain("<dt>SDK 기록 비용</dt><dd>0</dd>");
		expect(html).toContain("알 수 없는 값은 0이 아닙니다.");
	});

	test("labels SDK costs and unbilled provisional costs without currency, invoice or quota substitution", () => {
		const value = info();
		value.recordedTotals = { ...usage("transcript_aggregate", 1), cost: { amount: 0.123456, source: "sdk_recorded_cost", reason: "SDK 기록" } };
		value.liveProgress = { ...usage("stream_partial", 2), cost: { amount: 0.000003, source: "live_partial_cost", reason: "진행 중 잠정 기록" } };
		const html = render(value);
		expect(html).toContain("<dt>SDK 기록 비용</dt><dd>0.123456</dd>");
		expect(html).toContain("<dt>SDK 잠정 비용 · 미청구</dt><dd>0.000003</dd>");
		expect(html).toContain("비용 출처: sdk_recorded_cost");
		expect(html).toContain("비용 출처: live_partial_cost");
		expect(html).toContain("실제 청구액·계정 잔액·할당량이 아닙니다.");
		expect(html).toContain("통화는 제공되지 않아 가정하지 않습니다.");
		const account = section(html, "제공되지 않는 계정 정보");
		expect(account).toContain("계정 할당량</dt><dd>알 수 없음");
		expect(account).toContain("실제 청구액</dt><dd>알 수 없음");
		expect(account).toContain("공개 SDK에 계정 할당량 없음");
		expect(account).not.toContain("0.123456");
		expect(html).not.toMatch(/\$|USD|KRW|₩|€|£/u);
	});

	test("labels provider anchor plus trailing heuristic, heuristic alone and unknown context honestly", () => {
		const anchored = section(render(), "문맥 추정");
		expect(anchored).toContain("공급자 기준점 + 후속 휴리스틱 추정 (provider_anchor)");
		expect(anchored).toContain("공급자 기준점 이후 메시지는 추정");
		expect(anchored).toContain('aria-label="추정 문맥 사용률"');
		expect(anchored).toContain('aria-valuetext="약 8%"');
		expect(anchored).toContain('min="0" max="100" value="8"');
		expect(anchored).not.toContain("7.7125");
		expect(anchored).toContain("문맥 추정은 청구 사용량이 아닙니다.");
		const value = info();
		value.context = { tokens: 0, contextWindow: 16000, percent: 0, source: "heuristic", note: "로컬 추정" };
		const zero = section(render(value), "문맥 추정");
		expect(zero).toContain("출처: 휴리스틱 추정 (heuristic)");
		expect(zero).toContain('value="0"');
		expect(zero).toContain("문맥 토큰 추정</dt><dd>0</dd>");
		value.context = { tokens: null, contextWindow: null, percent: null, source: "unknown", note: "기준점 없음" };
		const unknown = section(render(value), "문맥 추정");
		expect(unknown).toContain("출처 알 수 없음 (unknown)");
		expect(unknown).toContain("추정 사용률</dt><dd>알 수 없음</dd>");
		expect(unknown).not.toContain("<meter");
	});

	test("bounds the accessible context meter and withholds it for unavailable or invalid estimates", () => {
		const value = info();
		value.context.percent = 182.7;
		const overflow = section(render(value), "문맥 추정");
		expect(overflow).toContain('value="100"');
		expect(overflow).toContain('aria-valuetext="약 100% 이상"');
		for (const percent of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			value.context.percent = percent;
			const html = section(render(value), "문맥 추정");
			expect(html).not.toContain("<meter");
			expect(html).toContain("추정 사용률</dt><dd>알 수 없음</dd>");
		}
		value.context = { ...value.context, source: "unknown", percent: 50 };
		expect(section(render(value), "문맥 추정")).not.toContain("<meter");
	});

	test("shows actual execution flags and tool scope while refresh stays enabled in every active state", () => {
		for (const state of ["running", "compacting", "retrying", "settling", "idle"] as const) {
			const value = info();
			value.run = { state, streaming: true, bashRunning: true, pythonRunning: true, compacting: true, retrying: true, postPromptWork: true, queuedMessages: 3 };
			const html = render(value);
			expect(html).toContain(`(${state})`);
			expect(refreshButton(html)).not.toContain('disabled=""');
			for (const label of ["스트리밍", "셸 직접 실행", "Python 직접 실행", "문맥 압축", "재시도", "프롬프트 후속 작업"]) {
				expect(html).toContain(`<dt>${label}</dt><dd>진행 중</dd>`);
			}
			expect(html).toContain("대기 메시지</dt><dd>3</dd>");
			expect(html).toContain("사용 가능한 도구</dt><dd>8</dd>");
			expect(html).toContain("대기 중인 도구</dt><dd>알 수 없음</dd>");
			expect(html).toContain("활성 메시지의 도구 호출</dt><dd>12</dd>");
			expect(html).toContain("활성 메시지의 도구 결과</dt><dd>11</dd>");
			expect(html).not.toContain("자원 정리 완료");
		}
		const normal = render();
		expect(normal).toContain("문맥 압축</dt><dd>아님</dd>");
		expect(normal).toContain("대기 메시지</dt><dd>0</dd>");
	});

	test("distinguishes no snapshot, pending, refresh errors and each unavailable session reason", () => {
		const empty = render(null);
		expect(empty).toContain("아직 받은 세션 정보가 없습니다.");
		expect(empty).not.toContain("SDK 제공 총 토큰");
		expect(refreshButton(empty)).not.toContain('disabled=""');
		const pending = render(info(), { pending: true });
		expect(pending).toContain('aria-busy="true"');
		expect(pending).toContain('role="status"');
		expect(pending).toContain("마지막으로 받은 정보");
		expect(refreshButton(pending)).toContain('disabled=""');
		const failed = render(info(), { error: "조회 실패 <연결>" });
		expect(failed).toContain('role="alert"');
		expect(failed).toContain("조회 실패 &lt;연결&gt;");
		expect(failed).toContain("현재 상태와 다를 수 있습니다.");
		expect(refreshButton(failed)).not.toContain('disabled=""');
		for (const code of ["disposed", "transitioning", "stale_session", "backend_failure", "redaction_failed", "invalid_catalog_session"] as const) {
			const html = render({ available: false, code, reason: `호스트 설명: ${code}` });
			expect(html).toContain('role="alert"');
			expect(html).toContain(`(${code})`);
			expect(html).toContain(`호스트 설명: ${code}`);
			expect(html).not.toContain("실제 모델 이름");
			expect(html).not.toContain("SDK 제공 총 토큰");
			expect(refreshButton(html)).not.toContain('disabled=""');
		}
		expect(render({ available: false, code: "redaction_failed", reason: "가림 실패" })).toContain("정보를 표시하지 않습니다.");
	});

	test("retains independently unavailable usage buckets and missing metadata without fabricating values", () => {
		const value = info();
		value.recordedTotals = { available: false, reason: "기록 읽기 불가" };
		value.liveProgress = { available: false, reason: "스트림 카운터 없음" };
		value.model = null;
		value.thinkingLevel = null;
		value.metadata.name = null;
		value.metadata.sessionFileDisplay = null;
		value.metadata.createdAt = null;
		value.metadata.persisted = false;
		const html = render(value);
		expect(section(html, "전체 기록 사용량 · 모든 분기")).toContain("기록 읽기 불가");
		expect(section(html, "실시간 진행 · 잠정·미청구 스트림 일부")).toContain("스트림 카운터 없음");
		expect(section(html, "전체 기록 사용량 · 모든 분기")).not.toContain("SDK 제공 총 토큰");
		expect(section(html, "활성 메시지 사용량 · 스트림 일부 제외")).toContain("<dd>204</dd>");
		expect(html).toContain("실제 모델을 알 수 없습니다.");
		expect(html).toContain("<dt>기록 저장 설정</dt><dd>꺼짐</dd>");
		expect(html).not.toContain("기록 저장 설정</dt><dd>켜짐");
	});

	test("renders catalog identity, masked paths and model/source metadata as bounded inert text", () => {
		const value = info();
		const hostile = '<script>alert(1)</script><img src="https://example.invalid/pixel">';
		value.metadata.sessionFileDisplay = hostile;
		value.metadata.cwd = "file:///display-only/path";
		value.model = { provider: hostile, id: "https://example.invalid/model", name: "x".repeat(239) + "𠀀tail" };
		value.recordedTotals = { ...usage("transcript_aggregate", 1), note: "note-start" + "n".repeat(2000) + "hidden-note-end" };
		const html = render(value, { error: "e".repeat(2000) + "hidden-error-end" });
		expect(html).toContain("app-catalog-session-17");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("file:///display-only/path");
		expect(html).toContain("가림 처리된 표시 전용");
		expect(html).toContain("경로 표시는 파일 열기 권한이 아닙니다.");
		expect(html).toContain("디스크 쓰기 완료를 보장하지 않음");
		expect(html).toContain("x".repeat(239) + '<small class="truncation-notice">');
		expect(html).toContain("긴 내용 생략");
		expect(html).not.toContain("𠀀");
		expect(html).not.toContain("hidden-note-end");
		expect(html).not.toContain("hidden-error-end");
		expect(html).not.toMatch(/<script|<img|<a\b|\shref="|\ssrc="/u);
	});

	test("does not show invalid or unsafe counters and costs as real zero", () => {
		const value = info();
		value.activeTotals = { ...usage("active_messages", Number.MAX_SAFE_INTEGER + 1), tokens: { input: -1, output: Number.NaN, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 1.5, total: Number.MAX_SAFE_INTEGER + 1 }, cost: { amount: Number.NaN, source: "sdk_recorded_cost", reason: "잘못된 기록" } };
		const html = section(render(value), "활성 메시지 사용량 · 스트림 일부 제외");
		expect(html).toContain("SDK 제공 총 토큰</dt><dd>알 수 없음</dd>");
		expect(html).toContain("SDK 기록 비용</dt><dd>알 수 없음</dd>");
		expect(html).not.toContain("<dd>0</dd>");
		expect(html).not.toMatch(/NaN|Infinity|9007199254740992/u);
	});
});
