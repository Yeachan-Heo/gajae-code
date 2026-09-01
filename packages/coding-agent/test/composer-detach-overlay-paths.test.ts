import { describe, expect, test, vi } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Container, Input } from "@gajae-code/tui";
import { getAgentDir, getDefaultTabWidth, getLogsDir, setAgentDir, setDefaultTabWidth } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { AsyncJobManager } from "../src/async";
import { DebugSelectorComponent } from "../src/debug";
import { DebugLogViewerComponent } from "../src/debug/log-viewer";
import { RawSseViewerComponent } from "../src/debug/raw-sse";
import { RawSseDebugBuffer } from "../src/debug/raw-sse-buffer";
import { BorderedLoader } from "../src/modes/components/bordered-loader";
import { CustomEditor } from "../src/modes/components/custom-editor";
import { PetFramedEditor } from "../src/modes/components/gajae-pet-widget";
import { JobsOverlayComponent } from "../src/modes/components/jobs-overlay";
import { MCPAddWizard } from "../src/modes/components/runtime-mcp-add-wizard";
import { TasksPaneComponent } from "../src/modes/components/tasks-pane";
import { CommandController } from "../src/modes/controllers/command-controller";
import { MCPCommandController } from "../src/modes/controllers/runtime-mcp-command-controller";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { JobsObserver } from "../src/modes/jobs-observer";
import { SessionObserverRegistry } from "../src/modes/session-observer-registry";
import { TasksAggregator } from "../src/modes/tasks-aggregator";
import { getCurrentThemeName, getThemeByName, initTheme, setTheme, setThemeInstance } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

const testTheme = await getThemeByName("red-claw");
if (!testTheme) throw new Error("Failed to load red-claw test theme");

/**
 * Issue #4657 regression harness: mount a real CustomEditor in a real
 * Container so the terminal disposal contract is observable end to end.
 *
 * The composer is reusable across overlays: Container.clear() disposes
 * children terminally, and Editor.dispose() unregisters the tab-width change
 * listener. An overlay-open path that calls clear() with the live composer
 * attached silently kills that listener; every later restore re-mounts a dead
 * editor and runtime tab-width changes stop re-deriving composer layout.
 *
 * Each test drives the exact production open path through its real controller
 * (SelectorController, CommandController, MCPCommandController, or
 * DebugSelectorComponent for the /debug viewers), closes it the way
 * production closes it, and then asserts the composer's tab-width listener
 * still fires across overlay cycles — the invalidation probe from
 * gajae-pet-widget.test.ts. The trailing "red control" block proves the probe
 * itself is sound: a genuinely disposed editor stops accruing invalidations.
 */

const CANCEL_KEY = "\u001b";
const CTRL_C_KEY = "\x03";
const SELECT_CONFIRM_KEY = "\r";
const SELECT_DOWN_KEY = "\u001b[B";
const WAIT_TIMEOUT_MS = 5_000;

function countInvalidations(editor: CustomEditor): { count: number } {
	const invalidations = { count: 0 };
	const originalInvalidate = editor.invalidate.bind(editor);
	editor.invalidate = () => {
		invalidations.count += 1;
		originalInvalidate();
	};
	return invalidations;
}

function makeComposerHarness() {
	const editor = new CustomEditor(defaultEditorTheme);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const chatContainer = new Container();
	const ctx = {
		editor,
		editorContainer,
		chatContainer,
		showWarning: () => {},
		showError: () => {},
		showStatus: () => {},
		isStopped: () => false,
		sessionManager: { getCwd: () => process.cwd() },
		ui: {
			setFocus: () => {},
			requestRender: () => {},
			requestLayoutRender: () => {},
			terminal: { rows: 30, columns: 80 },
		},
	} as unknown as InteractiveModeContext;
	return { editor, editorContainer, chatContainer, ctx };
}

/**
 * The /debug viewers re-open the selector through `ctx.showDebugSelector()`
 * (debug/index.ts onExit); wire that hook to the real SelectorController
 * method so the production cycle runs end to end.
 */
