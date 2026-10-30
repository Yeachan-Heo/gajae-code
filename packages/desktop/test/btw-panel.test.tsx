import { describe, expect, test } from "bun:test";
import { Children, isValidElement } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopBtwConversation, DesktopBtwTurn } from "../../desktop-host/src/btw-protocol";
import { BtwPanel, type BtwPanelProps } from "../src/BtwPanel";

function turn(overrides: Partial<DesktopBtwTurn> = {}): DesktopBtwTurn {
	return {
		turnId: "opaque:btw/turn <&> ?=29\n끝",
		question: "주 작업은 그대로 두고 질문합니다.\n  frozen context를 설명해 주세요.\n",
		answer: "여기까지 받은 부분 답변입니다.\n  한국어와 TypeScript 설명\n",
		status: "running",
		answerTruncated: false,
		...overrides,
	};
}

function conversation(turns: DesktopBtwTurn[] = [turn()]): DesktopBtwConversation {
	return { conversationId: "opaque-conversation", sessionGeneration: 17, revision: 3, turns };
}

function props(overrides: Partial<BtwPanelProps> = {}): BtwPanelProps {
	return {
		conversation: null,
		draft: "  후속 질문입니다.\n  기존 초안을 보존하세요.\n",
		disabled: false,
		pending: false,
		onDraftChange: () => { throw new Error("Rendering must not change the draft"); },
		onSend: () => { throw new Error("Rendering must not send a question"); },
		onCancel: () => { throw new Error("Rendering must not cancel a turn"); },
		...overrides,
	};
}

function render(overrides: Partial<BtwPanelProps> = {}): string {
	return renderToStaticMarkup(<BtwPanel {...props(overrides)} />);
}

function button(html: string, label: string): string {
	const result = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)]
		.find(match => match[0].endsWith(`${label}</button>`));
	if (!result) throw new Error(`Missing button: ${label}`);
	return result[0];
}

interface PanelNodeProps {
	children?: ReactNode;
	onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
	onChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
	onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
	onClick?: () => void;
}

