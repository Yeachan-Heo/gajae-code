import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { detectOpenAICompat, resolveOpenAICompat } from "../src/providers/openai-completions-compat";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

// ── Wire-capture fetch ───────────────────────────────────────────────────────
// The session-header injection lives in createClient(), which sets the OpenAI
// SDK client's `defaultHeaders`. The SDK then merges those into the real fetch
// `init.headers`. Capturing the outgoing headers here therefore proves the
// header is actually transmitted on the wire, not just stored on an object.

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
}

function createCapturingFetch(captured: CapturedRequest[]): typeof fetch {
	async function capturingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const headers: Record<string, string> = {};
		// Headers can arrive as a Headers instance, a plain record, or on a Request.
		const merge = (h: ConstructorParameters<typeof Headers>[0] | undefined): void => {
			if (!h) return;
			new Headers(h).forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});
		};
		if (input instanceof Request) merge(input.headers);
		merge(init?.headers);
		captured.push({
			url: input instanceof Request ? input.url : String(input),
			headers,
		});
		const payload = `data: ${JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "claude-opus-4-8",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\ndata: [DONE]\n\n`;
		return new Response(payload, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return Object.assign(capturingFetch, { preconnect: originalFetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	};
}

// A custom OpenAI-compatible relay model (NOT first-party OpenAI).
function relayModel(compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		provider: "relay",
		id: "claude-opus-4-8",
		api: "openai-completions",
		baseUrl: "https://api.relay.example.com/v1",
		...(compat ? { compat } : {}),
	};
}

// ── compat resolution ────────────────────────────────────────────────────────

describe("sendSessionHeaders compat resolution", () => {
	it("defaults to false for a custom relay base URL", () => {
		const detected = detectOpenAICompat(relayModel());
		expect(detected.sendSessionHeaders).toBe(false);
	});

	it("defaults to false for first-party OpenAI", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		expect(detectOpenAICompat(model).sendSessionHeaders).toBe(false);
	});

	it("is enabled when models.yml compat opts in", () => {
		const resolved = resolveOpenAICompat(relayModel({ sendSessionHeaders: true }));
		expect(resolved.sendSessionHeaders).toBe(true);
	});

	it("stays false when compat is present but omits the flag", () => {
		const resolved = resolveOpenAICompat(relayModel({ supportsDeveloperRole: false }));
		expect(resolved.sendSessionHeaders).toBe(false);
	});
});

// ── end-to-end wire transmission ─────────────────────────────────────────────

describe("session headers on the wire (streamOpenAICompletions)", () => {
	it("transmits session_id + x-session-id when flag is ON and sessionId is present", async () => {
		const captured: CapturedRequest[] = [];
		await streamOpenAICompletions(relayModel({ sendSessionHeaders: true }), baseContext(), {
			apiKey: "test-key",
			sessionId: "conv-abc-123",
			fetch: createCapturingFetch(captured),
		}).result();

		expect(captured).toHaveLength(1);
		expect(captured[0].headers.session_id).toBe("conv-abc-123");
		expect(captured[0].headers["x-session-id"]).toBe("conv-abc-123");
	});

	it("omits session headers when flag is OFF (default behavior unchanged)", async () => {
		const captured: CapturedRequest[] = [];
		await streamOpenAICompletions(relayModel(), baseContext(), {
			apiKey: "test-key",
			sessionId: "conv-abc-123",
			fetch: createCapturingFetch(captured),
		}).result();

		expect(captured).toHaveLength(1);
		expect(captured[0].headers.session_id).toBeUndefined();
		expect(captured[0].headers["x-session-id"]).toBeUndefined();
	});

	it("omits session headers when flag is ON but sessionId is empty", async () => {
		const captured: CapturedRequest[] = [];
		await streamOpenAICompletions(relayModel({ sendSessionHeaders: true }), baseContext(), {
			apiKey: "test-key",
			sessionId: "",
			fetch: createCapturingFetch(captured),
		}).result();

		expect(captured).toHaveLength(1);
		expect(captured[0].headers.session_id).toBeUndefined();
		expect(captured[0].headers["x-session-id"]).toBeUndefined();
	});

	it("does not overwrite a caller-supplied session_id header (options.headers precedence)", async () => {
		const captured: CapturedRequest[] = [];
		await streamOpenAICompletions(relayModel({ sendSessionHeaders: true }), baseContext(), {
			apiKey: "test-key",
			sessionId: "derived-session",
			headers: { session_id: "user-pinned" },
			fetch: createCapturingFetch(captured),
		}).result();

		expect(captured).toHaveLength(1);
		// User-supplied header wins; the auto-injected x-session-id still fills the gap.
		expect(captured[0].headers.session_id).toBe("user-pinned");
		expect(captured[0].headers["x-session-id"]).toBe("derived-session");
	});

	it("does not overwrite a session_id baked into model.headers (models.yml headers precedence)", async () => {
		const captured: CapturedRequest[] = [];
		const model = relayModel({ sendSessionHeaders: true });
		model.headers = { session_id: "config-pinned" };
		await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			sessionId: "derived-session",
			fetch: createCapturingFetch(captured),
		}).result();

		expect(captured).toHaveLength(1);
		expect(captured[0].headers.session_id).toBe("config-pinned");
		expect(captured[0].headers["x-session-id"]).toBe("derived-session");
	});
});
