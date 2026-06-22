import { describe, expect, test } from "bun:test";
import {
	asksFromAskInput,
	idleDedupeKey,
	notificationActionPayload,
	summaryFromMessage,
	truncate,
} from "../src/notifications/helpers";

describe("notifications helpers", () => {
	test("truncate keeps short strings and ellipsizes long ones", () => {
		expect(truncate("hello", 10)).toBe("hello");
		expect(truncate("hello world", 5)).toBe("hell\u2026");
		expect(truncate("x", 0)).toBe("");
	});

	test("idleDedupeKey is stable per session+turn", () => {
		expect(idleDedupeKey("s1", 3)).toBe("s1#3");
		expect(idleDedupeKey("s1", 3)).toBe(idleDedupeKey("s1", 3));
		expect(idleDedupeKey("s1", 4)).not.toBe(idleDedupeKey("s1", 3));
	});

	test("asksFromAskInput extracts questions, options, and namespaced ids", () => {
		const input = {
			questions: [
				{ id: "q1", question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] },
				{ id: "q2", question: "Pick env", options: [{ label: "prod" }] },
			],
		};
		const asks = asksFromAskInput("tc-1", input);
		expect(asks).toEqual([
			{ id: "tc-1:q1", question: "Proceed?", options: ["Yes", "No"] },
			{ id: "tc-1:q2", question: "Pick env", options: ["prod"] },
		]);
	});

	test("asksFromAskInput is defensive about bad shapes", () => {
		expect(asksFromAskInput("tc", undefined)).toEqual([]);
		expect(asksFromAskInput("tc", {})).toEqual([]);
		expect(asksFromAskInput("tc", { questions: "nope" })).toEqual([]);
		// missing id falls back to index; missing options -> empty array
		const asks = asksFromAskInput("tc", { questions: [{ question: "Q" }] });
		expect(asks).toEqual([{ id: "tc:0", question: "Q", options: [] }]);
	});

	test("summaryFromMessage extracts text from string or content blocks", () => {
		expect(summaryFromMessage({ content: "done" })).toBe("done");
		expect(
			summaryFromMessage({
				content: [
					{ type: "text", text: "hello " },
					{ type: "image", url: "x" },
					{ type: "text", text: "world" },
				],
			}),
		).toBe("hello world");
		expect(summaryFromMessage({ content: [] })).toBeUndefined();
		expect(summaryFromMessage(undefined)).toBeUndefined();
		expect(summaryFromMessage({ content: "   " })).toBeUndefined();
	});

	test("summaryFromMessage truncates long content", () => {
		const long = "a".repeat(500);
		const out = summaryFromMessage({ content: long }, 280);
		expect(out).toBeDefined();
		expect(out?.length).toBe(280);
		expect(out?.endsWith("\u2026")).toBe(true);
	});

	test("notificationActionPayload delegates redaction while preserving option count", () => {
		const ask = notificationActionPayload(
			{
				id: "ask-1",
				kind: "ask",
				sessionId: "session-secret",
				question: "Deploy prod with secret TOKEN?",
				options: ["Deploy prod", "Cancel"],
			},
			{ redact: true, sessionTag: "secret" },
		);

		expect(ask.question).not.toContain("TOKEN");
		expect(ask.options).toEqual(["1", "2"]);

		const idle = notificationActionPayload(
			{ id: "idle-1", kind: "idle", sessionId: "session-secret", summary: "sensitive summary" },
			{ redact: true, sessionTag: "secret" },
		);
		expect(idle.summary).toBeUndefined();
	});
});
