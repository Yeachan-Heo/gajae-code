import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { JobsOverlayComponent } from "../src/modes/components/jobs-overlay";
import { TasksPaneComponent } from "../src/modes/components/tasks-pane";
import { MCPCommandController } from "../src/modes/controllers/runtime-mcp-command-controller";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

beforeAll(async () => {
	const loadedTheme = await getThemeByName("red-claw");
	if (!loadedTheme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(loadedTheme);
});
type TestEditor = {
	id: string;
};

type TestEditorContainer = {
	children: unknown[];
	clearCount: number;
	clear(): void;
	addChild(child: unknown): void;
	detachChild(child: unknown): void;
};

function makeEditorContainer(editor: TestEditor): TestEditorContainer {
	const container: TestEditorContainer = {
		children: [editor],
		clearCount: 0,
		clear() {
			container.clearCount += 1;
			container.children = [];
		},
		addChild(child: unknown) {
			container.children.push(child);
		},
		detachChild(child: unknown) {
			const index = container.children.indexOf(child);
			if (index !== -1) container.children.splice(index, 1);
		},
	};
	return container;
}

type OverlayHost = {
	ctx: InteractiveModeContext;
	editorContainer: TestEditorContainer;
	editor: TestEditor;
	restoreComposer: ReturnType<typeof vi.fn>;
	detachComposer: ReturnType<typeof vi.fn>;
};

/**
 * Minimal host double: an active pet session restores the framed composer
 * through ctx.restoreComposer() and never re-adds the raw editor directly.
 */
function makeOverlayHost(): OverlayHost {
	const editor: TestEditor = { id: "core-editor" };
	const editorContainer = makeEditorContainer(editor);
	const restoreComposer = vi.fn(() => {
		editorContainer.clear();
		editorContainer.addChild({ id: "pet-framed-editor" });
	});
	const detachComposer = vi.fn(() => {
		editorContainer.detachChild(editor);
	});
	const ctx = {
		editor,
		editorContainer,
		ui: {
			requestRender: vi.fn(),
			setFocus: vi.fn(),
		},
		chatContainer: { addChild: vi.fn() },
		restoreComposer,
		detachComposer,
		isStopped: () => false,
	} as unknown as InteractiveModeContext;
	return { ctx, editorContainer, editor, restoreComposer, detachComposer };
}

function expectFramedRestore(host: OverlayHost, expectedRestoreCalls: number): void {
	expect(host.restoreComposer).toHaveBeenCalledTimes(expectedRestoreCalls);
	// The pet-aware restore remounted the framed composition, never the raw editor.
	expect(host.editorContainer.children.some(child => (child as TestEditor).id === "pet-framed-editor")).toBe(true);
	expect(host.editorContainer.children).not.toContain(host.editor);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("qa-pet-close-path-redteam (fix-forward for PR #4605 review findings)", () => {
	it("jobs overlay close restores the pet-aware composer instead of the raw editor", () => {
		const host = makeOverlayHost();
		const controller = new SelectorController(host.ctx as never);

		controller.showJobsOverlay({
			acknowledgeFailures: vi.fn(),
			getSnapshot: vi.fn(() => ({ monitors: [], crons: [], failedUnacknowledged: [] })),
			getMonitorOutput: vi.fn(() => ""),
		} as never);

		// Open detached the composer and mounted the overlay.
		expect(host.detachComposer).toHaveBeenCalledTimes(1);
		expect(host.editorContainer.children[0]).toBeInstanceOf(JobsOverlayComponent);

		// Cancel from the overlay list closes through the pet-aware restore.
		const overlay = host.editorContainer.children[0] as JobsOverlayComponent;
		overlay.handleInput("\x1b");

		expectFramedRestore(host, 1);
	});

	it("tasks pane close restores the pet-aware composer instead of the raw editor", () => {
		const host = makeOverlayHost();
		const controller = new SelectorController(host.ctx as never);

		controller.showTasksPane({
			acknowledgeFailures: vi.fn(),
			getSnapshot: vi.fn(() => ({ rows: [] })),
			onChange: vi.fn(() => () => {}),
		} as never);

		expect(host.detachComposer).toHaveBeenCalledTimes(1);
		expect(host.editorContainer.children[0]).toBeInstanceOf(TasksPaneComponent);

		const pane = host.editorContainer.children[0] as TasksPaneComponent;
		// Cancel closes the pane through the pet-aware restore.
		pane.handleInput("\x1b");

		expectFramedRestore(host, 1);
	});

	it("MCP add wizard close restores the pet-aware composer instead of the raw editor", async () => {
		const host = makeOverlayHost();
		const controller = new MCPCommandController(host.ctx as never);

		// "/mcp add" with no args opens the wizard overlay.
		await controller.handle("mcp add");

		const wizard = host.editorContainer.children[0];
		expect(wizard).toBeDefined();
		expect(host.detachComposer).toHaveBeenCalledTimes(1);

		// Cancel through the wizard's cancel path closes through the pet-aware restore.
		const handleInput = (wizard as { handleInput: (data: string) => void }).handleInput.bind(wizard);
		handleInput("\x1b");
		handleInput("\r");

		expectFramedRestore(host, 1);
	});

	it("OAuth manual-code submit restores the pet-aware composer instead of the raw editor", async () => {
		const host = makeOverlayHost();
		const controller = new SelectorController(host.ctx as never);

		let capturedPrompt: ((prompt: { message: string; placeholder?: string }) => Promise<string>) | undefined;
		const login = vi.fn(
			async (
				_providerId: string,
				handlers: {
					onAuth: (info: { url: string }) => void;
					onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
				},
			) => {
				capturedPrompt = handlers.onPrompt;
				handlers.onAuth({ url: "https://example.com/oauth" });
			},
		);
		const ctx = host.ctx as unknown as Record<string, unknown>;
		ctx.session = {
			modelRegistry: {
				authStorage: {
					login,
					listCredentialInventory: vi.fn(() => []),
					listCredentialRemovalTargets: vi.fn(() => []),
				},
				refresh: vi.fn(async () => {}),
				getModelProfiles: vi.fn(() => new Map()),
			},
			setCredentialPin: vi.fn(async () => {}),
			setCredentialAuto: vi.fn(async () => {}),
		};
		ctx.oauthManualInput = { clear: vi.fn(), waitForInput: vi.fn(async () => "unused") };
		ctx.showStatus = vi.fn();
		ctx.showError = vi.fn();

		// anthropic is a callback-server provider, so login uses the manual
		// code input overlay.
		await controller.showOAuthSelector("login", "anthropic");

		// onAuth ran without an overlay; the prompt opens the code input.
		expect(capturedPrompt).toBeDefined();
		const promptPromise = capturedPrompt!({ message: "Paste the code" });

		const codeInput = host.editorContainer.children.find(
			child => typeof (child as { onSubmit?: unknown }).onSubmit === "function",
		) as { onSubmit: (data?: string) => void; handleInput: (data: string) => void; getValue?: () => string };
		expect(codeInput).toBeDefined();
		codeInput.handleInput("a");
		codeInput.onSubmit();

		await expect(promptPromise).resolves.toBe("a");
		expectFramedRestore(host, 1);
	});

	it("jobs/tasks close paths keep working for hosts that predate restoreComposer (fallback)", () => {
		const host = makeOverlayHost();
		const legacyHost = {
			...host,
			ctx: { ...host.ctx, restoreComposer: undefined } as unknown as InteractiveModeContext,
		};
		const controller = new SelectorController(legacyHost.ctx as never);

		controller.showJobsOverlay({
			acknowledgeFailures: vi.fn(),
			getSnapshot: vi.fn(() => ({ monitors: [], crons: [], failedUnacknowledged: [] })),
			getMonitorOutput: vi.fn(() => ""),
		} as never);

		const overlay = legacyHost.editorContainer.children[0] as JobsOverlayComponent;
		overlay.handleInput("\x1b");

		// Fallback swaps the raw editor back in.
		expect(legacyHost.editorContainer.children).toEqual([legacyHost.editor]);
	});
});
