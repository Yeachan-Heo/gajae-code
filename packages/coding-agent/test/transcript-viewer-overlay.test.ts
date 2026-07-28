import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { createToolTranscriptRenderDescriptor } from "../src/modes/components/tool-transcript-format";
import {
	__transcriptViewerPerfCounters,
	type TranscriptViewerEntry,
	TranscriptViewerOverlay,
	type TranscriptViewerOverlayOptions,
	transcriptViewerEntries,
} from "../src/modes/components/transcript-viewer-overlay";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { getThemeByName, initTheme, setThemeInstance, theme } from "../src/modes/theme/theme";
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

test("renders tool names, state-aware folded display, and preserves neighboring tool folds", () => {
	const registry = new TranscriptItemRegistry();
	const toolPayload = (id: string, resultText: string, isError: boolean, hasResult: boolean) => ({
		text: `raw ${resultText}`,
		metadata: {
			name: "read",
			arguments: { path: `${id}.ts` },
			intent: "Inspect file",
			resultText,
			isError,
			hasResult,
		},
		source: id,
	});
	registry.register({
		id: "tool:first",
		kind: "tool",
		source: "first",
		getPayload: () => toolPayload("first", "first result", false, true),
	});
	registry.register({
		id: "tool:second",
		kind: "tool",
		source: "second",
		getPayload: () => toolPayload("second", "", false, false),
	});
	const entries = transcriptViewerEntries(registry);
	expect(entries.map(entry => entry.label)).toEqual(["read", "read"]);
	expect(entries[0]?.getDisplayText?.(false)).toBe("path: first.ts\nInspect file");
	expect(entries[0]?.getDisplayText?.(true)).toContain("first result");
	expect(entries[1]?.getDisplayText?.(true)).toContain("⏳ pending");

	const copied: string[] = [];
	const viewer = new TranscriptViewerOverlay({
		getEntries: () => transcriptViewerEntries(registry),
		onClose: () => {},
		copyToClipboard: text => copied.push(text),
	});
	viewer.handleInput("Y");
	const copiedMetadata = JSON.parse(copied[0] ?? "") as Record<string, unknown>;
	expect(Object.keys(copiedMetadata).sort()).toEqual([
		"arguments",
		"hasResult",
		"intent",
		"isError",
		"name",
		"resultText",
	]);
	viewer.handleInput(" ");
	viewer.handleInput("j");
	viewer.handleInput(" ");
	viewer.handleInput("k");
	expect(viewer.render(100).join("\n")).toContain("first result");
	viewer.handleInput("j");
	expect(viewer.render(100).join("\n")).toContain("⏳ pending");
});

test("preserves legacy tool payload text until complete formatter metadata is available", () => {
	const registry = new TranscriptItemRegistry();
	registry.register({
		id: "tool:legacy",
		kind: "tool",
		source: "legacy",
		getPayload: () => ({ text: "legacy default payload", metadata: {}, source: "legacy" }),
	});
	registry.register({
		id: "tool:partial",
		kind: "tool",
		source: "partial",
		getPayload: () => ({
			text: "partial legacy payload",
			metadata: { name: "bash", arguments: { command: "echo partial" }, resultText: "partial result" },
			source: "partial",
		}),
	});
	registry.register({
		id: "tool:open",
		kind: "tool",
		source: "open",
		getPayload: () => ({
			text: "open canonical payload",
			metadata: {
				name: "bash",
				arguments: { command: "echo open" },
				resultText: "",
				isError: false,
				hasResult: false,
			},
			source: "open",
		}),
	});
	const entries = transcriptViewerEntries(registry);
	expect(entries[0]?.getDisplayText).toBeUndefined();
	expect(entries[1]?.getDisplayText).toBeUndefined();
	expect(entries[2]?.getDisplayText?.(true)).toBe("echo open\n⏳ pending");

	const viewer = new TranscriptViewerOverlay({
		getEntries: () => transcriptViewerEntries(registry),
		onClose: () => {},
	});
	viewer.handleInput(" ");
	const rendered = viewer.render(100).join("\n");
	expect(rendered).toContain("legacy default payload");
	expect(rendered).toContain("partial legacy payload");
	expect(rendered).not.toContain("partial result");
});

