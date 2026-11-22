import { describe, expect, test } from "bun:test";
import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolCall } from "@gajae-code/desktop-host/tool-protocol";
import { groupTranscript, toolRunKinds, transcriptAnchorIndex } from "../src/transcript-groups";

const row = (id: string): DesktopMessage => ({ id, role: "assistant", text: `answer ${id}` });
const call = (
	id: string,
	callId: string,
	status: DesktopToolCall["status"],
	family: DesktopToolCall["family"] = "read",
): DesktopMessage => ({
	id,
	role: "tool",
	toolName: "read",
	text: "",
	tool: { callId, status, family, detail: false },
});
const reasoning = (id: string): DesktopMessage => ({
	id,
	role: "assistant",
	text: "",
	blocks: [{ type: "thinking", text: "next, check the caller" }],
});
const typedShell = (id: string): DesktopMessage => ({ id, role: "tool", toolName: "Direct shell", text: "ls" });
const shape = (items: ReturnType<typeof groupTranscript>) =>
	items.map(item => [item.key, item.tools, item.messages.map(message => message.id)]);

describe("transcript entries", () => {
	test("render the newest rows one message per entry, keyed by message id", () => {
		const messages = ["0:1", "1:2", "2:3", "3:4"].map(row);
		const items = groupTranscript(messages, 3);
		expect(items.map(item => item.key)).toEqual(["1:2", "2:3", "3:4"]);
		expect(items.map(item => item.messages)).toEqual([[messages[1]], [messages[2]], [messages[3]]]);
		expect(items.every(item => !item.tools)).toBe(true);
		expect(groupTranscript(messages, 100).map(item => item.key)).toEqual(["0:1", "1:2", "2:3", "3:4"]);
	});

	test("a call keeps one key from its running row to its settled result", () => {
		const running = groupTranscript([row("0:1"), call("call:toolu_1", "toolu_1", "running")], 100);
		const settled = groupTranscript([row("0:1"), call("1:5", "toolu_1", "done")], 100);
		expect(running.map(item => item.key)).toEqual(["0:1", "tool:toolu_1"]);
		expect(settled.map(item => item.key)).toEqual(["0:1", "tool:toolu_1"]);
		expect(running[1]?.memberKeys).toEqual(settled[1]?.memberKeys);
	});

	test("a repeated call id falls back to message ids across the whole transcript, not only the rendered tail", () => {
		const messages = [
			call("0:1", "dup", "done"),
			row("1:2"),
			call("2:3", "dup", "failed"),
			call("3:4", "solo", "done"),
		];
		const items = groupTranscript(messages, 100);
		expect(shape(items)).toEqual([
			["0:1", true, ["0:1"]],
			["1:2", false, ["1:2"]],
			["2:3", true, ["2:3", "3:4"]],
		]);
		expect(items[2]?.memberKeys).toEqual(["2:3", "tool:solo"]);
		expect(groupTranscript(messages, 2).map(item => item.key)).toEqual(["2:3"]);
	});

	test("an anchor key resolves to its message index", () => {
		const messages = [row("0:1"), call("1:2", "toolu_1", "done"), row("2:3")];
		expect(transcriptAnchorIndex(messages, "0:1")).toBe(0);
		expect(transcriptAnchorIndex(messages, "tool:toolu_1")).toBe(1);
		expect(transcriptAnchorIndex(messages, "1:2")).toBe(-1);
		expect(transcriptAnchorIndex(messages, "missing")).toBe(-1);
	});
});

describe("tool runs", () => {
	test("consecutive calls and the reasoning-only rows between them fold into one run", () => {
		const messages = [
			row("0:1"),
			reasoning("1:2"),
			call("2:3", "a", "done"),
			reasoning("3:4"),
			call("4:5", "b", "done", "shell"),
			call("5:6", "c", "failed", "shell"),
			reasoning("6:7"),
			row("7:8"),
		];
		expect(shape(groupTranscript(messages, 100))).toEqual([
			["0:1", false, ["0:1"]],
			["1:2", false, ["1:2"]],
			["tool:a", true, ["2:3", "3:4", "4:5", "5:6"]],
			["6:7", false, ["6:7"]],
			["7:8", false, ["7:8"]],
		]);
	});

	test("answers, notices and typed shell rows end a run and are never folded into one", () => {
		const notice: DesktopMessage = { id: "notice", role: "system", text: "Model changed" };
		const messages = [
			call("0:1", "a", "done"),
			typedShell("1:2"),
			call("2:3", "b", "done"),
			notice,
			call("3:4", "c", "done"),
			row("4:5"),
			call("5:6", "d", "done"),
		];
		expect(shape(groupTranscript(messages, 100))).toEqual([
			["tool:a", true, ["0:1"]],
			["1:2", false, ["1:2"]],
			["tool:b", true, ["2:3"]],
			["notice", false, ["notice"]],
			["tool:c", true, ["3:4"]],
			["4:5", false, ["4:5"]],
			["tool:d", true, ["5:6"]],
		]);
	});

	test("a run keeps its first call's key as it grows and as its newest call settles", () => {
		const first = [row("0:1"), call("1:2", "a", "done")];
		const growing = [...first, call("call:b", "b", "running")];
		const settled = [...first, call("2:3", "b", "done")];
		for (const messages of [first, growing, settled]) {
			const items = groupTranscript(messages, 100);
			expect(items.map(item => item.key)).toEqual(["0:1", "tool:a"]);
			expect(transcriptAnchorIndex(messages, items[1]!.key)).toBe(1);
		}
		expect(groupTranscript(growing, 100)[1]?.memberKeys).toEqual(["tool:a", "tool:b"]);
		expect(groupTranscript(settled, 100)[1]?.memberKeys).toEqual(["tool:a", "tool:b"]);
	});

	test("a run that starts before the rendered tail is included whole", () => {
		const messages = [row("0:1"), call("1:2", "a", "done"), call("2:3", "b", "done"), call("3:4", "c", "done")];
		expect(shape(groupTranscript(messages, 2))).toEqual([["tool:a", true, ["1:2", "2:3", "3:4"]]]);
		expect(groupTranscript(messages, 0)).toEqual([]);
	});

	test("a run's kinds count calls per family in order of first appearance", () => {
		expect(
			toolRunKinds([
				call("1", "a", "done", "read"),
				call("2", "b", "done", "shell"),
				call("3", "c", "done", "read"),
				call("4", "d", "done", "read"),
				call("5", "e", "failed", "edit"),
			]),
		).toBe("3 reads, 1 command, 1 edit");
	});
});
