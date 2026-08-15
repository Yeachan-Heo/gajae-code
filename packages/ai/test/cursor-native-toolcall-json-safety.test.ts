import { describe, expect, it } from "bun:test";
import { buildNativeToolCallBlock, cursorJsonSafeValueForTest } from "../src/providers/cursor";

/**
 * Cursor native tool calls arrive as protobuf-es payloads carrying
 * `$typeName` markers, `bigint` fields, and `Uint8Array` blobs. Those values
 * must never leak into assistant toolCall `arguments`: staged managed
 * snapshots, JSONL transcript persistence, and provider replay all require
 * plain `JSON.stringify`-safe data (issue #4578 producer boundary).
 */
describe("cursor native toolCall JSON safety", () => {
	it("converts protobuf payload values into plain JSON-safe data", () => {
		const converted = cursorJsonSafeValueForTest({
			$typeName: "agent.v1.ShellToolCallArgs",
			command: "ls -la",
			fileOutputThresholdBytes: 4096n,
			fileSize: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
			blob: Uint8Array.from([104, 105]),
			nested: [{ $typeName: "agent.v1.Inner", durationMs: 12n }],
			when: new Date(1755216000000),
		}) as Record<string, unknown>;
		expect(converted).toEqual({
			command: "ls -la",
			fileOutputThresholdBytes: 4096,
			fileSize: "9007199254740992",
			blob: Buffer.from("hi").toString("base64"),
			nested: [{ durationMs: 12 }],
			when: new Date(1755216000000).toISOString(),
		});
		expect(JSON.parse(JSON.stringify(converted))).toEqual(converted);
	});

	it("collapses cycles and non-data leaves instead of throwing", () => {
		const cyclic: Record<string, unknown> = { fn: () => "x" };
		cyclic.self = cyclic;
		const converted = cursorJsonSafeValueForTest(cyclic) as Record<string, unknown>;
		expect(converted).toEqual({ fn: null, self: null });
	});

	it("builds native toolCall blocks with JSON-serializable arguments", () => {
		const block = buildNativeToolCallBlock(
			{
				shellToolCall: {
					$typeName: "agent.v1.ShellToolCall",
					args: {
						$typeName: "agent.v1.ShellToolCallArgs",
						command: "echo hello",
						timeoutMs: 30000,
						fileOutputThresholdBytes: 65536n,
					},
				},
			},
			"call-1",
			0,
		);
		expect(block).toMatchObject({
			type: "toolCall",
			id: "call-1",
			name: "bash",
			arguments: { command: "echo hello", timeoutMs: 30000, fileOutputThresholdBytes: 65536 },
		});
		expect(JSON.parse(JSON.stringify(block?.arguments))).toEqual(block?.arguments);
	});

	it("wraps argument-less payloads as JSON-safe raw records", () => {
		const block = buildNativeToolCallBlock(
			{ readLintsToolCall: { $typeName: "agent.v1.ReadLintsToolCall", sizeBytes: 12n } },
			"call-2",
			1,
		);
		expect(block).toMatchObject({
			type: "toolCall",
			id: "call-2",
			name: "read_lints",
		});
		expect(JSON.parse(JSON.stringify(block?.arguments))).toEqual(block?.arguments);
	});
});
