/**
 * Regression: observer overlay must not render SILENT_ABORT_MARKER verbatim.
 *
 * OpenAI code backend review flagged that `session-observer-overlay.ts` renders `errorMessage`
 * without filtering the silent-abort sentinel. This test exercises the full
 * `#buildTranscriptLines` path through a real JSONL session file and mock registry.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionObserverOverlayComponent } from "../src/modes/components/session-observer-overlay";
import type { ObservableSession } from "../src/modes/session-observer-registry";
import { initTheme } from "../src/modes/theme/theme";
import { SILENT_ABORT_MARKER } from "../src/session/messages";

const SESSION_ID = "test-session-1";

function makeJsonlSessionFile(dirPath: string, entries: object[]): string {
	const filePath = path.join(dirPath, "session.jsonl");
	const lines = entries.map(e => JSON.stringify(e));
	fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
	return filePath;
}

function makeSubagentRegistry(sessions: ObservableSession[]) {
	return {
		getSessions: () => sessions,
		onChange: () => () => {},
		setMainSession: () => {},
		getActiveSubagentCount: () => sessions.filter(s => s.status === "active").length,
	} as unknown as import("../src/modes/session-observer-registry").SessionObserverRegistry;
}

describe("Observer overlay silent-abort regression", () => {
	let tmpDir: string;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-overlay-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does not render ✗ Error: for silent-abort assistant messages with empty content", () => {
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "msg-assistant-1",
				parentId: "msg-user-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "aborted",
					errorMessage: SILENT_ABORT_MARKER,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
		]);

		const registry = makeSubagentRegistry([
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Test Subagent",
				status: "active",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, ["ctrl+s"]);

		// The overlay opens in picker mode; Enter dives into the transcript viewer,
		// which reads the session file and calls #buildTranscriptLines internally.
		overlay.handleInput("\r");
		const rendered = overlay.render(120);
		const renderedText = rendered.join("\n");

		// The sentinel MUST NOT appear verbatim in any rendered line
		expect(renderedText).not.toContain(SILENT_ABORT_MARKER);
		// The error prefix MUST NOT appear for a silent-abort message
		expect(renderedText).not.toContain("✗ Error:");
	});

	it("renders normal error messages with ✗ Error: prefix", () => {
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-2",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "msg-assistant-2",
				parentId: "msg-user-2",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "error",
					errorMessage: "Connection timed out",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
		]);

		const registry = makeSubagentRegistry([
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Test Subagent",
				status: "failed",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, ["ctrl+s"]);

		overlay.handleInput("\r"); // enter the transcript viewer for the subagent
		const rendered = overlay.render(120);
		const renderedText = rendered.join("\n");

		// A real error message SHOULD be rendered with the ✗ Error: prefix
		expect(renderedText).toContain("✗ Error:");
		expect(renderedText).toContain("Connection timed out");
	});
});
