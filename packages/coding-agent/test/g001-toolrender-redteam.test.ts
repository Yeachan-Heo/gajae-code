import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionObserverOverlayComponent } from "../src/modes/components/session-observer-overlay";
import {
	composeToolResult,
	formatToolArgs,
	TOOL_RESULT_MAX_EXPANDED_LINES,
	toolDisplayText,
} from "../src/modes/components/tool-transcript-format";
import { TranscriptViewerOverlay, transcriptViewerEntries } from "../src/modes/components/transcript-viewer-overlay";
import type { ObservableSession, SessionObserverRegistry } from "../src/modes/session-observer-registry";
import { initTheme } from "../src/modes/theme/theme";
import { TranscriptItemRegistry } from "../src/modes/transcript-item-registry";

initTheme();

const call = { name: "read", args: { path: "src/file.ts" }, intent: "Inspect file" };

function fields(resultText: string, overrides: Partial<{ hasResult: boolean; isError: boolean; intent: string }> = {}) {
	return { ...call, resultText, hasResult: true, isError: false, ...overrides };
}

function registryWithTool(metadata: Record<string, unknown>, id = "tool:redteam") {
	const registry = new TranscriptItemRegistry();
	registry.register({
		id,
		kind: "tool",
		source: id,
		getPayload: () => ({ text: "canonical payload", metadata, source: id }),
	});
	return registry;
}

function observerRegistry(session: ObservableSession) {
	return {
		getSessions: () => [session],
		onChange: () => () => {},
		setMainSession: () => {},
		getActiveSubagentCount: () => 1,
	} as unknown as SessionObserverRegistry;
}

