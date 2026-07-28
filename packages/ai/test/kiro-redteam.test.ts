import { describe, expect, test } from "bun:test";
import { $env } from "@gajae-code/utils";
import {
	buildKiroRequest,
	KIRO_OPTOUT_HEADER,
	kiroOptoutHeader,
	resetKiroProfileArnCache,
	resolveKiroProfileArn,
} from "../src/providers/kiro";
import type { Model } from "../src/types";
import { fetchKiroModels } from "../src/utils/discovery/kiro";
import { redactedHttpErrorSummary } from "../src/utils/http-error-redaction";

const model: Model<"kiro-streaming"> = {
	id: "claude-haiku-4.5",
	name: "claude-haiku-4.5",
	api: "kiro-streaming",
	provider: "kiro",
	baseUrl: "https://runtime.us-east-1.kiro.dev/",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

describe("Kiro HTTP error summaries", () => {
	const hostileBodies = [
		["an ARN in __type", JSON.stringify({ __type: "arn:aws:iam::123456789012:role/Secret" })],
		["CRLF and ANSI in __type", JSON.stringify({ __type: "Fault\r\n\x1b[31mred\x1b[0m" })],
		["HTML", "<html><body>account 123456789012</body></html>"],
		["malformed JSON", '{"__type":'],
		["a huge body", "X".repeat(250_000)],
	] as const;

	for (const [name, body] of hostileBodies) {
		test(`returns only the status without consuming ${name}`, () => {
			const response = new Response(body, { status: 403 });

			expect(redactedHttpErrorSummary(response)).toBe("HTTP 403");
			expect(response.bodyUsed).toBe(false);
		});
	}
});

describe("Kiro data-collection opt-out", () => {
	test("applies a supplied value to profile resolution and discovery", async () => {
		resetKiroProfileArnCache();
		const previous = $env.GJC_KIRO_CODEWHISPERER_OPTOUT;
		$env.GJC_KIRO_CODEWHISPERER_OPTOUT = "true";
		try {
			const profileRequests: Request[] = [];
			const profileFetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				profileRequests.push(
					input instanceof Request ? new Request(input, init) : new Request(input.toString(), init),
				);
				return Response.json({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:1:profile/P" }] });
			};
			await resolveKiroProfileArn("tok-optout-profile", profileFetcher);
			expect(profileRequests[0]?.headers.get(KIRO_OPTOUT_HEADER)).toBe("true");

			const discoveryRequests: Request[] = [];
			const discoveryFetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				discoveryRequests.push(
					input instanceof Request ? new Request(input, init) : new Request(input.toString(), init),
				);
				return Response.json({ models: [] });
			};
			await fetchKiroModels({
				accessToken: "tok-optout-discovery",
				profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P",
				fetcher: discoveryFetcher,
			});
			expect(discoveryRequests[0]?.headers.get(KIRO_OPTOUT_HEADER)).toBe("true");
		} finally {
			if (previous === undefined) delete $env.GJC_KIRO_CODEWHISPERER_OPTOUT;
			else $env.GJC_KIRO_CODEWHISPERER_OPTOUT = previous;
		}
	});

	for (const value of ["", "   "]) {
		test(`omits the opt-out header for ${JSON.stringify(value)}`, () => {
			const previous = $env.GJC_KIRO_CODEWHISPERER_OPTOUT;
			$env.GJC_KIRO_CODEWHISPERER_OPTOUT = value;
			try {
				expect(kiroOptoutHeader()).toEqual({});
			} finally {
				if (previous === undefined) delete $env.GJC_KIRO_CODEWHISPERER_OPTOUT;
				else $env.GJC_KIRO_CODEWHISPERER_OPTOUT = previous;
			}
		});
	}
});

describe("Kiro image boundaries", () => {
	test("rejects an image in a tool result", () => {
		const context = {
			messages: [
				{ role: "user" as const, content: "use the tool", timestamp: 1 },
				{
					role: "assistant" as const,
					api: "kiro-streaming" as const,
					provider: "kiro" as const,
					model: model.id,
					content: [{ type: "toolCall" as const, id: "call1", name: "capture_screen", arguments: {} }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse" as const,
					timestamp: 2,
				},
				{
					role: "toolResult" as const,
					toolCallId: "call1",
					toolName: "capture_screen",
					content: [{ type: "image" as const, data: "AAAA", mimeType: "image/jpeg" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		expect(() => buildKiroRequest(model, context, "arn:aws:codewhisperer:us-east-1:1:profile/P")).toThrow(
			/image\/jpeg/,
		);
	});

	test("rejects an image in message history", () => {
		const context = {
			messages: [
				{
					role: "user" as const,
					content: [{ type: "image" as const, data: "AAAA", mimeType: "image/webp" }],
					timestamp: 1,
				},
				{ role: "user" as const, content: "second, now last", timestamp: 2 },
			],
		};
		expect(() => buildKiroRequest(model, context, "arn:aws:codewhisperer:us-east-1:1:profile/P")).toThrow(
			/image\/webp/,
		);
	});

	test("discovery reports text-only input despite an IMAGE advertisement", async () => {
		const fetcher = async (): Promise<Response> =>
			Response.json({
				models: [
					{
						modelId: "adversarial-model",
						modelName: "Adversarial",
						supportedInputTypes: ["TEXT", "IMAGE"],
						tokenLimits: { maxInputTokens: 1000, maxOutputTokens: 500 },
					},
				],
			});
		const models = await fetchKiroModels({
			accessToken: "tok",
			profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P",
			fetcher,
		});
		expect(models?.[0]?.input).toEqual(["text"]);
	});
});

describe("Kiro profile ARN cache", () => {
	test("evicts the oldest entry after eight unique tokens", async () => {
		resetKiroProfileArnCache();
		let calls = 0;
		const fetcher = async (): Promise<Response> => {
			calls += 1;
			return Response.json({ profiles: [{ arn: `arn:aws:codewhisperer:us-east-1:1:profile/${calls}` }] });
		};

		for (let i = 0; i < 9; i++) {
			await resolveKiroProfileArn(`tok-${i}`, fetcher);
		}
		expect(calls).toBe(9);

		await resolveKiroProfileArn("tok-0", fetcher);
		expect(calls).toBe(10);
	});
});