test("sanitizes tool results and leaves expanded assistant text uncapped", () => {
	const registry = new TranscriptItemRegistry();
	registry.register({
		id: "tool:chrome",
		kind: "tool",
		source: "chrome",
		getPayload: () => ({
			text: "raw",
			metadata: {
				name: "bash",
				arguments: { command: "echo safe" },
				resultText: "safe\x1b[2J\n# markdown-like",
				isError: true,
				hasResult: true,
			},
			source: "chrome",
		}),
	});
	registry.register({
		id: "assistant",
		kind: "assistant-text",
		source: "assistant",
		getPayload: () => ({
			text: Array.from({ length: 150 }, (_, index) => `assistant-${index}`).join("\n"),
			metadata: {},
			source: "assistant",
		}),
	});
	const viewer = new TranscriptViewerOverlay({
		getEntries: () => transcriptViewerEntries(registry),
		onClose: () => {},
	});
	viewer.handleInput(" ");
	let rendered = viewer.render(100).join("\n");
	expect(rendered).toContain("✗ safe");
	expect(rendered).not.toContain("\x1b[2J");
	viewer.handleInput("j");
	viewer.handleInput(" ");
	viewer.handleInput("\n");
	for (let index = 0; index < 20; index++) viewer.handleInput("\x1b[6~");
	rendered = viewer.render(100).join("\n");
	expect(rendered).toContain("assistant-149");
});

