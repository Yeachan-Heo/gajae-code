import { describe, expect, test } from "bun:test";
import { Children, isValidElement } from "react";
import type { ChangeEvent, FormEvent, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopOperatorOperation, DesktopOperatorStatus } from "../../desktop-host/src/operator-protocol";
import { OperatorPanel, type OperatorPanelProps } from "../src/OperatorPanel";

function operation(overrides: Partial<DesktopOperatorOperation> = {}): DesktopOperatorOperation {
	return {
		operationId: "opaque:!/$ <&> ?=29\n끝",
		connectionGeneration: "connection-fixture",
		sessionGeneration: 17,
		kind: "bash",
		excludeFromContext: false,
		status: "running",
		output: "실제 호스트 출력\n두 번째 줄",
		outputTruncated: false,
		liveOutput: "redacted",
		...overrides,
	};
}

function props(overrides: Partial<OperatorPanelProps> = {}): OperatorPanelProps {
	return {
		value: "!! printf '한국어'\n  printf 'next'\n",
		operation: null,
		onChange: () => { throw new Error("Rendering must not change a draft"); },
		onExecute: () => { throw new Error("Rendering must not execute"); },
		onAbort: () => { throw new Error("Rendering must not cancel"); },
		onFold: () => { throw new Error("Rendering must not fold a tool"); },
		onRefresh: () => { throw new Error("Rendering must not refresh"); },
		...overrides,
	};
}

function render(overrides: Partial<OperatorPanelProps> = {}): string {
	return renderToStaticMarkup(<OperatorPanel {...props(overrides)} />);
}

function button(html: string, label: string): string {
	const result = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)]
		.find(match => match[0].endsWith(`${label}</button>`));
	if (!result) throw new Error(`Missing button: ${label}`);
	return result[0];
}

interface PanelNodeProps {
	children?: ReactNode;
	type?: string;
	onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
	onChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
	onClick?: () => void;
}

// Capture the presentation tree inside a real SSR render (including useId).
// Invoking these handlers tests callback wiring only, not mounted DOM or SDK behavior.
function capture(overrides: Partial<OperatorPanelProps>): ReactNode {
	const captured: { tree: ReactNode } = { tree: null };
	function Harness() {
		captured.tree = OperatorPanel(props(overrides));
		return captured.tree;
	}
	renderToStaticMarkup(<Harness />);
	return captured.tree;
}

function node(tree: ReactNode, predicate: (element: ReactElement<PanelNodeProps>) => boolean): ReactElement<PanelNodeProps> {
	let found: ReactElement<PanelNodeProps> | undefined;
	function visit(children: ReactNode) {
		Children.forEach(children, child => {
			if (found || !isValidElement<PanelNodeProps>(child)) return;
			if (predicate(child)) found = child;
			else visit(child.props.children);
		});
	}
	visit(tree);
	if (!found) throw new Error("Missing presentation node");
	return found;
}

function click(tree: ReactNode, label: string) {
	const handler = node(tree, element => element.props.children === label).props.onClick;
	if (!handler) throw new Error(`Missing click handler: ${label}`);
	handler();
}

function submit(tree: ReactNode): boolean {
	let prevented = false;
	const handler = node(tree, element => element.type === "form").props.onSubmit;
	if (!handler) throw new Error("Missing submit handler");
	handler({ preventDefault: () => { prevented = true; } } as FormEvent<HTMLFormElement>);
	return prevented;
}

function change(tree: ReactNode, value: string) {
	const handler = node(tree, element => element.type === "textarea").props.onChange;
	if (!handler) throw new Error("Missing change handler");
	handler({ target: { value } } as ChangeEvent<HTMLTextAreaElement>);
}

