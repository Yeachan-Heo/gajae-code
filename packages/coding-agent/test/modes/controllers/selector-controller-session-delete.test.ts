import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { SessionSelectorComponent } from "@gajae-code/coding-agent/modes/components/session-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { SessionInfo } from "@gajae-code/coding-agent/session/session-manager";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { FileSessionStorage } from "@gajae-code/coding-agent/session/session-storage";

type TestContext = InteractiveModeContext & {
	editorContainer: {
		children: unknown[];
		clear: () => void;
		addChild: (child: unknown) => void;
	};
};

function makeSessionInfo(path: string): SessionInfo {
	return {
		path,
		id: path,
		cwd: "/tmp/project",
		title: "Active session",
		created: new Date("2025-01-01T00:00:00Z"),
		modified: new Date("2025-01-01T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: "hello",
		allMessagesText: "hello",
	};
}

function createContext(currentSessionFile: string): {
	ctx: TestContext;
	calls: string[];
	setCurrentSessionFile: (path: string) => void;
	showHookConfirm: (title: string, message: string) => Promise<boolean>;
	newSession: () => Promise<boolean>;
} {
	const calls: string[] = [];
	let sessionFile = currentSessionFile;
	const editorContainer = {
		children: [] as unknown[],
		clear() {
			this.children = [];
			calls.push("editorContainer.clear");
		},
		addChild(child: unknown) {
			this.children.push(child);
			calls.push("editorContainer.addChild");
		},
	};
	const showHookConfirm = vi.fn(async () => true);
	const newSession = vi.fn(async () => {
		calls.push("session.newSession");
		sessionFile = "/tmp/project/sessions/detached.jsonl";
		return true;
	});
	const ctx = {
		editorContainer,
		editor: {},
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(() => {
				calls.push("ui.requestRender");
			}),
			terminal: { columns: 120 },
		},
		session: {
			newSession,
			switchSession: vi.fn(async () => true),
		},
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionDir: () => "/tmp/project/sessions",
			getSessionFile: () => sessionFile,
		},
		statusContainer: {
			clear: vi.fn(() => {
				calls.push("statusContainer.clear");
			}),
		},
		pendingMessagesContainer: {
			clear: vi.fn(() => {
				calls.push("pendingMessagesContainer.clear");
			}),
		},
		compactionQueuedMessages: [] as unknown[],
		streamingComponent: { active: true },
		streamingMessage: { active: true },
		pendingTools: {
			clear: vi.fn(() => {
				calls.push("pendingTools.clear");
			}),
		},
		loadingAnimation: {
			stop: vi.fn(() => {
				calls.push("loadingAnimation.stop");
			}),
		},
		statusLine: {
			invalidate: vi.fn(() => {
				calls.push("statusLine.invalidate");
			}),
			setSessionStartTime: vi.fn(() => {
				calls.push("statusLine.setSessionStartTime");
			}),
		},
		updateEditorTopBorder: vi.fn(() => {
			calls.push("updateEditorTopBorder");
		}),
		updateEditorBorderColor: vi.fn(() => {
			calls.push("updateEditorBorderColor");
		}),
		renderInitialMessages: vi.fn(() => {
			calls.push("renderInitialMessages");
		}),
		reloadTodos: vi.fn(async () => {
			calls.push("reloadTodos");
		}),
		showStatus: vi.fn((message: string) => {
			calls.push(`showStatus:${message}`);
		}),
		showError: vi.fn(),
		showHookConfirm,
		shutdown: vi.fn(async () => undefined),
	} as unknown as TestContext;

	return {
		ctx,
		calls,
		setCurrentSessionFile(path: string) {
			sessionFile = path;
		},
		showHookConfirm,
		newSession,
	};
}

function renderText(selector: SessionSelectorComponent): string {
	return selector.render(120).join("\n");
}

beforeAll(() => {
	initTheme();
});

