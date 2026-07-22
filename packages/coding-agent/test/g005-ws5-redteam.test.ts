import { describe, expect, test } from "bun:test";
import { entriesFromMessages } from "../src/modes/components/session-observer-overlay";
import {
	buildToolTranscriptEntry,
	composeToolText,
	createToolTranscriptRenderDescriptor,
} from "../src/modes/components/tool-transcript-format";
import { TranscriptViewerOverlay, transcriptViewerEntries } from "../src/modes/components/transcript-viewer-overlay";
import { initTheme } from "../src/modes/theme/theme";
import { TranscriptItemRegistry } from "../src/modes/transcript-item-registry";

initTheme();

const osc52 = "\x1b]52;c;cmF3LWJ5dGVz\x07";
const controls = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

function lines(count: number): string {
	return Array.from({ length: count }, (_, index) => `result-${index}`).join("\n");
}

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function toolPayload(resultText: string) {
	return {
		text: composeToolText({
			name: "bash",
			args: { command: "printf ok" },
			intent: "Run",
			resultText,
			isError: false,
			hasResult: true,
		}),
		metadata: {
			name: "bash",
			arguments: { command: "printf ok" },
			intent: "Run",
			resultText,
			isError: false,
			hasResult: true,
		},
		source: { raw: resultText },
	};
}

function mainTool(resultText: string, id = "tool:stable") {
	const registry = new TranscriptItemRegistry();
	const payload = toolPayload(resultText);
	registry.register({ id, kind: "tool", source: payload, getPayload: () => payload });
	return transcriptViewerEntries(registry)[0]!;
}

function observerTool(resultText: string, id = "stable") {
	return entriesFromMessages([
		{
			id: "call",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id, name: "bash", arguments: { command: "printf ok" }, intent: "Run" }],
			},
		},
		{
			id: "result",
			message: {
				role: "toolResult",
				toolCallId: id,
				toolName: "bash",
				content: [{ type: "text", text: resultText }],
				isError: false,
			},
		},
	] as unknown as Parameters<typeof entriesFromMessages>[0])[0]!;
}

function copiedPayload(entry: ReturnType<typeof mainTool>): string {
	const copied: string[] = [];
	const viewer = new TranscriptViewerOverlay({
		getEntries: () => [entry],
		onClose: () => {},
		copyToClipboard: text => copied.push(text),
	});
	viewer.handleInput("y");
	return copied[0]!;
}