test("uses final rendered lines without Markdown processing and keeps raw ANSI-free", () => {
	const canonical = "raw\x1b]52;c;copy\x07\x1b[31mstyled";
	const viewer = new TranscriptViewerOverlay({
		getEntries: () => [
			entryForOverlay("rich", canonical, {
				kind: "tool",
				renderDescriptor: createToolTranscriptRenderDescriptor({
					name: "bash",
					args: {},
					resultContent: "done",
					hasResult: true,
				}),
				getDisplayText: () => "display",
				richRenderEligible: true,
			}),
		],
		onClose: () => {},
	});
	viewer.handleInput(" ");
	expect(viewer.render(100).join("\n")).toContain("✓ done");
	viewer.handleInput("r");
	expect(viewer.render(100).join("\n")).not.toContain("\x1b[31mstyled");
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

describe("PR2a: render/refresh separation and layout cache", () => {
	beforeEach(() => {
		__transcriptViewerPerfCounters.reset();
		__transcriptViewerPerfCounters.disable();
	});
	afterEach(() => {
		__transcriptViewerPerfCounters.reset();
		__transcriptViewerPerfCounters.disable();
	});

	function buildViewer(
		entries: readonly TranscriptViewerEntry[],
		options: Partial<TranscriptViewerOverlayOptions> = {},
	): TranscriptViewerOverlay {
		return new TranscriptViewerOverlay({
			getEntries: () => entries,
			onClose: () => {},
			...options,
		});
	}

	test("render does not refresh or rebuild on repeated paint-only frames", () => {
		const viewer = buildViewer([entryForOverlay("a", "alpha"), entryForOverlay("b", "beta")]);
		viewer.render(80); // stabilize width at 80 (constructor already rebuilt at 80)
		__transcriptViewerPerfCounters.enable();
		__transcriptViewerPerfCounters.reset();
		viewer.render(80);
		viewer.render(80);
		const snap = __transcriptViewerPerfCounters.snapshot();
		expect(snap.refreshRuns).toBe(0);
		expect(snap.rebuildRuns).toBe(0);
		expect(snap.layoutCacheHits).toBe(0);
		expect(snap.layoutCacheMisses).toBe(0);
	});

	test("j/k navigation moves selection and rebuilds so the cursor tracks", () => {
		const viewer = buildViewer([
			entryForOverlay("a", "alpha"),
			entryForOverlay("b", "beta"),
			entryForOverlay("c", "gamma"),
		]);
		viewer.render(80);
		__transcriptViewerPerfCounters.enable();
		__transcriptViewerPerfCounters.reset();
		viewer.handleInput("j");
		expect(viewer.selectedEntryId).toBe("b");
		viewer.handleInput("j");
		expect(viewer.selectedEntryId).toBe("c");
		viewer.handleInput("k");
		expect(viewer.selectedEntryId).toBe("b");
		expect(__transcriptViewerPerfCounters.snapshot().rebuildRuns).toBe(3);
		// Cursor marker must land on the currently-selected entry, proving the rebuild ran.
		const rendered = viewer.render(80);
		const cursorLines = rendered.filter(line => line.includes("▶"));
		expect(cursorLines).toHaveLength(1);
		expect(cursorLines[0]).toContain("[Custom]");
	});

	test("g/G jump to top and bottom with an explicit rebuild before scroll", () => {
		const entries = Array.from({ length: 6 }, (_, index) => entryForOverlay(`e${index}`, `entry-${index}`));
		const viewer = buildViewer(entries, { initialSelection: "latest" });
		viewer.render(80);
		expect(viewer.selectedEntryId).toBe("e5");
		__transcriptViewerPerfCounters.enable();
		__transcriptViewerPerfCounters.reset();
		viewer.handleInput("g");
		expect(viewer.selectedEntryId).toBe("e0");
		viewer.handleInput("G");
		expect(viewer.selectedEntryId).toBe("e5");
		// Each of g and G rebuilds exactly once before requesting paint.
		expect(__transcriptViewerPerfCounters.snapshot().rebuildRuns).toBe(2);
		// The tail entry's body is still on screen after the G rebuild + scroll clamp.
		expect(viewer.render(80).join("\n")).toContain("entry-5");
	});

	test("page up/down moves selection and keeps repeated paints stable", () => {
		const entries = Array.from({ length: 20 }, (_, index) => entryForOverlay(`e${index}`, `entry-${index}`));
		const viewer = buildViewer(entries);
		viewer.render(80);
		viewer.handleInput("G");
		viewer.render(80); // apply the G-requested tail clamp before capturing the stable frame
		const atTail = viewer.render(80).join("\n");
		__transcriptViewerPerfCounters.enable();
		__transcriptViewerPerfCounters.reset();
		viewer.handleInput("\x1b[5~"); // pageUp
		expect(__transcriptViewerPerfCounters.snapshot().rebuildRuns).toBe(1);
		const paged = viewer.render(80).join("\n");
		expect(paged).not.toStrictEqual(atTail);
		// Paint-only frames after the page are byte-identical (no refresh, no rebuild).
		__transcriptViewerPerfCounters.reset();
		expect(viewer.render(80).join("\n")).toStrictEqual(paged);
		expect(__transcriptViewerPerfCounters.snapshot().rebuildRuns).toBe(0);
		// pageDown also rebuilds exactly once and restores the tail viewport byte-for-byte.
		__transcriptViewerPerfCounters.reset();
		viewer.handleInput("\x1b[6~"); // pageDown
		expect(__transcriptViewerPerfCounters.snapshot().rebuildRuns).toBe(1);
		expect(viewer.render(80).join("\n")).toStrictEqual(atTail);
	});

	test("raw toggle rebuilds so the entry body switches between markdown and raw", () => {
		const viewer = buildViewer([entryForOverlay("a", "# heading\n\nbody text")]);
		viewer.handleInput(" "); // expand -> markdown path
		const markdown = viewer.render(80).join("\n");
		__transcriptViewerPerfCounters.enable();
		__transcriptViewerPerfCounters.reset();
		viewer.handleInput("r");
		expect(__transcriptViewerPerfCounters.snapshot().rebuildRuns).toBe(1);
		const raw = viewer.render(80).join("\n");
		expect(raw).not.toStrictEqual(markdown);
		viewer.handleInput("r");
		// Toggle back reproduces the original markdown byte-for-byte.
		expect(viewer.render(80).join("\n")).toStrictEqual(markdown);
	});

	test("fullscreen enter and exit each rebuild so the display set changes between modes", () => {
		const viewer = buildViewer([entryForOverlay("a", "alpha"), entryForOverlay("b", "beta")]);
		viewer.render(80);
		__transcriptViewerPerfCounters.enable();
		__transcriptViewerPerfCounters.reset();
		viewer.handleInput("\r");
		expect(viewer.isFullscreen).toBe(true);
		expect(__transcriptViewerPerfCounters.snapshot().rebuildRuns).toBe(1);
		const fullscreen = viewer.render(80).join("\n");
		viewer.handleInput("\x1b");
		expect(viewer.isFullscreen).toBe(false);
		expect(__transcriptViewerPerfCounters.snapshot().rebuildRuns).toBe(2);
		const normal = viewer.render(80).join("\n");
		expect(normal).not.toStrictEqual(fullscreen);
	});

	test("fullscreen scrolling does not rebuild or refresh (viewport slice only)", () => {
		const longBody = Array.from({ length: 400 }, (_, index) => `line-${index}`).join("\n");
		const viewer = buildViewer([entryForOverlay("a", longBody)]);
		viewer.handleInput("\r"); // enter fullscreen
		viewer.render(80); // stabilize width/state
		__transcriptViewerPerfCounters.enable();
		__transcriptViewerPerfCounters.reset();
		viewer.handleInput("j");
		viewer.handleInput("k");
		viewer.handleInput("\x1b[6~"); // pageDown
		viewer.handleInput("\x1b[5~"); // pageUp
		const snap = __transcriptViewerPerfCounters.snapshot();
		expect(snap.rebuildRuns).toBe(0);
		expect(snap.refreshRuns).toBe(0);
		expect(snap.layoutCacheHits).toBe(0);
		expect(snap.layoutCacheMisses).toBe(0);
		// The scroll offset actually moved, proving the slice window shifted without rebuilding.
		const midScroll = viewer.render(80).join("\n");
		viewer.handleInput("\x1b[6~"); // pageDown again
		const furtherScroll = viewer.render(80).join("\n");
		expect(furtherScroll).not.toStrictEqual(midScroll);
	});

	test("cache lifecycle: cold rebuild misses, stable navigation then hits", () => {
		const entries = Array.from({ length: 5 }, (_, index) => entryForOverlay(`e${index}`, `entry-${index}`));
		const viewer = buildViewer(entries);
		viewer.render(80); // populate cache at width 80 (counters disabled)
		__transcriptViewerPerfCounters.enable();
		__transcriptViewerPerfCounters.reset();
		viewer.render(120); // width change forces rebuild; cache empty at new width
		let snap = __transcriptViewerPerfCounters.snapshot();
		expect(snap.rebuildRuns).toBe(1);
		expect(snap.layoutCacheMisses).toBe(5);
		expect(snap.layoutCacheHits).toBe(0);
		__transcriptViewerPerfCounters.reset();
		viewer.handleInput("j"); // selected=1; the old selected (e0) needs its unselected variant and the newly selected (e1) needs its selected variant, so both miss
		snap = __transcriptViewerPerfCounters.snapshot();
		expect(snap.layoutCacheHits).toBe(3);
		expect(snap.layoutCacheMisses).toBe(2);
		__transcriptViewerPerfCounters.reset();
		viewer.handleInput("k"); // selected=0; all variants pre-cached
		snap = __transcriptViewerPerfCounters.snapshot();
		expect(snap.layoutCacheHits).toBe(5);
		expect(snap.layoutCacheMisses).toBe(0);
	});

	test("navigation with more than ten entries achieves at least 90% layout hits after the first rebuild", () => {
		const entries = Array.from({ length: 20 }, (_, index) => entryForOverlay(`e${index}`, `entry-${index}`));
		const viewer = buildViewer(entries);
		viewer.render(80); // populate cache (counters disabled)
		__transcriptViewerPerfCounters.enable();
		__transcriptViewerPerfCounters.reset();
		// Each move only misses the newly-selected variant; everything else hits.
		viewer.handleInput("j");
		viewer.handleInput("j");
		viewer.handleInput("j");
		viewer.handleInput("k");
		viewer.handleInput("k");
		viewer.handleInput("k");
		const snap = __transcriptViewerPerfCounters.snapshot();
		const total = snap.layoutCacheHits + snap.layoutCacheMisses;
		expect(total).toBeGreaterThan(0);
		expect(snap.layoutCacheHits / total).toBeGreaterThanOrEqual(0.9);
	});

	test("width change produces fresh cache misses for the new variant key", () => {
		const viewer = buildViewer([entryForOverlay("a", "alpha"), entryForOverlay("b", "beta")]);
		viewer.render(80);
		__transcriptViewerPerfCounters.enable();
		__transcriptViewerPerfCounters.reset();
		viewer.render(120);
		const snap = __transcriptViewerPerfCounters.snapshot();
		expect(snap.rebuildRuns).toBe(1);
		expect(snap.layoutCacheMisses).toBe(2);
		expect(snap.layoutCacheHits).toBe(0);
		__transcriptViewerPerfCounters.reset();
		viewer.render(80);
		const returned = __transcriptViewerPerfCounters.snapshot();
		expect(returned.layoutCacheMisses).toBe(2);
		expect(returned.layoutCacheHits).toBe(0);
	});

	test("theme reference change clears the cache and re-runs markdown layout", async () => {
		const original = theme;
		try {
			const viewer = buildViewer([entryForOverlay("a", "# heading\n\nbody")]);
			viewer.handleInput(" "); // expand -> markdown path uses mdTheme
			viewer.render(80);
			__transcriptViewerPerfCounters.enable();
			__transcriptViewerPerfCounters.reset();
			const other = await getThemeByName("blue-crab");
			expect(other).toBeDefined();
			setThemeInstance(other!);
			viewer.render(80);
			const snap = __transcriptViewerPerfCounters.snapshot();
			expect(snap.rebuildRuns).toBe(1);
			expect(snap.layoutCacheHits).toBe(0);
			expect(snap.layoutCacheMisses).toBe(1);
		} finally {
			setThemeInstance(original);
		}
	});

	test("refresh clears the cache so same-id changed closures cannot serve stale lines", () => {
		let displayText = "original-content";
		const entry: TranscriptViewerEntry = {
			id: "x",
			kind: "custom",
			label: "Custom",
			payload: { text: "raw-payload", metadata: {}, source: "raw-payload" },
			foldable: true,
			getDisplayText: () => displayText,
		};
		const viewer = new TranscriptViewerOverlay({
			getEntries: () => [entry],
			onClose: () => {},
		});
		viewer.handleInput(" "); // expand so getDisplayText feeds the markdown path
		expect(viewer.render(80).join("\n")).toContain("original-content");
		displayText = "updated-content";
		viewer.refresh();
		const after = viewer.render(80).join("\n");
		expect(after).toContain("updated-content");
		expect(after).not.toContain("original-content");
	});

	test("invalidateLayoutEntries drops every variant for the targeted ids", () => {
		const viewer = buildViewer([entryForOverlay("a", "alpha"), entryForOverlay("b", "beta")]);
		viewer.render(80); // populate cache: a's selected variant and b's unselected variant
		// Warm every selected-state variant first. The initial render only caches the selected
		// variant of `a` and the unselected variant of `b`; the first j/k warms the two missing
		// variants (b's selected and a's unselected).
		viewer.handleInput("j");
		viewer.handleInput("k");
		// With all variants warm, a no-invalidation j/k sequence hits every variant.
		__transcriptViewerPerfCounters.enable();
		__transcriptViewerPerfCounters.reset();
		viewer.handleInput("j");
		viewer.handleInput("k");
		let snap = __transcriptViewerPerfCounters.snapshot();
		expect(snap.layoutCacheMisses).toBe(0);
		expect(snap.layoutCacheHits).toBe(4);
		// Targeted invalidation drops only `a`'s variants; `b` stays fully cached, so only the
		// two `a` variants repopulate across the next j/k.
		__transcriptViewerPerfCounters.reset();
		viewer.invalidateLayoutEntries(["a"]);
		viewer.handleInput("j");
		viewer.handleInput("k");
		snap = __transcriptViewerPerfCounters.snapshot();
		expect(snap.layoutCacheMisses).toBe(2);
		expect(snap.layoutCacheHits).toBe(2);
	});
});
