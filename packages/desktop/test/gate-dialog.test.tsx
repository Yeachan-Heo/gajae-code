import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopGatePresentation } from "../../desktop-host/src/gate-presentation-protocol";
import { GateDialog, type GateDialogProps, validateGateJsonAnswer } from "../src/GateDialog";

function presentation(): DesktopGatePresentation {
	return {
		id: "opaque-presentation-not-display",
		gate: {
			ref: { sessionGeneration: "hidden-session-generation", connectionGeneration: "hidden-connection-generation", key: "hidden-gate-reference" },
			kind: "approval",
			stage: "설계 검토 단계",
			createdAt: "2026-10-28T18:00:00Z",
			answerable: true,
			content: {
				title: "한국어 日本語 中文 실행 전 검토",
				prompt: "원본 내용을 읽고 응답하세요.\n다음 줄도 유지합니다.",
				summary: "요약: 선택과 실행은 별개입니다.",
				plan: "1. 설계 확인\n2. 별도 실행 승인",
				source: "artifact:///private/source.md",
				language: "ko-KR / 日本語 / 中文",
			},
			artifacts: [{ kind: "plan", path: "artifact:///private/계획.html", sha256: "a".repeat(64) }],
			schemaJson: '{"type":"object","properties":{"decision":{"enum":["approve","revise"]}},"required":["decision"]}',
			choices: [{ key: "opaque-choice-not-display", label: "완전한 응답 제공", description: "생산자가 검증한 전체 값" }],
			optionLabels: [{ label: "필드 설명 전용", description: "이 안내는 완전한 응답이 아닙니다." }],
			truncated: false,
			maxAnswerBytes: 65_536,
		},
	};
}

function props(overrides: Partial<GateDialogProps> = {}): GateDialogProps {
	return {
		presentation: presentation(),
		presented: true,
		onPresented: () => { throw new Error("SSR must not acknowledge presentation"); },
		onRetired: () => { throw new Error("SSR must not acknowledge retirement"); },
		onAnswer: () => { throw new Error("Rendering must not submit answers"); },
		onWithdraw: () => { throw new Error("Rendering must not withdraw a surface"); },
		...overrides,
	};
}

function render(overrides: Partial<GateDialogProps> = {}): string {
	return renderToStaticMarkup(<GateDialog {...props(overrides)} />);
}

function button(html: string, label: string): string {
	const found = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)].find(match => match[0].includes(label));
	if (!found) throw new Error(`Missing rendered button: ${label}`);
	return found[0];
}