describe("SelectorController session deletion", () => {
	beforeEach(() => {
		vi.spyOn(SessionManager, "list").mockResolvedValue([]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("detaches the active session before selector deletion removes it", async () => {
		const activeSession = makeSessionInfo("/tmp/project/sessions/active.jsonl");
		const { ctx, calls } = createContext(activeSession.path);
		vi.spyOn(SessionManager, "list").mockResolvedValue([activeSession]);
		const deleteSessionWithArtifacts = vi
			.spyOn(FileSessionStorage.prototype, "deleteSessionWithArtifacts")
			.mockImplementation(async sessionPath => {
				calls.push(`delete:${sessionPath}`);
			});
		const controller = new SelectorController(ctx);

		await controller.showSessionSelector();
		const selector = ctx.editorContainer.children[0];
		if (!(selector instanceof SessionSelectorComponent)) {
			throw new Error("Expected session selector component");
		}

		const sessionList = selector.getSessionList() as unknown as {
			onDeleteRequest?: (session: SessionInfo) => void;
		};
		sessionList.onDeleteRequest?.(activeSession);
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(deleteSessionWithArtifacts).toHaveBeenCalledWith(activeSession.path);
		expect(calls).toEqual([
			"editorContainer.clear",
			"editorContainer.addChild",
			"ui.requestRender",
			"session.newSession",
			"loadingAnimation.stop",
			"statusContainer.clear",
			"pendingMessagesContainer.clear",
			"pendingTools.clear",
			"statusLine.invalidate",
			"statusLine.setSessionStartTime",
			"updateEditorTopBorder",
			"updateEditorBorderColor",
			"renderInitialMessages",
			"reloadTodos",
			"ui.requestRender",
			`delete:${activeSession.path}`,
			"ui.requestRender",
		]);
		expect(ctx.sessionManager.getSessionFile()).toBe("/tmp/project/sessions/detached.jsonl");
	});

	it("shows inline selector errors when session deletion fails after detach", async () => {
		const activeSession = makeSessionInfo("/tmp/project/sessions/active.jsonl");
		const { ctx, newSession } = createContext(activeSession.path);
		vi.spyOn(SessionManager, "list").mockResolvedValue([activeSession]);
		const deleteSessionWithArtifacts = vi
			.spyOn(FileSessionStorage.prototype, "deleteSessionWithArtifacts")
			.mockRejectedValue(new Error("disk failed"));
		const controller = new SelectorController(ctx);

		await controller.showSessionSelector();
		const selector = ctx.editorContainer.children[0];
		if (!(selector instanceof SessionSelectorComponent)) {
			throw new Error("Expected session selector component");
		}

		const sessionList = selector.getSessionList() as unknown as {
			onDeleteRequest?: (session: SessionInfo) => void;
		};
		sessionList.onDeleteRequest?.(activeSession);
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(newSession).toHaveBeenCalledTimes(1);
		expect(deleteSessionWithArtifacts).toHaveBeenCalledWith(activeSession.path);
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(ctx.sessionManager.getSessionFile()).toBe("/tmp/project/sessions/detached.jsonl");
		expect(renderText(selector)).toContain("Error: Failed to delete session: disk failed");
		expect(renderText(selector)).toContain("Active session");
	});

	it("creates a fresh session before deleting via slash command and then shows the selector", async () => {
		const activeSessionPath = "/tmp/project/sessions/active.jsonl";
		const { ctx, calls, showHookConfirm, newSession } = createContext(activeSessionPath);
		const deleteSessionWithArtifacts = vi
			.spyOn(FileSessionStorage.prototype, "deleteSessionWithArtifacts")
			.mockImplementation(async sessionPath => {
				calls.push(`delete:${sessionPath}`);
			});
		const exists = vi.spyOn(FileSessionStorage.prototype, "exists").mockResolvedValue(true);
		const controller = new SelectorController(ctx);

		await controller.handleSessionDeleteCommand();

		expect(exists).toHaveBeenCalledWith(activeSessionPath);
		expect(showHookConfirm).toHaveBeenCalledWith(
			"Delete current session transcript and artifacts?",
			[
				"This permanently deletes only the current session transcript file and its artifacts directory.",
				"Other sessions and topic/history metadata are not deleted.",
				"You will be moved to a fresh session and returned to the session selector.",
			].join("\n"),
		);
		expect(newSession).toHaveBeenCalledTimes(1);
		expect(deleteSessionWithArtifacts).toHaveBeenCalledWith(activeSessionPath);
		expect(calls).toEqual([
			"session.newSession",
			"loadingAnimation.stop",
			"statusContainer.clear",
			"pendingMessagesContainer.clear",
			"pendingTools.clear",
			"statusLine.invalidate",
			"statusLine.setSessionStartTime",
			"updateEditorTopBorder",
			"updateEditorBorderColor",
			"renderInitialMessages",
			"reloadTodos",
			"ui.requestRender",
			`delete:${activeSessionPath}`,
			"showStatus:Current session transcript and artifacts deleted",
			"editorContainer.clear",
			"editorContainer.addChild",
			"ui.requestRender",
		]);
	});
});
