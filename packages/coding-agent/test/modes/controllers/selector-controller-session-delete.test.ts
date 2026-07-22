import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
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
	setCurrentSessionId: (id: string) => void;
	setManagedDestination: (managed: boolean) => void;
	showHookConfirm: (title: string, message: string) => Promise<boolean>;
	newSession: () => Promise<boolean>;
	prepareManagedCandidateForStrictAdoption: Mock<(targetPath: string) => Promise<string>>;
	listForResumePickerReadOnly: Mock<() => Promise<SessionInfo[]>>;
	switchSession: Mock<(targetPath: string) => Promise<boolean>>;
} {
	const calls: string[] = [];
	let managedDestination = false;
	let sessionFile = currentSessionFile;
	let sessionId = currentSessionFile;
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
		sessionId = "detached-session";
		return true;
	});
	const switchSession = vi.fn(async (targetPath: string) => {
		sessionFile = targetPath;
		sessionId = targetPath;
		return true;
	});
	const prepareManagedCandidateForStrictAdoption = vi.fn(async (targetPath: string) => targetPath);
	const listForResumePickerReadOnly = vi.fn(async () => [] as SessionInfo[]);
	const ctx = {
		editorContainer,
		editor: {},
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(() => {
				calls.push("ui.requestRender");
			}),
			resetViewportAnchorIntent: vi.fn(() => {
				calls.push("ui.resetViewportAnchorIntent");
			}),
			prepareViewportAnchorForTranscriptRebuild: vi.fn(() => {
				calls.push("ui.prepareViewportAnchorForTranscriptRebuild");
			}),
			terminal: { columns: 120 },
		},
		session: {
			newSession,
			switchSession,
		},
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionDir: () => "/tmp/project/sessions",
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId,
			isManagedDestination: () => managedDestination,
			prepareManagedCandidateForStrictAdoption,
			listForResumePickerReadOnly,
		},
		chatContainer: {
			clear: vi.fn(() => {
				calls.push("chatContainer.clear");
			}),
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
		rebuildInitialMessages: vi.fn((policy: "replace-identity" | "reconcile-same-transcript") => {
			calls.push(`rebuildInitialMessages:${policy}`, "chatContainer.clear", "renderInitialMessages");
		}),
		reloadTodos: vi.fn(async () => {
			calls.push("reloadTodos");
		}),
		showStatus: vi.fn((message: string) => {
			calls.push(`showStatus:${message}`);
		}),
		showError: vi.fn(),
		resetIrcSidebarSession: vi.fn(() => {
			calls.push("resetIrcSidebarSession");
		}),

		showHookConfirm,
		shutdown: vi.fn(async () => undefined),
	} as unknown as TestContext;

	return {
		ctx,
		calls,
		setCurrentSessionFile(path: string) {
			sessionFile = path;
		},
		setCurrentSessionId(id: string) {
			sessionId = id;
		},
		setManagedDestination(managed: boolean) {
			managedDestination = managed;
		},
		showHookConfirm,
		newSession,
		prepareManagedCandidateForStrictAdoption,
		listForResumePickerReadOnly,
		switchSession,
	};
}

function renderText(selector: SessionSelectorComponent): string {
	return selector.render(120).join("\n");
}

beforeAll(() => {
	initTheme();
});