describe("G001 WS5 red-team", () => {
	test("deep-freezes sanitized nested descriptors without prototype pollution", () => {
		const args = JSON.parse(
			'{"nested":{"list":[{"value":"before"}]},"\\u001b[31mkey":"bad","__proto__":{"polluted":true},"constructor":{"nested":"safe"}}',
		);
		const descriptor = createToolTranscriptRenderDescriptor({
			name: "bash",
			args,
			resultContent: "ok",
			hasResult: true,
		});
		expect(Object.isFrozen(descriptor.args)).toBe(true);
		expect(Object.isFrozen((descriptor.args.nested as { list: unknown[] }).list)).toBe(true);
		expect(Object.isFrozen((descriptor.args.nested as { list: Array<{ value: string }> }).list[0])).toBe(true);
		expect(() => {
			(descriptor.args.nested as { list: Array<{ value: string }> }).list[0]!.value = "after";
		}).toThrow();
		expect(() => {
			((descriptor.args.nested as { list: unknown[] }).list as unknown[]).push("after");
		}).toThrow();
		expect((descriptor.args.nested as { list: Array<{ value: string }> }).list[0]!.value).toBe("before");
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
		expect(Object.hasOwn(descriptor.args, "__proto__")).toBe(true);
		// Intentional: prove the pollution-shaped keys stayed OWN properties (no prototype writes).
		expect(Object.getOwnPropertyDescriptor(descriptor.args, "__proto__")?.value).toEqual({ polluted: true });
		expect(Object.getOwnPropertyDescriptor(descriptor.args, "constructor")?.value).toEqual({ nested: "safe" });
	});

	test("recursively sanitizes display values and preserves canonical hostile bytes", () => {
		const hostile = `${osc52}\x1bPpayload\x1b\\\x01`;
		const args = { [`${osc52}key`]: `${osc52}value`, array: [{ deep: osc52 }] };
		const canonical = { text: hostile, metadata: { args, intent: hostile, details: hostile }, source: hostile };
		const descriptor = createToolTranscriptRenderDescriptor({
			name: hostile,
			args,
			intent: hostile,
			details: hostile,
			resultContent: hostile,
			hasResult: true,
		});
		const entry = buildToolTranscriptEntry({
			canonicalPayload: canonical,
			renderDescriptor: descriptor,
			capabilities: { copyable: true, foldable: true, rawViewable: true },
			identity: { id: "tool:hostile", label: "bash" },
		});
		expect(entry.payload).toBe(canonical);
		expect(entry.payload.text).toBe(hostile);
		expect(entry.getDisplayText!(true)).not.toMatch(controls);
		expect(JSON.stringify(descriptor)).not.toMatch(controls);
	});

	test("copies raw OSC52 bytes from both adapter surfaces without rendering them", () => {
		const result = `visible ${osc52} tail`;
		const main = mainTool(result);
		const observer = observerTool(result);
		expect(copiedPayload(main)).toBe(main.payload.text);
		expect(copiedPayload(observer as ReturnType<typeof mainTool>)).toBe(observer.payload.text);
		expect(main.payload.text).toContain(osc52);
		expect(observer.payload.text).toContain(osc52);
		expect(main.getDisplayText!(true)).not.toContain(osc52);
		expect(observer.getDisplayText!(true)).not.toContain(osc52);
	});

	test("enforces the main source cap and preserves the observer's single rendered-line cap", () => {
		for (const count of [99, 100, 101, 5000]) {
			const main = mainTool(lines(count));
			expect(main.getDisplayText!(false)).toBe("printf ok\nRun");
			const expanded = main.getDisplayText!(true);
			expect(expanded).toContain("result-0");
			expect(expanded).toContain(`result-${Math.min(count, 100) - 1}`);
			if (count > 100) expect(expanded).toEndWith(`... ${count - 100} more lines`);
			else expect(expanded).not.toContain("more lines");

			const observer = observerTool(lines(count));
			expect(observer.getDisplayText!(false)).toBe(observer.payload.text);
			expect(observer.getDisplayText!(true)).toBe(observer.payload.text);

			const render = (entry: typeof observer) => {
				const viewer = new TranscriptViewerOverlay({
					getEntries: () => [entry],
					onClose: () => {},
					maxExpandedLines: 100,
					enterExpands: true,
				});
				viewer.handleInput(" ");
				viewer.handleInput("G");
				return viewer.render(400).join("\n");
			};
			const preChange = { ...observer, getDisplayText: undefined };
			const rendered = render(observer);
			expect(rendered).toBe(render(preChange));
			const visible = stripAnsi(rendered);
			expect(visible).toContain(`... ${count - 98} more lines`);
			expect(visible).toContain("result-97");
			expect(visible).not.toContain("result-98");
		}
	});

	test("leaves non-tool payload projections byte-identical", () => {
		const registry = new TranscriptItemRegistry();
		const read = "read\x1b]52;c;raw\x07";
		const response = "response\x1b]52;c;raw\x07";
		registry.coalesceReadGroup("group", { text: read });
		registry.register({ id: "entry:assistant:content:0", kind: "assistant-text", source: { text: response } });
		const before = registry.items().flatMap(item => {
			const payload = registry.resolveSourcePayload(item.id);
			return payload ? [payload] : [];
		});
		const after = transcriptViewerEntries(registry).map(entry => entry.payload);
		expect(after).toEqual(before);
		expect(after.map(payload => payload.text)).toEqual([read, response]);
	});

	test("keeps tool identity stable so fold state survives rebuilt entries", () => {
		let entry = mainTool("one", "tool:call-id");
		const viewer = new TranscriptViewerOverlay({ getEntries: () => [entry], onClose: () => {} });
		expect(entry.id).toBe("tool:call-id");
		viewer.handleInput(" ");
		entry = mainTool("two", "tool:call-id");
		viewer.refresh();
		expect(viewer.selectedEntryId).toBe("tool:call-id");
		expect(viewer.render(200).join("\n")).toContain("two");
	});
});
