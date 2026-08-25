/**
 * E2E test: exercise an OpenAI Responses conversation through a live
 * auth-gateway and assert automatic prompt caching round-trips. OpenAI
 * Responses caches prefixes ≥1024 tokens automatically — no explicit
 * `cache_control` markers — so the bug surface is "did we keep the prefix
 * byte-identical across the two turns" and "did we surface
 * input_tokens_details.cached_tokens in the response usage block".
 *
 * Skips unless a local gateway is reachable at the default `127.0.0.1:4000`
 * (override via `GJC_E2E_GATEWAY_URL`) AND the bearer token file exists at
 * `~/.gjc/auth-gateway.token`.
 *
 * To run: `bun --cwd packages/ai test test/auth-gateway-openai-responses-caching.test.ts`
 * with the gateway live (`gjc auth-gateway serve --provider=<provider>` or pm2).
 */
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";

interface OpenAIResponsesUsage {
	input_tokens: number;
	output_tokens: number;
	input_tokens_details?: { cached_tokens?: number };
	output_tokens_details?: { reasoning_tokens?: number };
	total_tokens?: number;
}

interface OpenAIResponse {
	status?: string;
	output?: Array<{
		type: string;
		content?: Array<{ type: string; text?: string }>;
	}>;
	usage: OpenAIResponsesUsage;
	error?: { type?: string; message: string };
}

const GATEWAY_URL = Bun.env.GJC_E2E_GATEWAY_URL ?? "http://127.0.0.1:4000";
const TOKEN_PATH = path.join(os.homedir(), ".gjc", "auth-gateway.token");
// `gpt-5.3-OpenAI code backend` is the model we've verified the ChatGPT-subscription OpenAI code backend
// backend accepts; older or higher-tier ids 4xx with "model not supported".
const MODEL = Bun.env.GJC_E2E_OPENAI_RESPONSES_MODEL ?? "gpt-5.3-codex";

async function checkGatewayAvailable(): Promise<{ ok: boolean; token?: string; reason?: string }> {
	let token: string;
	try {
		token = (await Bun.file(TOKEN_PATH).text()).trim();
	} catch (err) {
		if (isEnoent(err)) return { ok: false, reason: `no token at ${TOKEN_PATH}` };
		throw err;
	}
	if (!token) return { ok: false, reason: `empty token at ${TOKEN_PATH}` };
	try {
		const res = await fetch(`${GATEWAY_URL}/healthz`, { signal: AbortSignal.timeout(2_000) });
		if (!res.ok) return { ok: false, reason: `healthz returned ${res.status}` };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: `healthz unreachable: ${msg}` };
	}
	return { ok: true, token };
}

const gateway = await checkGatewayAvailable();

// Long deterministic instructions, repeated to clear OpenAI's 1024-token
// automatic-caching floor with plenty of headroom.
const INSTRUCTIONS_PARAGRAPH = `
You are a precise assistant participating in an automated end-to-end test of
the gjc auth-gateway's OpenAI Responses prompt-caching pipeline. The same
instructions block will be reused across two turns; OpenAI automatically
caches identical prefixes ≥1024 tokens, so the second turn must see the
same prefix bytes as the first or the cache misses silently. Always respond
with extreme brevity: a single short word or phrase, never more than five
tokens. Do not add filler, do not add explanations, do not add punctuation
beyond what is strictly necessary. If asked to confirm something, respond
with "yes". If asked to deny, respond with "no". If asked to repeat your
previous reply, repeat it verbatim. Reasoning, hedging, and conversational
preamble are strictly forbidden. This block is intentionally verbose so the
caching threshold is comfortably cleared on every run; please disregard the
verbosity itself and follow the brevity rule above.
`.trim();

const INSTRUCTIONS = Array.from({ length: 12 }, () => INSTRUCTIONS_PARAGRAPH).join("\n\n");

interface ResponseInputMessage {
	role: "user" | "assistant" | "developer" | "system";
	content: string | Array<{ type: string; text?: string }>;
}