describe("desktop operator panel presentation", () => {
	test("labels a multiline draft, explains all prefixes and never executes during SSR", () => {
		const html = render();
		expect(html).toMatch(/<label for="[^"]+">셸 명령 \/ Python 코드<\/label>/u);
		expect(html).toMatch(/<textarea[^>]*aria-describedby="[^"]+"[^>]*rows="3"/u);
		expect(html).toContain("!! printf &#x27;한국어&#x27;\n  printf &#x27;next&#x27;\n");
		expect(html).toContain("<code>!</code> 셸");
		expect(html).toContain("<code>!!</code> 셸 (모델 문맥에서 제외)");
		expect(html).toContain("<code>$</code> Python");
		expect(html).toContain("<code>$$</code> Python (모델 문맥에서 제외)");
		expect(html).toContain("Enter는 줄바꿈이며, 실행 버튼으로만 제출합니다.");
		expect(html).toContain("모델에게 보내는 메시지가 아닙니다.");
		expect(html).toContain("아직 받은 실행 정보가 없습니다.");
		expect(html).not.toContain("성공");
		expect(html).not.toContain("onkeydown");
		expect(button(html, "실행")).toContain('type="submit"');
		expect(button(html, "실행")).not.toContain('disabled=""');
	});

	test("preserves every exact operator string and only submits through the explicit form handler", () => {
		for (const text of ["! echo a\n echo b\n", "!!  printf '!$'  ", "$ print('한국어')\n", "$$ x = 1\nprint(x)\n"]) {
			const changes: string[] = [];
			const executions: string[] = [];
			const tree = capture({ value: text, onChange: value => changes.push(value), onExecute: value => executions.push(value) });
			expect(executions).toEqual([]);
			change(tree, text);
			expect(changes).toEqual([text]);
			expect(executions).toEqual([]);
			expect(submit(tree)).toBe(true);
			expect(executions).toEqual([text]);
		}
	});

	test("addresses abort and read refresh with the exact opaque operation ID and keeps fold separate", () => {
		const value = operation();
		const aborts: string[] = [];
		const reads: string[] = [];
		let folds = 0;
		const tree = capture({ operation: value, onAbort: id => aborts.push(id), onRefresh: id => reads.push(id), onFold: () => { folds++; } });
		click(tree, "취소 요청");
		click(tree, "실행 상세 새로고침");
		click(tree, "현재 포그라운드 도구 접기");
		expect(aborts).toEqual([value.operationId]);
		expect(reads).toEqual([value.operationId]);
		expect(folds).toBe(1);
		const html = render({ operation: value });
		expect(html).toContain("opaque:!/$ &lt;&amp;&gt; ?=29\n끝");
		expect(html).toContain("current foreground tool");
		expect(html).toContain("직접 실행한 ! / !! 셸 명령을 접는 기능이 아닙니다.");
		expect(button(html, "실행")).toContain('disabled=""');
		for (const label of ["취소 요청", "실행 상세 새로고침", "현재 포그라운드 도구 접기"]) {
			expect(button(html, label)).not.toContain('disabled=""');
			expect(button(html, label)).toContain('type="button"');
		}
	});

	test("blocks all mutations and read requests while pending or disabled without clearing draft/output", () => {
		for (const state of [{ pending: true }, { disabled: true }]) {
			const overrides = { operation: operation(), ...state };
			const html = render(overrides);
			for (const label of ["실행", "취소 요청", "실행 상세 새로고침", "현재 포그라운드 도구 접기"]) {
				expect(button(html, label)).toContain('disabled=""');
			}
			expect(html).toMatch(/<textarea[^>]*disabled=""/u);
			expect(html).toContain("실제 호스트 출력");
			expect(html).toContain("!! printf");
			const tree = capture(overrides);
			expect(submit(tree)).toBe(true);
			change(tree, "! must not change");
			click(tree, "취소 요청");
			click(tree, "실행 상세 새로고침");
			click(tree, "현재 포그라운드 도구 접기");
		}
		expect(render({ pending: true })).toContain('aria-busy="true"');
		expect(render({ pending: true })).toContain("실행 완료를 뜻하지 않습니다.");
		expect(render({ disabled: true })).toContain("현재 연결 또는 세션에서는 제어할 수 없습니다.");
		for (const value of ["", " \n\t"]) {
			expect(button(render({ value }), "실행")).toContain('disabled=""');
			expect(submit(capture({ value }))).toBe(true);
		}
	});

	test("busy blocks only new execution while preserving editing, abort, detail and foreground-tool fold", () => {
		for (const value of [null, operation(), operation({ status: "completed", exitCode: 0 })]) {
			const overrides = { busy: true, operation: value };
			const html = render(overrides);
			expect(button(html, "실행")).toContain('disabled=""');
			expect(button(html, "현재 포그라운드 도구 접기")).not.toContain('disabled=""');
			expect(html).not.toMatch(/<textarea[^>]*disabled=""/u);
			expect(html).toContain('aria-busy="false"');
			if (value?.status === "running") {
				expect(button(html, "취소 요청")).not.toContain('disabled=""');
				expect(html).not.toContain("다른 세션 작업이 실행 중이거나 응답을 기다리고 있어");
			} else {
				expect(html).toContain("다른 세션 작업이 실행 중이거나 응답을 기다리고 있어 새 직접 실행을 시작할 수 없습니다.");
			}
			if (value) expect(button(html, "실행 상세 새로고침")).not.toContain('disabled=""');
			const changes: string[] = [];
			const aborts: string[] = [];
			const reads: string[] = [];
			let folds = 0;
			const tree = capture({ ...overrides, onChange: text => changes.push(text), onAbort: id => aborts.push(id), onRefresh: id => reads.push(id), onFold: () => { folds++; } });
			expect(submit(tree)).toBe(true);
			change(tree, "$$ print('preserved')\n");
			click(tree, "현재 포그라운드 도구 접기");
			if (value) {
				click(tree, "실행 상세 새로고침");
				click(tree, "취소 요청");
			}
			expect(changes).toEqual(["$$ print('preserved')\n"]);
			expect(folds).toBe(1);
			expect(reads).toEqual(value ? [value.operationId] : []);
			expect(aborts).toEqual(value?.status === "running" ? [value.operationId] : []);
		}
		for (const state of [{ pending: true }, { disabled: true }]) {
			const html = render({ busy: true, operation: operation(), ...state });
			for (const label of ["실행", "취소 요청", "실행 상세 새로고침", "현재 포그라운드 도구 접기"]) {
				expect(button(html, label)).toContain('disabled=""');
			}
		}
	});

	test("keeps cancel_requested distinct from cancelled and only offers abort for running", () => {
		const states: DesktopOperatorStatus[] = ["cancel_requested", "completed", "cancelled", "failed"];
		for (const status of states) {
			const html = render({ operation: operation({ status }) });
			expect(html).toContain(`data-status="${status}"`);
			expect(html).toContain(`(${status})`);
			expect(button(html, "취소 요청")).toContain('disabled=""');
			expect(button(html, "실행 상세 새로고침")).not.toContain('disabled=""');
			expect(button(html, "현재 포그라운드 도구 접기")).not.toContain('disabled=""');
			click(capture({ operation: operation({ status }) }), "취소 요청");
			if (status === "cancel_requested") {
				expect(button(html, "실행")).toContain('disabled=""');
				expect(html).toContain("취소 요청됨 · 실행 종료 미확인");
				expect(html).not.toContain("취소됨");
				expect(submit(capture({ operation: operation({ status }) }))).toBe(true);
			} else {
				expect(button(html, "실행")).not.toContain('disabled=""');
				const executions: string[] = [];
				const reads: string[] = [];
				const value = operation({ status });
				const tree = capture({ operation: value, onExecute: text => executions.push(text), onRefresh: id => reads.push(id) });
				expect(submit(tree)).toBe(true);
				click(tree, "실행 상세 새로고침");
				expect(executions).toEqual([props().value]);
				expect(reads).toEqual([value.operationId]);
			}
			expect(html).not.toContain("자원 정리 완료");
		}
	});

	test("preserves explicit cancellation despite its nonzero exit or termination signal", () => {
		for (const result of [{ exitCode: 130 }, { signal: "SIGTERM" }, { exitCode: 137, signal: "SIGKILL" }]) {
			const html = render({ operation: operation({ status: "cancelled", ...result }) });
			expect(html).toContain("취소됨 (cancelled)");
			expect(html).not.toContain('data-failed="true"');
			expect(html).not.toContain(" · 실패");
			expect(html).not.toContain("성공");
			if (result.exitCode !== undefined) expect(html).toContain(`<dt>종료 코드</dt><dd>${result.exitCode}</dd>`);
			if (result.signal !== undefined) expect(html).toContain(`<dt>종료 신호</dt><dd>${result.signal}</dd>`);
		}
		const error = render({ operation: operation({ status: "cancelled", exitCode: 130, error: { code: "redaction_failed", message: "출력 가림 처리 실패" } }) });
		expect(error).toContain("취소됨 (cancelled)");
		expect(error).toContain("redaction_failed: 출력 가림 처리 실패");
		expect(error).toContain('role="alert"');
	});

	test("never presents a completed nonzero exit, signal or operation error as success", () => {
		const nonzero = render({ operation: operation({ status: "completed", exitCode: 7 }) });
		expect(nonzero).toContain("실행 종료 (completed) · 실패");
		expect(nonzero).toContain("<dt>종료 코드</dt><dd>7</dd>");
		expect(nonzero).toContain('data-failed="true"');
		const signal = render({ operation: operation({ status: "completed", signal: "SIGTERM" }) });
		expect(signal).toContain("<dt>종료 신호</dt><dd>SIGTERM</dd>");
		expect(signal).toContain('data-failed="true"');
		const error = render({ operation: operation({ status: "failed", error: { code: "backend_failure", message: "실제 SDK 오류" } }), error: "상세 조회 실패" });
		expect(error).toContain("backend_failure: 실제 SDK 오류");
		expect(error).toContain("상세 조회 실패");
		expect(error.match(/role="alert"/gu)).toHaveLength(2);
		for (const html of [nonzero, signal, error, render({ operation: operation({ status: "completed", output: "", exitCode: 0 }) }), render({ operation: operation({ status: "completed", output: "" }) })]) {
			expect(html).not.toContain("성공");
			expect(html).not.toContain("실행 성공");
		}
		expect(render({ operation: operation({ status: "completed" }) })).toContain("<dt>종료 코드</dt><dd>제공되지 않음</dd>");
	});

	test("distinguishes withheld status-only updates from redacted output and allows actual final output", () => {
		for (const status of ["running", "cancel_requested"] as const) {
			const html = render({ operation: operation({ status, liveOutput: "withheld", output: "must remain withheld" }) });
			expect(html).toContain("실시간 출력 보류 · 상태만 수신 중입니다.");
			expect(html).toContain("현재 출력 내용은 표시하지 않습니다.");
			expect(html).not.toContain("must remain withheld");
			expect(html).not.toContain("<pre");
		}
		const final = render({ operation: operation({ status: "completed", liveOutput: "withheld", output: "실제 종료 결과", exitCode: 0 }) });
		expect(final).toContain("실시간 출력은 보류되었습니다. 제공된 종료 출력만 표시합니다.");
		expect(final).toContain("실제 종료 결과</pre>");
		const redacted = render({ operation: operation({ output: "token=[REDACTED]" }) });
		expect(redacted).toContain("민감 정보 가림 처리된 출력");
		expect(redacted).toContain("token=[REDACTED]</pre>");
		const empty = render({ operation: operation({ output: "" }) });
		expect(empty).toContain("제공된 출력이 없습니다. 상태 정보는 출력이 아닙니다.");
		expect(empty).not.toContain("<pre");
	});

	test("renders bounded inert output, host truncation and actual context exclusion without HTML interpretation", () => {
		const hostile = '<script>alert(1)</script><img src=x onerror="alert(2)">';
		const html = render({ operation: operation({ kind: "python", excludeFromContext: true, output: hostile, outputTruncated: true }) });
		expect(html).toContain("Python · 실행 중");
		expect(html).toContain("모델 문맥에서 제외</p>");
		expect(html).toContain('class="bounded-output operator-output"');
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
		expect(html).toContain("표시된 출력은 전체가 아닙니다.");
		expect(render({ operation: operation() })).toContain("모델 문맥에 포함</p>");
		const bounded = render({ operation: operation({ output: `omitted prefix${"x".repeat(20_000)}tail` }) });
		expect(bounded).not.toContain("omitted prefix");
		expect(bounded).not.toContain("x".repeat(16_385));
		expect(bounded).toContain("tail</pre>");
		expect(bounded).toContain("출력 한도로 일부 내용이 생략되었습니다.");
	});
});
