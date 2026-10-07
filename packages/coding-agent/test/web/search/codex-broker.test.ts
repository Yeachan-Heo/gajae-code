import { describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import type { AuthStorage } from "@gajae-code/ai";
import { OPENAI_HEADER_VALUES } from "@gajae-code/ai/providers/openai-codex/constants";
import { hookFetch } from "@gajae-code/utils";
import { AgentStorage } from "../../../src/session/agent-storage";
import type { SearchParams } from "../../../src/web/search/providers/base";
import { searchCodex } from "../../../src/web/search/providers/codex";

function makeSseResponse(): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Broker-backed Codex answer",
						annotations: [{ type: "url_citation", url: "https://example.com/broker", title: "Broker" }],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_broker", model: "gpt-5-codex-mini" },
		})}`,
		"",
	].join("\n");
}

describe("Codex web search broker auth", () => {
	it("uses AuthStorage.getOAuthAccess for token + account metadata without opening AgentStorage", async () => {
		const getOAuthAccess = vi.fn(async () => ({
			accessToken: "broker-refreshed-access-token",
			accountId: "broker-account-id",
		}));
		const authStorage = { getOAuthAccess } as unknown as AuthStorage;
		const openSpy = vi.spyOn(AgentStorage, "open");
		let requestHeaders: Headers | undefined;

		using _hook = hookFetch(async (_url, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response(makeSseResponse(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
		});

		const params: SearchParams = {
			query: "broker codex search",
			systemPrompt: "Use web search.",
			authStorage,
			sessionId: "codex-broker-session",
		};

		const result = await searchCodex(params);

		expect(result.provider).toBe("codex");
		expect(getOAuthAccess).toHaveBeenCalledWith("openai-codex", "codex-broker-session", { signal: undefined });
		expect(requestHeaders?.get("authorization")).toBe("Bearer broker-refreshed-access-token");
		expect(requestHeaders?.get("chatgpt-account-id")).toBe("broker-account-id");
		expect(openSpy).not.toHaveBeenCalled();
	});

	it("sanitizes non-ASCII OS components in the User-Agent header", async () => {
		const platformSpy = vi.spyOn(os, "platform").mockReturnValue("linux" as NodeJS.Platform);
		const releaseSpy = vi.spyOn(os, "release").mockReturnValue("4.4.302-Minimal™-EAS-QTI_Haptic-R26");
		const archSpy = vi.spyOn(os, "arch").mockReturnValue("arm64" as NodeJS.Architecture);
		const getOAuthAccess = vi.fn(async () => ({
			accessToken: "broker-refreshed-access-token",
			accountId: "broker-account-id",
		}));
		const authStorage = { getOAuthAccess } as unknown as AuthStorage;
		let userAgent: string | undefined;

		using _hook = hookFetch(async (_url, init) => {
			const headers = new Headers(init?.headers);
			userAgent = headers.get("User-Agent") ?? undefined;
			return new Response(makeSseResponse(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
		});

		const result = await searchCodex({
			query: "android codex search",
			systemPrompt: "Use web search.",
			authStorage,
			sessionId: "codex-broker-session",
		});

		expect(result.provider).toBe("codex");
		expect(userAgent).toMatch(
			new RegExp(
				`^${OPENAI_HEADER_VALUES.ORIGINATOR_CODEX}/[^\\s]+ \\(linux 4\\.4\\.302-Minimal-EAS-QTI_Haptic-R26; arm64\\)$`,
			),
		);
		expect(userAgent).toMatch(/^[\x20-\x7e]+$/);
		platformSpy.mockRestore();
		releaseSpy.mockRestore();
		archSpy.mockRestore();
	});
});
