import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import {
	appendTransportFailureContext,
	finalizeErrorMessage,
	formatModelUnavailableGuidance,
	isModelUnavailableError,
	type RawHttpRequestDump,
} from "../src/utils/http-inspector";

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
			url: "https://api.anthropic.com/v1/messages?sig=synthetic-query-secret",
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
		expect(saved).not.toContain("synthetic-query-secret");
		expect(saved).toContain("https://api.anthropic.com/v1/messages");
		expect(saved).toContain("visible text");
		expect(saved).toContain("[redacted]");
	});
});

describe("HTTP 400 error message safety (issue #438)", () => {
	function unavailableModelDump(): RawHttpRequestDump {
		return {
			provider: "openai",
			api: "openai-responses",
			model: "codex-mini-latest",
			method: "POST",
			url: "https://api.openai.com/v1/responses",
			body: { model: "codex-mini-latest" },
		};
	}

	it("does not encourage pasting the saved raw request log publicly", async () => {
		await useTempAgentDir();
		const error = new Error("400 The requested model 'codex-mini-latest' does not exist.");
		(error as { status?: number }).status = 400;

		const message = await finalizeErrorMessage(error, unavailableModelDump());

		expect(message).toContain("raw-http-request=");
		expect(message).toMatch(/do not paste/i);
		expect(message).toMatch(/public channels/i);
	});

	it("surfaces model/provider selection guidance for unavailable-model 400s", async () => {
		await useTempAgentDir();
		const error = new Error("400 The requested model 'codex-mini-latest' does not exist.");
		(error as { status?: number }).status = 400;

		const message = await finalizeErrorMessage(error, unavailableModelDump());

		expect(message).toContain("not available");
		expect(message).toContain("gjc --list-models");
		expect(message).toContain("gjc setup provider");
		expect(message).toContain("codex-mini-latest");
	});

	it("detects unavailable-model errors only for 400 responses", () => {
		const notFound = new Error("The requested model 'codex-mini-latest' does not exist.");
		(notFound as { status?: number }).status = 400;
		expect(isModelUnavailableError(notFound.message, notFound)).toBe(true);

		const serverError = new Error("The requested model 'codex-mini-latest' does not exist.");
		(serverError as { status?: number }).status = 500;
		expect(isModelUnavailableError(serverError.message, serverError)).toBe(false);

		const rateLimited = new Error("429 rate limit exceeded");
		(rateLimited as { status?: number }).status = 400;
		expect(isModelUnavailableError(rateLimited.message, rateLimited)).toBe(false);
	});

	it("omits model/provider names from guidance when the dump is absent", () => {
		const guidance = formatModelUnavailableGuidance(undefined);
		expect(guidance).toContain("not available");
		expect(guidance).toContain("gjc --list-models");
		expect(guidance).not.toContain("''");
	});
});

describe("transport failure context", () => {
	function bunTransportError(message: string, code: string, path?: string): Error {
		return Object.assign(new Error(message), path === undefined ? { code } : { code, path });
	}

	function codexDump(): RawHttpRequestDump {
		return {
			provider: "openai-codex",
			api: "openai-responses",
			model: "gpt-5.6-sol",
			method: "POST",
			url: "https://chatgpt.com/backend-api/codex/responses",
		};
	}

	it("names the host and the failure code for a Bun DNS failure", async () => {
		const error = bunTransportError(
			"Was there a typo in the url or port?",
			"FailedToOpenSocket",
			"https://chatgpt.com/backend-api/codex/responses",
		);

		const message = await finalizeErrorMessage(error, codexDump());

		expect(message).toContain("Was there a typo in the url or port?");
		expect(message).toContain("transport=FailedToOpenSocket");
		expect(message).toContain("url=https://chatgpt.com/backend-api/codex/responses");
	});

	it("falls back to the request dump URL when the error carries no path", () => {
		const error = bunTransportError(
			"Unable to connect. Is the computer able to access the url?",
			"ConnectionRefused",
		);

		const message = appendTransportFailureContext(error.message, error, codexDump());

		expect(message).toContain("transport=ConnectionRefused");
		expect(message).toContain("url=https://chatgpt.com/backend-api/codex/responses");
	});

	it("keeps query strings out of the surfaced URL", () => {
		const error = bunTransportError(
			"Unable to connect. Is the computer able to access the url?",
			"ENOTFOUND",
			"https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent?key=synthetic-secret",
		);

		const message = appendTransportFailureContext(error.message, error, undefined);

		expect(message).toContain(
			"url=https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent",
		);
		expect(message).not.toContain("synthetic-secret");
	});

	it("reads the transport failure through a wrapped cause", () => {
		const error = Object.assign(new Error("fetch failed"), {
			cause: bunTransportError(
				"connect ECONNREFUSED 127.0.0.1:11434",
				"ECONNREFUSED",
				"http://127.0.0.1:11434/api/chat",
			),
		});

		const message = appendTransportFailureContext(error.message, error, undefined);

		expect(message).toContain("transport=ECONNREFUSED");
		expect(message).toContain("url=http://127.0.0.1:11434/api/chat");
	});

	it("leaves errors that reached an HTTP status untouched", () => {
		const error = Object.assign(new Error("500 upstream failure"), { status: 500, code: "ConnectionReset" });

		expect(appendTransportFailureContext(error.message, error, codexDump())).toBe("500 upstream failure");
	});

	it("leaves aborts untouched so the abort display path keeps matching", () => {
		const error = Object.assign(new Error("Request was aborted."), { name: "AbortError", code: "ABORT_ERR" });

		expect(appendTransportFailureContext(error.message, error, codexDump())).toBe("Request was aborted.");
	});

	it("does not append the same context twice", () => {
		const error = bunTransportError(
			"Was there a typo in the url or port?",
			"FailedToOpenSocket",
			"https://chatgpt.com/x",
		);
		const once = appendTransportFailureContext(error.message, error, undefined);

		expect(appendTransportFailureContext(once, error, undefined)).toBe(once);
	});
});
