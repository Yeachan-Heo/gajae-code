import { describe, expect, test } from "bun:test";
import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolCall } from "@gajae-code/desktop-host/tool-protocol";
import { groupTranscript, transcriptAnchorIndex } from "../src/transcript-groups";

const row = (id: string): DesktopMessage => ({ id, role: "assistant", text: `answer ${id}` });
const call = (id: string, callId: string, status: DesktopToolCall["status"]): DesktopMessage => ({
	id,
	role: "tool",
	toolName: "read",
	text: "",
	tool: { callId, status, family: "read", detail: false },
});

describe("transcript entries", () => {
	test("render the newest rows one message per entry, keyed by message id", () => {
		const messages = ["0:1", "1:2", "2:3", "3:4"].map(row);
		const items = groupTranscript(messages, 3);
		expect(items.map(item => item.key)).toEqual(["1:2", "2:3", "3:4"]);
		expect(items.map(item => item.messages)).toEqual([[messages[1]], [messages[2]], [messages[3]]]);
		expect(groupTranscript(messages, 100).map(item => item.key)).toEqual(["0:1", "1:2", "2:3", "3:4"]);
	});

	test("a call keeps one key from its running row to its settled result", () => {
		const running = groupTranscript([row("0:1"), call("call:toolu_1", "toolu_1", "running")], 100);
		const settled = groupTranscript([row("0:1"), call("1:5", "toolu_1", "done")], 100);
		expect(running.map(item => item.key)).toEqual(["0:1", "tool:toolu_1"]);
		expect(settled.map(item => item.key)).toEqual(["0:1", "tool:toolu_1"]);
	});

	test("a repeated call id falls back to message ids across the whole transcript, not only the rendered tail", () => {
		const messages = [
			call("0:1", "dup", "done"),
			row("1:2"),
			call("2:3", "dup", "failed"),
			call("3:4", "solo", "done"),
		];
		expect(groupTranscript(messages, 100).map(item => item.key)).toEqual(["0:1", "1:2", "2:3", "tool:solo"]);
		expect(groupTranscript(messages, 2).map(item => item.key)).toEqual(["2:3", "tool:solo"]);
	});

	test("an anchor key resolves to its message index", () => {
		const messages = [row("0:1"), call("1:2", "toolu_1", "done"), row("2:3")];
		expect(transcriptAnchorIndex(messages, "0:1")).toBe(0);
		expect(transcriptAnchorIndex(messages, "tool:toolu_1")).toBe(1);
		expect(transcriptAnchorIndex(messages, "1:2")).toBe(-1);
		expect(transcriptAnchorIndex(messages, "missing")).toBe(-1);
	});
});
