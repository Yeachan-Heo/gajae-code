import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@gajae-code/ai";
import { formatSessionDumpText } from "@gajae-code/coding-agent/session/session-dump-format";

const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function assistantWithProxyAsk(): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: zeroUsage,
		stopReason: "toolUse",
		timestamp: 0,
		content: [
			{
				type: "toolCall",
				id: "ask-1",
				name: "proxy_ask",
				arguments: {
					_i: "Deciding guardrail package",
					questions: [
						{
							id: "r6_guardrails",
							question:
								"\\uac8c\\uc774\\ubc0d \\uac00\\ub4dc + \\uce21\\uc815 \\uacbd\\uacc4 \\ud328\\ud0a4\\uc9c0\\ub97c \\uace8\\ub77c\\uc918.",
							options: [
								{ label: "A) \\uad8c\\uc7a5 \\uac00\\ub4dc \\ud328\\ud0a4\\uc9c0 \\uadf8\\ub300\\ub85c" },
							],
							recommended: 0,
							deepInterview: {
								round: 6,
								component: "scoring-model",
								dimension: "constraints",
								ambiguity: 0.41,
							},
						},
					],
				},
			},
		],
	};
}

describe("formatSessionDumpText tool calls", () => {
	it("renders structured ask payloads readably when question text contains escaped Korean", () => {
		const dumped = formatSessionDumpText({
			messages: [assistantWithProxyAsk()],
			model: null,
			thinkingLevel: null,
		});

		expect(dumped).toContain('<invoke name="proxy_ask">');
		expect(dumped).toContain('<parameter name="questions">');
		expect(dumped).toContain("게이밍 가드 + 측정 경계 패키지를 골라줘.");
		expect(dumped).toContain("A) 권장 가드 패키지 그대로");
		expect(dumped).not.toContain("\\uac8c");
		expect(dumped).toContain('"deepInterview": {\n');
	});

	it("keeps escaped control and surrogate codes structural instead of injecting raw control text", () => {
		const dumped = formatSessionDumpText({
			messages: [
				{
					...assistantWithProxyAsk(),
					content: [
						{
							type: "toolCall",
							id: "ask-2",
							name: "proxy_ask",
							arguments: {
								note: "literal control marker: \\u000a, c1 marker: \\u0085, surrogate marker: \\ud800",
							},
						},
					],
				},
			],
			model: null,
			thinkingLevel: null,
		});

		expect(dumped).toContain("literal control marker: \\u000a");
		expect(dumped).toContain("c1 marker: \\u0085");
		expect(dumped).toContain("surrogate marker: \\ud800");
	});

	it("applies XML escaping after decoding readable Unicode escapes", () => {
		const dumped = formatSessionDumpText({
			messages: [
				{
					...assistantWithProxyAsk(),
					content: [
						{
							type: "toolCall",
							id: "ask-3",
							name: "proxy_ask",
							arguments: {
								"unsafe<key": "readable Korean: \\ud55c\\uae00 & raw <tag>",
							},
						},
					],
				},
			],
			model: null,
			thinkingLevel: null,
		});

		expect(dumped).toContain('name="unsafe&lt;key"');
		expect(dumped).toContain("readable Korean: 한글 &amp; raw &lt;tag&gt;");
		expect(dumped).not.toContain("\\ud55c");
	});
});
