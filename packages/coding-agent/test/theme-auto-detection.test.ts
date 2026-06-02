import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import * as nativesModule from "@gajae-code/natives";
import { MacOSAppearance } from "@gajae-code/natives";

const originalPlatform = process.platform;
const originalColorfgbg = Bun.env.COLORFGBG;
const originalZellij = Bun.env.ZELLIJ;

type ThemeTestGlobals = {
	platform?: NodeJS.Platform;
	colorfgbg?: string;
	zellij?: string;
};

const withThemeTestGlobals = (globals: ThemeTestGlobals = {}) => {
	Object.defineProperty(process, "platform", {
		value: globals.platform ?? "darwin",
		configurable: true,
		writable: true,
	});

	if (globals.colorfgbg === undefined) delete Bun.env.COLORFGBG;
	else Bun.env.COLORFGBG = globals.colorfgbg;

	if (globals.zellij === undefined) delete Bun.env.ZELLIJ;
	else Bun.env.ZELLIJ = globals.zellij;

	return {
		[Symbol.dispose]() {
			themeModule.stopThemeWatcher();
			Object.defineProperty(process, "platform", {
				value: originalPlatform,
				configurable: true,
				writable: true,
			});
			if (originalColorfgbg === undefined) delete Bun.env.COLORFGBG;
			else Bun.env.COLORFGBG = originalColorfgbg;
			if (originalZellij === undefined) delete Bun.env.ZELLIJ;
			else Bun.env.ZELLIJ = originalZellij;
			vi.restoreAllMocks();
		},
	};
};

describe("theme auto-detection", () => {
	beforeEach(async () => {
		themeModule.stopThemeWatcher();
		const darkTheme = await themeModule.getThemeByName("red-claw");
		if (!darkTheme) {
			throw new Error("Failed to load dark theme for tests");
		}
		themeModule.setThemeInstance(darkTheme);
		vi.restoreAllMocks();
	});

	afterEach(() => {
		themeModule.stopThemeWatcher();
		vi.restoreAllMocks();
	});

	it("prefers COLORFGBG before macOS fallback inside Zellij", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1", colorfgbg: "15;0" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");

		expect(themeModule.getCurrentThemeName()).toBe("red-claw");
		expect(detectSpy).not.toHaveBeenCalled();
	});

	it("keeps honoring terminal-reported appearance outside fallback mode", async () => {
		using _globals = withThemeTestGlobals();
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);
		const observerSpy = vi.spyOn(nativesModule.MacAppearanceObserver, "start");

		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(true, undefined, undefined, "red-claw", "blue-crab");

		expect(themeModule.getCurrentThemeName()).toBe("red-claw");
		expect(detectSpy).not.toHaveBeenCalled();
		expect(observerSpy).not.toHaveBeenCalled();
	});

	it("updates auto theme from the native fallback observer in Zellij", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1" });
		const stop = vi.fn();
		let onAppearanceChange: ((appearance: "dark" | "light") => void) | undefined;
		vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);
		const observerSpy = vi.spyOn(nativesModule.MacAppearanceObserver, "start").mockImplementation(((
			callback: (err: null | Error, appearance: "dark" | "light") => void,
		) => {
			onAppearanceChange = (appearance: "dark" | "light") => callback(null, appearance);
			return { stop };
		}) as any);

		await themeModule.initTheme(true, undefined, undefined, "red-claw", "blue-crab");

		expect(observerSpy).toHaveBeenCalledTimes(1);
		expect(themeModule.getCurrentThemeName()).toBe("blue-crab");
		expect(onAppearanceChange).toBeDefined();

		onAppearanceChange!("dark");
		await Bun.sleep(0);

		expect(themeModule.getCurrentThemeName()).toBe("red-claw");
		themeModule.stopThemeWatcher();
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("routes theme selection persistence to the detected appearance slot", async () => {
		using _globals = withThemeTestGlobals({ colorfgbg: "15;0" });
		themeModule.onTerminalAppearanceChange("light");
		await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");

		expect(themeModule.getDetectedThemeSettingsPath()).toBe("theme.light");

		themeModule.onTerminalAppearanceChange("dark");
		await Bun.sleep(0);
		expect(themeModule.getDetectedThemeSettingsPath()).toBe("theme.dark");
	});

	it("restores previewed themes without leaving preview mode active", async () => {
		using _globals = withThemeTestGlobals({ colorfgbg: "15;0" });
		await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
		const darkAccent = themeModule.theme.getFgAnsi("accent");

		await themeModule.previewTheme("blue-crab");
		expect(themeModule.theme.getFgAnsi("accent")).not.toBe(darkAccent);

		await themeModule.restoreThemePreview("red-claw");
		expect(themeModule.getCurrentThemeName()).toBe("red-claw");
		expect(themeModule.theme.getFgAnsi("accent")).toBe(darkAccent);

		themeModule.setAutoThemeMapping("dark", "red-claw");
		await Bun.sleep(0);
		expect(themeModule.getCurrentThemeName()).toBe("red-claw");
		expect(themeModule.theme.getFgAnsi("accent")).toBe(darkAccent);
	});

	it("restores the latest detected auto theme when terminal appearance changes during preview", async () => {
		using _globals = withThemeTestGlobals({ colorfgbg: "15;0" });
		await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
		const darkAccent = themeModule.theme.getFgAnsi("accent");

		await themeModule.previewTheme("red-claw");
		themeModule.onTerminalAppearanceChange("light");
		await Bun.sleep(0);
		await themeModule.restoreThemePreview("red-claw");

		expect(themeModule.getCurrentThemeName()).toBe("blue-crab");
		expect(themeModule.theme.getFgAnsi("accent")).not.toBe(darkAccent);
	});

	it("restores the resolved auto theme after saving the inactive theme slot from preview", async () => {
		using _globals = withThemeTestGlobals({ colorfgbg: "15;0" });
		await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
		const darkAccent = themeModule.theme.getFgAnsi("accent");

		await themeModule.previewTheme("blue-crab");
		themeModule.setAutoThemeMapping("light", "blue-crab");
		await Bun.sleep(0);

		expect(themeModule.getCurrentThemeName()).toBe("red-claw");
		expect(themeModule.theme.getFgAnsi("accent")).toBe(darkAccent);
	});

	it("auto theme remapping supersedes an in-flight preview", async () => {
		using _globals = withThemeTestGlobals({ colorfgbg: "15;0" });
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
		const darkAccent = themeModule.theme.getFgAnsi("accent");

		const preview = themeModule.previewTheme("light");
		themeModule.setAutoThemeMapping("dark", "dark");
		await preview;
		await Bun.sleep(0);

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(themeModule.theme.getFgAnsi("accent")).toBe(darkAccent);
	});

	it("Zellij fallback stays macOS-only (Linux + Zellij = honor terminal)", async () => {
		using _globals = withThemeTestGlobals({ platform: "linux", zellij: "1" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");

		expect(themeModule.getCurrentThemeName()).toBe("red-claw");
		expect(detectSpy).not.toHaveBeenCalled();
	});

	it("terminal-reported appearance wins over conflicting COLORFGBG", async () => {
		using _globals = withThemeTestGlobals({ colorfgbg: "15;0" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		themeModule.onTerminalAppearanceChange("light");
		await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");

		expect(themeModule.getCurrentThemeName()).toBe("blue-crab");
		expect(detectSpy).not.toHaveBeenCalled();
	});
});