function makeDebugHarness() {
	const harness = makeComposerHarness();
	const controller = new SelectorController(harness.ctx);
	const debugCtx = {
		...harness.ctx,
		showDebugSelector: () => controller.showDebugSelector(),
	} as unknown as InteractiveModeContext;
	const debugController = new SelectorController(debugCtx);
	return { harness, controller: debugController };
}

/**
 * Toggle the default tab width once and assert the composer's listener fired.
 * Returns the invalidation count after the toggle.
 */
function expectTabWidthToggleInvalidates(
	invalidations: { count: number },
	previous: number,
	defaultWidth: number,
): number {
	const otherWidth = defaultWidth === 3 ? 4 : 3;
	setDefaultTabWidth(otherWidth);
	setDefaultTabWidth(defaultWidth);
	expect(invalidations.count).toBeGreaterThan(previous);
	return invalidations.count;
}

/** Red control for the probe: a genuinely disposed editor stops invalidating. */
function expectDisposedEditorStopsInvalidating(
	editor: CustomEditor,
	editorContainer: Container,
	invalidations: { count: number },
	defaultWidth: number,
): void {
	const disposedCount = invalidations.count;
	editorContainer.clear();
	editorContainer.addChild(editor);
	const otherWidth = defaultWidth === 3 ? 4 : 3;
	setDefaultTabWidth(otherWidth);
	expect(invalidations.count).toBe(disposedCount);
}

/**
 * Bounded condition wait: no unbounded polls and no fixed timing assumptions.
 * Fails loudly with `description` when the condition never holds.
 */
async function waitUntil(condition: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await Bun.sleep(1);
	}
}

/** Process-global state this fixture mutates, snapshotted for exact restore. */
interface LifecycleGlobalsSnapshot {
	tabWidth: number;
	themeName: string | undefined;
}

/**
 * Snapshot the fixture's process-global state before a test mutates it, so
 * the finally block restores the exact prior values instead of hard-resetting
 * theme/tab width to constants and leaking them into later suites.
 */
function snapshotLifecycleGlobals(): LifecycleGlobalsSnapshot {
	return { tabWidth: getDefaultTabWidth(), themeName: getCurrentThemeName() };
}

/** Exact-inverse restore of {@link snapshotLifecycleGlobals}. */
async function restoreLifecycleGlobals(snapshot: LifecycleGlobalsSnapshot): Promise<void> {
	setDefaultTabWidth(snapshot.tabWidth);
	// The theme module exposes no live-instance getter, so restore through its
	// public API: a real prior name reloads that theme, and an unresolvable
	// prior (never initialized, or another suite's in-memory instance) falls
	// back to the canonical initTheme() default state.
	if (snapshot.themeName && snapshot.themeName !== "<in-memory>") {
		await setTheme(snapshot.themeName);
	} else {
		await initTheme();
	}
}

function restoreEnvVar(name: string, original: string | undefined): void {
	if (original === undefined) delete process.env[name];
	else process.env[name] = original;
}

/**
 * Pin the config-root and agent-dir resolution to exclusively owned
 * directories for one test.
 *
 * Both config-dir selectors (`GJC_CONFIG_DIR` and its legacy alias
 * `PI_CONFIG_DIR`) are pinned to the same per-run unique name — `GJC_CONFIG_DIR`
 * takes precedence, so pinning only the alias would let a caller-provided
 * override redirect resolution (and cleanup) outside this run's tree. The
 * agent directory gets its own mkdtemp root. The resolved config root is
 * asserted to sit inside the exclusive name before anything is seeded, so a
 * resolver that refuses the override (e.g. a project-env provenance clash)
 * fails the test loudly instead of touching the real `~/.gjc`.
 *
 * The config root is derived from the home directory, so the home is first
 * redirected to an owned temp tree. Anchoring the exclusive name under the
 * real home instead put the tree outside every allowed cleanup root, and the
 * fail-closed test cleanup contract (#4794) aborted the whole test process
 * rather than recursing there — taking every later file in the run with it and
 * leaving the directory behind in the developer's home.
 *
 * The returned restore closure puts the exact prior environment, home, and
 * agent directory back and removes both exclusive trees.
 */
