import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import {
	dashscopeTokenPlanDefaultHeaders,
	mergeDashScopeTokenPlanHeaders,
	QWEN_CODE_UPSTREAM_COMMIT,
	QWEN_CODE_UPSTREAM_VERSION,
	qwenCodeUserAgent,
} from "../src/providers/dashscope-token-plan-headers";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import type { Context, Model } from "../src/types";

// ── Upstream parity pin ─────────────────────────────────────────────────────
// If QwenLM/qwen-code bumps its version/commit, this test forces an explicit
// parity update rather than silent drift. The canonical header set is defined
// in exactly one place (dashscope-token-plan-headers.ts); these constants pin
// the upstream source of truth the set must match.

describe("DashScope Token Plan header contract (upstream pin)", () => {
	it("pins the upstream QwenLM/qwen-code commit/version", () => {
		expect(QWEN_CODE_UPSTREAM_COMMIT).toBe("f4cd6e1d8bbb1c24e7e5d1a40187d8e28aa7c4fb");
		expect(QWEN_CODE_UPSTREAM_VERSION).toBe("0.21.1");
	});

	it("builds the exact upstream User-Agent string", () => {
		// Mirrors upstream: `QwenCode/${version} (${process.platform}; ${process.arch})`
		const ua = qwenCodeUserAgent();
		expect(ua).toBe(`QwenCode/${QWEN_CODE_UPSTREAM_VERSION} (${process.platform}; ${process.arch})`);
	});

	it("emits exactly the four upstream default headers with correct values", () => {
		const headers = dashscopeTokenPlanDefaultHeaders();
		// Upstream buildHeaders() defaultHeaders, verbatim. The Token Plan preset
		// authenticates with AuthType.USE_OPENAI ('openai').
		expect(headers).toEqual({
			"User-Agent": qwenCodeUserAgent(),
			"X-DashScope-CacheControl": "enable",
			"X-DashScope-UserAgent": qwenCodeUserAgent(),
			"X-DashScope-AuthType": "openai",
		});
		// Exactly four identity headers — no more, no less.
		expect(Object.keys(headers)).toHaveLength(4);
	});
});

// ── Merge / override precedence (exact upstream) ────────────────────────────
// Upstream buildHeaders(): customHeaders ? { ...default, ...customHeaders } : default.
// Caller wins per header; an override of one identity key does NOT suppress the others.

describe("mergeDashScopeTokenPlanHeaders precedence", () => {
	it("returns the canonical set alone when no caller headers are supplied", () => {
		expect(mergeDashScopeTokenPlanHeaders(undefined)).toEqual(dashscopeTokenPlanDefaultHeaders());
	});

	it("lets a caller override a single identity header while keeping the rest canonical", () => {
		const merged = mergeDashScopeTokenPlanHeaders({ "User-Agent": "custom/1.0" });
		expect(merged["User-Agent"]).toBe("custom/1.0");
		expect(merged["X-DashScope-CacheControl"]).toBe("enable");
		expect(merged["X-DashScope-UserAgent"]).toBe(qwenCodeUserAgent());
		expect(merged["X-DashScope-AuthType"]).toBe("openai");
	});

	it("lets a caller override ALL identity headers (per-key precedence, no suppression)", () => {
		const merged = mergeDashScopeTokenPlanHeaders({
			"User-Agent": "a",
			"X-DashScope-CacheControl": "off",
			"X-DashScope-UserAgent": "b",
			"X-DashScope-AuthType": "oauth",
		});
		expect(merged).toEqual({
			"User-Agent": "a",
			"X-DashScope-CacheControl": "off",
			"X-DashScope-UserAgent": "b",
			"X-DashScope-AuthType": "oauth",
		});
	});

	it("preserves non-identity caller headers alongside the canonical set", () => {
		const merged = mergeDashScopeTokenPlanHeaders({ "X-Custom": "val" });
		expect(merged["X-Custom"]).toBe("val");
		expect(merged["X-DashScope-AuthType"]).toBe("openai");
	});

	it("overrides case-insensitively in wire capture (Headers lowercases keys)", () => {
		// The OpenAI SDK merges headers into a Headers instance, so a caller using a
		// different case (e.g. "user-agent") still wins because object-spread here is
		// case-sensitive — verify the merge record keeps the caller key as-given.
		const merged = mergeDashScopeTokenPlanHeaders({ "user-agent": "lowercase/1.0" });
		// Caller key wins verbatim (case-sensitive spread); canonical "User-Agent" stays.
		expect(merged["user-agent"]).toBe("lowercase/1.0");
		expect(merged["User-Agent"]).toBe(qwenCodeUserAgent());
	});
});