// SSR verifies output and pure validation only. It cannot prove effects, connected DOM,
// native dialog focus/Escape, retirement callbacks, or an SDK workflow continuation.
// The parent integration must exercise those with a live DOM and the real SDK presenter.
describe("desktop gate dialog presentation", () => {
	test("renders complete producer content and inert, read-only evidence with existing semantic controls", () => {
		const html = render();
		for (const text of ["한국어 日本語 中文 실행 전 검토", "원본 내용을 읽고 응답하세요.\n다음 줄도 유지합니다.", "요약: 선택과 실행은 별개입니다.", "1. 설계 확인\n2. 별도 실행 승인", "artifact:///private/source.md", "ko-KR / 日本語 / 中文", "artifact:///private/계획.html", "a".repeat(64), "설계 검토 단계"]) {
			expect(html).toContain(text);
		}
		for (const hook of ["gate-dialog", "gate-content", "gate-evidence", "gate-schema", "gate-answer", "gate-actions", "gate-status"]) expect(html).toContain(hook);
		expect(html).toContain('<dialog aria-labelledby=');
		expect(html).toContain('class="modal gate-dialog"');
		expect(html).toContain('<form class="gate-answer"');
		expect(html).toContain("아티팩트 참조 · 읽기 전용");
		expect(html).toContain("스키마 JSON · 읽기 전용");
		expect(html).toContain("&quot;required&quot;:[&quot;decision&quot;]");
		expect(html).toContain("원본 검증 스키마가 아닙니다.");
		expect(html).not.toContain("href=");
		expect(html).not.toContain("src=");
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("<input");
		for (const hidden of ["opaque-presentation-not-display", "opaque-choice-not-display", "hidden-session-generation", "hidden-connection-generation", "hidden-gate-reference"]) expect(html).not.toContain(hidden);
	});

	test("only advertised complete choices become actions; schema and option labels never synthesize buttons or fields", () => {
		const html = render();
		expect(button(html, "완전한 응답 제공")).not.toContain('disabled=""');
		expect(html).toContain("생산자가 검증한 전체 값");
		expect(html).toContain("필드 설명 전용");
		expect(html).toContain("이 안내는 완전한 응답이 아닙니다.");
		expect(html.match(/<button\b/gu)).toHaveLength(3); // Native close, actual choice, explicit JSON submit.
		expect(html).not.toContain('name="decision"');
		expect(html).not.toContain(">approve</button>");
		expect(html).not.toContain(">revise</button>");
		expect(button(html, "JSON 응답 보내기")).toContain('disabled=""'); // Empty draft is not JSON.
		expect(html.match(/<textarea\b/gu)).toHaveLength(1);
		expect(html.match(/<textarea\b[^>]*>/u)?.[0]).not.toContain('disabled=""');
		const value = presentation();
		value.gate.choices = [];
		const jsonOnly = render({ presentation: value });
		expect(jsonOnly).toContain("제공된 완전한 응답 선택지 없음 · JSON 응답을 사용하세요.");
		expect(jsonOnly).toContain("필드 설명 전용");
		expect(jsonOnly.match(/<button\b/gu)).toHaveLength(2);
	});

	test("unsupported, truncated, unacknowledged, pending and invalid-limit states disable answers without cancelling on close", () => {
		const unsupported = presentation();
		unsupported.gate.answerable = false;
		unsupported.gate.reason = "생산자가 원격 응답을 지원하지 않습니다.";
		const truncated = presentation();
		truncated.gate.truncated = true;
		const invalidLimit = presentation();
		invalidLimit.gate.maxAnswerBytes = 0;
		const states: Array<{ overrides: Partial<GateDialogProps>; notice: string }> = [
			{ overrides: { presentation: unsupported }, notice: "읽기 전용입니다." },
			{ overrides: { presentation: truncated }, notice: "완전한 내용을 확인할 수 없어 응답할 수 없습니다." },
			{ overrides: { presented: false }, notice: "화면 표시의 서버 확인을 기다리는 중입니다." },
			{ overrides: { pending: true }, notice: "연결 또는 응답 처리를 기다리는 중입니다." },
			{ overrides: { presentation: invalidLimit }, notice: "유효한 응답 크기 한도가 제공되지 않아 응답할 수 없습니다." },
		];
		for (const { overrides, notice } of states) {
			const html = render(overrides);
			expect(html).toContain(notice);
			expect(button(html, "완전한 응답 제공")).toContain('disabled=""');
			expect(button(html, "JSON 응답 보내기")).toContain('disabled=""');
			expect(html.match(/<textarea\b[^>]*>/u)?.[0]).toContain('disabled=""');
			expect(button(html, "닫기")).not.toContain('disabled=""');
			expect(html).toContain("닫기는 화면 철회 요청이며 워크플로 취소가 아닙니다.");
			expect(html).toContain("응답 수락은 실행 승인이나 워크플로 진행 완료를 뜻하지 않습니다.");
		}
		expect(render({ pending: true })).toContain('aria-busy="true"');
		expect(render({ error: "서버가 응답을 거절했습니다." })).toContain('role="alert"');
		expect(render({ error: "서버가 응답을 거절했습니다." })).toContain("서버가 응답을 거절했습니다.");
	});

	test("escapes all producer text and treats HTML, schema and artifact URLs as inert literals", () => {
		const value = presentation();
		const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
		value.gate.content.title = hostile;
		value.gate.content.plan = hostile;
		value.gate.content.source = "javascript:alert(3)";
		value.gate.schemaJson = hostile;
		value.gate.artifacts = [{ kind: hostile, path: "https://example.invalid/private.html", sha256: hostile }];
		value.gate.choices[0]!.label = hostile;
		value.gate.optionLabels[0]!.description = hostile;
		const html = render({ presentation: value, error: hostile });
		expect(html).toContain("&lt;img");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("javascript:alert(3)");
		expect(html).toContain("https://example.invalid/private.html");
		for (const executable of ["<img", "<script", "<iframe", "href=", "<a "]) expect(html).not.toContain(executable);
	});

	test("bounds oversized CJK, schema, evidence and choice labels and disables incomplete local displays", () => {
		for (const field of ["content", "schema", "artifact", "choice", "options"] as const) {
			const value = presentation();
			if (field === "content") value.gate.content.plan = "가".repeat(32_769);
			if (field === "schema") value.gate.schemaJson = "s".repeat(65_537);
			if (field === "artifact") value.gate.artifacts[0]!.path = "p".repeat(1025);
			if (field === "choice") value.gate.choices[0]!.description = "d".repeat(1025);
			if (field === "options") value.gate.optionLabels = Array.from({ length: 65 }, (_, index) => ({ label: `안내-${index}` }));
			const html = render({ presentation: value });
			expect(html).toContain("완전한 내용을 확인할 수 없어 응답할 수 없습니다.");
			expect(button(html, "완전한 응답 제공")).toContain('disabled=""');
			if (field === "options") expect(html).not.toContain("안내-64");
			else expect(html).toContain("긴 내용 생략");
			expect(html).not.toContain("가".repeat(32_769));
			expect(html).not.toContain("s".repeat(65_537));
			expect(html).not.toContain("p".repeat(1025));
		}
		const value = presentation();
		value.gate.content.plan = `${"x".repeat(32_767)}😀뒤`;
		const html = render({ presentation: value });
		expect(html).not.toContain("\uD83D");
		expect(html).not.toContain("😀");
		expect(html).toContain("긴 내용 생략");
	});

	test("retiring renders no root, Modal or answer controls even while pending; SSR emits no lifecycle callbacks", () => {
		for (const pending of [false, true]) {
			expect(render({ retiring: { nonce: "exact-retirement-nonce" }, pending })).toBe("");
		}
		// Callbacks throw in these SSR fixtures: rendering visible and retired trees must not call them.
		expect(render({ presented: false })).toContain("화면 표시의 서버 확인을 기다리는 중입니다.");
	});
});

