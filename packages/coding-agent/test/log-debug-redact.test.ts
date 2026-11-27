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
const CLONE_URL = `https://user:${CLONE_SECRET}@git.invalid/repo.git?private_token=abc123`;
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

function titleResponse(title = "Structured Title") {
	return {
		stopReason: "stop",
		content: [
			{
				type: "toolCall",
				id: "call-title",
				name: "set_title",
				arguments: { title },
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

	it("scrubs opaque generic credential labels from title logs but not the model request", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse());
		const debug = vi.spyOn(logger, "debug");
		const secrets = [
			"opaque-token-value",
			"opaque-secret-value",
			"opaque-credential-value",
			"opaque-private-key-value",
			"opaque-openai-api-key-value",
			"opaque-api-token-value",
			"opaque-cookie-value",
			"opaque-auth-value",
			"opaque-bearer-value",
			"opaque-credentials-value",
			"opaque-secrets-value",
		];
		const labels = [
			"token",
			"secret",
			"credential",
			"private_key",
			"OPENAI_API_KEY",
			"api_token",
			"cookie",
			"auth",
			"bearer",
			"credentials",
			"secrets",
		];
		const message = labels.map((label, index) => `${label}=${secrets[index]}`).join(" ");

		await generateSessionTitle(message, createRegistry(model), createSettings(model));

		const logged = loggedText(debug.mock.calls);
		for (const secret of secrets) expect(logged).not.toContain(secret);
		expect(logged.match(/«redacted»/g)).toHaveLength(secrets.length);
		const sent = completeSimple.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> } | undefined;
		for (const secret of secrets) expect(sent?.messages?.[0]?.content).toContain(secret);
	});

	it("scrubs short labeled credentials from title logs", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse());
		const debug = vi.spyOn(logger, "debug");
		const labeled =
			"token=abc123 password=123456 cookie=Q private_token=xyz AWS_SECRET_ACCESS_KEY=x auth=x bearer=abc123 credentials=x secrets=abc123";

		await generateSessionTitle(labeled, createRegistry(model), createSettings(model));

		const logged = loggedText(debug.mock.calls);
		for (const field of labeled.split(" ")) expect(logged).not.toContain(field);
		const sent = completeSimple.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> } | undefined;
		expect(sent?.messages?.[0]?.content).toContain(labeled);
	});

	it("scrubs the full quoted credential value from title logs", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse());
		const debug = vi.spyOn(logger, "debug");
		const labeled = 'password="correct horse battery" authorization="Bearer abc" note=keep-this';

		await generateSessionTitle(labeled, createRegistry(model), createSettings(model));

		const logged = loggedText(debug.mock.calls);
		expect(logged).not.toContain("correct horse battery");
		expect(logged).not.toContain("Bearer abc");
		expect(logged).toContain("note=keep-this");
		const sent = completeSimple.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> } | undefined;
		expect(sent?.messages?.[0]?.content).toContain(labeled);
	});

	it("scrubs escaped quoted credentials from title logs", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse());
		const debug = vi.spyOn(logger, "debug");
		const labeled = String.raw`password=\"correct horse battery\" payload={\"password\":\"correct horse battery\"} note=keep-this`;

		await generateSessionTitle(labeled, createRegistry(model), createSettings(model));

		const logged = loggedText(debug.mock.calls);
		expect(logged).not.toContain("correct horse battery");
		expect(logged).toContain("«redacted»");
		expect(logged).toContain("payload=");
		expect(logged).toContain("note=keep-this");
		const sent = completeSimple.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> } | undefined;
		expect(sent?.messages?.[0]?.content).toContain(labeled);
	});

	it("scrubs credential labels echoed in generated titles before logging", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const generatedTitle = "token=abc123";
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse(generatedTitle));
		const debug = vi.spyOn(logger, "debug");

		const title = await generateSessionTitle("ordinary title input", createRegistry(model), createSettings(model));

		expect(title).toBe(generatedTitle);
		const logged = loggedText(debug.mock.calls);
		expect(logged).not.toContain(generatedTitle);
		expect(logged).toContain("token=«redacted»");
		const sent = completeSimple.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> } | undefined;
		expect(sent?.messages?.[0]?.content).toContain("ordinary title input");
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
			expect(logged).toContain("«redacted»");
			expect(logged).toContain("git.invalid");
			expect(logged).not.toContain(CLONE_SECRET);
			expect(logged).not.toContain("private_token=abc123");
			expect(logged).not.toContain("user:");
			expect(clone.mock.calls[0]?.[0]).toBe(CLONE_URL);
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	it("scrubs username-only credentials from marketplace clone URLs", async () => {
		const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mkt-log-"));
		const clone = vi.spyOn(git, "clone").mockRejectedValue(new Error("clone stopped"));
		const debug = vi.spyOn(logger, "debug");
		const sources = [
			"https://opaque-token-1234@git.invalid/repo.git",
			"https://opaque-token-5678:@git.invalid/repo.git",
		];
		try {
			for (const source of sources) {
				debug.mockClear();
				clone.mockClear();
				await expect(fetchMarketplace(source, cacheDir)).rejects.toThrow(/clone stopped/);

				const logged = loggedText(debug.mock.calls);
				expect(logged).not.toContain("opaque-token-");
				expect(logged).toContain("«redacted-url-credential»");
				expect(logged).toContain("git.invalid");
				expect(clone.mock.calls[0]?.[0]).toBe(source);
			}
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
