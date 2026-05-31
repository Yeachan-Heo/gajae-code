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
		const match = /raw-http-request=(.+)$/m.exec(message);
		expect(match?.[1]).toBeDefined();
		const saved = await fs.readFile(match?.[1] ?? "", "utf-8");

		expect(saved).not.toContain(syntheticThinking);
		expect(saved).not.toContain(syntheticSignature);
		expect(saved).not.toContain(syntheticRedacted);
		expect(saved).not.toContain("synthetic-key");
		expect(saved).toContain("visible text");
		expect(saved).toContain("[redacted]");
	});
});
