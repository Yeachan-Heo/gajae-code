import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Model, ToolCall } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai";
import {
	createHarmonyAuditEvent,
	detectHarmonyLeak,
	detectHarmonyLeakInAssistantMessage,
	extractHarmonyRemoved,
	isHarmonyLeakMitigationTarget,
	recoverHarmonyToolCall,
	shouldMitigateHarmonyLeak,
	signalListLabel,
} from "../src/harmony-leak";
import corpus from "./fixtures/harmony-leak-corpus.json" with { type: "json" };
import { createAssistantMessage } from "./helpers";

interface CorpusPositive {
	id: string;
	kind: "edit_dsl" | "edit_json" | "eval";
	expectation: "recover" | "abort";
	input: string | null;
	argJson: string | null;
}
interface CorpusNegative {
	name: string;
	input: string;
}
const positives = corpus.positives as CorpusPositive[];
const negatives = corpus.negatives as CorpusNegative[];

const codexModel: Model = getBundledModel("openai-codex", "gpt-5.4");
const anthropicModel: Model = getBundledModel("anthropic", "claude-sonnet-4-5");

function makeToolCallMessage(toolName: string, input: string | null, argJson: string | null): AssistantMessage {
	const callArgs: Record<string, unknown> =
		input !== null ? { input } : argJson !== null ? (JSON.parse(argJson) as Record<string, unknown>) : {};
	const toolCall: ToolCall = {
		type: "toolCall",
		id: "call_test",
		name: toolName,
		arguments: callArgs,
	};
	return createAssistantMessage([toolCall], "toolUse");
}

describe("isHarmonyLeakMitigationTarget", () => {
	it("targets every openai-codex model (don't enumerate ids)", () => {
		expect(isHarmonyLeakMitigationTarget(codexModel)).toBe(true);
	});

	it("does not target Anthropic models", () => {
		expect(isHarmonyLeakMitigationTarget(anthropicModel)).toBe(false);
	});
});

describe("shouldMitigateHarmonyLeak", () => {
	it("mitigates provider-neutral invoke envelope leaks for Anthropic models", () => {
		const detection = detectHarmonyLeak(
			[
				"call",
				'<invoke name="web_search">',
				'<parameter name="query">portfolio copywriting examples</parameter>',
				"</invoke>",
			].join("\n"),
			"assistant_text",
		);

		expect(detection).toBeDefined();
		expect(shouldMitigateHarmonyLeak(anthropicModel, detection!)).toBe(true);
	});

	it("does not broaden codex harmony-header mitigation to Anthropic models", () => {
		const detection = detectHarmonyLeak("analysis to=functions.read code {}", "assistant_text");

		expect(detection).toBeDefined();
		expect(shouldMitigateHarmonyLeak(anthropicModel, detection!)).toBe(false);
	});
});

describe("detectHarmonyLeak — negative cases (must NOT trip)", () => {
	for (const neg of negatives) {
		it(neg.name, () => {
			const detection = detectHarmonyLeak(neg.input, "tool_arg");
			expect(detection).toBeUndefined();
		});
	}

	it("user prose mentioning marker is not scanned (caller responsibility)", () => {
		// Sanity: detector itself fires on bare M only when paired with co-signals.
		// User-message exemption is enforced by the call site, not the detector.
		const harmless = "I read about to=functions.edit in the docs.";
		expect(detectHarmonyLeak(harmless, "assistant_text")).toBeUndefined();
	});

	it("streaming chunk-boundary split does not trip on partial marker", () => {
		// Detector only fires once the full marker resolves in the buffer.
		expect(detectHarmonyLeak("...to=funct", "tool_arg")).toBeUndefined();
		expect(detectHarmonyLeak("...to=functions.", "tool_arg")).toBeUndefined();
	});

	it("does not treat normal Korean prose as a leak", () => {
		const korean = "추천 내용 이해 자체가 어렵네요. 다음 질문은 제약 조건을 명확히 합니다.";
		expect(detectHarmonyLeak(korean, "assistant_text")).toBeUndefined();
	});
});

describe("detectHarmonyLeak — positive corpus cases (must trip with co-signal)", () => {
	for (const pos of positives) {
		const surfaceText = pos.input ?? pos.argJson;
		if (surfaceText === null) continue;
		it(`${pos.id} (${pos.kind}) trips with co-signals`, () => {
			const detection = detectHarmonyLeak(surfaceText, "tool_arg", {
				toolName: pos.kind === "eval" ? "eval" : "edit",
			});
			expect(detection).toBeDefined();
			// Every signal that did fire must include `M` plus at least one co-signal.
			for (const signal of detection!.signals) {
				expect(signal.classes.length).toBeGreaterThanOrEqual(2);
				expect(signal.classes).toContain("M");
			}
		});
	}

	it("trips script-mismatch recovery for Korean-adjacent leaked tool markers", () => {
		const cases = [
			{ name: "Hangul syllables", text: "추천 내용" },
			{ name: "Hangul Jamo", text: "한글" },
			{ name: "Hangul compatibility Jamo", text: "ㅎㅏㄴㄱㅡㄹ" },
		];

		for (const { name, text } of cases) {
			const leaked = `${"ascii context ".repeat(20)}${text} to=functions.edit code \\ubcdef`;
			const detection = detectHarmonyLeak(leaked, "assistant_text");

			expect(detection, name).toBeDefined();
			expect(signalListLabel(detection!.signals), name).toContain("S");
		}
	});
});

