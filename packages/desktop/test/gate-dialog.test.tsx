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
			stage: "Design review stage",
			createdAt: "2026-10-28T18:00:00Z",
			answerable: true,
			content: {
				title: "日本語 中文 pre-run review",
				prompt: "Read the original content and answer.\nThe next line is preserved too.",
				summary: "Summary: choosing and executing are separate.",
				plan: "1. Confirm the design\n2. Approve execution separately",
				source: "artifact:///private/source.md",
				language: "ko-KR / 日本語 / 中文",
			},
			artifacts: [{ kind: "plan", path: "artifact:///private/plan.html", sha256: "a".repeat(64) }],
			schemaJson: '{"type":"object","properties":{"decision":{"enum":["approve","revise"]}},"required":["decision"]}',
			choices: [{ key: "opaque-choice-not-display", label: "Complete answer provided", description: "The full value verified by the producer" }],
			optionLabels: [{ label: "Field description only", description: "This guidance is not a complete answer." }],
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
		for (const text of ["日本語 中文 pre-run review", "Read the original content and answer.\nThe next line is preserved too.", "Summary: choosing and executing are separate.", "1. Confirm the design\n2. Approve execution separately", "artifact:///private/source.md", "ko-KR / 日本語 / 中文", "artifact:///private/plan.html", "a".repeat(64), "Design review stage"]) {
			expect(html).toContain(text);
		}
		for (const hook of ["gate-dialog", "gate-content", "gate-evidence", "gate-schema", "gate-answer", "gate-actions", "gate-status"]) expect(html).toContain(hook);
		expect(html).toContain('<dialog aria-labelledby=');
		expect(html).toContain('class="modal gate-dialog"');
		expect(html).toContain('<form class="gate-answer"');
		expect(html).toContain("Artifact references · Read only");
		expect(html).toContain("Schema JSON · Read only");
		expect(html).toContain("&quot;required&quot;:[&quot;decision&quot;]");
		expect(html).toContain("is not the original validation schema.");
		expect(html).not.toContain("href=");
		expect(html).not.toContain("src=");
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("<input");
		for (const hidden of ["opaque-presentation-not-display", "opaque-choice-not-display", "hidden-session-generation", "hidden-connection-generation", "hidden-gate-reference"]) expect(html).not.toContain(hidden);
	});

	test("only advertised complete choices become actions; schema and option labels never synthesize buttons or fields", () => {
		const html = render();
		expect(button(html, "Complete answer provided")).not.toContain('disabled=""');
		expect(html).toContain("The full value verified by the producer");
		expect(html).toContain("Field description only");
		expect(html).toContain("This guidance is not a complete answer.");
		expect(html.match(/<button\b/gu)).toHaveLength(3); // Native close, actual choice, explicit JSON submit.
		expect(html).not.toContain('name="decision"');
		expect(html).not.toContain(">approve</button>");
		expect(html).not.toContain(">revise</button>");
		expect(button(html, "Send JSON answer")).toContain('disabled=""'); // Empty draft is not JSON.
		expect(html.match(/<textarea\b/gu)).toHaveLength(1);
		expect(html.match(/<textarea\b[^>]*>/u)?.[0]).not.toContain('disabled=""');
		const value = presentation();
		value.gate.choices = [];
		const jsonOnly = render({ presentation: value });
		expect(jsonOnly).toContain("No complete answer choices provided · Use a JSON answer.");
		expect(jsonOnly).toContain("Field description only");
		expect(jsonOnly.match(/<button\b/gu)).toHaveLength(2);
	});

	test("unsupported, truncated, unacknowledged, pending and invalid-limit states disable answers without cancelling on close", () => {
		const unsupported = presentation();
		unsupported.gate.answerable = false;
		unsupported.gate.reason = "The producer does not support remote answers.";
		const truncated = presentation();
		truncated.gate.truncated = true;
		const invalidLimit = presentation();
		invalidLimit.gate.maxAnswerBytes = 0;
		const states: Array<{ overrides: Partial<GateDialogProps>; notice: string }> = [
			{ overrides: { presentation: unsupported }, notice: "It is read only." },
			{ overrides: { presentation: truncated }, notice: "It cannot be answered because the complete content is not available." },
			{ overrides: { presented: false }, notice: "Waiting for the host to confirm that this surface is displayed." },
			{ overrides: { pending: true }, notice: "Waiting for the connection or for the answer to be processed." },
			{ overrides: { presentation: invalidLimit }, notice: "The request cannot be answered because no valid answer size limit was provided." },
		];
		for (const { overrides, notice } of states) {
			const html = render(overrides);
			expect(html).toContain(notice);
			expect(button(html, "Complete answer provided")).toContain('disabled=""');
			expect(button(html, "Send JSON answer")).toContain('disabled=""');
			expect(html.match(/<textarea\b[^>]*>/u)?.[0]).toContain('disabled=""');
			expect(button(html, "Close")).not.toContain('disabled=""');
			expect(html).toContain("Closing requests that the surface be withdrawn; it does not cancel the workflow.");
			expect(html).toContain("Accepting an answer does not mean execution approval or workflow progress.");
		}
		expect(render({ pending: true })).toContain('aria-busy="true"');
		expect(render({ error: "The host rejected the answer." })).toContain('role="alert"');
		expect(render({ error: "The host rejected the answer." })).toContain("The host rejected the answer.");
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
			if (field === "content") value.gate.content.plan = "日".repeat(32_769);
			if (field === "schema") value.gate.schemaJson = "s".repeat(65_537);
			if (field === "artifact") value.gate.artifacts[0]!.path = "p".repeat(1025);
			if (field === "choice") value.gate.choices[0]!.description = "d".repeat(1025);
			if (field === "options") value.gate.optionLabels = Array.from({ length: 65 }, (_, index) => ({ label: `Guide-${index}` }));
			const html = render({ presentation: value });
			expect(html).toContain("It cannot be answered because the complete content is not available.");
			expect(button(html, "Complete answer provided")).toContain('disabled=""');
			if (field === "options") expect(html).not.toContain("Guide-64");
			else expect(html).toContain("content truncated");
			expect(html).not.toContain("日".repeat(32_769));
			expect(html).not.toContain("s".repeat(65_537));
			expect(html).not.toContain("p".repeat(1025));
		}
		const value = presentation();
		value.gate.content.plan = `${"x".repeat(32_767)}😀after`;
		const html = render({ presentation: value });
		expect(html).not.toContain("\uD83D");
		expect(html).not.toContain("😀");
		expect(html).toContain("content truncated");
	});

	test("retiring renders no root, Modal or answer controls even while pending; SSR emits no lifecycle callbacks", () => {
		for (const pending of [false, true]) {
			expect(render({ retiring: { nonce: "exact-retirement-nonce" }, pending })).toBe("");
		}
		// Callbacks throw in these SSR fixtures: rendering visible and retired trees must not call them.
		expect(render({ presented: false })).toContain("Waiting for the host to confirm that this surface is displayed.");
	});
});

