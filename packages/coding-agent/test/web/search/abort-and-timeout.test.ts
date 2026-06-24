/**
 * Regression coverage for issue #1221: `web_search` froze when an upstream
 * provider stalled because Bun's WinHTTP fetch could ignore `AbortSignal`,
 * and `executeSearch` masked the eventual `AbortError` as a normal provider
 * failure.
 *
 * The fix has two halves: a hard-timeout safety net wrapped around every
 * provider's outbound fetch (via the shared `withHardTimeout` helper), and
 * an abort re-throw in the provider-fallback loop so the session sees a real
 * cancellation instead of "all providers failed". The provider wiring is
 * spot-checked on anthropic (LLM-backed) and brave (pure search API); the
 * helper itself is exercised directly.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AgentStorage } from "../../../src/session/agent-storage";
import type { ToolSession } from "../../../src/tools";
import { ToolAbortError } from "../../../src/tools/tool-errors";
import { WebSearchTool } from "../../../src/web/search";
import * as provider from "../../../src/web/search/provider";
import { searchAnthropic } from "../../../src/web/search/providers/anthropic";
import type { SearchParams } from "../../../src/web/search/providers/base";
import { searchBrave } from "../../../src/web/search/providers/brave";
import { withHardTimeout } from "../../../src/web/search/providers/utils";
import type { SearchProviderId, SearchResponse } from "../../../src/web/search/types";

const FAKE_SESSION = {} as ToolSession;
const fakeStorage = {
	listAuthCredentials: () => [],
	updateAuthCredential: () => undefined,
	get authStore() {
		return null as never;
	},
} as unknown as AgentStorage;

describe("withHardTimeout", () => {
	it("returns a signal that aborts on the hard timeout when no caller signal is supplied", async () => {
		const signal = withHardTimeout(undefined, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
	});

	it("forwards a caller signal's abort to the composed signal", () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 60_000);
		ac.abort(new Error("user-cancel"));
		expect(signal.aborted).toBe(true);
	});

	it("fires the hard timeout even when the caller signal stays open", async () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
		expect(ac.signal.aborted).toBe(false);
	});
});

describe("Anthropic provider hard-timeout wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.ANTHROPIC_SEARCH_API_KEY;
	});

	it("passes a composed signal to fetch even when the caller did not supply one", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-test";

		let capturedSignal: AbortSignal | null | undefined;
		using _hook = hookFetch(async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		// The non-search "ok" response now fails closed (424) after fetch; the
		// captured signal is set during fetch, so swallow the throw here.
		await searchAnthropic({ query: "ping", system_prompt: "" }, fakeStorage).catch(() => {});

		// Without the hard-timeout wrapper, init.signal would be undefined when
		// the caller didn't supply one — leaving fetch with no cancellation at
		// all on a stalled WinHTTP connection.
		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal?.aborted).toBe(false);
	});

	it("composes the caller signal with the hard timeout instead of forwarding it directly", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-test";

		const ac = new AbortController();
		let capturedSignal: AbortSignal | null | undefined;
		using _hook = hookFetch(async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchAnthropic({ query: "ping", system_prompt: "", signal: ac.signal }, fakeStorage).catch(() => {});

		// The signal handed to fetch must be a *composed* one, not the raw
		// caller signal: that's what guarantees the hard timeout fires even
		// when Bun fails to honour the caller's abort.
		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal).not.toBe(ac.signal);
	});
});

describe("Brave provider hard-timeout wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.BRAVE_API_KEY;
	});

	it("hands fetch a composed signal even with no caller signal — confirms the rollout reaches non-Anthropic providers", async () => {
		process.env.BRAVE_API_KEY = "brave-test-key";

		let capturedSignal: AbortSignal | null | undefined;
		using _hook = hookFetch(async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ web: { results: [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchBrave({ query: "ping" });

		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal?.aborted).toBe(false);
	});
});

describe("executeSearch abort propagation", () => {
	afterEach(() => vi.restoreAllMocks());

	function fakeProvider(behaviour: (params: SearchParams) => Promise<SearchResponse>): provider.SearchProvider {
		const id: SearchProviderId = "anthropic";
		return {
			id,
			label: "Anthropic",
			isAvailable: () => true,
			search: behaviour,
		};
	}

	it("surfaces caller cancellation as ToolAbortError instead of falling through to the next provider", async () => {
		// Two providers: the first throws an AbortError after the caller aborted,
		// the second would happily return a value. Pre-fix, executeSearch would
		// fall through to provider B and report success; post-fix, the abort
		// re-throw stops the loop immediately.
		const secondProviderSearch = vi.fn();
		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			fakeProvider(async () => {
				throw new DOMException("aborted", "AbortError");
			}),
			fakeProvider(secondProviderSearch),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const ac = new AbortController();
		ac.abort();

		await expect(tool.execute("test-id", { query: "anything" }, ac.signal)).rejects.toBeInstanceOf(ToolAbortError);
		expect(secondProviderSearch).not.toHaveBeenCalled();
	});

	it("still reports provider failures as a tool result when the caller has not aborted", async () => {
		// Defensive: the abort re-throw must NOT alter normal provider-error
		// flow. A genuine provider error should still produce an error result
		// rather than throwing.
		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			fakeProvider(async () => {
				throw new Error("upstream 500");
			}),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("test-id", { query: "anything" });
		const block = result.content[0];
		expect(block?.type).toBe("text");
		expect(block && "text" in block ? block.text : "").toContain("upstream 500");
		expect(result.details?.error).toContain("upstream 500");
	});
});
