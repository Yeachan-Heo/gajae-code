import { describe, expect, test } from "bun:test";
import { projectMessages, requiredString, validateQuestionAnswer } from "../src/host";
import type { DesktopFrame, DesktopQuestion, DesktopRequest } from "../src/protocol";
import { MAX_FRAME_BYTES, parseRequest } from "../src/protocol";
import type { ProtocolHost } from "../src/transport";
import { serveProtocol } from "../src/transport";

const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const request = (id: string, method: DesktopRequest["method"]): DesktopRequest => ({ id, method, params: {} });

describe("desktop protocol validation", () => {
	test("question ownership and value validation preserve cancellation semantics", () => {
		const sessionId = "00000000-0000-4000-8000-000000000001";
		const question: DesktopQuestion = {
			id: "00000000-0000-4000-8000-000000000002",
			sessionId,
			kind: "select",
			title: "Choose",
			options: ["one", "two"],
		};
		expect(validateQuestionAnswer(question, { sessionId, value: "two" })).toBe("two");
		expect(validateQuestionAnswer(question, { sessionId, value: null })).toBeNull();
		expect(() =>
			validateQuestionAnswer(question, { sessionId: "00000000-0000-4000-8000-000000000003", value: "one" }),
		).toThrow("Question does not belong to session");
		expect(() => validateQuestionAnswer(question, { sessionId, value: "three" })).toThrow("Invalid question option");
		expect(() => validateQuestionAnswer({ ...question, kind: "confirm" }, { sessionId, value: "true" })).toThrow(
			"Invalid question answer",
		);
		expect(validateQuestionAnswer({ ...question, kind: "confirm" }, { sessionId, value: false })).toBe(false);
	});
	test("rejects malformed envelopes, arrays and oversized requests", () => {
		for (const input of [
			"null",
			"[]",
			"{",
			JSON.stringify({ id: 7, method: "bootstrap", params: {} }),
			JSON.stringify({ id: "x", method: "bootstrap", params: [] }),
		]) {
			expect(() => parseRequest(input)).toThrow();
		}
		expect(() => parseRequest(" ".repeat(MAX_FRAME_BYTES + 1))).toThrow("Request exceeds frame limit");
	});
	test("rejects empty, null-byte and overlong command values", () => {
		for (const value of [null, true, "", "  ", "a\0b", "12345"])
			expect(() => requiredString({ text: value }, "text", 4)).toThrow("Invalid text");
		expect(requiredString({ text: "test" }, "text", 4)).toBe("test");
	});
	test("only serializes visible message text, excluding credentials and reasoning blocks", () => {
		const messages = projectMessages([
			{ role: "system", content: "private instructions" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "toolCall", arguments: { key: "secret" } },
					{ type: "text", text: "Visible" },
				],
				headers: { Authorization: "secret" },
			},
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "result" }], isError: true },
		]);
		expect(messages.map(message => [message.role, message.text])).toEqual([
			["assistant", "Visible"],
			["tool", "result"],
		]);
		expect(messages[1]?.isError).toBe(true);
		expect(JSON.stringify(messages)).not.toContain("secret");
		expect(JSON.stringify(messages)).not.toContain("private");
	});
	test("bounds history and message text", () => {
		const projected = projectMessages(
			Array.from({ length: 200 }, (_, index) => ({ role: "user", content: `${index}:${"x".repeat(20_000)}` })),
		);
		expect(projected).toHaveLength(160);
		expect(projected.every(message => message.text.length <= 8000)).toBe(true);
		expect(projected.every(message => message.truncated === true)).toBe(true);
	});
});

describe("concurrent JSONL transport", () => {
	test("delivers question answers and abort while prompt is unresolved", async () => {
		const prompt = Promise.withResolvers<void>();
		const answered = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const calls: string[] = [];
		const host: ProtocolHost = {
			async handle(command) {
				calls.push(command.method);
				if (command.method === "prompt") await prompt.promise;
				if (command.method === "question.answer") answered.resolve();
				if (command.method === "abort") {
					prompt.resolve();
					aborted.resolve();
				}
			},
			async close() {
				calls.push("close");
				prompt.resolve();
			},
		};
		async function* input() {
			yield encode(request("p", "prompt"));
			yield encode(request("q", "question.answer"));
			await answered.promise;
			yield encode(request("a", "abort"));
			await aborted.promise;
		}
		await serveProtocol(input(), host, () => {});
		expect(calls).toEqual(["prompt", "question.answer", "abort", "close"]);
	});
	test("EOF closes before joining pending prompt so cancellation cannot deadlock", async () => {
		const pending = Promise.withResolvers<void>();
		let cancelled = false;
		const host: ProtocolHost = {
			async handle() {
				await pending.promise;
			},
			async close() {
				cancelled = true;
				pending.resolve();
			},
		};
		async function* input() {
			yield encode(request("p", "prompt"));
		}
		await serveProtocol(input(), host, () => {});
		expect(cancelled).toBe(true);
	});
	test("rejects duplicate in-flight IDs without invoking the command twice", async () => {
		const pending = Promise.withResolvers<void>();
		const frames: DesktopFrame[] = [];
		let count = 0;
		const host: ProtocolHost = {
			async handle() {
				count++;
				await pending.promise;
			},
			async close() {
				pending.resolve();
			},
		};
		async function* input() {
			yield encode(request("same", "prompt"));
			yield encode(request("same", "prompt"));
		}
		await serveProtocol(input(), host, frame => frames.push(frame));
		expect(count).toBe(1);
		expect(frames).toEqual([{ type: "response", id: "same", ok: false, error: "Request ID already in flight" }]);
	});
	test("handles split UTF-8, malformed lines and a final line without newline", async () => {
		const frames: DesktopFrame[] = [];
		const commands: DesktopRequest[] = [];
		const host: ProtocolHost = {
			async handle(command) {
				commands.push(command);
			},
			async close() {},
		};
		const bytes = new TextEncoder().encode(
			`null\n${JSON.stringify({ id: "utf8", method: "prompt", params: { text: "가재" } })}`,
		);
		async function* input() {
			for (const byte of bytes) yield Uint8Array.of(byte);
		}
		await serveProtocol(input(), host, frame => frames.push(frame));
		expect(frames).toEqual([{ type: "fatal", error: "Invalid protocol request" }]);
		expect(commands[0]?.params.text).toBe("가재");
	});
});
