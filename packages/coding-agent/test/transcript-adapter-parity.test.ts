import { expect, test } from "bun:test";
import { entriesFromMessages } from "../src/modes/components/session-observer-overlay";
import { composeToolText } from "../src/modes/components/tool-transcript-format";
import { transcriptViewerEntries } from "../src/modes/components/transcript-viewer-overlay";
import { TranscriptItemRegistry } from "../src/modes/transcript-item-registry";

const hostileResult = "result\x1b]52;c;clipboard\x07\x1bPdata\x1b\\\x1b[2J\x01\x80";
const fields = {
	name: "bash",
	args: { command: "printf hostile" },
	intent: "Inspect hostile bytes",
	resultText: hostileResult,
	isError: true,
	hasResult: true,
};
const hostileDetails = {
	diff: "--- a/file\n+++ b/file\n\x1b]52;c;clipboard\x07",
	perFileResults: [{ path: "src/\x1b[31mfile.ts", diff: "\x1bPdata\x1b\\" }],
};

test("tool adapters preserve canonical bytes and use sanitized frozen display descriptors", () => {
	const canonical = composeToolText(fields);
	const registry = new TranscriptItemRegistry();
	registry.register({
		id: "tool:call",
		kind: "tool",
		source: fields,
		getPayload: () => ({
			text: canonical,
			metadata: {
				name: fields.name,
				arguments: fields.args,
				intent: fields.intent,
				resultText: fields.resultText,
				isError: fields.isError,
				hasResult: fields.hasResult,
				detailsData: hostileDetails,
			},
			source: fields,
		}),
	});
	const main = transcriptViewerEntries(registry)[0]!;
	const observer = entriesFromMessages([
		{
			id: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call", name: fields.name, arguments: fields.args, intent: fields.intent },
				],
			},
		},
		{
			id: "result",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: fields.name,
				content: [{ type: "text", text: fields.resultText }],
				isError: fields.isError,
				details: hostileDetails,
			},
		},
	] as unknown as Parameters<typeof entriesFromMessages>[0])[0]!;

	expect(main.label).toBe(observer.label);
	expect(main.payload.text).toBe(canonical);
	expect(observer.payload.text).toBe(canonical);
	expect(main.payload.text).toContain("\x1b]52;c;clipboard\x07");
	expect(observer.payload.text).toContain("\x1b]52;c;clipboard\x07");
	expect(JSON.stringify(main.payload.metadata)).toBe(JSON.stringify(observer.payload.metadata));
	expect(main.getDisplayText?.(true)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
	expect(observer.getDisplayText?.(true)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
	expect(main.renderDescriptor?.detailsData).toEqual(observer.renderDescriptor?.detailsData);
	expect(JSON.stringify(main.renderDescriptor?.detailsData)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
	expect(Object.isFrozen(main.renderDescriptor?.detailsData as object)).toBe(true);
	expect(Object.isFrozen((main.renderDescriptor?.detailsData as { perFileResults: unknown[] }).perFileResults)).toBe(
		true,
	);
});