describe("SelectorController session deletion", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resets manual viewport intent before rendering a different session", async () => {
		const { ctx, calls } = createContext("/tmp/project/sessions/a.jsonl");
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession("/tmp/project/sessions/b.jsonl");

		expect(calls).toContain("rebuildInitialMessages:replace-identity");
		expect(calls.indexOf("rebuildInitialMessages:replace-identity")).toBeLessThan(
			calls.indexOf("chatContainer.clear"),
		);
		expect(calls.indexOf("chatContainer.clear")).toBeLessThan(calls.indexOf("renderInitialMessages"));
	});

	it("reconciles manual viewport intent before reloading the same session path", async () => {
		const sessionPath = "/tmp/project/sessions/a.jsonl";
		const { ctx, calls } = createContext(sessionPath);
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession(sessionPath);

		expect(calls).toContain("rebuildInitialMessages:reconcile-same-transcript");
		expect(calls).not.toContain("rebuildInitialMessages:replace-identity");
	});

	it("resets viewport intent when the same path loads a different session identity", async () => {
		const sessionPath = "/tmp/project/sessions/a.jsonl";
		const { ctx, calls, setCurrentSessionId, switchSession } = createContext(sessionPath);
		switchSession.mockImplementation(async () => {
			setCurrentSessionId("replacement-session-id");
			return true;
		});
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession(sessionPath);

		expect(calls).toContain("rebuildInitialMessages:replace-identity");
		expect(calls).not.toContain("rebuildInitialMessages:reconcile-same-transcript");
	});

	it("prepares a legacy managed candidate against its inspected identity before switching", async () => {
		const legacyPath = "/tmp/project/legacy/session.jsonl";
		const migratedPath = "/tmp/project/v2/session.jsonl";
		const identity = {
			canonicalPath: legacyPath,
			sessionId: "legacy",
			dev: 1n,
			ino: 1n,
			size: 1,
			mtimeMs: 1,
			mtimeNs: 1n,
			sha256: "legacy",
		};
		const { ctx, switchSession, prepareManagedCandidateForStrictAdoption, setManagedDestination } = createContext(
			"/tmp/project/sessions/a.jsonl",
		);
		setManagedDestination(true);
		vi.spyOn(SessionManager, "inspectSessionTailReadOnly").mockResolvedValue({ kind: "resumable", identity });
		prepareManagedCandidateForStrictAdoption.mockResolvedValue(migratedPath);
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession(legacyPath);

		expect(prepareManagedCandidateForStrictAdoption).toHaveBeenCalledWith(legacyPath, "copy-retain", identity);
		expect(switchSession).toHaveBeenCalledWith(migratedPath);
	});

	it("keeps explicit selections out of the managed migration fence", async () => {
		const explicitPath = "/tmp/project/explicit/session.jsonl";
		const { ctx, switchSession, prepareManagedCandidateForStrictAdoption } = createContext(
			"/tmp/project/sessions/a.jsonl",
		);
		const inspection = vi.spyOn(SessionManager, "inspectSessionTailReadOnly");
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession(explicitPath);

		expect(inspection).not.toHaveBeenCalled();
		expect(prepareManagedCandidateForStrictAdoption).not.toHaveBeenCalled();
		expect(switchSession).toHaveBeenCalledWith(explicitPath);
	});

	it("does not switch after a managed replacement race rejects the inspected identity", async () => {
		const selectedPath = "/tmp/project/legacy/session.jsonl";
		const identity = {
			canonicalPath: selectedPath,
			sessionId: "selected",
			dev: 1n,
			ino: 1n,
			size: 1,
			mtimeMs: 1,
			mtimeNs: 1n,
			sha256: "before-replacement",
		};
		const { ctx, switchSession, prepareManagedCandidateForStrictAdoption, setManagedDestination } = createContext(
			"/tmp/project/sessions/a.jsonl",
		);
		setManagedDestination(true);
		vi.spyOn(SessionManager, "inspectSessionTailReadOnly").mockResolvedValue({ kind: "resumable", identity });
		prepareManagedCandidateForStrictAdoption.mockRejectedValue(
			new Error("Managed session changed before migration authority was adopted."),
		);
		const controller = new SelectorController(ctx);

		await expect(controller.handleResumeSession(selectedPath)).rejects.toThrow("changed before migration");

		expect(prepareManagedCandidateForStrictAdoption).toHaveBeenCalledWith(selectedPath, "copy-retain", identity);
		expect(switchSession).not.toHaveBeenCalled();
	});

	it("lists sessions through the active manager's captured destination authority", async () => {
		const { ctx, listForResumePickerReadOnly } = createContext("/tmp/project/sessions/a.jsonl");
		const controller = new SelectorController(ctx);

		await controller.showSessionSelector();

		expect(listForResumePickerReadOnly).toHaveBeenCalledWith();
	});

	it("detaches the active session before selector deletion removes it", async () => {
		const activeSession = makeSessionInfo("/tmp/project/sessions/active.jsonl");
		const { ctx, calls, listForResumePickerReadOnly } = createContext(activeSession.path);
		listForResumePickerReadOnly.mockResolvedValue([activeSession]);
		const dropSession = vi.fn(async (sessionPath: string) => {
			calls.push(`deleteManaged:${sessionPath}`);
		});
		Object.assign(ctx.sessionManager, { dropSession });
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

		expect(dropSession).toHaveBeenCalledWith(activeSession.path);
		expect(calls).toEqual([
			"editorContainer.clear",
			"editorContainer.addChild",
			"ui.requestRender",
			"session.newSession",
			"resetIrcSidebarSession",
			"loadingAnimation.stop",
			"statusContainer.clear",
			"pendingMessagesContainer.clear",
			"pendingTools.clear",
			"statusLine.invalidate",
			"statusLine.setSessionStartTime",
			"updateEditorTopBorder",
			"updateEditorBorderColor",
			"rebuildInitialMessages:replace-identity",
			"chatContainer.clear",
			"renderInitialMessages",
			"reloadTodos",
			"ui.requestRender",
			`deleteManaged:${activeSession.path}`,
			"ui.requestRender",
		]);
		expect(ctx.sessionManager.getSessionFile()).toBe("/tmp/project/sessions/detached.jsonl");
	});

	it("shows inline selector errors when session deletion fails after detach", async () => {
		const activeSession = makeSessionInfo("/tmp/project/sessions/active.jsonl");
		const { ctx, newSession, listForResumePickerReadOnly } = createContext(activeSession.path);
		listForResumePickerReadOnly.mockResolvedValue([activeSession]);
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
			"resetIrcSidebarSession",
			"loadingAnimation.stop",
			"statusContainer.clear",
			"pendingMessagesContainer.clear",
			"pendingTools.clear",
			"statusLine.invalidate",
			"statusLine.setSessionStartTime",
			"updateEditorTopBorder",
			"updateEditorBorderColor",
			"rebuildInitialMessages:replace-identity",
			"chatContainer.clear",
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
