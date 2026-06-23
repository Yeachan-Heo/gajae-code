import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import { parseSearchArgs, runSearchCommand } from "../../../src/cli/web-search-cli";
import Search from "../../../src/commands/web-search";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";

describe("web search CLI args", () => {
	it("parses inline xAI search flags", () => {
		expect(
			parseSearchArgs([
				"q",
				"--provider=xai",
				"--xai-mode=x",
				"--allowed-x-handles=@xai,elonmusk",
				"--from-date=2025-10-01",
				"--to-date=2025-10-10",
				"--image-understanding",
				"--video-understanding",
				"latest Grok posts",
			]),
		).toMatchObject({
			query: "latest Grok posts",
			provider: "xai",
			xaiSearchMode: "x",
			allowedXHandles: ["@xai", "elonmusk"],
			fromDate: "2025-10-01",
			toDate: "2025-10-10",
			enableImageUnderstanding: true,
			enableVideoUnderstanding: true,
		});
	});

	it("parses separate, repeated, singular, and plural xAI list flags", () => {
		expect(
			parseSearchArgs([
				"web-search",
				"--allowed-domain",
				" docs.x.ai, ",
				"--allowed-domains=api.x.ai,console.x.ai",
				"--excluded-x-handle",
				" @spam ",
				"--excluded-x-handles=bot, ",
				"--image-search",
				"filtered search",
			]),
		).toMatchObject({
			query: "filtered search",
			allowedDomains: ["docs.x.ai", "api.x.ai", "console.x.ai"],
			excludedXHandles: ["@spam", "bot"],
			enableImageSearch: true,
		});
	});

	it("registers repeatable singular and plural xAI list flags on the command path", () => {
		expect(Search.flags["allowed-domain"]?.multiple).toBe(true);
		expect(Search.flags["allowed-domains"]?.multiple).toBe(true);
		expect(Search.flags["excluded-domain"]?.multiple).toBe(true);
		expect(Search.flags["excluded-domains"]?.multiple).toBe(true);
		expect(Search.flags["allowed-x-handle"]?.multiple).toBe(true);
		expect(Search.flags["allowed-x-handles"]?.multiple).toBe(true);
		expect(Search.flags["excluded-x-handle"]?.multiple).toBe(true);
		expect(Search.flags["excluded-x-handles"]?.multiple).toBe(true);
	});
});

const originalAgentDir = process.env.GJC_CODING_AGENT_DIR;
const originalXaiApiKey = process.env.XAI_API_KEY;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
let testAgentDir = "";

beforeEach(async () => {
	resetSettingsForTest();
	testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-web-search-cli-"));
	setAgentDir(testAgentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.GJC_CODING_AGENT_DIR;
	}
	if (originalXaiApiKey === undefined) delete process.env.XAI_API_KEY;
	else process.env.XAI_API_KEY = originalXaiApiKey;
	await fs.rm(testAgentDir, { recursive: true, force: true });
});

describe("web search CLI settings", () => {
	it("honors the configured web search provider when --provider is omitted", async () => {
		process.env.XAI_API_KEY = "sk-test-xai";
		await Settings.init({
			agentDir: testAgentDir,
			inMemory: true,
			overrides: { "providers.webSearch": "xai" },
		});

		const fetchMock = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-xai");
			return Response.json({
				output_text: "answer",
				citations: ["https://docs.x.ai/developers/tools/web-search"],
				model: "grok-4.3",
			});
		}) as typeof fetch;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output += String(chunk);
			return true;
		});

		await runSearchCommand({ query: "configured provider", expanded: false });

		expect(fetchSpy).toHaveBeenCalled();
		expect(Bun.stripANSI(output)).toContain("Provider: xAI");
	});
});