async function callGateway(body: unknown, token: string): Promise<OpenAIResponse> {
	const res = await fetch(`${GATEWAY_URL}/v1/responses`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: OpenAIResponse;
	try {
		parsed = JSON.parse(text) as OpenAIResponse;
	} catch {
		throw new Error(`gateway returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`);
	}
	if (parsed.error) {
		throw new Error(`gateway error: ${parsed.error.type ?? "unknown"}: ${parsed.error.message}`);
	}
	return parsed;
}

function extractAssistantText(res: OpenAIResponse): string {
	for (const item of res.output ?? []) {
		if (item.type !== "message") continue;
		const block = item.content?.find(c => c.type === "output_text");
		if (block?.text) return block.text;
	}
	return "";
}

describe.skipIf(!gateway.ok)("auth-gateway: openai-responses prompt caching e2e", () => {
	if (!gateway.ok) {
		console.warn(`[skip] openai-responses caching e2e: ${gateway.reason}`);
		return;
	}
	const token = gateway.token;
	if (!token) throw new Error("invariant: token must be present when gateway.ok is true");

	it("automatically caches the instructions prefix across two turns", async () => {
		// Per-run nonce ensures we always start with a cold cache. The bytes
		// before the cacheable prefix boundary must be unique to this run;
		// otherwise a previously-warm cache entry silently hits on turn 1
		// and we lose the ability to assert "first turn cold, second turn warm".
		const nonce = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
		// Prepend (not append) — OpenAI caches at prefix-tree granularity, so the
		// first chunk must differ across runs to guarantee a cold start.
		const instructionsWithNonce = `[run-nonce: ${nonce}]\n\n${INSTRUCTIONS}`;
		// Stable per-run cache key. The ChatGPT-subscription OpenAI code backend backend
		// only coalesces prefixes across requests when an explicit
		// `prompt_cache_key` is set — caching is opt-in there, unlike public
		// OpenAI Responses which caches automatically. Reusing the same key
		// across both turns is the contract that makes turn 2 hit.
		const cacheKey = `gjc-e2e-${nonce}`;

		// ── Turn 1 ───────────────────────────────────────────────────────
		const turn1Input: ResponseInputMessage[] = [{ role: "user", content: "Respond with the single word: alpha" }];
		const turn1 = await callGateway(
			{
				model: MODEL,
				max_output_tokens: 64,
				instructions: instructionsWithNonce,
				prompt_cache_key: cacheKey,
				input: turn1Input,
			},
			token,
		);

		const turn1Text = extractAssistantText(turn1);

		expect(turn1Text.length).toBeGreaterThan(0);

		// First turn cannot hit the cache (nothing to read yet thanks to the nonce).
		const turn1Cached = turn1.usage.input_tokens_details?.cached_tokens ?? 0;
		expect(turn1Cached).toBe(0);
		// Confirm the request actually crossed the 1024-token caching floor;
		// otherwise OpenAI never registers a cache entry and turn 2 can't
		// possibly read.
		expect(turn1.usage.input_tokens).toBeGreaterThan(1024);

		// ── Turn 2: append assistant + new user, re-send with same instructions ──
		const turn2Input: ResponseInputMessage[] = [
			...turn1Input,
			{ role: "assistant", content: turn1Text },
			{ role: "user", content: "Respond with the single word: beta" },
		];
		const turn2 = await callGateway(
			{
				prompt_cache_key: cacheKey,
				model: MODEL,
				max_output_tokens: 64,
				instructions: instructionsWithNonce,
				input: turn2Input,
			},
			token,
		);

		const turn2Text = extractAssistantText(turn2);
		expect(turn2Text.length).toBeGreaterThan(0);

		// Second turn MUST hit the cache populated by turn 1. If
		// cached_tokens is 0, the gateway either mutated the prefix bytes
		// between turns or failed to surface input_tokens_details from the
		// upstream usage block.
		const turn2Cached = turn2.usage.input_tokens_details?.cached_tokens ?? 0;
		expect(turn2Cached).toBeGreaterThan(0);
		// The cached prefix should cover at least the instructions block we
		// established on turn 1 — sanity check that we're not catching a
		// trivial 64-token overlap.
		expect(turn2Cached).toBeGreaterThan(1024);
	}, 90_000);
});