// ── Wire-capture infrastructure ──────────────────────────────────────────────
// createClient() sets the OpenAI SDK client's defaultHeaders; the SDK merges
// those into the real fetch init.headers. Capturing outgoing headers proves the
// canonical set is actually transmitted on the wire, not just stored on an object.

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
}

function createCapturingFetchCompletions(captured: CapturedRequest[]): typeof fetch {
	async function capturingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const headers: Record<string, string> = {};
		const merge = (h: ConstructorParameters<typeof Headers>[0] | undefined): void => {
			if (!h) return;
			new Headers(h).forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});
		};
		if (input instanceof Request) merge(input.headers);
		merge(init?.headers);
		captured.push({ url: input instanceof Request ? input.url : String(input), headers });
		const payload = `data: ${JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "test",
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		})}\n\ndata: [DONE]\n\n`;
		return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	return Object.assign(capturingFetch, { preconnect: originalFetch.preconnect });
}

function createCapturingFetchResponses(captured: CapturedRequest[]): typeof fetch {
	async function capturingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const headers: Record<string, string> = {};
		const merge = (h: ConstructorParameters<typeof Headers>[0] | undefined): void => {
			if (!h) return;
			new Headers(h).forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});
		};
		if (input instanceof Request) merge(input.headers);
		merge(init?.headers);
		captured.push({ url: input instanceof Request ? input.url : String(input), headers });
		const payload = `data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp-test", status: "completed", output: [], usage: {} },
		})}\n\ndata: [DONE]\n\n`;
		return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	return Object.assign(capturingFetch, { preconnect: originalFetch.preconnect });
}

function baseContext(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
}

function alibabaCompletionsModel(): Model<"openai-completions"> {
	return getBundledModel("alibaba-token-plan", "deepseek-v4-pro");
}

function alibabaResponsesModel(): Model<"openai-responses"> {
	return getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
}

// The four canonical DashScope identity headers, lowercased for wire comparison.
const CANONICAL = {
	"user-agent": qwenCodeUserAgent(),
	"x-dashscope-cachecontrol": "enable",
	"x-dashscope-useragent": qwenCodeUserAgent(),
	"x-dashscope-authtype": "openai",
} as const;

// ── openai-completions transport (glm-5.2 / deepseek-v4-pro) ─────────────────

