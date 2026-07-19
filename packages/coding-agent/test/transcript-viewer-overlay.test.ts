import { describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import {
	type TranscriptViewerEntry,
	TranscriptViewerOverlay,
	transcriptViewerEntries,
} from "../src/modes/components/transcript-viewer-overlay";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { initTheme } from "../src/modes/theme/theme";
import { TranscriptItemRegistry } from "../src/modes/transcript-item-registry";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { associateSessionMessageEntryId, SessionManager } from "../src/session/session-manager";

initTheme();

function harness() {
	const registry = new TranscriptItemRegistry();
	registry.register({
		id: "one",
		kind: "custom",
		source: { text: "# **first**\nline two", command: "echo one" },
		capabilities: { foldable: true },
	});
	registry.register({
		id: "two",
		kind: "custom",
		source: { text: "second entry", command: "echo two" },
		capabilities: { foldable: true },
	});
	const copied: string[] = [];
	let closed = 0;
	let renders = 0;
	const viewer = new TranscriptViewerOverlay({
		getEntries: () => transcriptViewerEntries(registry),
		onClose: () => {
			closed += 1;
		},
		requestRender: () => {
			renders += 1;
		},
		copyToClipboard: text => copied.push(text),
	});
	return {
		viewer,
		copied,
		get closed() {
			return closed;
		},
		get renders() {
			return renders;
		},
	};
}

describe("TranscriptViewerOverlay", () => {
	test("selects entries and expands/collapses without changing the inline transcript", () => {
		const h = harness();
		expect(h.viewer.selectedEntryId).toBe("one");
		h.viewer.handleInput("j");
		expect(h.viewer.selectedEntryId).toBe("two");
		h.viewer.handleInput(" ");
		expect(h.viewer.render(100).join("\n")).toContain("second entry");
		h.viewer.handleInput(" ");
		expect(h.renders).toBeGreaterThan(2);
	});

	test("copies content and metadata through the injected clipboard seam", () => {
		const h = harness();
		h.viewer.handleInput("y");
		h.viewer.handleInput("Y");
		expect(h.copied[0]).toBe("# **first**\nline two");
		expect(h.copied[1]).toContain('"command": "echo one"');
	});

	test("raw rendering toggles and fullscreen closes back to the viewer", () => {
		const h = harness();
		h.viewer.handleInput(" ");
		const renderedMarkdown = h.viewer.render(100).join("\n");
		h.viewer.handleInput("r");
		const renderedRaw = h.viewer.render(100).join("\n");
		expect(renderedRaw).not.toBe(renderedMarkdown);
		h.viewer.handleInput("\n");
		expect(h.viewer.isFullscreen).toBe(true);
		h.viewer.handleInput("\x1b");
		expect(h.viewer.isFullscreen).toBe(false);
	});

	test("close delegates restore work to its host and forces a render request", () => {
		const h = harness();
		h.viewer.handleInput("\x1b");
		expect(h.closed).toBe(1);
	});
});

test("SelectorController injects clipboard and restores the editor once when the viewer closes", () => {
	const registry = new TranscriptItemRegistry();
	registry.register({ id: "entry", kind: "custom", source: { text: "copied" } });
	const hide = vi.fn();
	let viewer: TranscriptViewerOverlay | undefined;
	const ui = {
		showOverlay: vi.fn((component: unknown) => {
			viewer = component as TranscriptViewerOverlay;
			return { hide };
		}),
		setFocus: vi.fn(),
		requestRender: vi.fn(),
	};
	const editor = {};
	const copied = vi.fn();
	const controller = new SelectorController({ ui, editor } as never, undefined, copied);
	controller.showTranscriptViewer(registry);
	controller.showTranscriptViewer(registry);
	expect(ui.showOverlay).toHaveBeenCalledTimes(1);
	if (!viewer) throw new Error("Transcript viewer was not shown");
	viewer.handleInput("y");
	expect(copied).toHaveBeenCalledWith("copied");
	viewer.handleInput("\x1b");
	expect(hide).toHaveBeenCalledTimes(1);
	expect(ui.setFocus).toHaveBeenCalledWith(editor);
	expect(ui.requestRender).toHaveBeenCalledWith(true);
});

test("InteractiveMode preserves viewer selection when its provisional assistant entry becomes durable", async () => {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-transcript-viewer-");
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	try {
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const user = { role: "user", content: "ask something", timestamp: Date.now() } as never;
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "streaming response" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [user, assistant] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		const showOverlay = vi.spyOn(mode.ui, "showOverlay");

		mode.showTranscriptViewer();
		const viewer = showOverlay.mock.calls[0]?.[0] as TranscriptViewerOverlay | undefined;
		if (!viewer) throw new Error("Transcript viewer was not shown");
		// Move selection off index 0 so an index-0 fallback would pick a different logical entry.
		viewer.handleInput("j");
		expect(viewer.selectedEntryId).toBe("entry:stream:0:1:content:0");

		const replacement: AssistantMessage = {
			...assistant,
			content: [{ type: "text", text: "streaming response updated" }],
		};
		session.agent.state.messages[1] = replacement;
		mode.refreshTranscriptViewer();
		expect(viewer.selectedEntryId).toBe("entry:stream:0:1:content:0");

		associateSessionMessageEntryId(replacement, "assistant-1");
		mode.refreshTranscriptViewer();

		expect(viewer.selectedEntryId).toBe("entry:assistant-1:content:0");
		expect(viewer.render(100).join("\n")).toContain("streaming response updated");
		expect(showOverlay).toHaveBeenCalledTimes(1);
	} finally {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir.removeSync();
		resetSettingsForTest();
	}
});

test("sanitizes rendered transcript chrome while copying the original payload and reports copy failures", () => {
	const payload = "safe\x1b]52;c;clipboard\x07\n\x1b[31mstyled";
	const copied: string[] = [];
	const errors: string[] = [];
	const viewer = new TranscriptViewerOverlay({
		title: "Title\x1b]0;owned\x07",
		getEntries: () => [entryForOverlay("entry", payload, { label: "Label\x1b[2J" })],
		onClose: () => {},
		copyToClipboard: value => copied.push(value),
		onError: message => errors.push(message),
		getHeaderLines: () => ["Header\x1b]0;owned\x07"],
		getFooterLines: () => ["Footer\x1b[2J"],
	});
	viewer.handleInput("y");
	expect(copied).toEqual([payload]);
	expect(viewer.render(100).join("\n")).not.toContain("\x1b]52;");
	expect(viewer.render(100).join("\n")).not.toContain("\x1b[2J");
	viewer.handleInput(" ");
	expect(viewer.render(100).join("\n")).not.toContain("\x1b[31m");
	viewer.handleInput("r");
	expect(viewer.render(100).join("\n")).not.toContain("\x1b[31m");

	const circular: Record<string, unknown> = {};
	circular.self = circular;
	const failing = new TranscriptViewerOverlay({
		getEntries: () => [entryForOverlay("circular", "text", { metadata: circular })],
		onClose: () => {},
		copyToClipboard: () => {
			throw new Error("clipboard unavailable");
		},
		onError: message => errors.push(message),
	});
	failing.handleInput("Y");
	failing.handleInput("y");
	expect(errors).toEqual([
		"Failed to copy transcript entry to clipboard.",
		"Failed to copy transcript entry to clipboard.",
	]);
});

test("reconciles missing IDs by position and keeps followed tail content visible", () => {
	let entries = Array.from({ length: 50 }, (_, index) => entryForOverlay(`entry-${index}`, `entry-${index}`));
	const viewer = new TranscriptViewerOverlay({
		getEntries: () => entries,
		onClose: () => {},
		initialSelection: "latest",
		followTail: true,
	});
	viewer.render(100);
	entries = [...entries, entryForOverlay("appended", "appended content")];
	viewer.refresh();
	expect(viewer.selectedEntryId).toBe("appended");
	expect(viewer.render(100).join("\n")).toContain("appended content");
	viewer.handleInput("\x1b[5~");
	const paged = viewer.render(100).join("\n");
	expect(paged).not.toContain("appended content");
	expect(viewer.render(100).join("\n")).toBe(paged);

	entries = [entryForOverlay("first", "first"), entryForOverlay("last", "last")];
	const positioned = new TranscriptViewerOverlay({ getEntries: () => entries, onClose: () => {} });
	positioned.handleInput("j");
	entries = [entryForOverlay("first", "first"), entryForOverlay("replacement", "replacement")];
	positioned.refresh();
	expect(positioned.selectedEntryId).toBe("replacement");
});

function entryForOverlay(
	id: string,
	text: string,
	overrides: Partial<TranscriptViewerEntry> & { metadata?: Readonly<Record<string, unknown>> } = {},
): TranscriptViewerEntry {
	const { metadata, ...entryOverrides } = overrides;
	return {
		id,
		kind: "custom",
		label: "Custom",
		payload: { text, metadata: metadata ?? {}, source: text },
		foldable: true,
		...entryOverrides,
	};
}