async function pinExclusiveDirState(): Promise<{ restore: () => Promise<void> }> {
	const originalAgentDir = getAgentDir();
	const originalConfigDir = process.env.PI_CONFIG_DIR;
	const originalGjcConfigDir = process.env.GJC_CONFIG_DIR;
	const originalCodingAgentDir = process.env.GJC_CODING_AGENT_DIR;
	const originalHome = process.env.HOME;
	const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-composer-detach-home-"));
	const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeRoot);
	process.env.HOME = homeRoot;
	const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-composer-detach-agent-"));
	const configName = `gjc-composer-detach-${randomUUID()}`;
	process.env.GJC_CONFIG_DIR = configName;
	process.env.PI_CONFIG_DIR = configName;
	setAgentDir(agentRoot);
	const exclusiveRoot = path.join(os.homedir(), configName);
	const configRoot = path.dirname(getLogsDir());
	if (!configRoot.startsWith(exclusiveRoot)) {
		throw new Error(`config root ${configRoot} escaped the exclusive test tree ${exclusiveRoot}`);
	}
	return {
		restore: async () => {
			restoreEnvVar("PI_CONFIG_DIR", originalConfigDir);
			restoreEnvVar("GJC_CONFIG_DIR", originalGjcConfigDir);
			// setAgentDir re-exports GJC_CODING_AGENT_DIR, so restore it after.
			setAgentDir(originalAgentDir);
			restoreEnvVar("GJC_CODING_AGENT_DIR", originalCodingAgentDir);
			restoreEnvVar("HOME", originalHome);
			homedirSpy.mockRestore();
			await safeRm(agentRoot, { recursive: true, force: true });
			await safeRm(homeRoot, { recursive: true, force: true });
		},
	};
}

/** Seed today's dated log under an exclusive config root for #handleViewLogs. */
async function seedExclusiveDatedLog(): Promise<void> {
	const logsDir = getLogsDir();
	await fs.mkdir(logsDir, { recursive: true });
	const today = new Date().toISOString().slice(0, 10);
	await Bun.write(path.join(logsDir, `gjc.${today}.log`), "seeded log line\n");
}

