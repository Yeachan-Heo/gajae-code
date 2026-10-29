import { describe, expect, test } from "bun:test";
import { Children, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopMcpAction, DesktopMcpRef, DesktopMcpServer, DesktopMcpSnapshot } from "../../desktop-host/src/mcp-protocol";
import { McpPanel, type McpPanelProps } from "../src/McpPanel";

function server(overrides: Partial<DesktopMcpServer> = {}): DesktopMcpServer {
	return {
		ref: { key: "opaque:!/$ <&> ?=29\n끝", connectionGeneration: "connection-private", sessionGeneration: 17 },
		label: "MCP server 1",
		state: "connected",
		transport: "stdio",
		sharing: "shared",
		toolCount: 7,
		controls: ["suspend", "reconnect"],
		...overrides,
	};
}

function snapshot(overrides: Partial<DesktopMcpSnapshot> = {}): DesktopMcpSnapshot {
	return {
		connectionGeneration: "connection-private",
		sessionGeneration: 17,
		available: true,
		scope: "factory_manager_may_be_shared",
		servers: [server()],
		truncated: false,
		...overrides,
	};
}

function props(overrides: Partial<McpPanelProps> = {}): McpPanelProps {
	return {
		snapshot: snapshot(),
		onRefresh: () => { throw new Error("Rendering must not read manager state"); },
		onOperate: () => { throw new Error("Rendering must not mutate manager state"); },
		...overrides,
	};
}

function render(overrides: Partial<McpPanelProps> = {}): string {
	return renderToStaticMarkup(<McpPanel {...props(overrides)} />);
}

function buttons(html: string): string[] {
	return html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gu) ?? [];
}

function button(html: string, label: string): string {
	const result = buttons(html).find(value => value.endsWith(`${label}</button>`));
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}

interface PanelNodeProps {
	children?: ReactNode;
	onClick?: () => void;
}

// These captured handlers prove presentation callback wiring only, not mounted
// DOM interaction, IPC delivery, SDK effects, or remote/resource settlement.
function capture(overrides: Partial<McpPanelProps>): ReactNode {
	const captured: { tree: ReactNode } = { tree: null };
	function Harness() {
		captured.tree = McpPanel(props(overrides));
		return captured.tree;
	}
	renderToStaticMarkup(<Harness />);
	return captured.tree;
}

function click(tree: ReactNode, label: string) {
	let target: ReactElement<PanelNodeProps> | undefined;
	function visit(children: ReactNode) {
		Children.forEach(children, child => {
			if (target || !isValidElement<PanelNodeProps>(child)) return;
			if (child.props.children === label && child.props.onClick) target = child;
			else visit(child.props.children);
		});
	}
	visit(tree);
	if (!target?.props.onClick) throw new Error(`Missing handler: ${label}`);
	target.props.onClick();
}