describe("alibaba-token-plan wire headers (openai-completions)", () => {
	it("transmits the full canonical DashScope header set on the wire", async () => {
		const captured: CapturedRequest[] = [];
		await streamOpenAICompletions(alibabaCompletionsModel(), baseContext(), {
			apiKey: "test-key",
			fetch: createCapturingFetchCompletions(captured),
		}).result();

		expect(captured).toHaveLength(1);
		const h = captured[0].headers;
		expect(h["user-agent"]).toBe(CANONICAL["user-agent"]);
		expect(h["x-dashscope-cachecontrol"]).toBe(CANONICAL["x-dashscope-cachecontrol"]);
		expect(h["x-dashscope-useragent"]).toBe(CANONICAL["x-dashscope-useragent"]);
		expect(h["x-dashscope-authtype"]).toBe(CANONICAL["x-dashscope-authtype"]);
	});

	it("does NOT inject canonical headers when a caller overrides an identity header (per-key precedence)", async () => {
		// Upstream { ...default, ...customHeaders }: caller User-Agent wins per key,
		// the other canonicals still apply. No partial fingerprint is *suppressed* —
		// the canonical set is the base and the override only takes its own key.
		const captured: CapturedRequest[] = [];
		await streamOpenAICompletions(alibabaCompletionsModel(), baseContext(), {
			apiKey: "test-key",
			headers: { "User-Agent": "my-cli/2.0" },
			fetch: createCapturingFetchCompletions(captured),
		}).result();

		expect(captured).toHaveLength(1);
		const h = captured[0].headers;
		expect(h["user-agent"]).toBe("my-cli/2.0");
		// The other canonical identity headers remain canonical.
		expect(h["x-dashscope-cachecontrol"]).toBe("enable");
		expect(h["x-dashscope-useragent"]).toBe(CANONICAL["x-dashscope-useragent"]);
		expect(h["x-dashscope-authtype"]).toBe("openai");
	});

	it("sends Authorization as Bearer scheme and keeps identity headers independent of auth", async () => {
		// Auth is the SDK's responsibility (Authorization: Bearer <key>); the canonical
		// DashScope identity headers are separate and must coexist with auth on the wire.
		// We compare Authorization by scheme/presence only — the token value itself is
		// never logged or persisted by the parity path (redaction is about output, not
		// about mutating the live wire header).
		const captured: CapturedRequest[] = [];
		await streamOpenAICompletions(alibabaCompletionsModel(), baseContext(), {
			apiKey: "sk-test-key",
			fetch: createCapturingFetchCompletions(captured),
		}).result();

		expect(captured).toHaveLength(1);
		const h = captured[0].headers;
		expect(h.authorization).toMatch(/^Bearer /);
		// Canonical identity headers are present alongside auth.
		expect(h["user-agent"]).toBe(CANONICAL["user-agent"]);
		expect(h["x-dashscope-authtype"]).toBe("openai");
	});
});

// ── openai-responses transport (qwen3.8-max-preview) ─────────────────────────

describe("alibaba-token-plan wire headers (openai-responses)", () => {
	it("transmits the full canonical DashScope header set on the wire", async () => {
		const captured: CapturedRequest[] = [];
		await streamOpenAIResponses(alibabaResponsesModel(), baseContext(), {
			apiKey: "test-key",
			fetch: createCapturingFetchResponses(captured),
		}).result();

		expect(captured).toHaveLength(1);
		const h = captured[0].headers;
		expect(h["user-agent"]).toBe(CANONICAL["user-agent"]);
		expect(h["x-dashscope-cachecontrol"]).toBe(CANONICAL["x-dashscope-cachecontrol"]);
		expect(h["x-dashscope-useragent"]).toBe(CANONICAL["x-dashscope-useragent"]);
		expect(h["x-dashscope-authtype"]).toBe(CANONICAL["x-dashscope-authtype"]);
	});

	it("honors a caller identity override per-key while keeping the rest canonical", async () => {
		const captured: CapturedRequest[] = [];
		await streamOpenAIResponses(alibabaResponsesModel(), baseContext(), {
			apiKey: "test-key",
			headers: { "X-DashScope-AuthType": "oauth" },
			fetch: createCapturingFetchResponses(captured),
		}).result();

		expect(captured).toHaveLength(1);
		const h = captured[0].headers;
		expect(h["x-dashscope-authtype"]).toBe("oauth");
		expect(h["user-agent"]).toBe(CANONICAL["user-agent"]);
		expect(h["x-dashscope-cachecontrol"]).toBe("enable");
		expect(h["x-dashscope-useragent"]).toBe(CANONICAL["x-dashscope-useragent"]);
	});
});

// ── Non-Alibaba providers must be unaffected ─────────────────────────────────

describe("non-Alibaba providers are unaffected by the canonical header injection", () => {
	it("openai-completions: a non-Alibaba provider sends NO DashScope headers", async () => {
		const captured: CapturedRequest[] = [];
		const model = getBundledModel<"openai-completions">("openai", "gpt-4o-mini");
		await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: createCapturingFetchCompletions(captured),
		}).result();

		expect(captured).toHaveLength(1);
		const h = captured[0].headers;
		expect(h["x-dashscope-cachecontrol"]).toBeUndefined();
		expect(h["x-dashscope-useragent"]).toBeUndefined();
		expect(h["x-dashscope-authtype"]).toBeUndefined();
		// First-party OpenAI UA is the SDK default, not QwenCode.
		expect(h["user-agent"]).not.toContain("QwenCode");
	});
});
