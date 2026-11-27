import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, TextContent, ThinkingContent, ToolCall } from "@gajae-code/ai/core";
import fc from "fast-check";
import { obfuscateMessages, SecretObfuscator } from "../src/secrets/obfuscator";

const SECRET = "planted-outbound-secret";
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function obfuscator(): SecretObfuscator {
	return new SecretObfuscator([{ type: "plain", content: SECRET }], KEY);
}

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "stop",
		timestamp: 1,
		usage: USAGE,
		...extra,
	};
}

function textOf(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	const block = content[0];
	if (block?.type === "text") return block.text;
	return "";
}

describe("obfuscateMessages outbound fields", () => {
	it("masks a planted secret in string content", () => {
		const secrets = obfuscator();
		const input: Message[] = [
			{ role: "user", content: `recover ${SECRET}`, timestamp: 1 },
			{ role: "developer", content: `note ${SECRET}`, timestamp: 2 },
		];
		const out = obfuscateMessages(secrets, input);
		expect(out[0]?.content).toBe(secrets.obfuscate(`recover ${SECRET}`));
		expect(out[1]?.content).toBe(secrets.obfuscate(`note ${SECRET}`));
		expect(JSON.stringify(out)).not.toContain(SECRET);
		expect(secrets.deobfuscate(String(out[0]?.content))).toBe(`recover ${SECRET}`);
	});

	it("masks a planted secret in unsigned thinking text", () => {
		const secrets = obfuscator();
		const thinking = `plan ${SECRET}`;
		const summaryText = `sum ${SECRET}`;
		const rawText = `raw ${SECRET}`;
		const input: Message[] = [assistant([{ type: "thinking", thinking, summaryText, rawText }])];
		const out = obfuscateMessages(secrets, input);
		const block = (out[0]?.content as ThinkingContent[])[0];
		expect(block?.thinking).toBe(secrets.obfuscate(thinking));
		expect(block?.summaryText).toBe(secrets.obfuscate(summaryText));
		expect(block?.rawText).toBe(secrets.obfuscate(rawText));
		expect(block?.thinkingSignature).toBeUndefined();
		expect(JSON.stringify(out)).not.toContain(SECRET);
	});

	it("masks a text block", () => {
		const secrets = obfuscator();
		const text = `hello ${SECRET}`;
		const input: Message[] = [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }];
		const out = obfuscateMessages(secrets, input);
		const block = (out[0]?.content as TextContent[])[0];
		expect(block?.text).toBe(secrets.obfuscate(text));
		expect(block?.text).not.toContain(SECRET);
		expect(secrets.deobfuscate(block?.text ?? "")).toBe(text);
	});

	it("keeps tool-call arguments, image data, and assistant error text unchanged", () => {
		const secrets = obfuscator();
		const input: Message[] = [
			assistant([
				{
					type: "toolCall",
					id: "call-1",
					name: "bash",
					arguments: { cmd: `echo ${SECRET}`, nested: { note: SECRET }, n: 3 },
					thoughtSignature: "opaque-thought",
				},
			]),
			{ role: "user", content: [{ type: "image", data: `img-${SECRET}`, mimeType: "image/png" }], timestamp: 1 },
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				isError: false,
				timestamp: 2,
				content: [{ type: "image", data: `shot-${SECRET}`, mimeType: "image/webp" }],
			},
			assistant([{ type: "text", text: "failed" }], {
				errorMessage: `status ${SECRET}`,
				errorCode: "upstream_timeout",
			}),
		];
		const out = obfuscateMessages(secrets, input);
		for (let index = 0; index < input.length; index++) expect(out[index]).toBe(input[index]);
	});

	it("omits signed thinking prose that contains a configured secret", () => {
		const secrets = obfuscator();
		const input: Message[] = [
			assistant([
				{ type: "thinking", thinking: `plan ${SECRET}`, thinkingSignature: "opaque-thinking-signature" },
				{ type: "text", text: "visible" },
			]),
		];
		const out = obfuscateMessages(secrets, input);
		const content = out[0]?.content as Array<{ type: string }>;
		expect(content.map(block => block.type)).toEqual(["text"]);
		expect((content[0] as TextContent).text).toBe("visible");
		expect(JSON.stringify(out)).not.toContain(SECRET);
		expect(JSON.stringify(out)).not.toContain("opaque-thinking-signature");
	});

	it("keeps secret-free messages and signed thinking unchanged", () => {
		const secrets = obfuscator();
		const input: Message[] = [
			{ role: "user", content: "plain string", timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "plain text" }], timestamp: 2 },
			assistant([{ type: "thinking", thinking: "plain thought", thinkingSignature: "opaque-sig" }]),
			assistant([
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "src/a.ts", n: 1 },
					thoughtSignature: "opaque-thought",
				},
			]),
			{ role: "user", content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], timestamp: 3 },
			assistant([{ type: "text", text: "ok" }], { errorMessage: "provider busy", errorCode: "upstream_timeout" }),
			assistant([{ type: "redactedThinking", data: "opaque-redacted" }]),
		];
		const out = obfuscateMessages(secrets, input);
		for (let index = 0; index < input.length; index++) expect(out[index]).toBe(input[index]);
	});

	it("keeps a tool name equal to a configured secret", () => {
		const secrets = obfuscator();
		const input: Message[] = [
			assistant([{ type: "toolCall", id: "call-1", name: SECRET, arguments: { path: "src/a.ts" } }]),
		];
		const out = obfuscateMessages(secrets, input);
		const call = (out[0]?.content as ToolCall[])[0];
		expect(call?.name).toBe(SECRET);
		expect(call?.id).toBe("call-1");
		expect(call?.arguments).toEqual({ path: "src/a.ts" });
		expect(out[0]).toBe(input[0]);
	});

	it("keeps a thinking signature byte for byte when prose has no configured secret", () => {
		const secrets = obfuscator();
		const signature = `opaque-${SECRET}`;
		const input: Message[] = [
			assistant([{ type: "thinking", thinking: "plain thought", thinkingSignature: signature }]),
		];
		const out = obfuscateMessages(secrets, input);
		expect(out[0]).toBe(input[0]);
		expect((out[0]?.content as ThinkingContent[])[0]?.thinkingSignature).toBe(signature);
	});

	it("property: outbound obfuscation replaces a configured secret", () => {
		const secrets = obfuscator();
		const filler = fc.array(fc.constantFrom("a", "b", "c", " "), { maxLength: 12 }).map(chars => chars.join(""));
		fc.assert(
			fc.property(
				filler,
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				(pad, stringHas, textHas, thinkingHas, signed, argsHas, imageHas, errorHas) => {
					const stringContent = `${pad}${stringHas ? SECRET : ""}`;
					const text = `${pad}${textHas ? SECRET : "text"}`;
					const thinking = `${pad}${thinkingHas ? SECRET : "thought"}`;
					const summaryText = thinkingHas ? `s${SECRET}` : "summary";
					const cmd = `${pad}${argsHas ? SECRET : "ls"}`;
					const imageData = `${pad}${imageHas ? SECRET : "img"}`;
					const errorMessage = `${pad}${errorHas ? SECRET : "busy"}`;
					const input: Message[] = [
						{ role: "user", content: stringContent, timestamp: 1 },
						{ role: "user", content: [{ type: "text", text }], timestamp: 2 },
						assistant([
							{
								type: "thinking",
								thinking,
								summaryText,
								...(signed ? { thinkingSignature: "opaque-thinking-signature" } : {}),
							},
						]),
						assistant([
							{
								type: "toolCall",
								id: "call-1",
								name: "bash",
								arguments: { cmd, nested: { note: argsHas ? SECRET : "ok" }, n: 3 },
								thoughtSignature: "opaque-thought",
							},
						]),
						{ role: "user", content: [{ type: "image", data: imageData, mimeType: "image/png" }], timestamp: 3 },
						assistant([{ type: "text", text: "status" }], { errorMessage, errorCode: "upstream_timeout" }),
					];
					const out = obfuscateMessages(secrets, input);
					expect(JSON.stringify(obfuscateMessages(secrets, out))).toBe(JSON.stringify(out));

					if (!stringHas) expect(out[0]).toBe(input[0]);
					else {
						expect(out[0]?.content).toBe(secrets.obfuscate(stringContent));
						expect(String(out[0]?.content)).not.toContain(SECRET);
					}

					if (!textHas) expect(out[1]).toBe(input[1]);
					else {
						expect(textOf(out[1] as Message)).toBe(secrets.obfuscate(text));
						expect(textOf(out[1] as Message)).not.toContain(SECRET);
					}

					const thinkingOut = out[2] as AssistantMessage;
					if (thinkingHas && signed) {
						expect(thinkingOut.content).toEqual([]);
						expect(JSON.stringify(thinkingOut)).not.toContain(SECRET);
						expect(JSON.stringify(thinkingOut)).not.toContain("opaque-thinking-signature");
					} else if (thinkingHas) {
						const block = thinkingOut.content[0] as ThinkingContent;
						expect(block.thinking).toBe(secrets.obfuscate(thinking));
						expect(block.summaryText).toBe(secrets.obfuscate(summaryText));
						expect(block.thinking).not.toContain(SECRET);
						expect(block.thinkingSignature).toBeUndefined();
					} else {
						expect(thinkingOut.content[0]).toBe((input[2] as AssistantMessage).content[0]);
					}

					expect(out[3]).toBe(input[3]);
					expect(out[4]).toBe(input[4]);
					expect(out[5]).toBe(input[5]);

					if (!stringHas && !textHas && !thinkingHas) {
						for (let index = 0; index < input.length; index++) expect(out[index]).toBe(input[index]);
					}
				},
			),
			{ seed: 20261022, numRuns: 64 },
		);
	});
});
