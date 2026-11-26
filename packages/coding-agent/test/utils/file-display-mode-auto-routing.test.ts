import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { FileDisplayModeSession } from "@gajae-code/coding-agent/utils/file-display-mode";
import { resolveFileDisplayMode } from "@gajae-code/coding-agent/utils/file-display-mode";

// ─── Env isolation ───────────────────────────────────────────────────────────

let savedGjcVariant: string | undefined;
let savedPiVariant: string | undefined;

beforeEach(() => {
	savedGjcVariant = Bun.env.GJC_EDIT_VARIANT;
	savedPiVariant = Bun.env.PI_EDIT_VARIANT;
	delete Bun.env.GJC_EDIT_VARIANT;
	delete Bun.env.PI_EDIT_VARIANT;
});

afterEach(() => {
	if (savedGjcVariant === undefined) delete Bun.env.GJC_EDIT_VARIANT;
	else Bun.env.GJC_EDIT_VARIANT = savedGjcVariant;
	if (savedPiVariant === undefined) delete Bun.env.PI_EDIT_VARIANT;
	else Bun.env.PI_EDIT_VARIANT = savedPiVariant;
	resetSettingsForTest();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(options: {
	model?: string;
	readLineNumbers?: boolean;
	hasEditTool?: boolean;
	editMode?: string;
}): FileDisplayModeSession & { getActiveModelString?: () => string | undefined } {
	const globalSettings: Record<string, unknown> = {};
	if (options.readLineNumbers !== undefined) globalSettings.readLineNumbers = options.readLineNumbers;
	if (options.editMode !== undefined) globalSettings["edit.mode"] = options.editMode;
	const session: FileDisplayModeSession & { getActiveModelString?: () => string | undefined } = {
		settings: Settings.isolated(globalSettings as never),
		...(options.hasEditTool !== undefined ? { hasEditTool: options.hasEditTool } : {}),
		...(options.model !== undefined ? { getActiveModelString: () => options.model } : {}),
	};
	return session;
}

// ─── File display mode: line numbers ─────────────────────────────────────────

describe("resolveFileDisplayMode", () => {
	test("line numbers default to off", () => {
		for (const model of [
			"openai/gpt-5.4",
			"anthropic/claude-sonnet-4-6",
			"deepseek/deepseek-v3.2",
			"zai/glm-4.7",
			undefined,
		]) {
			const mode = resolveFileDisplayMode(makeSession({ model }));
			expect(mode.lineNumbers).toBe(false);
		}
	});

	test("readLineNumbers: true enables line numbers", () => {
		const mode = resolveFileDisplayMode(makeSession({ model: "openai/gpt-5.4", readLineNumbers: true }));
		expect(mode.lineNumbers).toBe(true);
	});



	test("raw reads suppress line numbers", () => {
		const raw = resolveFileDisplayMode(makeSession({ model: "zai/glm-4.7", readLineNumbers: true }), { raw: true });
		expect(raw.lineNumbers).toBe(false);
	});

	test("immutable reads suppress line numbers", () => {
		const immutable = resolveFileDisplayMode(
			makeSession({ model: "zai/glm-4.7", readLineNumbers: true }),
			{ immutable: true },
		);
		expect(immutable.lineNumbers).toBe(false);
	});
});
