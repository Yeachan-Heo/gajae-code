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

	it("removes a URL password that an auth-token prefix would otherwise hide", () => {
		const password = "SYNTHETIC_PG_PASSWORD";
		const dumped = dump([
			{
				role: "user",
				content: `connect with Token postgres://app:${password}@db.example.com:5432/prod`,
				timestamp: 1,
			},
		] as AgentMessage[]);

		// The auth-token rule matches the scheme word, so the URL has to be classified from the
		// original text before that rule consumes the authority delimiter it needs.
		expect(dumped).not.toContain(password);
		expect(dumped).toContain("db.example.com");
		expect(dumped).toContain("connect with");
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

	it("masks a nested escaped credential key whose value is an escaped PEM block", () => {
		const body = "ESCAPED_NESTED_PEM_BODY";
		// A JSON-encoded payload keeps the name and the value escaped: the name is only
		// credential-shaped once the escape is resolved, and the block arrives on one line.
		const escapedPem = `${pem("RSA", "BEGIN")}\\n${body}\\n${pem("RSA", "END")}`;
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-escaped-credential-pem",
						name: "request",
						arguments: { payload: { "api\\u005fkey": escapedPem } },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
		expect(parameterValue(dumped, "payload")).toContain('"«redacted»"');
	});

	it("masks an escaped PEM block the block scan cannot close under a nested escaped credential key", () => {
		const body = "TRUNCATED_ESCAPED_PEM_BODY";
		// The export was truncated before the footer, so no complete block exists for the block
		// scan; the decoded credential name is what has to remove the banner and the body.
		const escapedPem = `${pem("RSA", "BEGIN")}\\n${body}`;
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-truncated-escaped-pem",
						name: "request",
						arguments: { payload: { "api\\u005fkey": escapedPem } },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(parameterValue(dumped, "payload")).toContain('"«redacted»"');
	});

	it("masks an escaped PEM whose banner survives the block scan under a decoded credential name", () => {
		const body = "UNREADABLE_BANNER_PEM_BODY";
		// Three escape layers leave the banner unreadable to the block scan; the credential name,
		// readable after the same decode, is what removes the banner and the body.
		const escapedBanner = `-----BEGIN PRIVA${"\\\\\\"}u0054E KEY-----`;
		const escapedPem = `${escapedBanner}\\n${body}\\n${pem("RSA", "END")}`;
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-unreadable-banner-pem",
						name: "request",
						arguments: { payload: { "api\\u005fkey": escapedPem } },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain("PRIVA");
		expect(parameterValue(dumped, "payload")).toContain('"«redacted»"');
	});

	it("masks both arguments when two spellings decode to one credential name", () => {
		const escapedSecret = "ESCAPED_DUPLICATE_SECRET";
		const plainSecret = "PLAIN_DUPLICATE_SECRET";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-decoded-name-duplicate",
						name: "request",
						arguments: { payload: { "api\\u005fkey": escapedSecret, api_key: plainSecret } },
					},
				],
				1,
			),
		] as AgentMessage[]);

		const payload = parameterValue(dumped, "payload") ?? "";
		expect(payload).not.toContain(escapedSecret);
		expect(payload).not.toContain(plainSecret);
		expect(payload.match(/«redacted»/g) ?? []).toHaveLength(2);
	});

	it("masks a later escaped credential spelling when the plain name already holds the field", () => {
		const plainSecret = "PLAIN_FIRST_SECRET";
		const escapedSecret = "ESCAPED_SECOND_SECRET";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-decoded-name-duplicate-reversed",
						name: "request",
						arguments: { payload: { api_key: plainSecret, "api\\u005fkey": escapedSecret } },
					},
				],
				1,
			),
		] as AgentMessage[]);

		const payload = parameterValue(dumped, "payload") ?? "";
		expect(payload).not.toContain(plainSecret);
		expect(payload).not.toContain(escapedSecret);
		expect(payload.match(/«redacted»/g) ?? []).toHaveLength(2);
	});

	it("keeps the pairing order when an escaped name decodes to an array index", () => {
		const body = "NUMERIC_NAME_PEM_BODY";
		// Decoded to `12`, the name would be enumerated ahead of `head` and split the block from
		// its footer, so the stored spelling has to survive for the pairing to stay in order.
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-numeric-name-pairing",
						name: "request",
						arguments: {
							payload: { head: `${pem("RSA", "BEGIN")}\\n${body}`, "\\u0031\\u0032": `\\n${pem("RSA", "END")}` },
						},
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("keeps header-pair redaction for an escaped header collection name", () => {
		const escapedSecret = "ESCAPED_HEADER_SECRET";
		const suffixedSecret = "SUFFIXED_HEADER_SECRET";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-escaped-header-alias",
						name: "http",
						arguments: {
							payload: {
								"head\\u0065rs": ["X-Api-Key", escapedSecret, "Accept", "application/json"],
								headers: ["Authorization", suffixedSecret],
							},
						},
					},
				],
				1,
			),
		] as AgentMessage[]);

		const payload = parameterValue(dumped, "payload") ?? "";
		expect(payload).not.toContain(escapedSecret);
		expect(payload).not.toContain(suffixedSecret);
		expect(payload).toContain('"X-Api-Key"');
		expect(payload).toContain('"application/json"');
	});

	it("keeps ordinary data under a literal hash-suffixed name", () => {
		// Only a name the prepass decoded is classified by its resolved spelling; a name that
		// literally ends in `#2` is ordinary data, not a header collection or a credential field.
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-literal-hash-name",
						name: "request",
						arguments: {
							payload: { "api_key#2": "public-value", "headers#2": ["Authorization", "public-note"] },
						},
					},
				],
				1,
			),
		] as AgentMessage[]);

		const payload = parameterValue(dumped, "payload") ?? "";
		expect(payload).toContain("public-value");
		expect(payload).toContain("public-note");
	});

	it("masks an escaped header-record value member", () => {
		const escapedSecret = "ESCAPED_RECORD_MEMBER_SECRET";
		const canonicalSecret = "CANONICAL_RECORD_MEMBER_SECRET";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-escaped-header-record-member",
						name: "http",
						arguments: {
							payload: {
								headers: [{ name: "Authorization", value: canonicalSecret, "val\\u0075e": escapedSecret }],
							},
						},
					},
				],
				1,
			),
		] as AgentMessage[]);

		const payload = parameterValue(dumped, "payload") ?? "";
		expect(payload).not.toContain(escapedSecret);
		expect(payload).not.toContain(canonicalSecret);
		expect(payload).toContain('"name": "Authorization"');
	});

	it("keeps the JSON delimiters of an argument value that spells a credential assignment", () => {
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-json-delimiter",
						name: "request",
						arguments: { data: { note: 'password="fake"', next: "ordinary" } },
					},
				],
				1,
			),
		] as AgentMessage[]);

		const value = parameterValue(dumped, "data") ?? "";
		expect(JSON.parse(value)).toEqual({ note: 'password="«redacted»"', next: "ordinary" });
	});

	it("prints an argument name with the spelling it arrived with", () => {
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-authored-spelling",
						name: "request",
						arguments: { "fi\\u006ce": "ORDINARY_VALUE" },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).toContain('name="fi\\u006ce"');
		expect(dumped).not.toContain('name="file"');
		expect(dumped).toContain("ORDINARY_VALUE");
	});

	it("keeps a field whose name only resolves to the intent field and drops the literal one", () => {
		// The intent field is the literal `_i` key the agent loop destructures. A field whose name
		// merely resolves to it is an ordinary argument, so its value stays and its own spelling is
		// printed, exactly as origin/dev renders it.
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-escaped-intent-field",
						name: "request",
						arguments: { "\\u005fi": "ESCAPED_INTENT_DATA", _i: "PLAIN_INTENT_DATA", note: "kept-note" },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).not.toContain("PLAIN_INTENT_DATA");
		expect(dumped).toContain("ESCAPED_INTENT_DATA");
		expect(dumped).toContain('name="\\u005fi"');
		expect(dumped).toContain("kept-note");
	});

	it("keeps both schema definitions when an escaped credential name collides with a plain one", () => {
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
							api_key: { type: "string", minLength: 10 },
							"api\\u005fkey": { type: "number" },
						},
					},
				},
			],
		});

		expect(dumped).toContain('"api_key"');
		expect(dumped).toContain('"type": "string"');
		expect(dumped).toContain('"minLength": 10');
		expect(dumped).toContain('"type": "number"');
	});

	it("keeps both schema default members when two token-shaped keys share one marker", () => {
		const first = "ghp_FIRSTTOKEN0123456789AB";
		const second = "ghp_SECONDTOKEN0123456789A";
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
						properties: { api_key: { type: "object", default: { [first]: first, [second]: second } } },
					},
				},
			],
		});

		expect(dumped).not.toContain(first);
		expect(dumped).not.toContain(second);
		// Both members survive: the marker plus one suffix for the second key.
		expect(dumped.match(/«redacted-github-token»/g) ?? []).toHaveLength(2);
	});

	it("masks both spellings of a data keyword under a credential-named property", () => {
		const escapedDefault = "ESCAPED_DEFAULT_SECRET";
		const canonicalDefault = "CANONICAL_DEFAULT_SECRET";
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
							api_key: { "def\\u0061ult": escapedDefault, default: canonicalDefault },
							publicFlag: { type: "boolean", default: true },
						},
					},
				},
			],
		});

		expect(dumped).not.toContain(escapedDefault);
		expect(dumped).not.toContain(canonicalDefault);
		expect(dumped).toContain('"default": "«redacted»"');
		expect(dumped).toContain('"default": true');
	});

	it("masks both spellings of a data keyword in either order under a credential-named property", () => {
		const escapedFirst = "ESCAPED_FIRST_DEFAULT_SECRET";
		const canonicalFirst = "CANONICAL_FIRST_DEFAULT_SECRET";
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
							api_key: { "def\\u0061ult": escapedFirst, default: escapedFirst },
							client_secret: { default: canonicalFirst, "def\\u0061ult": canonicalFirst },
						},
					},
				},
			],
		});

		expect(dumped).not.toContain(escapedFirst);
		expect(dumped).not.toContain(canonicalFirst);
	});

	it("masks an escaped credential key inside a JSON string payload", () => {
		const secret = "escaped-string-payload-token";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-escaped-key-in-json-text",
						name: "request",
						arguments: { payload: `{"\\u0061pi_key":"${secret}"}` },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).not.toContain(secret);
		expect(parameterValue(dumped, "payload")).toBe('{"api_key":"«redacted»"}');
	});

	it("keeps both entries when a chained escape decodes to an authored sibling name", () => {
		// `n\u005cu005cu006fte` decodes twice to `n\u006fte`, which is an authored sibling key that
		// keeps its own spelling, so decoding into it would overwrite one of the two entries.
		const authored = "n\\u006fte";
		const chained = "n\\u005cu005cu006fte";
		const orders: Record<string, unknown>[] = [
			{ note: "VALUE_C", [authored]: "VALUE_U", [chained]: "VALUE_T" },
			{ [chained]: "VALUE_T", [authored]: "VALUE_U", note: "VALUE_C" },
		];

		for (const args of orders) {
			const dumped = dump([
				assistant([{ type: "toolCall", id: "call-chained-escape-name", name: "request", arguments: args }], 1),
			] as AgentMessage[]);

			for (const value of ["VALUE_C", "VALUE_U", "VALUE_T"]) {
				expect(dumped).toContain(value);
			}
		}
	});

	it("keeps a schema definition named like the intent field", () => {
		// The intent field is an argument concept; a schema root definition with that name is
		// schema structure and stays readable.
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [{ name: "x", description: "", parameters: { "\\u005fi": { type: "string" } } }],
		});

		expect(dumped).toContain('"type": "string"');
		expect(dumped).toContain("Parameters");
	});

	it("classifies an encoded tab separator in an argument name like the tab itself", () => {
		// The credential labels accept a tab separator, so a field name has to resolve to the same
		// identity; the printed dump still keeps the control character spelled out.
		const encodedSecret = "encoded-tab-secret";
		const directSecret = "direct-tab-secret";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-encoded-tab-name",
						name: "request",
						arguments: { payload: { "client\\u0009secret": encodedSecret, "client\tsecret": directSecret } },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).not.toContain(encodedSecret);
		expect(dumped).not.toContain(directSecret);
		expect(parameterValue(dumped, "payload")).toContain('"client\\\\u0009secret": "«redacted»"');
	});

	it("keeps an ordinary decoded JSON blob in the session dump", () => {
		const payload = '{"path": "src/auth", "note": "ok"}';
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-plain-json-blob",
						name: "read",
						arguments: { payload },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(parameterValue(dumped, "payload")).toBe('{"path": "src/auth", "note": "ok"}');
		expect(dumped).not.toContain("«redacted");
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

	it("does not expose a closed container after the scan budget is exhausted", () => {
		// Every unclosed container forces a scan of the remaining text, so enough of them spend
		// the whole lookahead budget before the real container is reached.
		const filler = "secret={\n".repeat(40);
		const longPayload = "A".repeat(20_000);
		const tail = `secret={\n  "payload": "${longPayload}EXHAUSTED_BUDGET_SECRET"\n}\nafter`;
		const dumped = dump([{ role: "user", content: `${filler}${tail}`, timestamp: 1 }] as AgentMessage[]);

		expect(dumped).not.toContain("EXHAUSTED_BUDGET_SECRET");
		expect(dumped).not.toContain(longPayload);
		expect(dumped).toContain("«redacted»");
	});

	it("keeps literal unicode escapes in message text while decoding argument values", () => {
		const literal = 'const s = "\\u0041";';
		const dumped = dump([
			{ role: "user", content: literal, timestamp: 1 },
			assistant([{ type: "text", text: literal }], 2),
			assistant(
				[
					{
						type: "toolCall",
						id: "call-escaped-argument",
						name: "read",
						arguments: { pattern: "\\u0041" },
					},
				],
				3,
			),
		] as AgentMessage[]);

		expect(dumped.split(literal).length - 1).toBe(2);
		expect(dumped).toContain('name="pattern">A</parameter>');
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

	it("removes a private-key block that only appears after two escape layers", () => {
		const body = "DOUBLE_ESCAPED_PEM_BODY";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-double-escaped-banner",
						name: "request",
						arguments: {
							body: `\\u005cu002d----BEGIN RSA PRIVATE KEY-----\n${body}`,
							private_key: pem("RSA", "END"),
						},
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

	it("keeps a schema definition named after a data keyword", () => {
		const secret = "OPAQUE_DEFINITION_DEFAULT";
		const dumped = formatSessionDumpText({
			messages: [],
			model: null,
			thinkingLevel: null,
			tools: [
				{
					name: "mcp_request",
					description: "calls a tool",
					parameters: {
						$defs: {
							default: { type: "object", properties: { token: { type: "string", minLength: 10 } } },
						},
						properties: {
							payload: { $ref: "#/$defs/default" },
							token: { type: "string", default: secret },
						},
					},
				},
			],
		});

		expect(dumped).toContain('"minLength": 10');
		expect(dumped).toContain('"$ref": "#/$defs/default"');
		expect(dumped).not.toContain(secret);
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

	it("removes a private-key block split across adjacent tool-result blocks", () => {
		const body = "ADJACENT_TOOL_RESULT_BODY";
		const dumped = dump([
			{
				role: "toolResult",
				toolName: "mcp_fetch",
				toolCallId: "call-tool-result-split",
				content: [
					{ type: "text", text: "-----BEGIN RSA " },
					{ type: "text", text: `PRIVATE KEY-----\n${body}\n${pem("RSA", "END")}` },
					{ type: "text", text: "ordinary after" },
				],
				isError: false,
				timestamp: 1,
			},
		] as AgentMessage[]);

		expect(dumped).not.toContain(body);
		expect(dumped).toContain("ordinary after");
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

	it("removes a private-key block split mid-token across arguments", () => {
		const body = "MID_BANNER_BODY";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-mid-token",
						name: "request",
						arguments: { a: "-----BEGIN RSA ", b: `PRIVATE KEY-----\n${body}\n${pem("RSA", "END")}` },
					},
				],
				1,
			),
		] as AgentMessage[]);

		expect(dumped).not.toContain(body);
		expect(parameterValue(dumped, "b")).toBe("«redacted-private-key»");
	});

	it("removes a private-key block whose footer sits inside a credential container", () => {
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

		// The complete block is replaced before the container pass can remove its footer, so the
		// body that precedes the container does not survive as an unmatched opener's payload.
		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("still masks a credential container that holds no private-key block", () => {
		const secret = "CONTAINER_ONLY_SECRET_VALUE";
		const dumped = dump([
			{
				role: "bashExecution",
				command: "printenv",
				output: `private_key={footer:"${secret}"}`,
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		] as AgentMessage[]);

		// Replacing the block first must not disable container masking for everything else.
		expect(dumped).toContain("private_key=«redacted»");
		expect(dumped).not.toContain(secret);
	});

	it("masks a container whose assignment is inside a complete private-key block", () => {
		const body = "CONTAINER_OVERLAP_PEM_BODY";
		const sibling = "CONTAINER_OVERLAP_SIBLING_SECRET";
		const dumped = dump([
			{
				role: "user",
				content: [
					`before ${pem("RSA", "BEGIN")}`,
					body,
					"private_key={",
					`  "footer": "${pem("RSA", "END")}",`,
					`  "sibling": "${sibling}"`,
					"}",
					"after",
				].join("\n"),
				timestamp: 1,
			},
		] as AgentMessage[]);

		// The block starts before the container and ends inside it, so its range and the container's
		// range overlap: both must hold, and the text after the container has to survive.
		expect(dumped).toContain("before");
		expect(dumped).toContain("after");
		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(sibling);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("masks a container whose assignment is inside a paired private-key block", () => {
		const body = "PAIRED_CONTAINER_PEM_BODY";
		const sibling = "PAIRED_CONTAINER_SIBLING_SECRET";
		const dumped = dump([
			assistant(
				[
					{ type: "text", text: `before ${pem("RSA", "BEGIN")}\n${body}` },
					{
						type: "text",
						text: `private_key={\n  "footer": "${pem("RSA", "END")}",\n  "sibling": "${sibling}"\n}\nafter`,
					},
				],
				1,
			),
		]);

		// Same overlap through the adjacent-run pairing path: the blocks are paired while still
		// adjacent, and the paired ranges are then unified with the containers of the joined text.
		expect(dumped).toContain("before");
		expect(dumped).toContain("after");
		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(sibling);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
	});

	it("keeps header records masked when a private-key block covers a numeric collection slot", () => {
		const body = "MIXED_HEADER_PEM_BODY";
		const secret = "MIXED_HEADER_RECORD_SECRET";
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-mixed-header-pem",
						name: "http",
						arguments: {
							body: `${pem("RSA", "BEGIN")}\n${body}`,
							headers: [7, "X-Api-Key", `tail\n${pem("RSA", "END")}`, { name: "Authorization", value: secret }],
							note: "unrelated note",
						},
					},
				],
				1,
			),
		]);

		// The original slot is a number, so the collection is not a flat name/value list even though
		// the mask replaces that slot with a string marker. Read as pairs, the record after it would
		// lose its header context and print its value.
		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).toContain('"Authorization"');
		expect(dumped).toContain("unrelated note");
		expect(dumped).not.toContain(secret);
		expect(dumped).not.toContain(body);
	});

	it("keeps the leaf cursor aligned across a sparse array hole", () => {
		const body = "SPARSE_PEM_BODY";
		const sparse: unknown[] = [];
		sparse[1] = `${pem("RSA", "BEGIN")}\n${body}`;
		sparse[3] = `tail\n${pem("RSA", "END")}`;
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-sparse-pem",
						name: "request",
						arguments: { payload: sparse, note: "SURROUNDING_NOTE" },
					},
				],
				1,
			),
		]);

		// A hole prints as `null`, so it owns one leaf in both walks. If only one walk counts it, every
		// slot after the hole is masked with the ranges of its predecessor.
		expect(dumped).toContain("SURROUNDING_NOTE");
		expect(dumped).toContain("«redacted-private-key»");
		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
		expect(parameterValue(dumped, "payload")).toContain("null");
	});

	it("removes a private-key block whose footer sits inside a parameter name", () => {
		const body = "PARAMETER_NAME_PEM_BODY";
		// A name is not joined with the value leaves, so it needs its own single detection pass:
		// a container mask that eats the footer first would leave the banner and body printed inside
		// the `<parameter name="...">` attribute.
		const name = `note ${pem("RSA", "BEGIN")}\n${body} private_key={footer:"${pem("RSA", "END")}"}`;
		const dumped = dump([
			assistant([{ type: "toolCall", id: "call-name", name: "read", arguments: { [name]: "visible-value" } }], 1),
		]);

		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
		expect(dumped).toContain("visible-value");
		expect(XMLValidator.validate(`<dump>${dumped}</dump>`)).toBe(true);
	});

	it("keeps the line after a credential container inside a YAML scalar", () => {
		const body = "YAML_OVERLAP_PEM_BODY";
		const sibling = "YAML_OVERLAP_SIBLING";
		const fixture = [
			"secret: |",
			`  ${pem("RSA", "BEGIN")}`,
			body,
			`private_key={"footer":"${pem("RSA", "END")}","sibling":"${sibling}"}`,
			"  keep-me",
			"public: visible",
		].join("\n");
		const dumped = dump([{ role: "user", content: fixture, timestamp: 1 }] as AgentMessage[]);

		// The masked block and its container are gone.
		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(sibling);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
		// Removing the unindented lines must not let a later pass reinterpret the remaining
		// indented lines as the scalar: `keep-me` is outside every detected range and survives, and
		// the output is still a YAML document the block scalar belongs to.
		expect(dumped).toContain("\n  keep-me\npublic: visible");
		const parsed = Bun.YAML.parse(dumped) as { secret?: unknown; public?: unknown };
		expect(typeof parsed.secret).toBe("string");
		expect(parsed.secret).toContain("keep-me");
		expect(parsed.secret).not.toContain(body);
		expect(parsed.public).toBe("visible");
	});

	it("keeps a covered typed constraint out of the rendered schema", () => {
		const body = "SCHEMA_TYPED_PEM_BODY";
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
							first: { type: "string", default: `${pem("RSA", "BEGIN")}\n${body}` },
							limit: { type: "integer", minimum: 10, maximum: 20 },
							kind: { type: ["string", "null"] },
							flag: false,
							second: { type: "string", default: `tail\n${pem("RSA", "END")}` },
						},
					},
				},
			],
		});

		const properties = JSON.parse(parameterValue(dumped, "properties") ?? "null") as Record<string, unknown>;
		expect(dumped).not.toContain(body);
		expect(dumped).not.toContain(pem("RSA", "END"));
		// Incidental label check for one covered default; the assertions below do not depend on which
		// marker wins a merged range.
		expect((properties.first as { default: string }).default).toBe("«redacted-private-key»");
		// A covered keyword is omitted rather than printed as a string, and a covered boolean
		// subschema becomes the neutral schema. What survives is still a JSON Schema document:
		// `{}` constrains nothing, and every remaining value has the shape its keyword requires.
		expect(properties.limit).toEqual({});
		expect(Object.hasOwn(properties.limit as object, "minimum")).toBe(false);
		expect(Object.hasOwn(properties.limit as object, "maximum")).toBe(false);
		// A `type` list accepts only type names, so a covered member is dropped instead of printed.
		expect(properties.kind).toEqual({});
		expect(Object.hasOwn(properties.second as object, "type")).toBe(false);
		expect(properties.flag).toEqual({});
		expect((properties.first as { type: string }).type).toBe("string");
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

	it("removes a private-key block whose body passes through non-string arguments", () => {
		const firstSecretPart = "MIIEowIB";
		const secondSecretPart = "AAKCAQEAxGZ0000";
		const digits = 987654321;
		const dumped = dump([
			assistant(
				[
					{
						type: "toolCall",
						id: "call-scalar-body",
						name: "request",
						arguments: {
							retries: 3,
							a: `${pem("RSA", "BEGIN")}\n${firstSecretPart}`,
							bits: digits,
							ready: true,
							empty: null,
							b: `${secondSecretPart}\n${pem("RSA", "END")}`,
						},
					},
				],
				1,
			),
		] as AgentMessage[]);

		// The block is written between the two banners, so every scalar it passes through is part
		// of the key body and is replaced with it rather than printed as digits, `true` or `null`.
		expect(parameterValue(dumped, "a")).toBe("«redacted-private-key»");
		expect(parameterValue(dumped, "bits")).toBe("«redacted-private-key»");
		expect(parameterValue(dumped, "ready")).toBe("«redacted-private-key»");
		expect(parameterValue(dumped, "empty")).toBe("«redacted-private-key»");
		expect(parameterValue(dumped, "b")).toBe("«redacted-private-key»");
		expect(dumped).not.toContain(String(digits));
		expect(dumped).not.toContain(firstSecretPart);
		expect(dumped).not.toContain(secondSecretPart);
		expect(dumped).not.toContain(pem("RSA", "BEGIN"));
		expect(dumped).not.toContain(pem("RSA", "END"));
		// A number outside the block keeps its own printed form.
		expect(parameterValue(dumped, "retries")).toBe("3");
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
