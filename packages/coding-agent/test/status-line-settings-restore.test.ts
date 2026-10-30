import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Container } from "@gajae-code/tui";
import { getProjectDir, setProjectDir } from "@gajae-code/utils";
import { resetSettingsForTest, Settings, settings } from "../src/config/settings";
import { SettingsSelectorComponent } from "../src/modes/components/settings-selector";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { buildStatusLineSettings, SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

/** Minimal session shape the status line reads from during rendering. */
function createStatusLineSession(sessionName: string) {
	return {
		state: { messages: [] },
		isStreaming: false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		isFastModeActive: () => false,
		sessionManager: {
			getSessionName: () => sessionName,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

// Every field the preview / cancel-restore / commit paths must keep in sync.
const RESTORED_FIELDS = [
	"preset",
	"leftSegments",
	"rightSegments",
	"separator",
	"showHookStatus",
	"sessionAccent",
	"maxRows",
	"segmentOptions",
] as const;

describe("buildStatusLineSettings snapshot", () => {
	it("reflects the persisted statusLine.maxRows", () => {
		settings.set("statusLine.maxRows", 3);
		expect(buildStatusLineSettings(settings).maxRows).toBe(3);

		settings.set("statusLine.maxRows", 1);
		expect(buildStatusLineSettings(settings).maxRows).toBe(1);
	});

	it("includes every field the status line restores on cancel", () => {
		const snapshot = buildStatusLineSettings(settings);
		for (const field of RESTORED_FIELDS) {
			expect(snapshot).toHaveProperty(field);
		}
	});
});

describe("status line preview/cancel restore (statusLine.maxRows)", () => {
	const SESSION = "RestoreSess1";

	// Persist an overflow-prone single-row layout as the "saved" state.
	function persistSavedLayout(): void {
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["gajae", "session"]);
		settings.set("statusLine.rightSegments", ["session_name", "time"]);
		settings.set("statusLine.separator", "pipe");
		settings.set("statusLine.sessionAccent", false);
		settings.set("statusLine.maxRows", 1);
	}

	it("does not leave the previewed row count active after cancel", () => {
		persistSavedLayout();
		const component = new StatusLineComponent(createStatusLineSession(SESSION));

		// Saved state: maxRows 1 always collapses to a single row.
		component.updateSettings(buildStatusLineSettings(settings));
		expect(component.render(24)).toHaveLength(1);

		// Preview a taller status line (like selecting maxRows = 3 in /settings).
		component.updateSettings({ maxRows: 3 });
		expect(component.render(24).length).toBeGreaterThan(1);

		// Cancel restores from the saved settings; the previewed 3 rows must be gone.
		component.updateSettings(buildStatusLineSettings(settings));
		expect(component.render(24)).toHaveLength(1);
	});

	it("refreshes the rendered status line after accepted configuration changes", () => {
		persistSavedLayout();
		const component = new StatusLineComponent(createStatusLineSession(SESSION));
		component.updateSettings(buildStatusLineSettings(settings));
		expect(component.render(24)).toHaveLength(1);
		let renders = 0;
		let borderUpdates = 0;
		let stopped = false;
		const controller = new SelectorController({
			settings,
			statusLine: component,
			isStopped: () => stopped,
			updateEditorTopBorder: () => borderUpdates++,
			ui: { requestRender: () => renders++ },
		} as unknown as InteractiveModeContext);
		settings.set("statusLine.maxRows", 3);
		controller.refreshConfiguration();
		expect(component.render(24).length).toBeGreaterThan(1);
		expect(renders).toBe(1);
		expect(borderUpdates).toBe(1);

		stopped = true;
		settings.set("statusLine.maxRows", 1);
		controller.refreshConfiguration();
		expect(component.render(24).length).toBeGreaterThan(1);
		expect(renders).toBe(1);
		component.dispose();
	});

	it("preserves an active preview, then releases cancelled values before the next reload", async () => {
		persistSavedLayout();
		const statusLine = new StatusLineComponent(createStatusLineSession(SESSION));
		const editorContainer = new Container();
		const editor = Object.assign(new Container(), { getTopBorderAvailableWidth: () => 24 });
		editorContainer.addChild(editor);
		const selectorReady = Promise.withResolvers<SettingsSelectorComponent>();
		const ui = {
			terminal: { columns: 24 },
			requestRender: () => {},
			setFocus: (component: unknown) => {
				if (component instanceof SettingsSelectorComponent) selectorReady.resolve(component);
			},
		};
		const context = {
			settings,
			statusLine,
			editorContainer,
			editor,
			ui,
			session: {
				getAvailableThinkingLevels: () => [],
				thinkingLevel: undefined,
				getActiveModelProfile: () => undefined,
				modelRegistry: { getModelProfiles: () => new Map() },
			},
			sessionManager: {},
			isStopped: () => false,
			updateEditorTopBorder: () => {},
			showError: () => {},
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(context);
		let selector: SettingsSelectorComponent | undefined;
		const timeout = setTimeout(() => selectorReady.reject(new Error("Settings selector did not open")), 5_000);
		controller.showSettingsSelector();
		try {
			selector = await selectorReady.promise;
			let selectedRowsDescription = selector.render(120).join("\n");
			for (
				let index = 0;
				index < 40 && !selectedRowsDescription.includes("Maximum rows for the status line");
				index++
			) {
				selector.handleInput("\x1b[B");
				selectedRowsDescription = selector.render(120).join("\n");
			}
			expect(selectedRowsDescription).toContain("Maximum rows for the status line");

			settings.set("statusLine.maxRows", 2);
			controller.refreshConfiguration();
			expect(Bun.stripANSI(selector.render(120).join("\n"))).toMatch(/Status Line Rows\s+2/);
			expect(selector.render(120).join("\n")).toContain("Maximum rows for the status line");
			settings.set("statusLine.maxRows", 1);
			controller.refreshConfiguration();

			selector.handleInput("\n"); // Open Status Line Rows.
			selector.handleInput("\x1b[B"); // Preview 2 rows.
			selector.handleInput("\x1b[B"); // Preview 3 rows.
			expect(statusLine.render(24).length).toBeGreaterThan(1);

			settings.set("statusLine.maxRows", 1); // Accepted external configuration.
			controller.refreshConfiguration();
			expect(statusLine.render(24).length).toBeGreaterThan(1); // The active 3-row draft remains visible.

			selector.handleInput("\x1b"); // Cancel restores the newly accepted saved value.
			expect(statusLine.render(24)).toHaveLength(1);
			settings.set("statusLine.maxRows", 3);
			controller.refreshConfiguration();
			expect(statusLine.render(24).length).toBeGreaterThan(1);
		} finally {
			clearTimeout(timeout);
			if (selector) {
				if ((selector.getFocusComponent() as { navigationLocked?: boolean }).navigationLocked) {
					selector.handleInput("\x1b");
				}
				selector.handleInput("\x1b");
			}
			statusLine.dispose();
		}
	});
});

describe("generated config schema", () => {
	it("exposes statusLine.maxRows", () => {
		const schemaPath = path.resolve(import.meta.dir, "../../../schemas/config.schema.json");
		const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
		const maxRows = schema.properties?.statusLine?.properties?.maxRows;
		expect(maxRows).toBeDefined();
		expect(maxRows.type).toBe("number");
	});
});