describe("recoverHarmonyToolCall — edit DSL", () => {
	const editDsl = positives.filter(p => p.kind === "edit_dsl");
	for (const fix of editDsl) {
		it(`${fix.id}: produces an args-truncated message ending with the *** Abort sentinel`, () => {
			const message = makeToolCallMessage("edit", fix.input, fix.argJson);
			const detection = detectHarmonyLeakInAssistantMessage(message);
			expect(detection).toBeDefined();
			const recovered = recoverHarmonyToolCall(message, detection!);
			expect(recovered).toBeDefined();

			const recoveredCall = recovered!.message.content[0];
			expect(recoveredCall.type).toBe("toolCall");
			if (recoveredCall.type !== "toolCall") return; // narrow

			const cleanInput = recoveredCall.arguments.input;
			expect(typeof cleanInput).toBe("string");
			expect(cleanInput as string).toMatch(/\n\*\*\* Abort\n$/);
			// The cleaned input is a strict prefix of the original (plus the sentinel).
			expect((cleanInput as string).length).toBeLessThan(fix.input!.length + 16);
			expect((cleanInput as string).includes("to=functions.")).toBe(false);

			// Encrypted reasoning blob is dropped (we cannot validate it isn't contaminated).
			expect(recovered!.message.providerPayload).toBeUndefined();

			// Removed substring is non-empty and contains the marker we cut.
			expect(recovered!.removed.length).toBeGreaterThan(0);
			expect(recovered!.removed.includes("to=functions.")).toBe(true);
		});
	}

	it("idempotence: re-running detect+recover on the cleaned message is a no-op", () => {
		const fix = editDsl[0];
		const message = makeToolCallMessage("edit", fix.input, fix.argJson);
		const detection = detectHarmonyLeakInAssistantMessage(message)!;
		const recovered = recoverHarmonyToolCall(message, detection)!;
		const second = detectHarmonyLeakInAssistantMessage(recovered.message);
		expect(second).toBeUndefined();
	});

	it("rejects edit input that doesn't look like the patch DSL", () => {
		// Apply_patch envelope shape — its parser doesn't recognize *** Abort,
		// so we fall through to abort-and-retry rather than recover.
		const applyPatchInput =
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch\n analysis to=functions.edit code 大发官网";
		const message = makeToolCallMessage("edit", applyPatchInput, null);
		const detection = detectHarmonyLeakInAssistantMessage(message)!;
		expect(detection).toBeDefined();
		const recovered = recoverHarmonyToolCall(message, detection);
		expect(recovered).toBeUndefined();
	});
});

describe("recoverHarmonyToolCall — edit JSON-schema (must NOT recover)", () => {
	for (const fix of positives.filter(p => p.kind === "edit_json")) {
		it(`${fix.id}: detects but refuses to recover`, () => {
			const message = makeToolCallMessage("edit", fix.input, fix.argJson);
			const detection = detectHarmonyLeakInAssistantMessage(message);
			expect(detection).toBeDefined();
			const recovered = recoverHarmonyToolCall(message, detection!);
			// argJson cases either lack a string `input` field, or their `input`
			// doesn't start with `@<path>` — both go to abort-and-retry.
			expect(recovered).toBeUndefined();
		});
	}
});

describe("recoverHarmonyToolCall — eval", () => {
	for (const fix of positives.filter(p => p.kind === "eval")) {
		it(`${fix.id}: cleaned input ends with *** Abort sentinel`, () => {
			const message = makeToolCallMessage("eval", fix.input, fix.argJson);
			const detection = detectHarmonyLeakInAssistantMessage(message);
			expect(detection).toBeDefined();
			const recovered = recoverHarmonyToolCall(message, detection!);
			expect(recovered).toBeDefined();
			const block = recovered!.message.content[0];
			if (block.type !== "toolCall") throw new Error("expected toolCall");
			const cleanInput = block.arguments.input;
			expect(typeof cleanInput).toBe("string");
			expect(cleanInput as string).toMatch(/\n\*\*\* Abort\n$/);
			expect((cleanInput as string).includes("to=functions.")).toBe(false);
		});
	}
});

describe("recoverHarmonyToolCall — unsupported tools", () => {
	it("returns undefined for tools not in the recovery registry", () => {
		const text =
			'{"path":"src/foo.ts","sel":"raw"}' /* legitimate-looking */ +
			" \tchangedFiles to=functions.read code  天天中彩票";
		const message = makeToolCallMessage("read", text, null);
		const detection = detectHarmonyLeakInAssistantMessage(message);
		// Detector trips because of `G` (changedFiles) + `M`.
		expect(detection).toBeDefined();
		// But `read` is not in RECOVERY_REGISTRY, so no recovery offered.
		const recovered = recoverHarmonyToolCall(message, detection!);
		expect(recovered).toBeUndefined();
	});
});

