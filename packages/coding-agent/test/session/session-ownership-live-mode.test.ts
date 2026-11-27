/**
 * `liveSessionOwnershipModeFor`: the mode a running process decides by. It is the lower of the mode
 * the process read and the operator's config file reread now, where only an explicit lower value in
 * the file lowers it. Driven through the setting source itself, never the forced test mode, so the
 * lower-of-two rule and a mid-run `off` are what is measured.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SessionOwnershipTestHooks } from "../../src/session/session-ownership";
import {
	liveSessionOwnershipModeFor,
	resetSessionOwnershipModeForTests,
	type SessionOwnershipMode,
	sessionOwnershipMode,
	setSessionOwnershipSettingSource,
} from "../../src/session/session-ownership-mode";

/** The process's settings (`processValue`) and the file on disk now (`fileValue`). */
const source: { processValue: unknown; fileValue: unknown } = { processValue: undefined, fileValue: undefined };
let savedEnv: string | undefined;

beforeEach(() => {
	delete SessionOwnershipTestHooks.mode;
	savedEnv = process.env.GJC_SESSION_OWNERSHIP;
	delete process.env.GJC_SESSION_OWNERSHIP;
	resetSessionOwnershipModeForTests();
	setSessionOwnershipSettingSource(options => (options?.fresh ? source.fileValue : source.processValue));
});

afterEach(() => {
	setSessionOwnershipSettingSource(undefined);
	if (savedEnv === undefined) delete process.env.GJC_SESSION_OWNERSHIP;
	else process.env.GJC_SESSION_OWNERSHIP = savedEnv;
	resetSessionOwnershipModeForTests();
});

describe("liveSessionOwnershipModeFor", () => {
	it("takes the lower of the process mode and an explicit value in the file, and never raises", () => {
		const cases: Array<[SessionOwnershipMode, unknown, SessionOwnershipMode]> = [
			["enforce", undefined, "enforce"],
			["enforce", "enforce", "enforce"],
			["enforce", "observe", "observe"],
			["enforce", "off", "off"],
			["observe", "enforce", "observe"],
			["observe", undefined, "observe"],
			["observe", "off", "off"],
			["off", "enforce", "off"],
			["enforce", "not-a-mode", "enforce"],
		];
		for (const [processMode, fileValue, expected] of cases) {
			source.fileValue = fileValue;
			expect([processMode, fileValue, liveSessionOwnershipModeFor(processMode)]).toEqual([
				processMode,
				fileValue,
				expected,
			]);
		}
	});

	it("defaults to the process's own mode, and sees `off` written while the process runs", () => {
		source.processValue = "enforce";
		source.fileValue = "enforce";
		expect(sessionOwnershipMode()).toBe("enforce");
		expect(liveSessionOwnershipModeFor()).toBe("enforce");
		source.fileValue = "off";
		expect(liveSessionOwnershipModeFor()).toBe("off");
		// With no mode in the settings the process runs the default, `observe`, and a file naming
		// none leaves it there.
		source.processValue = undefined;
		source.fileValue = undefined;
		expect(liveSessionOwnershipModeFor()).toBe("observe");
	});
});
