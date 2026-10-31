import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage, Usage } from "@gajae-code/ai";
import { formatSessionDumpText } from "@gajae-code/coding-agent/session/session-dump-format";
import fc from "fast-check";
import { XMLValidator } from "fast-xml-parser";

const openaiKey = ["sk", "FAKE12345678"].join("-");
const githubToken = ["ghp", "FAKE1234567890AB"].join("_");

const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function assistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: zeroUsage,
		stopReason: "toolUse",
		timestamp,
		content,
	};
}

function dump(messages: AgentMessage[], systemPrompt?: readonly string[]): string {
	return formatSessionDumpText({
		messages,
		systemPrompt,
		model: null,
		thinkingLevel: null,
	});
}

const pem = (kind: string, edge: "BEGIN" | "END") => ["-----", edge, " ", kind, " PRIVATE", " KEY-----"].join("");

describe("formatSessionDumpText credential scrub", () => {
	it("removes credential-shaped tokens from session dump text", () => {
		const dumped = dump(
			[
				{ role: "user", content: `please review ${githubToken}`, timestamp: 1 },
				assistant(
					[
						{ type: "thinking", thinking: `consider ${openaiKey}` },
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { note: githubToken },
						},
					],
					2,
				),
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: `file has ${openaiKey}` }],
					timestamp: 3,
				},
				{
					role: "bashExecution",
					command: "echo hi",
					output: githubToken,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 4,
				},
				{
					role: "pythonExecution",
					code: "print(1)",
					output: openaiKey,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 5,
				},
				{
					role: "fileMention",
					files: [{ path: "notes.txt", content: `token ${githubToken}` }],
					timestamp: 6,
				},
			] as AgentMessage[],
			[`system with ${openaiKey}`],
		);

		expect(dumped).not.toContain(openaiKey);
		expect(dumped).not.toContain(githubToken);
		expect(dumped).toContain("«redacted-api-key»");
		expect(dumped).toContain("«redacted-github-token»");
		expect(dumped).toContain("please review");
		expect(dumped).toContain("consider");
		expect(dumped).toContain("file has");
		expect(dumped).toContain("echo hi");
		expect(dumped).toContain("print(1)");
		expect(dumped).toContain("notes.txt");
		expect(dumped).toContain("system with");
	});

	it("redacts opaque values under credential-labeled tool argument keys", () => {
		const apiKey = "opaque-api-key-value";
		const clientSecret = "opaque-client-secret-value";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-credentials",
						name: "request",
						arguments: {
							api_key: apiKey,
							settings: { clientSecret },
						},
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).toContain('name="api_key"');
		expect(dumped).toContain("clientSecret");
		expect(dumped).toContain("«redacted»");
		expect(dumped).not.toContain(apiKey);
		expect(dumped).not.toContain(clientSecret);
	});

	it("removes a private-key block split across sibling tool arguments and keeps XML well formed", () => {
		const firstSecretPart = "MIIEowIB";
		const secondSecretPart = "AAKCAQEAxGZ0000";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-split-private-key",
						name: "request",
						arguments: {
							first: `before ${pem("RSA", "BEGIN")}\n${firstSecretPart}`,
							second: `${secondSecretPart}\n${pem("RSA", "END")} after`,
						},
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).toContain("before");
		expect(dumped).toContain("after");
		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(firstSecretPart);
		expect(dumped).not.toContain(secondSecretPart);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
		expect(XMLValidator.validate(`<dump>${dumped}</dump>`)).toBe(true);
	});

	it("keeps an ordinary sentence in the session dump", () => {
		const sentence = "The ordinary sentence remains.";
		const dumped = dump(
			[
				{ role: "user", content: sentence, timestamp: 1 },
				assistant([{ type: "text", text: "Answer about the build." }], 2),
				{
					role: "bashExecution",
					command: "echo hello",
					output: "hello",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 3,
				},
				{
					role: "fileMention",
					files: [{ path: "src/main.ts", content: "export const ready = true;" }],
					timestamp: 4,
				},
			] as AgentMessage[],
			["You are a coding assistant."],
		);

		expect(dumped).toContain(sentence);
		expect(dumped).toContain("Answer about the build.");
		expect(dumped).toContain("echo hello");
		expect(dumped).toContain("hello");
		expect(dumped).toContain("src/main.ts");
		expect(dumped).toContain("export const ready = true;");
		expect(dumped).toContain("You are a coding assistant.");
		expect(dumped).not.toContain("«redacted");
	});

	it("keeps an already scrubbed marker in the session dump", () => {
		const marker = "«redacted-api-key»";
		const dumped = dump([{ role: "user", content: `saw ${marker} earlier`, timestamp: 1 }] as AgentMessage[]);

		expect(dumped).toContain(marker);
		expect(dumped).toContain("saw");
		expect(dumped).toContain("earlier");
	});

	it("removes a complete private-key block from session dump text", () => {
		const secret = "MIIEowIBAAKCAQEAxGZ0000";
		const privateKeyBlock = [pem("RSA", "BEGIN"), secret, pem("RSA", "END")].join("\n");
		const dumped = dump([
			{
				role: "user",
				content: `before ${privateKeyBlock} after`,
				timestamp: 1,
			},
		] as AgentMessage[]);

		expect(dumped).toContain("before");
		expect(dumped).toContain("after");
		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(secret);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("removes a private-key block split across a bash command and its output", () => {
		const firstSecretPart = "MIIEowIB";
		const secondSecretPart = "AAKCAQEAxGZ0000";
		const dumped = dump([
			{
				role: "bashExecution",
				command: `before ${pem("RSA", "BEGIN")}\n${firstSecretPart}`,
				output: `${secondSecretPart}\n${pem("RSA", "END")} after`,
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		] as AgentMessage[]);

		expect(dumped).toContain("before");
		expect(dumped).toContain("after");
		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(firstSecretPart);
		expect(dumped).not.toContain(secondSecretPart);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("removes a private-key block split across python code and its output", () => {
		const firstSecretPart = "MIIEowIB";
		const secondSecretPart = "AAKCAQEAxGZ0000";
		const dumped = dump([
			{
				role: "pythonExecution",
				code: `before ${pem("RSA", "BEGIN")}\n${firstSecretPart}`,
				output: `${secondSecretPart}\n${pem("RSA", "END")} after`,
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		] as AgentMessage[]);

		expect(dumped).toContain("before");
		expect(dumped).toContain("after");
		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(firstSecretPart);
		expect(dumped).not.toContain(secondSecretPart);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("removes a private-key block split across adjacent assistant text blocks", () => {
		const firstSecretPart = "MIIEowIB";
		const secondSecretPart = "AAKCAQEAxGZ0000";
		const dumped = dump([
			assistant(
				[
					{ type: "text", text: `before ${pem("RSA", "BEGIN")}\n${firstSecretPart}` },
					{ type: "text", text: `${secondSecretPart}\n${pem("RSA", "END")} after` },
				],
				1,
			),
		]);

		expect(dumped).toContain("before");
		expect(dumped).toContain("after");
		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(firstSecretPart);
		expect(dumped).not.toContain(secondSecretPart);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("does not pair private-key banners across separate session messages", () => {
		// Banners are assembled with pem() so the PEM-shaped fixtures stay intact in rendered diffs.
		const opening = `first message ${pem("RSA", "BEGIN")}`;
		const middle = "second message: plain notes between the two banners, no key material";
		const closing = `${pem("RSA", "END")} last message`;
		const dumped = dump([
			{ role: "user", content: opening, timestamp: 1 },
			{ role: "user", content: middle, timestamp: 2 },
			{ role: "user", content: closing, timestamp: 3 },
		]);

		expect(dumped).toContain(opening);
		expect(dumped).toContain(middle);
		expect(dumped).toContain(closing);
		expect(dumped).not.toContain("«redacted-private-key»");
	});

	it("keeps a certificate banner in the session dump", () => {
		const banner = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
		const dumped = dump([{ role: "user", content: banner, timestamp: 1 }] as AgentMessage[]);

		expect(dumped).toContain(banner);
		expect(dumped).not.toContain("«redacted-private-key»");
	});

	it("keeps an unclosed private-key banner in the session dump", () => {
		const banner = "-----BEGIN PRIVATE KEY-----\n";
		const dumped = dump([{ role: "user", content: `note ${banner.repeat(3)}tail`, timestamp: 1 }] as AgentMessage[]);

		expect(dumped).toContain("note");
		expect(dumped).toContain(banner);
		expect(dumped).toContain("tail");
		expect(dumped).not.toContain("«redacted-private-key»");
	});

	it("bounds an unclosed private-key banner in the session dump", () => {
		const banner = "-----BEGIN PRIVATE KEY-----\n";
		const started = performance.now();
		const small = dump([{ role: "user", content: banner.repeat(8_000), timestamp: 1 }] as AgentMessage[]);
		const mid = performance.now();
		const large = dump([{ role: "user", content: banner.repeat(16_000), timestamp: 1 }] as AgentMessage[]);
		const elapsed = performance.now() - mid;
		expect(small).toContain("-----BEGIN PRIVATE KEY-----");
		expect(large).toContain("-----BEGIN PRIVATE KEY-----");
		expect(mid - started).toBeLessThan(2_000);
		expect(elapsed).toBeLessThan(2_000);
	});

	it("property: a complete private-key block leaves the session dump, seed 81517, 64 inputs", () => {
		const kind = fc.constantFrom("", "RSA ", "EC ", "OPENSSH ");
		const letters = (min: number, max: number) =>
			fc
				.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), { minLength: min, maxLength: max })
				.map(chars => chars.join(""));
		const secret = fc
			.array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")), { minLength: 8, maxLength: 24 })
			.map(chars => chars.join(""));
		fc.assert(
			fc.property(kind, secret, letters(3, 12), letters(3, 12), (label, body, before, after) => {
				const dumped = dump([
					{
						role: "user",
						content: `${before} -----BEGIN ${label}PRIVATE KEY-----\n${body}\n-----END ${label}PRIVATE KEY----- ${after}`,
						timestamp: 1,
					},
				] as AgentMessage[]);
				return (
					dumped.includes(before) &&
					dumped.includes(after) &&
					dumped.includes("«redacted-private-key»") &&
					!dumped.includes(body) &&
					!dumped.includes(`-----BEGIN ${label}PRIVATE KEY-----`) &&
					!dumped.includes(`-----END ${label}PRIVATE KEY-----`)
				);
			}),
			{ seed: 81517, numRuns: 64 },
		);
	});

	it("property: keeps ordinary prose in the session dump, seed 70413, 64 inputs", () => {
		const prose = fc
			.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), { minLength: 1, maxLength: 24 })
			.map(chars => chars.join(""));
		fc.assert(
			fc.property(prose, text => {
				const dumped = dump([{ role: "user", content: text, timestamp: 1 }] as AgentMessage[]);
				return dumped.includes(text) && !dumped.includes("«redacted");
			}),
			{ seed: 70413, numRuns: 64 },
		);
	});
});