describe("desktop gate JSON syntax and UTF-8 validation", () => {
	test("preserves the exact JSON wire text and accepts whole values without guessing schema fields", () => {
		for (const json of [' {"decision":"revise","note":"검토 日本語 😀"}\n', "false", "null", "42", '"직접 응답"', '["선택", 1]']) {
			const bytes = new TextEncoder().encode(json).byteLength;
			expect(validateGateJsonAnswer(json, bytes)).toEqual({ valid: true, bytes, answer: { kind: "json", json } });
		}
	});

	test("rejects empty, whitespace, malformed, trailing and JavaScript-only input rather than executing or repairing it", () => {
		for (const json of ["", "  \n", "{", '{"a":1,}', '{"a":undefined}', "true false", "NaN", "(() => 1)()", "// comment\n1"]) {
			expect(validateGateJsonAnswer(json, 1024)).toEqual({ valid: false, error: "유효한 JSON 값을 입력하세요." });
		}
	});

	test("measures multibyte UTF-8 at the exact boundary including whitespace and refuses over-limit answers", () => {
		const json = '"가😀"'; // Two quotes + three-byte Hangul + four-byte emoji.
		expect(validateGateJsonAnswer(json, 9)).toEqual({ valid: true, bytes: 9, answer: { kind: "json", json } });
		expect(validateGateJsonAnswer(json, 8)).toEqual({ valid: false, error: "응답은 UTF-8 8바이트 이하여야 합니다." });
		expect(validateGateJsonAnswer(" true ", 5)).toEqual({ valid: false, error: "응답은 UTF-8 5바이트 이하여야 합니다." });
		expect(validateGateJsonAnswer('"abcd"', 5)).toEqual({ valid: false, error: "응답은 UTF-8 5바이트 이하여야 합니다." });
	});

	test("refuses missing or unusable wire limits rather than substituting a browser default", () => {
		for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			expect(validateGateJsonAnswer("true", limit)).toEqual({ valid: false, error: "유효한 응답 크기 한도가 제공되지 않았습니다." });
		}
	});
});
