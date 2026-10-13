import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai";
import { logger } from "@gajae-code/utils";
import { fetchMarketplace } from "../src/extensibility/plugins/marketplace/fetcher";
import * as git from "../src/utils/git";
import { generateSessionTitle } from "../src/utils/title-generator";

const TITLE_SECRET = "sk-TESTFAKE-TITLE-0123456789abcdef";
const CLONE_SECRET = "ghp_TESTFAKE-MKT-0123456789abcdef";
const CLONE_URL = `https://user:${CLONE_SECRET}@git.invalid/repo.git`;
const PLAIN_CLONE_URL = "https://git.invalid/plain-repo.git";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>) {
	return {
		getModelRole(role: string) {
			return role === "default" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
	} as never;
}

function titleResponse() {
	return {
		stopReason: "stop",
		content: [
			{
				type: "toolCall",
				id: "call-title",
				name: "set_title",
				arguments: { title: "Structured Title" },
			},
		],
	} as never;
}

function loggedText(calls: ReadonlyArray<readonly unknown[]>): string {
	return JSON.stringify(calls);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("debug log credential scrub", () => {
	it("does not write the session title api key into the debug log", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse());
		const debug = vi.spyOn(logger, "debug");
		const message = `hello, please title this session. my api key is ${TITLE_SECRET} — note it for later`;

		const title = await generateSessionTitle(message, createRegistry(model), createSettings(model));

		expect(title).toBe("Structured Title");
		const logged = loggedText(debug.mock.calls);
		expect(logged).toContain("title-generator: request");
		expect(logged).toContain("«redacted-api-key»");
		expect(logged).toContain("hello, please title this session");
		expect(logged).not.toContain(TITLE_SECRET);
		const sent = completeSimple.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> } | undefined;
		expect(sent?.messages?.[0]?.content).toContain(TITLE_SECRET);
	});

	it("keeps an ordinary title prompt in the debug log and the model request", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse());
		const debug = vi.spyOn(logger, "debug");
		const message = "Investigate the resolver without any token";

		const title = await generateSessionTitle(message, createRegistry(model), createSettings(model));

		expect(title).toBe("Structured Title");
		const logged = loggedText(debug.mock.calls);
		expect(logged).toContain(message);
		expect(logged).not.toContain("«redacted");
		const sent = completeSimple.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> } | undefined;
		expect(sent?.messages?.[0]?.content).toContain(message);
	});

	it("does not write the marketplace clone userinfo into the debug log", async () => {
		const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mkt-log-"));
		try {
			const clone = vi.spyOn(git, "clone").mockRejectedValue(new Error("clone stopped"));
			const debug = vi.spyOn(logger, "debug");

			await expect(fetchMarketplace(CLONE_URL, cacheDir)).rejects.toThrow(/clone stopped/);

			const logged = loggedText(debug.mock.calls);
			expect(logged).toContain("[marketplace] cloning");
			expect(logged).toContain("«redacted-url-credential»");
			expect(logged).toContain("git.invalid");
			expect(logged).not.toContain(CLONE_SECRET);
			expect(logged).not.toContain("user:");
			expect(clone.mock.calls[0]?.[0]).toBe(CLONE_URL);
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	it("keeps a credential-free git URL in the marketplace debug log", async () => {
		const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mkt-log-"));
		try {
			const clone = vi.spyOn(git, "clone").mockRejectedValue(new Error("clone stopped"));
			const debug = vi.spyOn(logger, "debug");

			await expect(fetchMarketplace(PLAIN_CLONE_URL, cacheDir)).rejects.toThrow(/clone stopped/);

			const logged = loggedText(debug.mock.calls);
			expect(logged).toContain(PLAIN_CLONE_URL);
			expect(logged).not.toContain("«redacted");
			expect(clone.mock.calls[0]?.[0]).toBe(PLAIN_CLONE_URL);
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});
});
