import { afterEach, beforeAll, describe, expect, it, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { MouseEvent } from "@gajae-code/tui";
import { SessionObserverOverlayComponent } from "../src/modes/components/session-observer-overlay";
import { type TranscriptViewerEntry, TranscriptViewerOverlay } from "../src/modes/components/transcript-viewer-overlay";
import { InputController } from "../src/modes/controllers/input-controller";
import type { ObservableSession } from "../src/modes/session-observer-registry";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { associateSessionMessageViewportAnchorId } from "../src/session/session-manager";

beforeAll(() => initTheme());

afterEach(() => vi.restoreAllMocks());

function entry(id: string, text: string, options: Partial<TranscriptViewerEntry> = {}): TranscriptViewerEntry {
	return { id, kind: "custom", payload: { text, metadata: {}, source: text }, foldable: true, ...options };
}

function visibleWidth(line: string): number {
	return line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").length;
}

function observerRegistry(sessions: ObservableSession[]) {
	return {
		getSessions: () => sessions,
		onChange: () => () => {},
		setMainSession: () => {},
		getActiveSubagentCount: () => sessions.filter(session => session.status === "active").length,
	} as unknown as import("../src/modes/session-observer-registry").SessionObserverRegistry;
}

function sessionFile(dir: string, id: string, messages: object[]): string {
	const file = path.join(dir, `${id}.jsonl`);
	fs.writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString() })}\n${messages.map(message => JSON.stringify(message)).join("\n")}\n`,
	);
	return file;
}

function message(id: string, value: object): object {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: value };
}

function controller(messages: AgentMessage[], revealViewportAnchor = vi.fn((_id: string) => true)) {
	const showTranscriptViewer = vi.fn();
	const session = { messages };
	const ctx = {
		session,
		ui: { revealViewportAnchor },
		showTranscriptViewer,
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { controller: new InputController(ctx), revealViewportAnchor, showTranscriptViewer, session };
}

describe("G002 WS1 red-team: TranscriptViewerOverlay boundaries", () => {
	it("keeps an empty transcript selectable-safe and closes repeatedly without throwing", () => {
		let closed = 0;
		const viewer = new TranscriptViewerOverlay({
			getEntries: () => [],
			onClose: () => {
				closed++;
			},
		});
		for (let i = 0; i < 20; i++) {
			viewer.handleInput("j");
			viewer.handleInput("k");
			viewer.handleInput("\x1b");
		}
		expect(viewer.selectedEntryId).toBeUndefined();
		expect(viewer.render(100).join("\n")).toContain("No transcript entries yet.");
		expect(closed).toBe(20);
	});

	it("pages a 10k-line expanded entry and clamps selection at both boundaries", () => {
		const huge = Array.from({ length: 10_000 }, (_, index) => `line-${index}`).join("\n");
		const viewer = new TranscriptViewerOverlay({
			getEntries: () => [entry("huge", huge), entry("last", "last")],
			onClose: () => {},
		});
		viewer.handleInput("k");
		expect(viewer.selectedEntryId).toBe("huge");
		viewer.handleInput("j");
		viewer.handleInput("j");
		expect(viewer.selectedEntryId).toBe("last");
		viewer.handleInput("k");
		viewer.handleInput(" ");
		viewer.handleInput("\n");
		for (let i = 0; i < 800; i++) viewer.handleInput("j");
		expect(viewer.isFullscreen).toBe(true);
		expect(viewer.render(100).join("\n")).toContain("line-");
	});

	it("does not copy missing capabilities, allows raw non-markdown, and opens fullscreen from collapsed", () => {
		const copied: string[] = [];
		const viewer = new TranscriptViewerOverlay({
			getEntries: () => [entry("locked", "plain <> text", { copyable: false, foldable: true, rawViewable: true })],
			onClose: () => {},
			copyToClipboard: value => copied.push(value),
		});
		viewer.handleInput("y");
		viewer.handleInput("Y");
		expect(copied).toEqual([]);
		viewer.render(100);
		viewer.handleInput("r");
		expect(() => viewer.render(100)).not.toThrow();
		viewer.handleInput("\n");
		expect(viewer.isFullscreen).toBe(true);
	});

	it("renders content within a 20-column viewport", () => {
		const viewer = new TranscriptViewerOverlay({
			getEntries: () => [entry("narrow", "unbroken-content-that-exceeds-twenty-columns")],
			onClose: () => {},
		});
		const lines = viewer.render(20);
		expect(lines.every(line => visibleWidth(line) <= 20)).toBe(true);
	});
});

it("keeps an oversized entry at its beginning and pages through it without changing selection", () => {
	const huge = Array.from({ length: 200 }, (_, index) => `huge-line-${index}`).join("\n");
	const viewer = new TranscriptViewerOverlay({
		getEntries: () => [entry("small", "small"), entry("huge", huge)],
		onClose: () => {},
	});
	viewer.render(100);
	viewer.handleInput("j");
	viewer.handleInput(" ");
	viewer.handleInput("k");
	viewer.handleInput("j");

	expect(viewer.selectedEntryId).toBe("huge");
	expect(viewer.render(100).join("\n")).toContain("huge-line-0");
	viewer.handleInput("\n");
	viewer.handleInput("\x1b[6~");
	expect(viewer.selectedEntryId).toBe("huge");
	expect(viewer.render(100).join("\n")).toContain("huge-line-15");
	viewer.handleInput("\x1b[5~");
	expect(viewer.selectedEntryId).toBe("huge");
	expect(viewer.render(100).join("\n")).toContain("huge-line-0");
});

describe("G002 WS1 red-team: observer adapter parity", () => {
	it("loads observed sessions, navigates, expands, cycles sessions, and closes", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g002-observer-"));
		try {
			const first = sessionFile(dir, "first", [
				message("u1", { role: "user", content: "first user", timestamp: Date.now() }),
				message("a1", {
					role: "assistant",
					content: [{ type: "text", text: "first response" }],
					timestamp: Date.now(),
				}),
			]);
			const second = sessionFile(dir, "second", [
				message("u2", { role: "user", content: "second user", timestamp: Date.now() }),
			]);
			let closed = 0;
			const overlay = new SessionObserverOverlayComponent(observerRegistry([
				{ id: "first", kind: "subagent", label: "First", status: "active", sessionFile: first, lastUpdate: 1 },
				{
					id: "second",
					kind: "subagent",
					label: "Second",
					status: "completed",
					sessionFile: second,
					lastUpdate: 2,
				},
			]), () => {
				closed++;
			}, ["ctrl+s"]);
			expect(overlay.render(100).join("\n")).toContain("first user");
			overlay.handleInput("j");
			overlay.handleInput(" ");
			expect(overlay.render(100).join("\n")).toContain("first response");
			overlay.handleInput("]");
			expect(overlay.render(100).join("\n")).toContain("second user");
			overlay.handleInput("[");
			expect(overlay.render(100).join("\n")).toContain("First [active]");
			overlay.handleInput("\x1b");
			expect(closed).toBe(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("selects the latest entry, follows appended output, recovers after truncation, and renders observer chrome", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g002-observer-parity-"));
		try {
			const file = sessionFile(dir, "parity", [
				message("u1", { role: "user", content: "first", timestamp: Date.now() }),
				message("a1", {
					role: "assistant",
					content: [{ type: "text", text: "latest" }],
					timestamp: Date.now(),
					model: "test-model",
				}),
			]);
			const sessions = [
				{
					id: "parity",
					kind: "subagent" as const,
					label: "Parity Agent",
					status: "active" as const,
					sessionFile: file,
					lastUpdate: 1,
					progress: { toolCount: 2, tokens: 10, durationMs: 1_000, cost: 0.5 } as ObservableSession["progress"],
				},
			];
			const overlay = new SessionObserverOverlayComponent(observerRegistry(sessions), () => {}, ["ctrl+s"]);
			expect(overlay.selectedEntryId).toBe("a1:text:0");
			let rendered = overlay.render(100).join("\n");
			expect(rendered).toContain("Parity Agent");
			expect(rendered).toContain("test-model");
			expect(rendered).toContain("2 tools");
			fs.appendFileSync(
				file,
				`${JSON.stringify(message("a2", { role: "assistant", content: [{ type: "text", text: "appended" }], timestamp: Date.now() }))}\n`,
			);
			overlay.refreshFromRegistry();
			expect(overlay.selectedEntryId).toBe("a2:text:0");
			fs.writeFileSync(
				file,
				`${JSON.stringify({ type: "session", version: 3, id: "parity", timestamp: new Date().toISOString() })}\n${JSON.stringify(message("u2", { role: "user", content: "replacement", timestamp: Date.now() }))}\n`,
			);
			overlay.refreshFromRegistry();
			rendered = overlay.render(100).join("\n");
			expect(rendered).toContain("replacement");
			expect(rendered).not.toContain("appended");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

it("preserves tool arguments, intent, empty errors, thinking caps, paging, and observer chrome", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g002-observer-rendering-"));
	try {
		const thinking = "t".repeat(4_500);
		const oversized = Array.from({ length: 200 }, (_, index) => `page-line-${index}`).join("\n");
		const file = sessionFile(dir, "rendering", [
			message("a1", {
				role: "assistant",
				content: [
					{ type: "thinking", thinking },
					{
						type: "toolCall",
						id: "bad-tool",
						name: "read",
						arguments: { path: "src/file.ts" },
						intent: "Inspect the file",
					},
					{ type: "text", text: oversized },
				],
				timestamp: Date.now(),
			}),
			message("r1", {
				role: "toolResult",
				toolCallId: "bad-tool",
				toolName: "read",
				content: [],
				isError: true,
				timestamp: Date.now(),
			}),
		]);
		const overlay = new SessionObserverOverlayComponent(observerRegistry([
			{
				id: "rendering",
				kind: "subagent",
				label: "Render Agent",
				status: "active",
				sessionFile: file,
				lastUpdate: 1,
			},
		]), () => {}, ["ctrl+s"]);
		let rendered = overlay.render(100).join("\n");
		expect(rendered).toContain("Session Observer");
		expect(rendered).toContain("j/k:select");
		expect(rendered).toContain("path: src/file.ts");
		expect(rendered).toContain("Inspect the file");
		expect(rendered).toContain("✗ Error");
		expect(rendered).not.toContain("t".repeat(201));
		overlay.handleInput("j");
		overlay.handleInput("j");
		overlay.handleInput("\n");
		rendered = overlay.render(100).join("\n");
		expect(rendered).toContain("page-line-0");
		overlay.handleInput("\x1b[6~");
		rendered = overlay.render(100).join("\n");
		expect(rendered).toContain("page-line-");
		expect(rendered).toMatch(/\[\d+-\d+\/\d+\]/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("renders an unmatched observer tool call as pending instead of done", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g002-observer-pending-"));
	try {
		const file = sessionFile(dir, "pending", [
			message("a1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "pending-tool", name: "read", arguments: { path: "src/file.ts" } }],
				timestamp: Date.now(),
			}),
		]);
		const overlay = new SessionObserverOverlayComponent(observerRegistry([
			{ id: "pending", kind: "subagent", label: "Pending", status: "active", sessionFile: file, lastUpdate: 1 },
		]), () => {}, ["ctrl+s"]);
		const rendered = overlay.render(100).join("\n");
		expect(rendered).toContain("⏳ pending");
		expect(rendered).not.toContain("✓ done");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("G002 WS1 red-team: turn jumps and browse action", () => {
	it("does not wrap at jump boundaries, resets on anchor eviction, and retries reveal failures", async () => {
		const messages = ["one", "two", "three"].map(
			text => ({ role: "user", content: text, timestamp: Date.now() }) as AgentMessage,
		);
		for (const [index, value] of messages.entries())
			associateSessionMessageViewportAnchorId(value, `anchor-${index}`);
		const reveal = vi.fn((_id: string) => true);
		const h = controller(messages, reveal);
		await h.controller.actionRegistry.execute("app.transcript.nextTurn");
		await h.controller.actionRegistry.execute("app.transcript.prevTurn");
		await h.controller.actionRegistry.execute("app.transcript.prevTurn");
		await h.controller.actionRegistry.execute("app.transcript.prevTurn");
		expect(reveal.mock.calls.map(call => call[0])).toEqual(["anchor-2", "anchor-1", "anchor-0"]);
		messages.splice(2, 1);
		await h.controller.actionRegistry.execute("app.transcript.prevTurn");
		expect(reveal.mock.calls.at(-1)?.[0]).toBe("anchor-0");
		reveal.mockReturnValueOnce(false);
		await h.controller.actionRegistry.execute("app.transcript.prevTurn");
		await h.controller.actionRegistry.execute("app.transcript.prevTurn");
		expect(reveal.mock.calls.slice(-2).map(call => call[0])).toEqual(["anchor-1", "anchor-0"]);
	});

	it("makes browse unavailable for an empty session and executes without crashing for a nonempty session", async () => {
		const empty = controller([]);
		expect(empty.controller.actionRegistry.isAvailable("app.transcript.browse")).toBe(false);
		const full = controller([{ role: "user", content: "present", timestamp: Date.now() } as AgentMessage]);
		expect(await full.controller.actionRegistry.execute("app.transcript.browse")).toBe(true);
		expect(full.showTranscriptViewer).toHaveBeenCalledTimes(1);
	});
});

it("preserves the active turn when anchors append or reorder and keeps availability side-effect-free", async () => {
	const messages = ["one", "two"].map(
		(text, index) => ({ role: "user", content: text, timestamp: Date.now(), metadata: { index } }) as AgentMessage,
	);
	for (const [index, value] of messages.entries()) associateSessionMessageViewportAnchorId(value, `anchor-${index}`);
	const reveal = vi.fn((_id: string) => true);
	const h = controller(messages, reveal);
	await h.controller.actionRegistry.execute("app.transcript.prevTurn");
	expect(reveal.mock.calls.at(-1)?.[0]).toBe("anchor-1");
	const appended = { role: "user", content: "three", timestamp: Date.now() } as AgentMessage;
	associateSessionMessageViewportAnchorId(appended, "anchor-2");
	messages.push(appended);
	expect(h.controller.actionRegistry.isAvailable("app.transcript.nextTurn")).toBe(true);
	await h.controller.actionRegistry.execute("app.transcript.nextTurn");
	expect(reveal.mock.calls.at(-1)?.[0]).toBe("anchor-2");
	messages.unshift(messages.pop() as AgentMessage);
	await h.controller.actionRegistry.execute("app.transcript.prevTurn");
	expect(reveal.mock.calls.at(-1)?.[0]).toBe("anchor-1");
});

it("keeps queue actions available during compaction and foreground tool work", () => {
	const h = controller([]);
	const session = h.session as { isCompacting?: boolean; isBashRunning?: boolean; isEvalRunning?: boolean };
	session.isCompacting = true;
	expect(h.controller.actionRegistry.isAvailable("app.message.queue")).toBe(true);
	session.isCompacting = false;
	session.isBashRunning = true;
	expect(h.controller.actionRegistry.isAvailable("app.message.followUp")).toBe(true);
	session.isBashRunning = false;
	session.isEvalRunning = true;
	expect(h.controller.actionRegistry.isAvailable("app.message.queue")).toBe(true);
});

it("maps mouse rows from rendered transcript chrome in main and observer-style views", () => {
	const entries = () => [entry("first", "first"), entry("second", "second")];
	const viewer = new TranscriptViewerOverlay({ getEntries: entries, onClose: () => {} });
	viewer.render(100);
	viewer.handleMouse({ kind: "click", localY: 6 } as unknown as MouseEvent);
	expect(viewer.selectedEntryId).toBe("second");

	const observerStyle = new TranscriptViewerOverlay({
		getEntries: entries,
		onClose: () => {},
		getHeaderLines: () => ["Observed session"],
	});
	observerStyle.render(100);
	observerStyle.handleMouse({ kind: "click", localY: 7 } as unknown as MouseEvent);
	expect(observerStyle.selectedEntryId).toBe("second");
});
