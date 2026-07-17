import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@gajae-code/utils";
import { resetSettingsForTest, Settings, settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { buildStatusLineSettings } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";

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
