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

/** Value of one rendered `<parameter>`, so a test can bind surviving text to its argument. */
function parameterValue(dumped: string, name: string): string | undefined {
	return new RegExp(`<parameter name="${name}">([\\s\\S]*?)</parameter>`).exec(dumped)?.[1];
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
		expect(parameterValue(dumped, "first")).toBe("before «redacted-private-key»");
		expect(parameterValue(dumped, "second")).toBe("«redacted-private-key» after");
		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(firstSecretPart);
		expect(dumped).not.toContain(secondSecretPart);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
		expect(XMLValidator.validate(`<dump>${dumped}</dump>`)).toBe(true);
	});

	it("removes a private-key block whose footer sits under a credential-named argument", () => {
		const body = "MIIEowIBAAKCAQEAxGZ0001";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-credential-named-footer",
						name: "request",
						arguments: {
							body: `${pem("RSA", "BEGIN")}\n${body}`,
							private_key: pem("RSA", "END"),
						},
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).toContain("«redacted-private-key»");
		expect(parameterValue(dumped, "body")).toBe("«redacted-private-key»");
		expect(parameterValue(dumped, "private_key")).toBe("«redacted»");
		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
		expect(XMLValidator.validate(`<dump>${dumped}</dump>`)).toBe(true);
	});

	it("keeps parameter markup out of the credential scrubber", () => {
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-tag-boundary",
						name: "bash",
						arguments: { command: "export PASSWORD=opaque-secret-value", note: "keep-note" },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).toContain("export PASSWORD=«redacted»");
		expect(dumped).toContain('<parameter name="note">keep-note</parameter>');
		expect(dumped).not.toContain("opaque-secret-value");
		expect(XMLValidator.validate(`<dump>${dumped}</dump>`)).toBe(true);
	});

	it("keeps a credential-named tool parameter definition while masking its default", () => {
		const defaultValue = "opaque-schema-default";
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: {
						type: "object",
						properties: {
							token: { type: "string", minLength: 10, default: defaultValue },
							publicFlag: { type: "boolean" },
						},
					},
				},
			],
		});

		expect(dumped).toContain('"token"');
		expect(dumped).toContain('"type": "string"');
		expect(dumped).toContain('"minLength": 10');
		expect(dumped).toContain('"default": "«redacted»"');
		expect(dumped).toContain('"publicFlag"');
		expect(dumped).toContain('"type": "boolean"');
		expect(dumped).not.toContain(defaultValue);
		expect(XMLValidator.validate(`<dump>${dumped}</dump>`)).toBe(true);
	});

	it("does not read an ordinary argument array as header pairs", () => {
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-search-paths",
						name: "ast_grep",
						arguments: { paths: ["auth", "src"] },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).toContain('"auth"');
		expect(dumped).toContain('"src"');
	});

	it("keeps header-pair redaction for a known header collection", () => {
		const secret = "opaque-header-secret";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-headers",
						name: "http",
						arguments: { headers: ["X-Api-Key", secret, "Accept", "application/json"] },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).toContain('"X-Api-Key"');
		expect(dumped).toContain('"application/json"');
		expect(dumped).not.toContain(secret);
	});

	it("removes a private-key block split across a nested argument object", () => {
		const body = "MIIEowIBAAKCAQEAxGZ0002";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-nested-private-key",
						name: "request",
						arguments: {
							payload: { body: `${pem("RSA", "BEGIN")}\n${body}`, private_key: pem("RSA", "END") },
						},
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("masks a schema default object that holds credential-named values", () => {
		const tokenDefault = "SCHEMA_DEFAULT_SECRET";
		const nestedDefault = "NESTED_SCHEMA_SECRET";
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: {
						type: "object",
						properties: {
							config: {
								type: "object",
								default: { token: tokenDefault, nested: { password: nestedDefault }, host: "example.com" },
							},
						},
					},
				},
			],
		});

		expect(dumped).not.toContain(tokenDefault);
		expect(dumped).not.toContain(nestedDefault);
		expect(dumped).toContain('"token": "«redacted»"');
		expect(dumped).toContain('"host": "example.com"');
	});

	it("scrubs a schema default that only becomes a token after unescaping", () => {
		const escaped = "\\u0073k-abcdefghijklmnop";
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: { type: "object", properties: { value: { type: "string", default: escaped } } },
				},
			],
		});

		expect(dumped).not.toContain("sk-abcdefghijklmnop");
		expect(dumped).toContain('"default": "«redacted-api-key»"');
	});

	it("keeps a long container that closes after several unclosed containers", () => {
		const filler = "secret={\n".repeat(12);
		const longPayload = "A".repeat(1_500);
		const tail = `secret={\n  "payload": "${longPayload}OPAQUE_TAIL_SECRET"\n}\nafter`;
		const dumped = dump([{ role: "user", content: `${filler}${tail}`, timestamp: 1 }] as AgentMessage[]);

		expect(dumped).not.toContain("OPAQUE_TAIL_SECRET");
		expect(dumped).toContain("after");
	});

	it("keeps a very long container that closes after several unclosed containers", () => {
		const filler = "secret={\n".repeat(12);
		const longPayload = "A".repeat(20_000);
		const tail = `secret={\n  "payload": "${longPayload}OPAQUE_LONG_TAIL_SECRET"\n}\nafter`;
		const dumped = dump([{ role: "user", content: `${filler}${tail}`, timestamp: 1 }] as AgentMessage[]);

		expect(dumped).not.toContain("OPAQUE_LONG_TAIL_SECRET");
		expect(dumped).toContain("after");
	});

	it("keeps line-based redaction linear for carriage-return-only text", () => {
		const line = "secret={unclosed\r";
		const measure = (lines: number): number => {
			const started = performance.now();
			const dumped = dump([{ role: "user", content: line.repeat(lines), timestamp: 1 }] as AgentMessage[]);
			expect(dumped).toContain("«redacted»");
			return performance.now() - started;
		};
		measure(1_000);
		const small = measure(4_000);
		const large = measure(16_000);
		expect(large).toBeLessThan(small * 10 + 2_000);
	});

	it("keeps line-based redaction linear when the other terminator appears once", () => {
		const measure = (text: string): number => {
			const started = performance.now();
			const dumped = dump([{ role: "user", content: text, timestamp: 1 }] as AgentMessage[]);
			expect(dumped).toContain("«redacted»");
			return performance.now() - started;
		};
		measure(`${"secret={unclosed\n".repeat(1_000)}\r`);
		const small = measure(`${"secret={unclosed\n".repeat(4_000)}\r`);
		const large = measure(`${"secret={unclosed\n".repeat(16_000)}\r`);
		expect(large).toBeLessThan(small * 10 + 2_000);
	});

	it("removes a private-key block split across a schema default object", () => {
		const body = "SCHEMA_SPLIT_PEM_BODY";
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: {
						type: "object",
						properties: {
							config: {
								type: "object",
								default: { body: `${pem("RSA", "BEGIN")}\n${body}`, private_key: pem("RSA", "END") },
							},
						},
					},
				},
			],
		});

		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("removes a private-key block whose banner uses a unicode escape", () => {
		const body = "UNICODE_PEM_BODY";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-unicode-banner",
						name: "request",
						arguments: { body: `\\u002d----BEGIN RSA PRIVATE KEY-----\n${body}`, private_key: pem("RSA", "END") },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("removes a private-key block split across bash output and its truncation notice", () => {
		const body = "NOTICE_SPLIT_BODY";
		const dumped = dump([
			{
				role: "bashExecution",
				command: `export PRIVATE_KEY='${pem("RSA", "BEGIN")}`,
				output: body,
				exitCode: 0,
				cancelled: false,
				truncated: true,
				meta: {
					truncation: {
						direction: "tail",
						truncatedBy: "bytes",
						totalLines: 1,
						totalBytes: 100,
						outputLines: 1,
						outputBytes: 17,
						artifactFailureDiagnostic: pem("RSA", "END"),
					},
				},
				timestamp: 1,
			},
		] as AgentMessage[]);

		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("pairs bash sections in render order even when the message stores output first", () => {
		const body = "ORDERED_OUTPUT_SECRET";
		const dumped = dump([
			{
				role: "bashExecution",
				output: `${body}\n${pem("RSA", "END")}`,
				command: `export PRIVATE_KEY='${pem("RSA", "BEGIN")}`,
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		] as AgentMessage[]);

		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("scrubs a token-shaped schema key outside a properties map", () => {
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: { $defs: { "sk-abcdefghijklmnop": { type: "string" } } },
				},
			],
		});

		expect(dumped).not.toContain("sk-abcdefghijklmnop");
		expect(dumped).toContain("«redacted-api-key»");
	});

	it("redacts a header default under a property named after a header collection", () => {
		const secret = "OPAQUE_PROPERTY_HEADER_SECRET";
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: {
						properties: { headers: { type: "array", default: ["Authorization", secret] } },
					},
				},
			],
		});

		expect(dumped).toContain('"Authorization"');
		expect(dumped).not.toContain(secret);
	});

	it("keeps a schema definition whose root key is credential-shaped", () => {
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: { "sk-abcdefghijklmnop": { type: "string", description: "KEEP_ROOT_SCHEMA" } },
				},
			],
		});

		expect(dumped).not.toContain("sk-abcdefghijklmnop");
		expect(dumped).toContain("KEEP_ROOT_SCHEMA");
		expect(dumped).not.toContain("null");
	});

	it("keeps both schema definitions when two keys scrub to the same marker", () => {
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: {
						$defs: { "sk-aaaaaaaaaaaaaaaa": { type: "string" }, "sk-bbbbbbbbbbbbbbbb": { type: "number" } },
					},
				},
			],
		});

		expect(dumped).not.toContain("sk-aaaaaaaaaaaaaaaa");
		expect(dumped).not.toContain("sk-bbbbbbbbbbbbbbbb");
		expect(dumped).toContain('"type": "string"');
		expect(dumped).toContain('"type": "number"');
		expect(dumped).toContain("#2");
	});

	it("keeps header-pair redaction inside a schema default", () => {
		const secret = "OPAQUE_SCHEMA_HEADER_SECRET";
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: { type: "object", default: { headers: ["Authorization", secret] } },
				},
			],
		});

		expect(dumped).toContain('"Authorization"');
		expect(dumped).not.toContain(secret);
	});

	it("pairs a private-key block split across schema data keywords", () => {
		const body = "SCHEMA_CROSS_KEYWORD_SECRET";
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: {
						type: "object",
						default: `${pem("RSA", "BEGIN")}\n${body}`,
						example: pem("RSA", "END"),
					},
				},
			],
		});

		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("pairs a private-key block split across sibling schema definitions", () => {
		const body = "CROSS_PROPERTY_PEM_BODY";
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: {
						properties: {
							a: { type: "string", default: `${pem("RSA", "BEGIN")}\n${body}` },
							b: { type: "string", default: pem("RSA", "END") },
						},
					},
				},
			],
		});

		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "END"));
		// The first definition's type sits before the opening banner and must survive.
		expect(dumped).toContain('"type": "string"');
	});

	it("removes a private-key block whose footer is an argument name", () => {
		const body = "KEY_POSITION_PEM_BODY";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-key-footer",
						name: "request",
						arguments: { body: `${pem("RSA", "BEGIN")}\n${body}`, [pem("RSA", "END")]: "after" },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).not.toContain(body);
		expect(parameterValue(dumped, "body")).toBe("«redacted-private-key»");
		expect(dumped).toContain("after");
	});

	it("removes a private-key block whose footer sits in a credential container", () => {
		const body = "CONTAINER_FOOTER_PEM_BODY";
		const dumped = dump([
			{
				role: "bashExecution",
				command: `echo ${pem("RSA", "BEGIN")}`,
				output: `${body}\nprivate_key={footer:"${pem("RSA", "END")}"}`,
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		] as AgentMessage[]);

		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("bounds unclosed credential containers in the session dump", () => {
		const line = "secret={unclosed\n";
		const measure = (lines: number): number => {
			const started = performance.now();
			const dumped = dump([{ role: "user", content: line.repeat(lines), timestamp: 1 }] as AgentMessage[]);
			expect(dumped).toContain("«redacted»");
			return performance.now() - started;
		};
		measure(1_000);
		const small = measure(4_000);
		const large = measure(16_000);
		// Rescanning the remaining suffix per unclosed container grows with the square of the input;
		// a work-bounded scan stays close to linear, so quadrupling the input must not cost 16x.
		expect(large).toBeLessThan(small * 10 + 2_000);
	});

	it("removes a private-key block split between a string argument and a nested object argument", () => {
		const firstSecretPart = "MIIEowIB";
		const secondSecretPart = "AAKCAQEAxGZ0000";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-mixed-split-private-key",
						name: "request",
						arguments: {
							a: `${pem("RSA", "BEGIN")}\n${firstSecretPart}`,
							b: { data: `${secondSecretPart}\n${pem("RSA", "END")} after` },
						},
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(parameterValue(dumped, "a")).toBe("«redacted-private-key»");
		expect(parameterValue(dumped, "b")).toContain("«redacted-private-key» after");
		expect(dumped).not.toContain(firstSecretPart);
		expect(dumped).not.toContain(secondSecretPart);
		expect(dumped).not.toContain(pem("RSA", "END"));
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

	it("removes a private-key block split across a bash command that assigns a credential key", () => {
		const firstSecretPart = "MIIEowIB";
		const secondSecretPart = "AAKCAQEAxGZ0000";
		const dumped = dump([
			{
				role: "bashExecution",
				command: `export PRIVATE_KEY='${pem("RSA", "BEGIN")}\n${firstSecretPart}`,
				output: `${secondSecretPart}\n${pem("RSA", "END")}`,
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		] as AgentMessage[]);

		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(firstSecretPart);
		expect(dumped).not.toContain(secondSecretPart);
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("keeps an AST node whose name field is credential-shaped", () => {
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-ast-node",
						name: "ast_grep",
						arguments: { node: { name: "token", value: "identifier" } },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).toContain('"name": "token"');
		expect(dumped).toContain('"value": "identifier"');
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