// Match the existing OperatorPanel SSR presentation-tree approach. Handler invocation
// proves callback wiring, not mounted browser keyboard, focus or transport behavior.
function capture(overrides: Partial<BtwPanelProps>): ReactNode {
	const captured: { tree: ReactNode } = { tree: null };
	function Harness() {
		captured.tree = BtwPanel(props(overrides));
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

function key(tree: ReactNode, options: { key?: string; metaKey?: boolean; ctrlKey?: boolean; composing?: boolean } = {}): boolean {
	let prevented = false;
	const handler = node(tree, element => element.type === "textarea").props.onKeyDown;
	if (!handler) throw new Error("Missing keyboard handler");
	handler({
		key: options.key ?? "Enter",
		metaKey: options.metaKey ?? false,
		ctrlKey: options.ctrlKey ?? false,
		nativeEvent: { isComposing: options.composing ?? false },
		preventDefault: () => { prevented = true; },
	} as KeyboardEvent<HTMLTextAreaElement>);
	return prevented;
}

function cancel(tree: ReactNode) {
	const handler = node(tree, element => element.props.children === "곁대화 중지 요청").props.onClick;
	if (!handler) throw new Error("Missing side-turn cancel handler");
	handler();
}

describe("desktop BTW side-chat presentation", () => {
	test("explains frozen text-only isolation and provides a labeled controlled draft without owning a dialog", () => {
		for (const value of [null, conversation([])]) {
			const html = render({ conversation: value });
			expect(html).toContain("시작할 때 고정한 문맥(frozen context)");
			expect(html).toContain("텍스트 전용 곁대화");
			expect(html).toContain("도구를 사용하지 않으며");
			expect(html).toContain("주 대화 기록에 쓰이지 않습니다");
			expect(html).toContain("주 작업과 입력창은 별개입니다");
			expect(html).toContain("아직 곁대화가 없습니다");
			expect(html).toMatch(/<label for="[^"]+">곁대화 질문<\/label>/u);
			expect(html).toMatch(/<textarea[^>]*aria-describedby="[^"]+"[^>]*rows="3"/u);
			expect(html).toContain(props().draft);
			expect(html).toContain("Enter는 줄바꿈");
			expect(html).not.toContain("<dialog");
			expect(html).not.toContain("곁대화 중지 요청");
			expect(button(html, "곁대화 보내기")).not.toContain('disabled=""');
		}
	});

	test("renders ordered question and answer text inertly with original whitespace and explicit truncation", () => {
		const hostile = '<script>alert("fixture")</script>\n  <img src=x onerror=alert(1)>\n';
		const html = render({ conversation: conversation([
			turn({ turnId: "first", status: "completed" }),
			turn({ turnId: "second", question: "두 번째 질문\n  들여쓰기", answer: hostile, status: "cancelled", answerTruncated: true }),
		]) });
		expect(html).toContain('class="btw-history" role="region" aria-label="곁대화 질문과 답변" tabindex="0"');
		expect(html).toContain('class="btw-turn-list"');
		expect(html).toContain(turn().question);
		expect(html).toContain(turn().answer);
		expect(html.indexOf(turn().question)).toBeLessThan(html.indexOf("두 번째 질문"));
		expect(html).toContain("&lt;script&gt;alert(&quot;fixture&quot;)&lt;/script&gt;\n  &lt;img");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
		expect(html).toContain("취소됨 · 받은 답변 보존");
		expect(html).toContain("표시된 답변은 전체가 아닙니다");
		expect(html).not.toContain("곁대화 중지 요청");
		expect(button(html, "곁대화 보내기")).not.toContain('disabled=""');
	});

	test("submits the exact draft without clearing it and reports edits without mutating controlled text", () => {
		const changes: string[] = [];
		const sends: string[] = [];
		const draft = "  원래 초안\n    공백을 보존합니다.\n";
		const tree = capture({ draft, onDraftChange: value => changes.push(value), onSend: value => sends.push(value) });
		expect(submit(tree)).toBe(true);
		expect(sends).toEqual([draft]);
		expect(changes).toEqual([]);
		const edited = "\n  다음 질문 초안";
		change(tree, edited);
		expect(changes).toEqual([edited]);
		expect(sends).toEqual([draft]);
		expect(render({ draft })).toContain(draft);
		expect(render({ draft: edited })).toContain(edited);
	});

	test("reserves ordinary Enter for newline and submits Meta/Ctrl+Enter only outside IME composition", () => {
		for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
			const sends: string[] = [];
			const tree = capture({ onSend: value => sends.push(value) });
			expect(key(tree)).toBe(false);
			expect(key(tree, { ...modifier, key: "Escape" })).toBe(false);
			expect(key(tree, { ...modifier, composing: true })).toBe(false);
			expect(sends).toEqual([]);
			expect(key(tree, modifier)).toBe(true);
			expect(sends).toEqual([props().draft]);
		}
	});

	test("blocks blank, pending, disconnected and active-turn sends without discarding editable drafts", () => {
		const cases: Partial<BtwPanelProps>[] = [
			{ draft: " \n\t " },
			{ pending: true },
			{ disabled: true },
			{ conversation: conversation() },
			{ conversation: conversation([turn({ status: "cancel_requested" })]) },
		];
		for (const state of cases) {
			const changes: string[] = [];
			const sends: string[] = [];
			const tree = capture({ ...state, onDraftChange: value => changes.push(value), onSend: value => sends.push(value) });
			const html = render(state);
			expect(button(html, "곁대화 보내기")).toContain('disabled=""');
			expect(submit(tree)).toBe(true);
			expect(key(tree, { metaKey: true })).toBe(false);
			expect(key(tree, { ctrlKey: true })).toBe(false);
			expect(sends).toEqual([]);
			change(tree, "보존할 다음 초안\n  후속 질문");
			expect(changes).toEqual(["보존할 다음 초안\n  후속 질문"]);
			expect(html.match(/<textarea[^>]*>/u)?.[0]).not.toContain('disabled=""');
		}
		expect(render({ pending: true })).toContain("응답을 기다리는 중");
		expect(render({ disabled: true })).toContain("연결 또는 세션을 사용할 수 없습니다");
		expect(render({ disabled: true })).toContain(props().draft);
	});

	test("targets only the active side-turn ID and never presents a stop request as confirmed cancellation", () => {
		const active = turn();
		const value = conversation([turn({ turnId: "completed-side-turn", status: "completed" }), active]);
		const cancellations: string[] = [];
		const tree = capture({ conversation: value, onCancel: id => cancellations.push(id) });
		cancel(tree);
		expect(cancellations).toEqual([active.turnId]);
		const html = render({ conversation: conversation() });
		expect(button(html, "곁대화 중지 요청")).not.toContain('disabled=""');
		expect(html).toContain("이 곁대화 응답만 대상으로");
		expect(html).toContain("즉시 종료를 보장하지 않습니다");
		for (const state of [{ pending: true }, { disabled: true }, { conversation: conversation([turn({ status: "cancel_requested" })]) }]) {
			const locked = { conversation: conversation(), ...state };
			expect(button(render(locked), "곁대화 중지 요청")).toContain('disabled=""');
			cancel(capture(locked));
		}
		const cancelling = render({ conversation: conversation([turn({ status: "cancel_requested" })]) });
		expect(cancelling).toContain("중지 요청됨 · 종료 확인 대기");
		expect(cancelling).not.toContain("취소됨");
		expect(cancelling).toContain(active.answer);
	});

	test("exposes each terminal result, preserves partial failures and re-enables follow-up without inventing output", () => {
		for (const [status, label] of [["completed", "응답 완료"], ["cancelled", "취소됨 · 받은 답변 보존"], ["failed", "응답 실패"]] as const) {
			const html = render({ conversation: conversation([turn({ status })]) });
			expect(html).toContain(`data-status="${status}"`);
			expect(html).toContain(`role="status">${label}</p>`);
			expect(html).toContain(turn().answer);
			expect(html).not.toContain("곁대화 중지 요청");
			expect(button(html, "곁대화 보내기")).not.toContain('disabled=""');
			const sends: string[] = [];
			submit(capture({ conversation: conversation([turn({ status })]), onSend: value => sends.push(value) }));
			expect(sends).toEqual([props().draft]);
		}
		const failed = render({ conversation: conversation([turn({ status: "failed", error: { code: "provider_failure", message: "응답 연결이 끊겼습니다.\n  받은 내용은 보존됩니다." } })]) });
		expect(failed).toContain('role="alert"');
		expect(failed).toContain("provider_failure: 응답 연결이 끊겼습니다.\n  받은 내용은 보존됩니다.");
		expect(failed).toContain(turn().answer);
		const empty = render({ conversation: conversation([turn({ status: "cancelled", answer: "" })]) });
		expect(empty).toContain("아직 받은 답변이 없습니다");
		expect(empty).not.toContain('aria-label="곁대화 답변"');
		expect(empty).not.toContain("응답 완료");
	});
});