describe("desktop gate JSON syntax and UTF-8 validation", () => {
	test("preserves the exact JSON wire text and accepts whole values without guessing schema fields", () => {
		for (const json of [' {"decision":"revise","note":"review 日本語 😀"}\n', "false", "null", "42", '"direct answer"', '["choice", 1]']) {
			const bytes = new TextEncoder().encode(json).byteLength;
			expect(validateGateJsonAnswer(json, bytes)).toEqual({ valid: true, bytes, answer: { kind: "json", json } });
		}
	});

	test("rejects empty, whitespace, malformed, trailing and JavaScript-only input rather than executing or repairing it", () => {
		for (const json of ["", "  \n", "{", '{"a":1,}', '{"a":undefined}', "true false", "NaN", "(() => 1)()", "// comment\n1"]) {
			expect(validateGateJsonAnswer(json, 1024)).toEqual({ valid: false, error: "Enter a valid JSON value." });
		}
	});

	test("measures multibyte UTF-8 at the exact boundary including whitespace and refuses over-limit answers", () => {
		const json = '"日😀"'; // Two quotes + three-byte CJK + four-byte emoji.
		expect(validateGateJsonAnswer(json, 9)).toEqual({ valid: true, bytes: 9, answer: { kind: "json", json } });
		expect(validateGateJsonAnswer(json, 8)).toEqual({ valid: false, error: "The answer must be at most 8 bytes of UTF-8." });
		expect(validateGateJsonAnswer(" true ", 5)).toEqual({ valid: false, error: "The answer must be at most 5 bytes of UTF-8." });
		expect(validateGateJsonAnswer('"abcd"', 5)).toEqual({ valid: false, error: "The answer must be at most 5 bytes of UTF-8." });
	});

	test("refuses missing or unusable wire limits rather than substituting a browser default", () => {
		for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			expect(validateGateJsonAnswer("true", limit)).toEqual({ valid: false, error: "No valid answer size limit was provided." });
		}
	});
});