describe("reusable composer lifecycle across remaining overlay open paths (#4657)", () => {
	test("jobs overlay open does not dispose the reusable composer", async () => {
		const globals = snapshotLifecycleGlobals();
		const harness = makeComposerHarness();
		const invalidations = countInvalidations(harness.editor);
		const controller = new SelectorController(harness.ctx);
		const defaultWidth = 3;

		try {
			setThemeInstance(testTheme);
			setDefaultTabWidth(defaultWidth);
			const observer = new JobsObserver(new AsyncJobManager({ onJobComplete: async () => {} }), undefined);
			let previous = 0;
			for (let cycle = 0; cycle < 4; cycle += 1) {
				controller.showJobsOverlay(observer);
				const overlay = harness.editorContainer.children.find(child => child instanceof JobsOverlayComponent);
				expect(overlay).toBeDefined();
				// Production close: cancel the overlay's focus list.
				overlay?.handleInput(CANCEL_KEY);
				expect(harness.editorContainer.children).toEqual([harness.editor]);
				previous = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
			}
			expect(previous).toBeGreaterThanOrEqual(4);
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			harness.editorContainer.clear();
			await restoreLifecycleGlobals(globals);
		}
	});

	test("tasks pane open does not dispose the reusable composer", async () => {
		const globals = snapshotLifecycleGlobals();
		const harness = makeComposerHarness();
		const invalidations = countInvalidations(harness.editor);
		const controller = new SelectorController(harness.ctx);
		const defaultWidth = 3;

		try {
			setThemeInstance(testTheme);
			setDefaultTabWidth(defaultWidth);
			const manager = new AsyncJobManager({ onJobComplete: async () => {} });
			const observer = new JobsObserver(manager, undefined);
			const aggregator = new TasksAggregator(manager, observer, new SessionObserverRegistry(), undefined);
			let previous = 0;
			for (let cycle = 0; cycle < 4; cycle += 1) {
				controller.showTasksPane(aggregator);
				const pane = harness.editorContainer.children.find(child => child instanceof TasksPaneComponent);
				expect(pane).toBeDefined();
				// Production close: cancel the pane's focus list.
				pane?.handleInput(CANCEL_KEY);
				expect(harness.editorContainer.children).toEqual([harness.editor]);
				previous = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
			}
			expect(previous).toBeGreaterThanOrEqual(4);
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			harness.editorContainer.clear();
			await restoreLifecycleGlobals(globals);
		}
	});

	test("debug log and raw-SSE viewer opens do not dispose the reusable composer", async () => {
		const globals = snapshotLifecycleGlobals();
		const { harness, controller } = makeDebugHarness();
		const invalidations = countInvalidations(harness.editor);
		const defaultWidth = 3;
		// Seed today's dated log under an exclusively owned config root so the
		// real #handleViewLogs path mounts the real viewer without touching the
		// operator's real config tree.
		const dirState = await pinExclusiveDirState();

		try {
			setThemeInstance(testTheme);
			setDefaultTabWidth(defaultWidth);
			await seedExclusiveDatedLog();

			// The production /debug entry: showDebugSelector goes through the real
			// SelectorController.showSelector generic open boundary, so the open
			// detach at that boundary is exercised too. Viewer exits re-open the
			// selector through the ctx hook exactly like production (wired in
			// makeDebugHarness).
			const openDebugSelector = () => {
				controller.showDebugSelector();
				const selector = harness.editorContainer.children.find(child => child instanceof DebugSelectorComponent);
				if (!selector) throw new Error("Expected the debug selector to mount");
				return selector;
			};
			// DEBUG_MENU_ITEMS order: open-artifacts, performance, work, dump,
			// memory, logs, system, raw-sse — "logs" is index 5, "raw-sse" is 7.
			const menuIndexes = { logs: 5, rawSse: 7 } as const;

			const runViewerCycle = async (menuIndex: number) => {
				const selector = openDebugSelector();
				for (let step = 0; step < menuIndex; step += 1) selector.handleInput(SELECT_DOWN_KEY);
				selector.handleInput(SELECT_CONFIRM_KEY);
				// DebugSelectorComponent calls done() (restore) then opens the real
				// viewer through the exact production path under test.
				await waitUntil(
					() =>
						harness.editorContainer.children.length === 1 &&
						harness.editorContainer.children[0] !== harness.editor &&
						!(harness.editorContainer.children[0] instanceof DebugSelectorComponent),
					"the debug viewer to mount",
				);
				const viewer = harness.editorContainer.children[0];
				// Concrete per-branch proof BEFORE the shared lifecycle probe: the
				// logs index must mount a DebugLogViewerComponent and the raw-SSE
				// index a RawSseViewerComponent, so a menu reorder or dispatch
				// mismatch fails here instead of staying green on the wrong path.
				if (menuIndex === menuIndexes.logs) {
					expect(viewer).toBeInstanceOf(DebugLogViewerComponent);
				} else {
					expect(viewer).toBeInstanceOf(RawSseViewerComponent);
				}
				// Production close: viewer exit re-opens the debug selector;
				// canceling that restores the composer.
				viewer?.handleInput?.(CANCEL_KEY);
				expect(harness.editorContainer.children[0]).toBeInstanceOf(DebugSelectorComponent);
				harness.editorContainer.children[0]?.handleInput?.(CANCEL_KEY);
				expect(harness.editorContainer.children).toEqual([harness.editor]);
			};

			let previous = 0;
			for (let cycle = 0; cycle < 4; cycle += 1) {
				// Both changed viewer branches, alternating per cycle.
				await runViewerCycle(cycle % 2 === 0 ? menuIndexes.logs : menuIndexes.rawSse);
				previous = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
			}
			expect(previous).toBeGreaterThanOrEqual(4);
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			harness.editorContainer.clear();
			await dirState.restore();
			await restoreLifecycleGlobals(globals);
		}
	});

	test("stale /debug log load does not replace a newer overlay owner", async () => {
		const globals = snapshotLifecycleGlobals();
		const { harness, controller } = makeDebugHarness();
		const invalidations = countInvalidations(harness.editor);
		const defaultWidth = 3;
		const dirState = await pinExclusiveDirState();

		try {
			setThemeInstance(testTheme);
			setDefaultTabWidth(defaultWidth);
			await seedExclusiveDatedLog();

			controller.showDebugSelector();
			const selector = harness.editorContainer.children.find(child => child instanceof DebugSelectorComponent);
			if (!selector) throw new Error("Expected the debug selector to mount");
			// Select "logs" (menu index 5): onSelect restores the composer
			// synchronously and then starts the async log-source load.
			for (let step = 0; step < 5; step += 1) selector.handleInput(SELECT_DOWN_KEY);
			selector.handleInput(SELECT_CONFIRM_KEY);
			// Before any event-loop turn, a newer overlay seizes the editor
			// container exactly as the production open paths do. The pending log
			// load must then discard its viewer instead of clearing and mounting
			// over the new owner.
			const observer = new JobsObserver(new AsyncJobManager({ onJobComplete: async () => {} }), undefined);
			controller.showJobsOverlay(observer);
			const overlay = harness.editorContainer.children.find(
				(child): child is JobsOverlayComponent => child instanceof JobsOverlayComponent,
			);
			if (!overlay) throw new Error("Expected the jobs overlay to mount");

			// Settle window: the stale log continuation (if it wrongly mounts)
			// runs within this bounded sleep; the assertion below is structural.
			await Bun.sleep(100);
			expect(harness.editorContainer.children).toEqual([overlay]);
			// The composer stayed alive (detached, never disposed) and the newer
			// owner was never cleared away.
			const previous = expectTabWidthToggleInvalidates(invalidations, 0, defaultWidth);
			expect(previous).toBeGreaterThan(0);
			// Red control precondition: the composer must be mounted (not just
			// alive-but-detached) for the disposed-editor probe, so close the
			// overlay the production way first.
			overlay?.handleInput(CANCEL_KEY);
			expect(harness.editorContainer.children).toEqual([harness.editor]);
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			harness.editorContainer.clear();
			await dirState.restore();
			await restoreLifecycleGlobals(globals);
		}
	});

	test("stale /debug log load does not replace newer RawSSE or Input owners", async () => {
		const globals = snapshotLifecycleGlobals();
		const { harness, controller } = makeDebugHarness();
		const invalidations = countInvalidations(harness.editor);
		const defaultWidth = 3;
		const dirState = await pinExclusiveDirState();

		try {
			setThemeInstance(testTheme);
			setDefaultTabWidth(defaultWidth);
			await seedExclusiveDatedLog();

			for (const ownerKind of ["raw-sse", "input"] as const) {
				controller.showDebugSelector();
				const selector = harness.editorContainer.children.find(child => child instanceof DebugSelectorComponent);
				if (!selector) throw new Error("Expected the debug selector to mount");
				for (let step = 0; step < 5; step += 1) selector.handleInput(SELECT_DOWN_KEY);
				selector.handleInput(SELECT_CONFIRM_KEY);

				const owner =
					ownerKind === "raw-sse"
						? new RawSseViewerComponent({
								buffer: new RawSseDebugBuffer(),
								terminalRows: 30,
								onExit: () => {},
							})
						: new Input();
				// Simulate a newer non-Container owner arriving before the pending
				// log read resolves. Both components intentionally lack the
				// structural marker the old guard used, so identity + revision are
				// required to keep this regression meaningful.
				harness.editorContainer.detachChild(harness.editor);
				harness.editorContainer.clear();
				harness.editorContainer.addChild(owner);

				await Bun.sleep(100);
				expect(harness.editorContainer.children).toEqual([owner]);
				harness.editorContainer.detachChild(owner);
				harness.editorContainer.clear();
				harness.editorContainer.addChild(harness.editor);
				expectTabWidthToggleInvalidates(invalidations, 0, defaultWidth);
			}
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			harness.editorContainer.clear();
			await dirState.restore();
			await restoreLifecycleGlobals(globals);
		}
	});

	test("/debug log viewer opens over the pet-wrapped composer", async () => {
		const globals = snapshotLifecycleGlobals();
		const harness = makeComposerHarness();
		const invalidations = countInvalidations(harness.editor);
		const defaultWidth = 3;
		const dirState = await pinExclusiveDirState();

		try {
			setThemeInstance(testTheme);
			setDefaultTabWidth(defaultWidth);
			await seedExclusiveDatedLog();

			// Production pet path: InteractiveMode.restoreComposer delegates to
			// GajaePetWidget.remountComposer, which re-adds the PetFramedEditor
			// wrapper — not the bare editor — as the container's content. The
			// wrapper has no dispose(), so clear() never disposes the editor,
			// but a stale-owner guard that only checked for the bare editor as
			// a direct child would refuse to mount the log viewer at all.
			const framed = new PetFramedEditor(harness.editor);
			const petCtx = {
				...harness.ctx,
				restoreComposer: () => {
					harness.editorContainer.clear();
					harness.editorContainer.addChild(framed);
				},
			} as unknown as InteractiveModeContext;
			const controller = new SelectorController(petCtx);
			const debugCtx = {
				...petCtx,
				showDebugSelector: () => controller.showDebugSelector(),
			} as unknown as InteractiveModeContext;
			const debugController = new SelectorController(debugCtx);

			debugController.showDebugSelector();
			const selector = harness.editorContainer.children.find(child => child instanceof DebugSelectorComponent);
			if (!selector) throw new Error("Expected the debug selector to mount");
			for (let step = 0; step < 5; step += 1) selector.handleInput(SELECT_DOWN_KEY);
			selector.handleInput(SELECT_CONFIRM_KEY);
			await waitUntil(
				() => harness.editorContainer.children[0] instanceof DebugLogViewerComponent,
				"the debug log viewer to mount over the pet-wrapped composer",
			);
			// The wrapped composer stayed alive while the viewer owns the container.
			const previous = expectTabWidthToggleInvalidates(invalidations, 0, defaultWidth);
			expect(previous).toBeGreaterThan(0);
			// Production close: viewer exit re-opens the selector; canceling that
			// restores through the pet-aware restoreComposer.
			harness.editorContainer.children[0]?.handleInput?.(CANCEL_KEY);
			expect(harness.editorContainer.children[0]).toBeInstanceOf(DebugSelectorComponent);
			harness.editorContainer.children[0]?.handleInput?.(CANCEL_KEY);
			expect(harness.editorContainer.children).toEqual([framed]);
			const after = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
			expect(after).toBeGreaterThan(previous);
		} finally {
			harness.editorContainer.clear();
			await dirState.restore();
			await restoreLifecycleGlobals(globals);
		}
	});

	test("/share custom-share loader does not dispose the reusable composer", async () => {
		const globals = snapshotLifecycleGlobals();
		const harness = makeComposerHarness();
		const invalidations = countInvalidations(harness.editor);
		const defaultWidth = 3;
		// loadCustomShare() resolves the handler from the agent directory; pin
		// an exclusively owned root and seed a gated share.ts so the loader
		// open state is observable before completion restores the composer.
		const dirState = await pinExclusiveDirState();
		const gateKey = `__gjcComposerDetachShareGate_${randomUUID()}`;
		const shareGate = Promise.withResolvers<void>();
		(globalThis as Record<string, unknown>)[gateKey] = shareGate.promise;
		await Bun.write(
			path.join(getAgentDir(), "share.ts"),
			`export default async function () {\n\tawait (globalThis as any)["${gateKey}"];\n\treturn { message: "shared" };\n}\n`,
		);

		const shareCtx = {
			...harness.ctx,
			session: { exportToHtml: async () => {} },
			openInBrowser: () => {},
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(shareCtx);

		try {
			setThemeInstance(testTheme);
			setDefaultTabWidth(defaultWidth);
			const shared = controller.handleShareCommand();
			await waitUntil(
				() => harness.editorContainer.children[0] instanceof BorderedLoader,
				"the /share loader to mount",
			);
			expect(harness.editorContainer.children.length).toBe(1);
			// The composer is detached, not disposed: the probe still fires while
			// the loader owns the container.
			let previous = expectTabWidthToggleInvalidates(invalidations, 0, defaultWidth);
			// Release the custom share handler; production restores the composer.
			shareGate.resolve();
			await shared;
			expect(harness.editorContainer.children).toEqual([harness.editor]);
			previous = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
			expect(previous).toBeGreaterThanOrEqual(2);
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			shareGate.resolve();
			delete (globalThis as Record<string, unknown>)[gateKey];
			harness.editorContainer.clear();
			await dirState.restore();
			await restoreLifecycleGlobals(globals);
		}
	});

	test("/mcp add wizard mount does not dispose the reusable composer", async () => {
		const globals = snapshotLifecycleGlobals();
		const harness = makeComposerHarness();
		const invalidations = countInvalidations(harness.editor);
		const controller = new MCPCommandController(harness.ctx);
		const defaultWidth = 3;

		try {
			setThemeInstance(testTheme);
			setDefaultTabWidth(defaultWidth);
			let previous = 0;
			for (let cycle = 0; cycle < 2; cycle += 1) {
				await controller.handle("/mcp add");
				expect(harness.editorContainer.children.length).toBe(1);
				expect(harness.editorContainer.children[0]).toBeInstanceOf(MCPAddWizard);
				// The composer is detached, not disposed, while the wizard owns
				// the container.
				previous = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
				// Production close: the wizard cancels through its interrupt key.
				const wizard = harness.editorContainer.children[0];
				expect(wizard).toBeInstanceOf(MCPAddWizard);
				(wizard as MCPAddWizard).handleInput(CTRL_C_KEY);
				expect(harness.editorContainer.children).toEqual([harness.editor]);
				previous = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
			}
			expect(previous).toBeGreaterThanOrEqual(4);
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			harness.editorContainer.clear();
			await restoreLifecycleGlobals(globals);
		}
	});

	test("OAuth API-key paste onPrompt does not dispose the reusable composer", async () => {
		const globals = snapshotLifecycleGlobals();
		const harness = makeComposerHarness();
		const invalidations = countInvalidations(harness.editor);
		const defaultWidth = 3;

		// Capture the production onPrompt callback (the exact closure under
		// test) while stubbing everything around it.
		const capturedPrompts: Array<(prompt: { message: string; placeholder?: string }) => Promise<string>> = [];
		const oauthCtx = {
			...harness.ctx,
			oauthManualInput: { waitForInput: () => Promise.resolve("code"), clear: () => {} },
			openInBrowser: () => {},
			showHookConfirm: async () => false,
			settings: { get: () => undefined },
			session: {
				modelRegistry: {
					refresh: async () => {},
					getModelProfiles: () => new Map(),
					authStorage: {
						login: async (
							_providerId: string,
							callbacks: {
								onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
							},
						) => {
							capturedPrompts.push(callbacks.onPrompt);
						},
						listCredentialInventory: () => [],
						listCredentialRemovalTargets: () => [],
					},
				},
			},
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(oauthCtx);

		try {
			setThemeInstance(testTheme);
			setDefaultTabWidth(defaultWidth);
			let previous = 0;
			for (let cycle = 0; cycle < 4; cycle += 1) {
				const opened = controller.showOAuthSelector("login", "vllm");
				// Drive the captured production onPrompt until the code input
				// mounts (the promise resolves on submit).
				const promptPromise = (async () => {
					await waitUntil(() => capturedPrompts.length > 0, "the production onPrompt callback");
					const onPrompt = capturedPrompts.shift();
					if (!onPrompt) throw new Error("Expected a captured onPrompt callback");
					return onPrompt({ message: "Paste your API key" });
				})();
				// Find the mounted code Input through a bounded mount wait, not a
				// fixed sleep.
				const findCodeInput = (): Input | undefined =>
					oauthCtx.editorContainer.children.find(
						(child): child is Input =>
							child instanceof Input && typeof (child as { onSubmit?: unknown }).onSubmit === "function",
					);
				await waitUntil(() => findCodeInput() !== undefined, "the API-key code input to mount");
				const codeInput = findCodeInput();
				if (!codeInput) throw new Error("Expected the API-key code input to mount");
				for (const character of "sk-test") codeInput.handleInput(character);
				codeInput.handleInput("\r");
				await promptPromise;
				await opened;
				expect(oauthCtx.editorContainer.children).toEqual([harness.editor]);
				previous = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
			}
			expect(previous).toBeGreaterThanOrEqual(4);
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			harness.editorContainer.clear();
			await restoreLifecycleGlobals(globals);
		}
	});
});