describe("extractHarmonyRemoved", () => {
	it("returns the contaminated tail of a tool argument", () => {
		const fix = positives.filter(p => p.kind === "edit_json")[0];
		const message = makeToolCallMessage("edit", fix.input, fix.argJson);
		const detection = detectHarmonyLeakInAssistantMessage(message)!;
		const removed = extractHarmonyRemoved(message, detection);
		expect(removed.length).toBeGreaterThan(0);
		expect(removed.startsWith("to=functions.")).toBe(true);
	});

	it("returns the contaminated tail of an assistant text block", () => {
		const text = "Some prose. analysis to=functions.edit code 大发官网";
		const message = createAssistantMessage([{ type: "text", text }], "stop");
		const detection = detectHarmonyLeakInAssistantMessage(message)!;
		const removed = extractHarmonyRemoved(message, detection);
		expect(removed.length).toBeGreaterThan(0);
		expect(removed.includes("to=functions.")).toBe(true);
	});
});

describe("createHarmonyAuditEvent", () => {
	it("captures sha + redacted preview by default; raw blob hidden", () => {
		const fix = positives.filter(p => p.kind === "edit_dsl")[0];
		const message = makeToolCallMessage("edit", fix.input, fix.argJson);
		const detection = detectHarmonyLeakInAssistantMessage(message)!;
		const recovered = recoverHarmonyToolCall(message, detection)!;
		const event = createHarmonyAuditEvent({
			action: "truncate_resume",
			detection,
			model: codexModel,
			retryN: 0,
			removed: recovered.removed,
		});
		expect(event.removedLen).toBe(recovered.removed.length);
		expect(event.removedSha8).toMatch(/^[0-9a-f]{8}$/);
		// Default: no raw blob.
		expect(event.removedBlob).toBeUndefined();
		// Preview is non-empty and obeys the junk-only redaction (every
		// non-junk char becomes `·`; marker tokens are kept verbatim).
		expect(event.removedPreview.length).toBeGreaterThan(0);
		expect(event.signal).toBe(signalListLabel(detection.signals));
	});
});

describe("detectHarmonyLeak — leaked <invoke> envelope dialect (I)", () => {
	const leakedAsk = [
		"court",
		'<invoke name="proxy_ask">',
		'<parameter name="_i">Round 11 self-ref exclusion detail</parameter>',
		'<parameter name="questions">[{"id":"r11"}]</parameter>',
		"</invoke>",
	].join("\n");

	it("trips on a leaked tool-call envelope in assistant text (no co-signal needed)", () => {
		const detection = detectHarmonyLeak(leakedAsk, "assistant_text");
		expect(detection).toBeDefined();
		expect(signalListLabel(detection!.signals)).toContain("I");
	});

	it("trips with zero non-Latin content (the leak is not a Korean/script issue)", () => {
		const asciiLeak = '<invoke name="proxy_read">\n<parameter name="path">src/x.ts</parameter>\n</invoke>';
		const detection = detectHarmonyLeak(asciiLeak, "assistant_text");
		expect(detection).toBeDefined();
		expect(signalListLabel(detection!.signals)).toContain("I");
	});

	it("trips on the thinking surface too", () => {
		expect(detectHarmonyLeak(leakedAsk, "assistant_thinking")).toBeDefined();
	});

	it("detects via detectHarmonyLeakInAssistantMessage; text-surface leak is not recoverable", () => {
		const message = createAssistantMessage([{ type: "text", text: `ok\n\n${leakedAsk}` }], "stop");
		const detection = detectHarmonyLeakInAssistantMessage(message);
		expect(detection).toBeDefined();
		expect(detection!.surface).toBe("assistant_text");
		expect(recoverHarmonyToolCall(message, detection!)).toBeUndefined();
	});

	it("does NOT trip on an invoke example inside a fenced code block", () => {
		const fenced = [
			"Here is the wire format:",
			"```xml",
			'<invoke name="ask">',
			'<parameter name="x">1</parameter>',
			"</invoke>",
			"```",
		].join("\n");
		expect(detectHarmonyLeak(fenced, "assistant_text")).toBeUndefined();
	});

	it("does NOT trip on prose that mentions the opening tag without a committed body", () => {
		const prose =
			'The model sometimes prints a bare <invoke name="ask"> and then ordinary prose continues right here with no parameter or closing tag whatsoever.';
		expect(detectHarmonyLeak(prose, "assistant_text")).toBeUndefined();
	});

	it("does not treat normal Korean prose (even containing the word court) as a leak", () => {
		const korean = "법원 판결문을 읽고 다음 단계를 정합니다. court 같은 단어가 나와도 문제 없어야 한다.";
		expect(detectHarmonyLeak(korean, "assistant_text")).toBeUndefined();
	});
});