function observerText(resultText: string, isError: boolean, hasResult = true): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g001-observer-"));
	try {
		const now = new Date().toISOString();
		const message = (id: string, value: object) => ({
			type: "message",
			id,
			parentId: null,
			timestamp: now,
			message: value,
		});
		const file = path.join(dir, "session.jsonl");
		const messages = [
			{ type: "session", version: 3, id: "session", timestamp: now },
			message("call", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tool", name: call.name, arguments: call.args, intent: call.intent }],
				timestamp: Date.now(),
			}),
		];
		if (hasResult)
			messages.push(
				message("result", {
					role: "toolResult",
					toolCallId: "tool",
					toolName: "read",
					content: resultText ? [{ type: "text", text: resultText }] : [],
					isError,
					timestamp: Date.now(),
				}),
			);
		fs.writeFileSync(file, `${messages.map(message => JSON.stringify(message)).join("\n")}\n`);
		const overlay = new SessionObserverOverlayComponent(observerRegistry({
			id: "session",
			kind: "subagent",
			label: "Session",
			status: "active",
			sessionFile: file,
			lastUpdate: 1,
		}), () => {}, ["ctrl+s"]);
		// The observer does not expose a clipboard seam; inspect its public rendered payload instead.
		const rendered = overlay.render(200).join("\n");
		return rendered
			.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
			.split("\n")
			.map(line => line.trimStart())
			.join("\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("G001 red-team: shared formatter and adapters", () => {
	test("distinguishes every result state and trims boundary whitespace without losing interior lines", () => {
		expect(composeToolResult(fields("ignored", { hasResult: false }))).toBe("⏳ pending");
		expect(composeToolResult(fields(" \t\n ", { isError: false }))).toBe("✓ done");
		expect(composeToolResult(fields(" \t\n ", { isError: true }))).toBe("✗ Error");
		expect(composeToolResult(fields("\n completed \n"))).toBe("completed");
		expect(composeToolResult(fields("\nfirst\nsecond\n"))).toBe("first\nsecond");
		expect(composeToolResult(fields("\nfailed\nreason\n", { isError: true }))).toBe("✗ failed\nreason");
	});

	test("rejects malformed special-tool arguments and bounds generic argument text", () => {
		expect(formatToolArgs("read", {})).toBe("");
		expect(formatToolArgs("write", { path: "" })).toBe("");
		expect(formatToolArgs("edit", { path: null })).toBe("");
		expect(formatToolArgs("bash", { command: 42 })).toBe("");
		expect(formatToolArgs("bash", { command: "a\tb\t" })).toBe("a    b    ");
		expect(formatToolArgs("search", { pattern: "needle", paths: "src" })).toBe("pattern: needle");
		const generic = formatToolArgs("custom", { _secret: "hidden", bool: true, nil: null, list: [1, "x"] });
		expect(generic).toBe('bool: true, nil: null, list: [1,"x"]');
		expect(formatToolArgs("custom", { value: "x".repeat(600) })).toHaveLength(500);
	});

	test("caps only expanded result source lines at exactly 100 and preserves every call line", () => {
		const lineResult = (count: number) => Array.from({ length: count }, (_, index) => `line-${index}`).join("\n");
		const manyCallLines = {
			...fields(lineResult(100)),
			args: { command: "echo ok" },
			name: "bash",
			intent: "intent-a\nintent-b\nintent-c",
		};
		const callLines = toolDisplayText(manyCallLines, false).split("\n");
		expect(toolDisplayText(manyCallLines, false)).toBe(callLines.join("\n"));
		expect(toolDisplayText(manyCallLines, true).split("\n")).toHaveLength(callLines.length + 100);
		expect(toolDisplayText({ ...manyCallLines, resultText: lineResult(101) }, true).split("\n")).toHaveLength(
			callLines.length + 101,
		);
		expect(toolDisplayText({ ...manyCallLines, resultText: lineResult(101) }, true)).toEndWith("... 1 more lines");
		const massive = toolDisplayText({ ...manyCallLines, resultText: lineResult(100_000) }, true);
		expect(massive.split("\n")).toHaveLength(callLines.length + TOOL_RESULT_MAX_EXPANDED_LINES + 1);
		expect(massive).toEndWith("... 99900 more lines");
		expect(toolDisplayText(fields("single"), true)).not.toContain("more lines");
	});

	test("adapter tolerates incomplete tool metadata and does not add display callbacks to non-tools", () => {
		const incomplete = registryWithTool({ arguments: undefined, resultText: "", isError: false, hasResult: true });
		const incompleteEntry = transcriptViewerEntries(incomplete)[0];
		expect(incompleteEntry?.label).toBe("Tool");
		expect(incompleteEntry?.payload.text).toBe("canonical payload");
		expect(incompleteEntry?.getDisplayText).toBeUndefined();

		const registry = new TranscriptItemRegistry();
		registry.register({ id: "user", kind: "user", source: { text: "hello" } });
		registry.register({ id: "thinking", kind: "assistant-thinking", source: { text: "think" } });
		expect(transcriptViewerEntries(registry).every(entry => entry.getDisplayText === undefined)).toBe(true);
	});

	test("observer present-result rendering retains pre-change golden payload text", () => {
		const golden = [
			{ resultText: "success", isError: false, expected: "path: src/file.ts\nInspect file\nsuccess" },
			{ resultText: "", isError: false, expected: "path: src/file.ts\nInspect file\n✓ done" },
			{ resultText: "failed", isError: true, expected: "path: src/file.ts\nInspect file\n✗ failed" },
			{ resultText: "", isError: true, expected: "path: src/file.ts\nInspect file\n✗ Error" },
		];
		for (const fixture of golden) {
			const rendered = observerText(fixture.resultText, fixture.isError);
			expect(rendered).toContain(fixture.expected);
		}
		expect(observerText("ignored", false, false)).toContain("path: src/file.ts\nInspect file\n⏳ pending");
	});

	test("sanitizes ANSI chrome while retaining CJK and line-based caps", () => {
		const resultText = ["結果 漢字 😀", "\x1b]52;c;clipboard\x07", "\x1b[31mred\x1b[0m"]
			.concat(Array.from({ length: 101 }, (_, index) => `行-${index}`))
			.join("\n");
		const registry = registryWithTool({
			name: "bash",
			arguments: { command: "echo" },
			resultText,
			isError: false,
			hasResult: true,
		});
		const entry = transcriptViewerEntries(registry)[0];
		expect(entry?.getDisplayText?.(true).split("\n")).toHaveLength(102);
		const viewer = new TranscriptViewerOverlay({
			getEntries: () => transcriptViewerEntries(registry),
			onClose: () => {},
		});
		viewer.handleInput(" ");
		const rendered = viewer.render(120).join("\n");
		expect(rendered).toContain("結果 漢字");
		expect(rendered).not.toContain("\x1b]52;");
		expect(rendered).not.toContain("\x1b[31m");
	});
});
