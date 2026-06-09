import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../src/utils/http-inspector";

let previousAgentDir: string | undefined;
let previousPiConfigDir: string | undefined;
let previousGjcConfigDir: string | undefined;
let tempAgentDir: string | undefined;
let tempConfigRoot: string | undefined;

async function useTempAgentDir(): Promise<string> {
	previousAgentDir = getConfigRootDir();
	previousPiConfigDir = process.env.PI_CONFIG_DIR;
	previousGjcConfigDir = process.env.GJC_CONFIG_DIR;
	tempConfigRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-http-inspector-"));
	process.env.PI_CONFIG_DIR = path.relative(os.homedir(), tempConfigRoot);
	delete process.env.GJC_CONFIG_DIR;
	tempAgentDir = path.join(tempConfigRoot, "agent");
	setAgentDir(tempAgentDir);
	return tempAgentDir;
}

afterEach(async () => {
	if (previousPiConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = previousPiConfigDir;
	}
	previousPiConfigDir = undefined;
	if (previousGjcConfigDir === undefined) {
		delete process.env.GJC_CONFIG_DIR;
	} else {
		process.env.GJC_CONFIG_DIR = previousGjcConfigDir;
	}
	previousGjcConfigDir = undefined;
	if (previousAgentDir) {
		setAgentDir(previousAgentDir);
		previousAgentDir = undefined;
	}
	if (tempConfigRoot) {
		await fs.rm(tempConfigRoot, { recursive: true, force: true });
		tempAgentDir = undefined;
		tempConfigRoot = undefined;
	}
});

describe("HTTP 400 request dump sanitization", () => {
	it("redacts Anthropic thinking and redacted-thinking payloads in saved request dumps", async () => {
		await useTempAgentDir();
		const syntheticThinking = "synthetic-private-thinking";
		const syntheticSignature = "synthetic-private-signature";
		const syntheticRedacted = "synthetic-redacted-payload";
		const dump: RawHttpRequestDump = {
			provider: "anthropic",
			api: "anthropic-messages",
			model: "claude-sonnet-4-6",
			method: "POST",
			url: "https://api.anthropic.com/v1/messages",
			headers: {
				"X-Api-Key": "synthetic-key",
			},
			body: {
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "thinking",
								thinking: syntheticThinking,
								signature: syntheticSignature,
							},
							{
								type: "redacted_thinking",
								data: syntheticRedacted,
							},
							{
								type: "text",
								text: "visible text",
							},
						],
					},
				],
			},
		};
		const error = new Error("400 invalid_request_error: synthetic bad request");
		(error as { status?: number }).status = 400;

		const message = await finalizeErrorMessage(error, dump);
		const match = /HTTP 400 request diagnostics were saved locally at (.+?)\. Review/m.exec(message);
		expect(match?.[1]).toBeDefined();
		const saved = await fs.readFile(match?.[1] ?? "", "utf-8");

		expect(saved).not.toContain(syntheticThinking);
		expect(saved).not.toContain(syntheticSignature);
		expect(saved).not.toContain(syntheticRedacted);
		expect(saved).not.toContain("synthetic-key");
		expect(saved).toContain("visible text");
		expect(saved).toContain("[redacted]");
	});

	it("adds unavailable-model setup guidance without raw request paste hints", async () => {
		await useTempAgentDir();
		const dump: RawHttpRequestDump = {
			provider: "openai",
			api: "openai-responses",
			model: "codex-mini-latest",
			method: "POST",
			url: "https://api.openai.com/v1/responses",
			body: { model: "codex-mini-latest" },
		};
		const error = new Error("400 The requested model 'codex-mini-latest' does not exist.");
		(error as { status?: number; code?: string }).status = 400;
		(error as { status?: number; code?: string }).code = "model_not_found";

		const message = await finalizeErrorMessage(error, dump);

		expect(message).toContain("gjc --list-models");
		expect(message).toContain("gjc --model <provider/model>");
		expect(message).toContain("gjc setup provider");
		expect(message).toContain("do not paste raw request logs publicly");
		expect(message).toContain("codex-mini-latest");
		expect(message).not.toContain("raw-http-request=");
		expect(message).not.toContain("http-400-requests/*.json");
	});
});
