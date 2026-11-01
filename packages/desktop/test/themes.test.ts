import { afterEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_THEME_ID,
	DESKTOP_THEMES,
	isThemeId,
	readThemePreference,
	THEME_IDS,
	THEME_STORAGE_KEY,
	themeLabel,
	writeThemePreference,
} from "../src/themes";

const stored = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
function installStorage(setItem?: () => void): void {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => {
				setItem?.();
				stored.set(key, value);
			},
		},
	});
}
afterEach(() => {
	stored.clear();
	if (original) Object.defineProperty(globalThis, "localStorage", original);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("desktop themes", () => {
	test("ports every bundled TUI theme and defaults to red-claw", () => {
		expect(THEME_IDS).toEqual([
			"red-claw",
			"blue-crab",
			"claude-code",
			"codex",
			"gruvbox-dark",
			"opencode",
			"ouroboros",
		]);
		expect(DEFAULT_THEME_ID).toBe("red-claw");
		expect(new Set(THEME_IDS.map(themeLabel)).size).toBe(THEME_IDS.length);
		for (const id of THEME_IDS) {
			const palette = DESKTOP_THEMES[id];
			expect(palette.bg).toMatch(/^#[0-9a-f]{6}$/u);
			expect(palette.accent).toMatch(/^#[0-9a-f]{6}$/u);
			expect(palette.onAccent).not.toBe(palette.accent);
		}
	});

	test("accepts only catalog ids", () => {
		expect(isThemeId("gruvbox-dark")).toBe(true);
		expect(isThemeId("red-crab")).toBe(false);
		expect(isThemeId(undefined)).toBe(false);
		expect(isThemeId("toString")).toBe(false);
	});

	test("falls back to the default when storage is empty, invalid or blocked", () => {
		installStorage();
		expect(readThemePreference()).toBe(DEFAULT_THEME_ID);
		localStorage.setItem(THEME_STORAGE_KEY, "not-a-theme");
		expect(readThemePreference()).toBe(DEFAULT_THEME_ID);
		localStorage.setItem(THEME_STORAGE_KEY, "codex");
		expect(readThemePreference()).toBe("codex");
		expect(writeThemePreference("ouroboros")).toBe(true);
		expect(readThemePreference()).toBe("ouroboros");
	});

	test("reports a blocked write without losing the in-memory render", () => {
		installStorage(() => {
			throw new Error("denied");
		});
		expect(writeThemePreference("blue-crab")).toBe(false);
		expect(readThemePreference()).toBe(DEFAULT_THEME_ID);
	});
});