describe("desktop MCP manager presentation", () => {
	test("renders each actual manager state, transport, sharing and tool count without inventing controls", () => {
		const cases: { state: DesktopMcpServer["state"]; label: string; transport: DesktopMcpServer["transport"]; sharing: DesktopMcpServer["sharing"]; sharingLabel: string }[] = [
			{ state: "connected", label: "관리자 연결됨", transport: "stdio", sharing: "shared", sharingLabel: "공유" },
			{ state: "connecting", label: "관리자 연결 중", transport: "http", sharing: "per-session", sharingLabel: "세션별" },
			{ state: "disconnected", label: "관리자 연결 끊김", transport: "sse", sharing: "unknown", sharingLabel: "알 수 없음" },
			{ state: "suspended", label: "관리자 연결 일시 중지됨", transport: "unknown", sharing: "shared", sharingLabel: "공유" },
			{ state: "unknown", label: "알 수 없음", transport: "unknown", sharing: "unknown", sharingLabel: "알 수 없음" },
		];
		for (const [index, value] of cases.entries()) {
			const html = render({ snapshot: snapshot({ servers: [server({ ...value, toolCount: index, controls: [] })] }) });
			expect(html).toContain(`data-state="${value.state}"`);
			expect(html).toContain(`<dt>관리자 상태</dt><dd>${value.label} (${value.state})</dd>`);
			expect(html).toContain(`<dt>전송</dt><dd>${value.transport === "unknown" ? "알 수 없음 (unknown)" : value.transport}</dd>`);
			expect(html).toContain(`<dt>공유</dt><dd>${value.sharingLabel} (${value.sharing})</dd>`);
			expect(html).toContain(`<dt>관리자 도구 수</dt><dd>${index}</dd>`);
			expect(html).toContain("제공된 제어 없음 · 읽기 전용");
			expect(buttons(html)).toHaveLength(1);
		}
	});

	test("uses only advertised actions even when state would suggest different capabilities", () => {
		for (const [action, label] of [["suspend", "연결 일시 중지"], ["resume", "연결 재개"], ["reconnect", "다시 연결"]] as const) {
			const html = render({ snapshot: snapshot({ servers: [server({ state: "connected", controls: [action] })] }) });
			expect(buttons(html)).toHaveLength(2);
			expect(button(html, label)).not.toContain('disabled=""');
			expect(html).not.toContain("제공된 제어 없음");
		}
		const html = render();
		expect(buttons(html)).toHaveLength(3);
		expect(button(html, "연결 일시 중지")).not.toContain('disabled=""');
		expect(button(html, "다시 연결")).not.toContain('disabled=""');
		expect(html).not.toMatch(/>연결 재개<\/button>/u);
		expect(html).not.toMatch(/>(?:삭제|원격 종료|설정 변경|도구 동기화)<\/button>/u);
	});

	test("passes the exact original reference object and advertised action without rewriting opaque identifiers", () => {
		const ref = server().ref;
		const calls: { ref: DesktopMcpRef; action: DesktopMcpAction }[] = [];
		const tree = capture({
			snapshot: snapshot({ servers: [server({ ref, controls: ["resume"] })] }),
			onOperate: (value, action) => calls.push({ ref: value, action }),
		});
		expect(calls).toEqual([]);
		click(tree, "연결 재개");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.ref).toBe(ref);
		expect(calls[0]?.action).toBe("resume");
	});

	test("busy blocks mutations but leaves read refresh and manager information available", () => {
		const html = render({ busy: true });
		expect(button(html, "연결 일시 중지")).toContain('disabled=""');
		expect(button(html, "다시 연결")).toContain('disabled=""');
		expect(button(html, "상태 새로고침")).not.toContain('disabled=""');
		expect(html).toContain("관리자 도구 수</dt><dd>7");
		expect(html).toContain("상태 조회는 별도");
		let reads = 0;
		const tree = capture({ busy: true, onRefresh: () => { reads++; } });
		click(tree, "연결 일시 중지");
		click(tree, "다시 연결");
		click(tree, "상태 새로고침");
		expect(reads).toBe(1);
	});

	test("pending locks callbacks and labels retained data as last received rather than current or successful", () => {
		const html = render({ pending: true });
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("연결 또는 요청 처리를 기다리는 중");
		expect(html).toContain("마지막으로 받은 관리자 정보이며 현재 상태를 보증하지 않습니다.");
		expect(buttons(html)).toHaveLength(3);
		for (const value of buttons(html)) expect(value).toContain('disabled=""');
		const tree = capture({ pending: true });
		for (const label of ["상태 새로고침", "연결 일시 중지", "다시 연결"]) click(tree, label);
		expect(html).not.toContain("변경 완료");
	});

	test("distinguishes missing, unavailable and available empty snapshots, with refresh still possible", () => {
		const missing = render({ snapshot: null });
		expect(missing).toContain("MCP 관리자 정보를 받지 못했습니다.");
		expect(missing).toContain("연결된 서버가 없다는 뜻은 아닙니다.");
		const unavailable = render({ snapshot: snapshot({ available: false, error: { code: "unavailable", message: "Captured manager unavailable" } }) });
		expect(unavailable).toContain("캡처한 MCP 관리자 조회·제어를 사용할 수 없습니다.");
		expect(unavailable).toContain("unavailable:");
		expect(unavailable).toContain("Captured manager unavailable");
		expect(unavailable).not.toContain("MCP server 1");
		const empty = render({ snapshot: snapshot({ servers: [] }) });
		expect(empty).toContain("받은 관리자 목록에 표시된 서버가 없습니다.");
		expect(empty).toContain("표시된 서버 0개");
		for (const html of [missing, unavailable, empty]) {
			expect(buttons(html)).toHaveLength(1);
			expect(button(html, "상태 새로고침")).not.toContain('disabled=""');
		}
		let reads = 0;
		click(capture({ snapshot: null, onRefresh: () => { reads++; } }), "상태 새로고침");
		expect(reads).toBe(1);
	});

	test("qualifies manager scope and unknown effects without certifying remote cleanup or registry synchronization", () => {
		const html = render({
			error: "Operation result not received",
			snapshot: snapshot({ error: { code: "unknown_effect", message: "Completion was not proven" } }),
		});
		expect(html.match(/role="alert"/gu)).toHaveLength(2);
		expect(html).toContain("Operation result not received");
		expect(html).toContain("unknown_effect:");
		expect(html).toContain("Completion was not proven");
		expect(html).toContain("변경 효과가 확인되지 않았습니다. 재시도 전에 상태를 새로고침하세요.");
		expect(html).toContain("세션 생성 시 캡처한 팩터리 관리자");
		expect(html).toContain("다른 세션과 공유될 수 있습니다.");
		expect(html).toContain("연결됨(connected)·재개(resumed)·재연결(reconnected)은 관리자 연결·도구 카탈로그만 뜻합니다.");
		expect(html).toContain("원격 세션 종료, 자원 정산·정리, 세션 도구 레지스트리 동기화를 보증하지 않습니다.");
		expect(html).toContain("cleanup: not_certified");
		expect(html).not.toContain("성공");
		expect(html).not.toContain("자원 정리 완료");
		const failed = render({ snapshot: snapshot({ error: { code: "backend_failure", message: "SDK operation failed" } }) });
		expect(failed).toContain("SDK operation failed");
		expect(failed).toContain("변경 효과가 확인되지 않았습니다.");
	});

	test("bounds server lists and label text, preserves host truncation and does not split surrogate pairs", () => {
		const long = render({ snapshot: snapshot({ servers: [server({ label: `${"가".repeat(127)}😀private-tail` })], truncated: true }) });
		expect(long).toContain("가".repeat(127));
		expect(long).not.toContain("😀");
		expect(long).not.toContain("\uD83D");
		expect(long).not.toContain("private-tail");
		expect(long).toContain("긴 내용 생략");
		expect(long).toContain("표시된 수는 전체 서버 수가 아닙니다.");
		const many = render({ snapshot: snapshot({ servers: Array.from({ length: 101 }, (_, index) => server({
			ref: { key: `opaque-${index}`, connectionGeneration: "connection-private", sessionGeneration: 17 },
			label: `제한 서버 ${index}`,
			controls: [],
		})) }) });
		expect(many.match(/class="mcp-server"/gu)).toHaveLength(100);
		expect(many).toContain("표시된 서버 100개");
		expect(many).toContain("제한 서버 99");
		expect(many).not.toContain("제한 서버 100");
		expect(many).toContain("표시 한도로 일부 서버가 생략되었습니다.");
		expect(render()).not.toContain("표시 한도로 일부 서버가 생략되었습니다.");
	});

	test("renders strings inertly and never exposes refs, SDK targets or extra configuration fields", () => {
		const hostile = '<script>alert(1)</script><img src="https://invalid.test/private" onerror="alert(2)">';
		const extra = {
			...server({ label: hostile }),
			target: { binding: "private-binding", name: "private-configured-name" },
			config: { endpoint: "https://secret.example/api", token: "private-token" },
		};
		const html = render({ snapshot: snapshot({ servers: [extra] }), error: hostile });
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<a ");
		expect(html).not.toContain("<iframe");
		for (const secret of ["opaque:", "connection-private", "sessionGeneration", "private-binding", "private-configured-name", "https://secret.example/api", "private-token"]) {
			expect(html).not.toContain(secret);
		}
		expect(html).toContain("원본 설정·주소·인증 정보는 표시하지 않습니다.");
		const boundedError = render({ error: `${"x".repeat(1024)}private-error-tail` });
		expect(boundedError).not.toContain("private-error-tail");
		expect(boundedError).toContain("긴 내용 생략");
	});
});
