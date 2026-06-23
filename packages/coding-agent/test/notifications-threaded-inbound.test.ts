import { describe, expect, test } from "bun:test";
import { decideThreadedInbound, type ThreadedInboundCtx } from "../src/notifications/threaded-inbound";

function ctx(overrides: Partial<ThreadedInboundCtx> = {}): ThreadedInboundCtx {
	return {
		pairedChatId: "42",
		topicToSession: (t: string) => (t === "topic-1" ? "sess-1" : undefined),
		isDuplicate: () => false,
		...overrides,
	};
}

describe("decideThreadedInbound (fail-closed injection)", () => {
	test("injects a valid first-seen text message in a known topic of the paired chat", () => {
		const decision = decideThreadedInbound(
			{ update_id: 7, message: { text: "keep going", chat: { id: 42 }, message_thread_id: "topic-1" } },
			ctx(),
		);
		expect(decision).toEqual({
			kind: "inject",
			sessionId: "sess-1",
			text: "keep going",
			updateId: 7,
			threadId: "topic-1",
		});
	});

	test("ignores updates from a non-paired chat", () => {
		const decision = decideThreadedInbound(
			{ update_id: 7, message: { text: "hi", chat: { id: 999 }, message_thread_id: "topic-1" } },
			ctx(),
		);
		expect(decision).toEqual({ kind: "ignore", reason: "wrong_chat" });
	});

	test("ignores messages without a topic (no injection outside a session thread)", () => {
		const decision = decideThreadedInbound({ update_id: 7, message: { text: "hi", chat: { id: 42 } } }, ctx());
		expect(decision).toEqual({ kind: "ignore", reason: "no_topic" });
	});

	test("ignores unknown topics that map to no session", () => {
		const decision = decideThreadedInbound(
			{ update_id: 7, message: { text: "hi", chat: { id: 42 }, message_thread_id: "topic-unknown" } },
			ctx(),
		);
		expect(decision).toEqual({ kind: "ignore", reason: "unknown_topic" });
	});

	test("treats a replayed update_id as a duplicate", () => {
		const decision = decideThreadedInbound(
			{ update_id: 7, message: { text: "hi", chat: { id: 42 }, message_thread_id: "topic-1" } },
			ctx({ isDuplicate: (id: number) => id === 7 }),
		);
		expect(decision).toEqual({ kind: "duplicate", updateId: 7 });
	});

	test("ignores updates missing an update_id (cannot dedupe)", () => {
		const decision = decideThreadedInbound(
			{ message: { text: "hi", chat: { id: 42 }, message_thread_id: "topic-1" } },
			ctx(),
		);
		expect(decision).toEqual({ kind: "ignore", reason: "missing_update_id" });
	});

	test("ignores empty/whitespace text", () => {
		const decision = decideThreadedInbound(
			{ update_id: 7, message: { text: "   ", chat: { id: 42 }, message_thread_id: "topic-1" } },
			ctx(),
		);
		expect(decision).toEqual({ kind: "ignore", reason: "empty_text" });
	});

	test("accepts numeric chat id and numeric thread id forms", () => {
		const decision = decideThreadedInbound(
			{ update_id: 8, message: { text: "go", chat: { id: 42 }, message_thread_id: 1 } },
			ctx({ topicToSession: (t: string) => (t === "1" ? "sess-x" : undefined) }),
		);
		expect(decision).toEqual({ kind: "inject", sessionId: "sess-x", text: "go", updateId: 8, threadId: "1" });
	});

	test("injects a photo-only message with an image attachment and empty text", () => {
		const decision = decideThreadedInbound(
			{
				update_id: 9,
				message: {
					chat: { id: 42 },
					message_thread_id: "topic-1",
					photo: [
						{ file_id: "small", width: 90, height: 90 },
						{ file_id: "large", width: 1280, height: 1280 },
					],
				},
			},
			ctx(),
		);
		expect(decision).toEqual({
			kind: "inject",
			sessionId: "sess-1",
			text: "",
			updateId: 9,
			threadId: "topic-1",
			attachment: { fileId: "large", kind: "photo", mime: "image/jpeg" },
		});
	});

	test("injects a document using its caption as text plus a document attachment", () => {
		const decision = decideThreadedInbound(
			{
				update_id: 10,
				message: {
					chat: { id: 42 },
					message_thread_id: "topic-1",
					caption: "  see attached  ",
					document: { file_id: "doc-1", mime_type: "application/pdf", file_name: "report.pdf" },
				},
			},
			ctx(),
		);
		expect(decision).toEqual({
			kind: "inject",
			sessionId: "sess-1",
			text: "see attached",
			updateId: 10,
			threadId: "topic-1",
			attachment: { fileId: "doc-1", kind: "document", mime: "application/pdf", fileName: "report.pdf" },
		});
	});
});
